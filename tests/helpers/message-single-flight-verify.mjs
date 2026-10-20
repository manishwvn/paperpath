/* global AbortSignal, Buffer, URL, clearTimeout, console, fetch, process, setTimeout */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../../src/domain.ts';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const timeoutMs = 8000;
const held = [];
let providerCalls = 0;
let failNext = false;
let holdNextProviderResponse = false;
let unsupportedFactNext = false;
let conflictingFactNext = false;
let child;
let childExit;
let mock;
let appPort;
let mockPort;
let dataDir;
let preloadDir;
let preloadPath;
let base;
let mockBase;
const completionDispatchFailureKey = `msg_${randomUUID()}`;
const unsupportedCompletionKey = `msg_${randomUUID()}`;
const unsupportedEvidenceCompletionKey = `msg_${randomUUID()}`;
const domainUnsupportedCompletionKey = `msg_${randomUUID()}`;
const conflictingCompletionKey = `msg_${randomUUID()}`;
const lostCompletionResponseKey = `msg_${randomUUID()}`;
let adapterCleanupAction;
let cleanupTask;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('invalid-listener-address'));
      resolve(addr.port);
    });
  });
}
function waitUntil(predicate, label, ms = timeoutMs) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= end) return reject(new Error(`timeout:${label}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}
function toolResponse(unsupportedFact = false, conflictingFact = false) {
  const value = unsupportedFact ? 'Jordan Lee' : conflictingFact ? 'Nora Grey' : 'Morgan Bell';
  const quote = conflictingFact ? 'Nora Grey' : 'Morgan Bell';
  return JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ type: 'function', function: {
    name: 'propose_facts', arguments: JSON.stringify({ candidates: [{
      field: 'name', value, quote
    }] })
  } }] }, finish_reason: 'tool_calls' }] });
}
function finishProvider(res, status = 200, unsupportedFact = false) {
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? toolResponse(unsupportedFact) : JSON.stringify({ error: 'synthetic-failure' }));
  }
}
function releaseHeld() {
  for (const res of held.splice(0)) finishProvider(res);
}
function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      server.closeAllConnections?.();
      reject(new Error('mock-server-close-timeout'));
    }, 5000);
    server.close(error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}
async function stopChild() {
  if (!child || !childExit || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const graceful = await Promise.race([
    childExit.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })
  ]);
  clearTimeout(timer);
  if (!graceful) {
    child.kill('SIGKILL');
    let timer;
    const exited = await Promise.race([childExit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    clearTimeout(timer);
    if (!exited) throw new Error('owned-child-exit-timeout; preserve-test-data');
  }
}
async function crashOwnedChild() {
  if (!child || !childExit || child.exitCode !== null || child.signalCode !== null) {
    throw new Error('owned-app-child-not-running-for-crash-proof');
  }
  child.kill('SIGKILL');
  let timer;
  const exit = await Promise.race([
    childExit,
    new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 3000); })
  ]);
  clearTimeout(timer);
  if (!exit) throw new Error('owned-app-child-crash-timeout');
  assert.equal(exit.signal, 'SIGKILL', 'only the owned app child is terminated to model a crash');
}
async function removeKnown(dir, filenames) {
  for (const name of filenames) {
    const file = path.join(dir, name);
    try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const exportsDir = path.join(dir, 'exports');
  try { await rmdir(exportsDir); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; if (error.code === 'ENOTEMPTY') throw error; }
  await rmdir(dir);
}
function cleanup() {
  if (!cleanupTask) {
    cleanupTask = (async () => {
      releaseHeld();
      const cleanupErrors = [];
      let childStopped = false;
      try { await stopChild(); childStopped = true; } catch (error) { cleanupErrors.push(error); }
      try { if (adapterCleanupAction) await adapterCleanupAction(); } catch (error) { cleanupErrors.push(error); }
      try { await closeServer(mock); } catch (error) { cleanupErrors.push(error); }
      if (childStopped && dataDir) {
        try { await removeKnown(dataDir, ['service-secret.txt', 'paperpath.sqlite', 'paperpath.sqlite-journal', 'paperpath.sqlite-wal', 'paperpath.sqlite-shm', 'mcp-events.jsonl', 'completion-dispatch-failure.injected', 'completion-response-loss.injected']); }
        catch (error) { cleanupErrors.push(error); }
      }
      if (preloadPath) { try { await unlink(preloadPath); } catch (error) { cleanupErrors.push(error); } }
      if (preloadDir) { try { await rmdir(preloadDir); } catch (error) { cleanupErrors.push(error); } }
      if (cleanupErrors.length) {
        process.exitCode = 1;
        console.error('single-flight test cleanup failed');
      }
    })();
  }
  return cleanupTask;
}
async function api(method, route, session, payload) {
  const url = new URL(route, base);
  if (url.origin !== base || url.hostname !== '127.0.0.1') throw new Error('api-origin-rejected');
  const headers = { Accept: 'application/json', Origin: base };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-PaperPath-CSRF'] = session.csrf;
  }
  const response = await fetch(url, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs), redirect: 'manual'
  });
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`invalid-json:${method}:${route}:${response.status}`); }
  return { status: response.status, json };
}
async function localFetch(input, init = {}) {
  const url = input instanceof URL ? input : new URL(input);
  if (url.origin !== base || url.hostname !== '127.0.0.1') throw new Error('local-fetch-origin-rejected');
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw new Error('unexpected-local-redirect');
  return response;
}
function sessionFrom(response) {
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find(value => value.startsWith('paperpath_session='))?.split(';', 1)[0];
  assert.ok(cookie, 'session cookie is set');
  return response.json().then(body => {
    assert.equal(typeof body.csrf, 'string');
    return { cookie, csrf: body.csrf };
  });
}
function assertPacketEvidence(result, expectedText) {
  assert.equal(result.status, 200);
  const packet = result.json.packet;
  assert.equal(packet.revision, 2);
  const fact = packet.facts.name;
  assert.equal(fact.value, 'Morgan Bell');
  const evidence = fact.evidence;
  assert.equal(evidence.quote, 'Morgan Bell');
  assert.equal(expectedText.slice(evidence.start, evidence.end), 'Morgan Bell');
  const source = packet.sources.find(item => item.id === evidence.sourceId);
  assert.ok(source);
  assert.equal(source.text, expectedText);
  return { packet, evidence, source };
}

async function verifyAdapterCompletion() {
  const syntheticSecret = 'a'.repeat(64);
  const priorProviderCalls = providerCalls;
  let adapterDataDir;
  let adapterPreloadDir;
  let adapterPreloadPath;
  let adapterChild;
  let adapterChildExit;
  let seedStore;
  let snapshotDb;
  let adapterCleanupPromise;

  async function stopOwnedChild() {
    if (!adapterChild) return true;
    if (!adapterChildExit) throw new Error('adapter-child-exit-untracked; preserve-test-data');
    if (adapterChild.exitCode !== null || adapterChild.signalCode !== null) return true;
    adapterChild.kill('SIGTERM');
    let timer;
    const graceful = await Promise.race([
      adapterChildExit.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })
    ]);
    clearTimeout(timer);
    if (graceful) return true;
    adapterChild.kill('SIGKILL');
    let killTimer;
    const exited = await Promise.race([
      adapterChildExit.then(() => true),
      new Promise(resolve => { killTimer = setTimeout(() => resolve(false), 3000); })
    ]);
    clearTimeout(killTimer);
    if (!exited) throw new Error('adapter-child-exit-timeout; preserve-test-data');
    return true;
  }

  async function removeAdapterFiles(dir) {
    for (const name of ['service-secret.txt', 'paperpath.sqlite', 'paperpath.sqlite-journal',
      'paperpath.sqlite-wal', 'paperpath.sqlite-shm', 'mcp-events.jsonl']) {
      const file = path.join(dir, name);
      try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const exportsDir = path.join(dir, 'exports');
    try {
      await rmdir(exportsDir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rmdir(dir);
  }

  function cleanupAdapter() {
    if (!adapterCleanupPromise) {
      adapterCleanupPromise = (async () => {
        const cleanupErrors = [];
        let storesClosed = true;
        try {
          if (snapshotDb) { snapshotDb.close(); snapshotDb = null; }
        } catch (error) { storesClosed = false; cleanupErrors.push(error); }
        try {
          if (seedStore) { seedStore.close(); seedStore = null; }
        } catch (error) { storesClosed = false; cleanupErrors.push(error); }

        let childStopped = false;
        try { childStopped = await stopOwnedChild(); }
        catch (error) { cleanupErrors.push(error); }

        if (childStopped && storesClosed && cleanupErrors.length === 0) {
          if (adapterDataDir) {
            try { await removeAdapterFiles(adapterDataDir); }
            catch (error) { cleanupErrors.push(error); }
          }
          if (adapterPreloadPath) {
            try { await unlink(adapterPreloadPath); }
            catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error); }
          }
          if (adapterPreloadDir) {
            try { await rmdir(adapterPreloadDir); }
            catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error); }
          }
        }
        if (cleanupErrors.length) {
          process.exitCode = 1;
          console.error('adapter proof cleanup failed; preserve test data');
          return false;
        }
        return true;
      })();
    }
    return adapterCleanupPromise;
  }
  adapterCleanupAction = cleanupAdapter;

  try {
    adapterDataDir = await mkdtemp(path.join(os.tmpdir(), 'paperpath-mcp-adapter-data-'));
    adapterPreloadDir = await mkdtemp(path.join(os.tmpdir(), 'paperpath-mcp-adapter-preload-'));
    adapterPreloadPath = path.join(adapterPreloadDir, 'loopback-fetch.mjs');

    const secretPath = path.join(adapterDataDir, 'service-secret.txt');
    await writeFile(secretPath, syntheticSecret, { flag: 'wx', mode: 0o600 });

    const portProbe = net.createServer();
    const adapterPort = await listen(portProbe);
    await closeServer(portProbe);
    const adapterBase = 'http://127.0.0.1:' + adapterPort;
    const preload = 'const appBase=' + JSON.stringify(adapterBase) +
      '; const nativeFetch=globalThis.fetch;' +
      ' globalThis.fetch=async(input,init={})=>{' +
      ' const u=typeof input===\'string\'?new URL(input):input instanceof URL?input:new URL(input.url);' +
      ' if(u.origin!==appBase||u.hostname!==\'127.0.0.1\')throw new Error(\'adapter-network-guard-rejected\');' +
      ' const response=await nativeFetch(input,{...init,redirect:\'manual\'});' +
      ' if(response.status>=300&&response.status<400)throw new Error(\'adapter-redirect-rejected\');' +
      ' return response};';
    await writeFile(adapterPreloadPath, preload, { flag: 'wx', mode: 0o600 });

    function exactAdapterUrl(input) {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.origin !== adapterBase || url.hostname !== '127.0.0.1') {
        throw new Error('adapter-fetch-origin-rejected');
      }
      return url;
    }
    async function adapterFetch(input, init = {}) {
      const url = exactAdapterUrl(input);
      const response = await fetch(url, { ...init, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) throw new Error('adapter-fetch-redirect-rejected');
      return response;
    }
    async function adapterApi(method, route, session, payload) {
      const url = exactAdapterUrl(new URL(route, adapterBase));
      const headers = { Accept: 'application/json', Origin: adapterBase };
      if (session?.cookie) headers.Cookie = session.cookie;
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['X-PaperPath-CSRF'] = session.csrf;
      }
      const response = await adapterFetch(url, {
        method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const raw = await response.text();
      let json;
      try { json = JSON.parse(raw); } catch { throw new Error('adapter-invalid-json:' + method + ':' + route + ':' + response.status); }
      return { status: response.status, json };
    }

    async function startAdapterChild() {
      adapterChild = spawn(process.execPath, ['--import', adapterPreloadPath,
        '--experimental-strip-types', 'src/server.ts'], {
        cwd: appRoot,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8',
          HOME: adapterDataDir, TMPDIR: adapterDataDir,
          PORT: String(adapterPort), PAPERPATH_DATA_DIR: adapterDataDir
        },
        stdio: ['ignore', 'ignore', 'ignore']
      });
      adapterChildExit = new Promise(resolve => adapterChild.once('exit', (code, signal) => resolve({ code, signal })));
      let ready = false;
      const readyDeadline = Date.now() + 25000;
      while (!ready && Date.now() < readyDeadline) {
        if (adapterChild.exitCode !== null || adapterChild.signalCode !== null) {
          throw new Error('adapter-app-child-exited-before-ready');
        }
        try {
          const response = await adapterFetch(new URL('/health', adapterBase), { signal: AbortSignal.timeout(1000) });
          const payload = await response.json();
          ready = response.status === 200 && payload.protocol === '2025-11-25';
        } catch {
          // The owned app may not have bound the loopback listener yet.
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'adapter app readiness deadline');
    }
    await startAdapterChild();

    async function newSession() {
      const response = await adapterFetch(new URL('/api/session', adapterBase), { signal: AbortSignal.timeout(timeoutMs) });
      assert.equal(response.status, 200);
      const body = await response.clone().json();
      assert.equal(body.providerReady, false, 'adapter phase has no provider credential');
      return sessionFrom(response);
    }
    const ownerA = await newSession();
    const ownerB = await newSession();
    const ownerAId = ownerA.cookie.slice('paperpath_session='.length);
    const ownerBId = ownerB.cookie.slice('paperpath_session='.length);
    assert.ok(ownerAId && ownerBId && ownerAId !== ownerBId);

    const created = await adapterApi('POST', '/api/cases', ownerA, { idempotencyKey: 'case_' + randomUUID() });
    assert.equal(created.status, 200);
    const packet = created.json.packet;
    const messageKey = 'msg_' + randomUUID();
    const sourceText = 'Morgan Bell volunteers as coordinator at the north gate.';
    const candidateList = [{ field: 'name', value: 'Morgan Bell', quote: 'Morgan Bell' }];
    const dbPath = path.join(adapterDataDir, 'paperpath.sqlite');

    seedStore = new Store(dbPath);
    const reservation = seedStore.reserveMessage(ownerAId, packet.id, packet.revision, messageKey, sourceText);
    assert.equal(reservation.state, 'pending');
    assert.equal(reservation.acquired, true);
    const attemptToken = reservation.attemptToken;
    assert.match(attemptToken, /^[a-f0-9]{32}$/);
    seedStore.close();
    seedStore = null;

    snapshotDb = new DatabaseSync(dbPath);
    const snapshot = () => ({
      cases: snapshotDb.prepare('SELECT * FROM cases WHERE id=?').all(packet.id),
      operations: snapshotDb.prepare('SELECT * FROM operations WHERE owner=? AND key=?').all(ownerAId, messageKey),
      reservations: snapshotDb.prepare('SELECT * FROM message_reservations WHERE owner=? AND key=?').all(ownerAId, messageKey)
    });

    const tokenBeforeRestart = snapshot().reservations[0]?.attempt_token;
    assert.equal(tokenBeforeRestart, attemptToken);
    assert.equal(await stopOwnedChild(), true);
    await startAdapterChild();

    const pendingHttp = await adapterApi('POST', '/api/cases/' + packet.id + '/message', ownerA, {
      expectedRevision: packet.revision, idempotencyKey: messageKey, text: sourceText
    });
    assert.equal(pendingHttp.status, 409, 'a reservation remains pending after server restart');
    assert.equal(pendingHttp.json.error, 'MESSAGE_PENDING');
    assert.equal(providerCalls, priorProviderCalls, 'a restarted pending reservation does not invoke extraction');
    assert.equal(snapshot().reservations[0]?.attempt_token, tokenBeforeRestart,
      'restart and same-request replay leave the original server token unchanged');

    const noKeyMessageKey = 'msg_' + randomUUID();
    const noKeyMessageText = 'Morgan Bell prefers Saturday shifts.';
    const notStarted = await adapterApi('POST', '/api/cases/' + packet.id + '/message', ownerA, {
      expectedRevision: packet.revision, idempotencyKey: noKeyMessageKey, text: noKeyMessageText
    });
    assert.equal(notStarted.status, 503);
    assert.equal(notStarted.json.error, 'GROQ_KEY_REQUIRED');
    const releasedReservation = snapshotDb.prepare('SELECT attempt_token FROM message_reservations WHERE owner=? AND key=?')
      .get(ownerAId, noKeyMessageKey);
    assert.equal(releasedReservation?.attempt_token, '', 'known not-started extraction releases the reservation');
    assert.equal(JSON.stringify(notStarted).includes(attemptToken), false, 'HTTP error omits the server attempt token');
    const notStartedRetry = await adapterApi('POST', '/api/cases/' + packet.id + '/message', ownerA, {
      expectedRevision: packet.revision, idempotencyKey: noKeyMessageKey, text: noKeyMessageText
    });
    assert.equal(notStartedRetry.status, 503);
    assert.equal(notStartedRetry.json.error, 'GROQ_KEY_REQUIRED');
    assert.equal(snapshotDb.prepare('SELECT attempt_token FROM message_reservations WHERE owner=? AND key=?')
      .get(ownerAId, noKeyMessageKey)?.attempt_token, '', 'known not-started retry releases its new token');
    assert.equal(providerCalls, priorProviderCalls, 'missing credentials never reach the provider mock');

    async function withAdapterMcp(session, action) {
      const client = new Client({ name: 'PaperPath adapter proof', version: '0.1.0' });
      const owner = session.cookie.slice('paperpath_session='.length);
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', adapterBase), {
        requestInit: { headers: {
          Authorization: 'Bearer ' + syntheticSecret,
          'X-PaperPath-Owner': owner
        } },
        fetch: adapterFetch
      });
      try {
        await client.connect(transport);
        return await action(client);
      } finally {
        await client.close();
      }
    }
    async function completeCall(session, args) {
      return withAdapterMcp(session, client => client.callTool({
        name: 'complete_message', arguments: args
      }));
    }

    const listing = await withAdapterMcp(ownerA, client => client.listTools());
    const completionTool = listing.tools.find(tool => tool.name === 'complete_message');
    const proposalTool = listing.tools.find(tool => tool.name === 'propose_facts');
    assert.ok(completionTool, 'complete_message is registered');
    assert.ok(proposalTool, 'propose_facts remains registered');
    const completionProperties = completionTool.inputSchema.properties;
    assert.deepEqual(Object.keys(completionProperties).sort(),
      ['attemptToken', 'candidates', 'caseId', 'expectedRevision', 'idempotencyKey', 'sourceText'].sort());
    assert.equal(Object.hasOwn(completionProperties, 'owner'), false);
    assert.deepEqual([...completionTool.inputSchema.required].sort(),
      ['attemptToken', 'candidates', 'caseId', 'expectedRevision', 'idempotencyKey', 'sourceText'].sort());
    const proposalProperties = proposalTool.inputSchema.properties;
    assert.deepEqual(Object.keys(proposalProperties).sort(),
      ['candidates', 'caseId', 'expectedRevision', 'idempotencyKey', 'sourceText'].sort());
    assert.equal(proposalProperties.candidates.type, 'array');
    assert.equal(proposalProperties.candidates.maxItems, 5);
    assert.equal(proposalProperties.sourceText.minLength, 1);
    assert.equal(proposalProperties.sourceText.maxLength, 4000);

    const completionArgs = {
      caseId: packet.id, expectedRevision: packet.revision, idempotencyKey: messageKey,
      sourceText, attemptToken, candidates: candidateList
    };
    async function rejectedWithoutMutation(session, args, label) {
      const before = snapshot();
      const result = await completeCall(session, args);
      assert.equal(result.isError, true, label + ' is rejected');
      assert.equal(JSON.stringify(result).includes(attemptToken), false, label + ' result omits attempt token');
      assert.deepEqual(snapshot(), before, label + ' leaves case, operations, and reservation unchanged');
      return result;
    }
    async function rejectsUnknownFieldWithoutMutation() {
      const before = snapshot();
      let result;
      let rejected = false;
      let rejectionCode;
      try {
        result = await completeCall(ownerA, { ...completionArgs, owner: ownerBId });
      } catch (error) {
        rejected = true;
        rejectionCode = error?.code;
      }
      assert.ok(rejected || result?.isError === true, 'strict MCP schema rejects unknown owner field');
      if (rejected) assert.equal(rejectionCode, -32602, 'unknown owner field is an InvalidParams rejection');
      assert.deepEqual(snapshot(), before, 'unknown owner field leaves case, operations, and reservation unchanged');
    }

    await rejectedWithoutMutation(ownerB, completionArgs, 'wrong owner');
    const wrongToken = attemptToken === '0'.repeat(32) ? '1'.repeat(32) : '0'.repeat(32);
    await rejectedWithoutMutation(ownerA, { ...completionArgs, attemptToken: wrongToken }, 'wrong token');
    await rejectedWithoutMutation(ownerA, {
      ...completionArgs, sourceText: 'A different source message with no matching reservation.'
    }, 'wrong source text');
    await rejectedWithoutMutation(ownerA, {
      ...completionArgs, expectedRevision: packet.revision + 1
    }, 'wrong revision');
    await rejectsUnknownFieldWithoutMutation();

    const completedResult = await completeCall(ownerA, completionArgs);
    assert.equal(completedResult.isError, undefined);
    assert.equal(JSON.stringify(completedResult).includes(attemptToken), false, 'completion result omits attempt token');
    const completed = completedResult.structuredContent;
    assert.ok(completed);
    assert.equal(completed.revision, packet.revision + 1);
    assert.equal(completed.sources.length, 1);
    assert.equal(completed.sources[0].text, sourceText);
    assert.equal(completed.facts.name.value, 'Morgan Bell');
    assert.equal(Object.hasOwn(completed, 'reservation'), false);
    const committedSnapshot = snapshot();
    assert.equal(committedSnapshot.cases.length, 1);
    assert.equal(committedSnapshot.operations.length, 1);
    assert.equal(committedSnapshot.reservations.length, 0);

    const repeated = await completeCall(ownerA, completionArgs);
    assert.equal(repeated.isError, true, 'repeated completion conflicts');
    assert.equal(JSON.stringify(repeated).includes(attemptToken), false, 'repeat result omits attempt token');
    assert.deepEqual(snapshot(), committedSnapshot, 'repeat adds no operation, source, or reservation');

    const corrected = await adapterApi('POST', '/api/cases/' + packet.id + '/correct', ownerA, {
      expectedRevision: completed.revision, idempotencyKey: 'fix_' + randomUUID(),
      field: 'name', value: 'Morgan Bell Corrected'
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.json.packet.facts.name.value, 'Morgan Bell Corrected');

    const beforeReplayProviderCalls = providerCalls;
    const replay = await adapterApi('POST', '/api/cases/' + packet.id + '/message', ownerA, {
      expectedRevision: packet.revision, idempotencyKey: messageKey, text: sourceText
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json.packet, corrected.json.packet,
      'completed HTTP replay returns the corrected current case');
    assert.equal(providerCalls, beforeReplayProviderCalls, 'completed replay adds no provider call');

    const eventLog = await readFile(path.join(adapterDataDir, 'mcp-events.jsonl'), 'utf8');
    assert.ok(eventLog.length > 0, 'existing metadata event log was exercised');
    assert.equal(eventLog.includes(attemptToken), false, 'metadata logs omit attempt token');
    assert.equal(providerCalls, priorProviderCalls, 'adapter phase makes no provider calls');

    return {
      sdkInitializeListCall: true, validOwnerTokenCompletesOnce: true,
      fiveRejectionsIncludingUnknownFieldLeaveRowsUnchanged: true,
      unknownFieldRejectedWithoutMutation: true, repeatAddsNoOperationOrSource: true,
      proposeFactsSchemaRetained: true, tokenAbsentFromResultsAndLogs: true,
      correctedHttpReplayWithoutProvider: true, providerCredentialAbsent: true,
      pendingHttpReservationIsNotReinferred: true, knownNotStartedReservationIsReleased: true,
      restartPendingReservationKeepsAttemptToken: true
    };
  } finally {
    const cleanupComplete = await cleanupAdapter();
    if (!cleanupComplete) process.exitCode = 1;
    if (adapterCleanupAction === cleanupAdapter) adapterCleanupAction = undefined;
  }
}


for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(128 + (signal === 'SIGTERM' ? 15 : 2)));
  });
}

try {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'paperpath-single-flight-data-'));
  preloadDir = await mkdtemp(path.join(os.tmpdir(), 'paperpath-single-flight-preload-'));
  preloadPath = path.join(preloadDir, 'mock-fetch.mjs');

  mock = http.createServer((req, res) => {
    req.setTimeout(timeoutMs, () => res.destroy(new Error('mock-request-timeout')));
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); if (Buffer.concat(chunks).length > 100_000) req.destroy(); });
    req.on('end', () => {
      providerCalls += 1;
      if (req.method !== 'POST' || req.url !== '/chat/completions' || req.headers.authorization !== 'Bearer synthetic-local-only') {
        res.writeHead(403).end();
        return;
      }
      if (failNext) { failNext = false; finishProvider(res, 400); return; }
      if (holdNextProviderResponse) { holdNextProviderResponse = false; held.push(res); return; }
      if (providerCalls <= 2) { held.push(res); return; }
      if (unsupportedFactNext) { unsupportedFactNext = false; finishProvider(res, 200, true); return; }
      if (conflictingFactNext) {
        conflictingFactNext = false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(toolResponse(false, true));
        return;
      }
      finishProvider(res);
    });
  });
  mockPort = await listen(mock);
  mockBase = `http://127.0.0.1:${mockPort}`;
  const appProbe = net.createServer();
  appPort = await listen(appProbe);
  await closeServer(appProbe);
  base = `http://127.0.0.1:${appPort}`;

  const dispatchFailureMarker = path.join(dataDir, 'completion-dispatch-failure.injected');
  const responseLossMarker = path.join(dataDir, 'completion-response-loss.injected');
  const preload = `const appBase=${JSON.stringify(base)};
const provider='https://api.groq.com/openai/v1/chat/completions';
const mockBase=${JSON.stringify(mockBase)};
const dispatchFailureKey=${JSON.stringify(completionDispatchFailureKey)};
const unsupportedKey=${JSON.stringify(unsupportedCompletionKey)};
const unsupportedEvidenceKey=${JSON.stringify(unsupportedEvidenceCompletionKey)};
const lostResponseKey=${JSON.stringify(lostCompletionResponseKey)};
const dispatchFailureMarker=${JSON.stringify(dispatchFailureMarker)};
const responseLossMarker=${JSON.stringify(responseLossMarker)};
const nativeFetch=globalThis.fetch;
let dispatchFailureInjected=false;
let responseLossInjected=false;
function completionKey(input,init){
  const method=(init.method??(typeof Request!=='undefined'&&input instanceof Request?input.method:'')).toUpperCase();
  if(method!=='POST')return undefined;
  const raw=init.body;
  const text=typeof raw==='string'?raw:raw instanceof Uint8Array?new TextDecoder().decode(raw):undefined;
  if(!text)return undefined;
  let request;
  try{request=JSON.parse(text)}catch{return undefined}
  if(request.method!=='tools/call'||request.params?.name!=='complete_message')return undefined;
  return request.params?.arguments?.idempotencyKey;
}
globalThis.fetch=async(input,init={})=>{
  const u=typeof input==='string'?new URL(input):input instanceof URL?input:new URL(input.url);
  let target;
  if(u.href===provider){if(typeof input!=='string')throw new Error('provider-request-shape-rejected'); target=new URL('/chat/completions',mockBase)}
  else if(u.origin===appBase && u.hostname==='127.0.0.1') target=input;
  else throw new Error('network-guard-rejected');
  const key=u.pathname==='/mcp'?completionKey(input,init):undefined;
  if(key===unsupportedKey||key===unsupportedEvidenceKey){
    const request=JSON.parse(typeof init.body==='string'?init.body:new TextDecoder().decode(init.body));
    const code=key===unsupportedKey?'UNSUPPORTED_FACT':'UNSUPPORTED_EVIDENCE';
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{isError:true,content:[{type:'text',text:code}]}}),
      {status:200,headers:{'content-type':'application/json'}});
  }
  if(key===dispatchFailureKey&&!dispatchFailureInjected){
    dispatchFailureInjected=true;
    const fs=await import('node:fs/promises');
    await fs.writeFile(dispatchFailureMarker,'injected',{flag:'wx',mode:0o600});
    throw new Error('injected-complete-message-dispatch-failure');
  }
  const response=await nativeFetch(target,{...init,redirect:'manual'});
  if(response.status>=300&&response.status<400)throw new Error('redirect-rejected');
  if(key===lostResponseKey&&!responseLossInjected){
    responseLossInjected=true;
    await response.arrayBuffer();
    const fs=await import('node:fs/promises');
    await fs.writeFile(responseLossMarker,'injected-after-response',{flag:'wx',mode:0o600});
    throw new Error('injected-complete-message-response-loss');
  }
  return response
};`;
  await writeFile(preloadPath, preload, { flag: 'wx', mode: 0o600 });
  async function startMainChild() {
    child = spawn(process.execPath, ['--import', preloadPath, '--experimental-strip-types', 'src/server.ts'], {
      cwd: appRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dataDir, TMPDIR: dataDir,
        PORT: String(appPort), PAPERPATH_DATA_DIR: dataDir,
        GROQ_API_KEY: 'synthetic-local-only', GROQ_MODEL: 'openai/gpt-oss-20b',
        PAPERPATH_TEST_APP_BASE_URL: base, PAPERPATH_TEST_PROVIDER_MOCK_URL: mockBase
      },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let ready = false;
    const readyDeadline = Date.now() + 25000;
    while (!ready && Date.now() < readyDeadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('app-child-exited-before-ready');
      try {
        const response = await localFetch(new URL('/health', base), { signal: AbortSignal.timeout(1000) });
        const payload = await response.json();
        ready = response.status === 200 && payload.protocol === '2025-11-25';
      } catch {
        // App may not have bound the listener yet.
      }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'app readiness deadline');
  }
  await startMainChild();

  async function newSession() {
    const response = await localFetch(new URL('/api/session', base), { signal: AbortSignal.timeout(timeoutMs) });
    assert.equal(response.status, 200);
    return sessionFrom(response);
  }
  const ownerA = await newSession();
  const ownerB = await newSession();
  const createA = await api('POST', '/api/cases', ownerA, { idempotencyKey: `caseA_${randomUUID()}` });
  const createB = await api('POST', '/api/cases', ownerB, { idempotencyKey: `caseB_${randomUUID()}` });
  assert.equal(createA.status, 200);
  assert.equal(createB.status, 200);
  const caseA = createA.json.packet;
  const caseB = createB.json.packet;
  assert.deepEqual(createB.json.validation, {
    complete: false,
    missing: ['name', 'email', 'availability', 'equipment'],
    conflicts: []
  }, 'a newly created production Store packet exposes every missing required fact');
  const messageKey = `msg_${randomUUID()}`;
  const textA = 'Hello Morgan Bell, please confirm the north gate shift.';
  const textB = 'Hello Morgan Bell, please confirm the south gate shift.';
  const messagePathA = `/api/cases/${caseA.id}/message`;
  const messagePathB = `/api/cases/${caseB.id}/message`;
  const bodyA = { expectedRevision: caseA.revision, idempotencyKey: messageKey, text: textA };
  const bodyChanged = { ...bodyA, text: 'Hello Morgan Bell, changed the north gate shift.' };
  const bodyB = { expectedRevision: caseB.revision, idempotencyKey: messageKey, text: textB };
  providerCalls = 0;
  const ownerAFirst = api('POST', messagePathA, ownerA, bodyA);
  await waitUntil(() => providerCalls >= 1, 'first-provider-call');
  const ownerADuplicate = api('POST', messagePathA, ownerA, bodyA);
  const ownerAChanged = await api('POST', messagePathA, ownerA, bodyChanged);
  assert.equal(ownerAChanged.status, 409);
  assert.equal(providerCalls, 1, 'changed-payload conflict adds no provider call');
  const ownerBFirst = api('POST', messagePathB, ownerB, bodyB);
  await waitUntil(() => providerCalls >= 2, 'owner-b-provider-call');
  assert.equal(providerCalls, 2, 'two independent owners produce exactly two provider calls');
  assert.equal(held.length, 2);
  releaseHeld();
  const [responseA, responseADuplicate, responseB] = await Promise.all([ownerAFirst, ownerADuplicate, ownerBFirst]);
  assert.deepEqual(responseA, responseADuplicate, 'identical owner-A in-flight responses match');
  const proofA = assertPacketEvidence(responseA, textA);
  const proofB = assertPacketEvidence(responseB, textB);
  assert.notEqual(proofA.packet.id, proofB.packet.id);
  assert.notEqual(proofA.source.id, proofB.source.id);
  const committedReplay = await api('POST', messagePathA, ownerA, bodyA);
  const replayProof = assertPacketEvidence(committedReplay, textA);
  assert.deepEqual(committedReplay, responseA);
  assert.deepEqual(replayProof.evidence, proofA.evidence);
  assert.equal(providerCalls, 2, 'committed replay adds no provider call');

  const failBody = { expectedRevision: proofA.packet.revision, idempotencyKey: `msg_${randomUUID()}`, text: 'Follow up Morgan Bell about the north gate.' };
  const beforeFailure = providerCalls;
  failNext = true;
  const failed = await api('POST', messagePathA, ownerA, failBody);
  assert.equal(failed.status, 409);
  assert.equal(failed.json.error, 'MESSAGE_PENDING');
  assert.equal(providerCalls, beforeFailure + 1, 'provider failure uses exactly one call');
  const retry = await api('POST', messagePathA, ownerA, failBody);
  assert.equal(retry.status, 409);
  assert.equal(retry.json.error, 'MESSAGE_PENDING');
  assert.equal(providerCalls, beforeFailure + 1, 'unknown provider outcome stays pending without another call');

  const completionFailureText = 'Morgan Bell asked us to confirm the north gate schedule.';
  const completionFailureBody = {
    expectedRevision: proofA.packet.revision,
    idempotencyKey: completionDispatchFailureKey,
    text: completionFailureText
  };
  const beforeCompletionFailure = providerCalls;
  const completionFailure = await api('POST', messagePathA, ownerA, completionFailureBody);
  assert.equal(completionFailure.status, 409);
  assert.equal(completionFailure.json.error, 'MESSAGE_PENDING');
  assert.equal(providerCalls, beforeCompletionFailure + 1,
    'one successful extraction precedes the injected MCP dispatch failure');
  assert.equal(await readFile(path.join(dataDir, 'completion-dispatch-failure.injected'), 'utf8'), 'injected');

  const ownerAId = ownerA.cookie.slice('paperpath_session='.length);
  const mainDb = new DatabaseSync(path.join(dataDir, 'paperpath.sqlite'));
  const mainMessageSnapshot = (key, caseId = caseA.id, ownerId = ownerAId) => ({
    operation: mainDb.prepare('SELECT * FROM operations WHERE owner=? AND key=?').all(ownerId, key),
    reservation: mainDb.prepare('SELECT * FROM message_reservations WHERE owner=? AND key=?').all(ownerId, key),
    packet: mainDb.prepare('SELECT revision,body FROM cases WHERE id=?').get(caseId)
  });
  const unsupportedBody = {
    expectedRevision: proofA.packet.revision,
    idempotencyKey: unsupportedCompletionKey,
    text: 'Morgan Bell asked us to confirm the north gate schedule.'
  };
  const beforeUnsupported = providerCalls;
  const unsupported = await api('POST', messagePathA, ownerA, unsupportedBody);
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.json.error, 'UNSUPPORTED_FACT');
  assert.match(unsupported.json.message, /not clearly supported/);
  assert.equal(providerCalls, beforeUnsupported + 1, 'unsupported completion follows exactly one extraction');
  const unsupportedSnapshot = mainMessageSnapshot(unsupportedCompletionKey);
  assert.equal(unsupportedSnapshot.operation.length, 0, 'unsupported completion writes no operation');
  assert.equal(unsupportedSnapshot.reservation.length, 1, 'unsupported completion keeps reservation pending');
  assert.equal(unsupportedSnapshot.packet.revision, proofA.packet.revision, 'unsupported completion leaves case unchanged');
  const unsupportedReplay = await api('POST', messagePathA, ownerA, unsupportedBody);
  assert.equal(unsupportedReplay.status, 409);
  assert.equal(unsupportedReplay.json.error, 'MESSAGE_PENDING');
  assert.equal(providerCalls, beforeUnsupported + 1, 'unsupported completion replay does not reinfer');

  const unsupportedEvidenceBody = {
    expectedRevision: proofA.packet.revision,
    idempotencyKey: unsupportedEvidenceCompletionKey,
    text: 'Morgan Bell asked us to confirm the north gate schedule.'
  };
  const beforeUnsupportedEvidence = providerCalls;
  const unsupportedEvidence = await api('POST', messagePathA, ownerA, unsupportedEvidenceBody);
  assert.equal(unsupportedEvidence.status, 400);
  assert.equal(unsupportedEvidence.json.error, 'UNSUPPORTED_EVIDENCE');
  assert.match(unsupportedEvidence.json.message, /could not be matched/);
  assert.equal(providerCalls, beforeUnsupportedEvidence + 1, 'unsupported evidence follows exactly one extraction');
  const unsupportedEvidenceSnapshot = mainMessageSnapshot(unsupportedEvidenceCompletionKey);
  assert.equal(unsupportedEvidenceSnapshot.operation.length, 0, 'unsupported evidence writes no operation');
  assert.equal(unsupportedEvidenceSnapshot.reservation.length, 1, 'unsupported evidence keeps reservation pending');
  assert.equal(unsupportedEvidenceSnapshot.packet.revision, proofA.packet.revision, 'unsupported evidence leaves case unchanged');
  const unsupportedEvidenceReplay = await api('POST', messagePathA, ownerA, unsupportedEvidenceBody);
  assert.equal(unsupportedEvidenceReplay.status, 409);
  assert.equal(unsupportedEvidenceReplay.json.error, 'MESSAGE_PENDING');
  assert.equal(providerCalls, beforeUnsupportedEvidence + 1, 'unsupported evidence replay does not reinfer');

  const domainUnsupportedBody = {
    expectedRevision: proofA.packet.revision,
    idempotencyKey: domainUnsupportedCompletionKey,
    text: 'Morgan Bell asked us to confirm the north gate schedule.'
  };
  const beforeDomainUnsupported = providerCalls;
  const domainUnsupportedPacketBefore = mainDb.prepare('SELECT revision,body FROM cases WHERE id=?').get(caseA.id);
  unsupportedFactNext = true;
  const domainUnsupported = await api('POST', messagePathA, ownerA, domainUnsupportedBody);
  assert.equal(domainUnsupported.status, 400);
  assert.equal(domainUnsupported.json.error, 'UNSUPPORTED_FACT');
  assert.match(domainUnsupported.json.message, /not clearly supported/);
  assert.equal(JSON.stringify(domainUnsupported.json).includes('Jordan Lee'), false,
    'the HTTP error exposes sanitized guidance, not the rejected provider candidate');
  assert.equal(providerCalls, beforeDomainUnsupported + 1,
    'the production domain rejection follows exactly one schema-valid provider response');
  const domainUnsupportedSnapshot = mainMessageSnapshot(domainUnsupportedCompletionKey);
  assert.equal(domainUnsupportedSnapshot.operation.length, 0, 'domain-rejected completion writes no operation');
  assert.equal(domainUnsupportedSnapshot.reservation.length, 1, 'domain-rejected completion keeps reservation pending');
  assert.deepEqual(domainUnsupportedSnapshot.packet, domainUnsupportedPacketBefore,
    'domain-rejected completion leaves case revision and facts unchanged');
  const domainUnsupportedReplay = await api('POST', messagePathA, ownerA, domainUnsupportedBody);
  assert.equal(domainUnsupportedReplay.status, 409);
  assert.equal(domainUnsupportedReplay.json.error, 'MESSAGE_PENDING');
  assert.equal(providerCalls, beforeDomainUnsupported + 1,
    'same-key replay after the production domain rejection does not reinfer');

  const conflictCaseCreate = await api('POST', '/api/cases', ownerA, {
    idempotencyKey: `caseConflict_${randomUUID()}`
  });
  assert.equal(conflictCaseCreate.status, 200);
  let conflictCase = conflictCaseCreate.json.packet;
  const conflictCasePath = `/api/cases/${conflictCase.id}`;
  for (const [field, value] of [
    ['name', 'Taylor Synthetic'],
    ['email', 'taylor@example.test'],
    ['availability', 'Saturday mornings'],
    ['equipment', false]
  ]) {
    const correction = await api('POST', `${conflictCasePath}/correct`, ownerA, {
      expectedRevision: conflictCase.revision,
      idempotencyKey: `correct_${randomUUID()}`,
      field,
      value
    });
    assert.equal(correction.status, 200, `synthetic ${field} correction is accepted`);
    conflictCase = correction.json.packet;
  }
  assert.deepEqual((await api('GET', conflictCasePath, ownerA)).json.validation, {
    complete: true, missing: [], conflicts: []
  }, 'the separate conflict fixture starts complete');

  const conflictingBody = {
    expectedRevision: conflictCase.revision,
    idempotencyKey: conflictingCompletionKey,
    text: 'Nora Grey asked us to confirm the north gate schedule.'
  };
  const beforeConflicting = providerCalls;
  conflictingFactNext = true;
  const conflictMessagePath = `${conflictCasePath}/message`;
  const conflicting = await api('POST', conflictMessagePath, ownerA, conflictingBody);
  assert.equal(conflicting.status, 200, 'a conflicting but supported candidate reaches the production Store');
  assert.equal(providerCalls, beforeConflicting + 1, 'conflicting completion follows exactly one extraction');
  assert.deepEqual(conflicting.json.validation, {
    complete: false,
    missing: [],
    conflicts: ['name']
  });
  assert.equal(conflicting.json.packet.facts.name.value, 'Taylor Synthetic', 'the canonical fact remains unchanged');
  assert.deepEqual(conflicting.json.packet.facts.name.conflicts.map(item => item.value), ['Nora Grey'],
    'the production Store exposes the conflicting candidate for review');
  assert.equal(conflicting.json.packet.revision, conflictCase.revision + 1);
  const postConflictRevision = conflicting.json.packet.revision;
  assert.equal(conflicting.json.packet.confirmedRevision, null, 'conflict leaves the packet unconfirmed');
  const conflictingSnapshot = mainMessageSnapshot(conflictingCompletionKey, conflictCase.id);
  assert.equal(conflictingSnapshot.operation.length, 1, 'conflicting completion is durably recorded');
  assert.equal(conflictingSnapshot.reservation.length, 0, 'completed conflict releases its reservation');
  assert.equal(conflictingSnapshot.packet.revision, postConflictRevision);
  const confirmConflict = await api('POST', `${conflictCasePath}/confirm`, ownerA, {
    expectedRevision: postConflictRevision,
    idempotencyKey: `confirmConflict_${randomUUID()}`,
    iConfirm: true
  });
  assert.equal(confirmConflict.status, 400);
  assert.equal(confirmConflict.json.error, 'INCOMPLETE_PACKET');
  const exportConflict = await api('POST', `${conflictCasePath}/export`, ownerA, {
    expectedRevision: postConflictRevision,
    idempotencyKey: `exportConflict_${randomUUID()}`
  });
  assert.equal(exportConflict.status, 400);
  assert.equal(exportConflict.json.error, 'INCOMPLETE_PACKET');
  const conflictReplayState = await api('GET', conflictCasePath, ownerA);
  assert.equal(conflictReplayState.json.packet.confirmedRevision, null);
  assert.deepEqual(conflictReplayState.json.validation, { complete: false, missing: [], conflicts: ['name'] });
  const conflictingReplay = await api('POST', conflictMessagePath, ownerA, conflictingBody);
  assert.equal(conflictingReplay.status, 200);
  assert.deepEqual(conflictingReplay, conflicting, 'same-key replay preserves the visible Store conflict');
  assert.equal(providerCalls, beforeConflicting + 1, 'conflicting completion replay does not reinfer');

  let dispatchFailureSnapshot;
  try {
    dispatchFailureSnapshot = mainMessageSnapshot(completionDispatchFailureKey);
    assert.equal(dispatchFailureSnapshot.operation.length, 0, 'failed MCP dispatch creates no operation');
    assert.equal(dispatchFailureSnapshot.reservation.length, 1, 'unknown MCP outcome preserves its reservation');
    assert.match(dispatchFailureSnapshot.reservation[0].attempt_token, /^[a-f0-9]{32}$/);
    assert.equal(dispatchFailureSnapshot.packet.revision, proofA.packet.revision);

    const beforeCompletionFailureReplay = providerCalls;
    const completionFailureReplay = await api('POST', messagePathA, ownerA, completionFailureBody);
    assert.equal(completionFailureReplay.status, 409);
    assert.equal(completionFailureReplay.json.error, 'MESSAGE_PENDING');
    assert.equal(providerCalls, beforeCompletionFailureReplay,
      'same-key replay of unknown MCP outcome does not extract again');
    assert.deepEqual(mainMessageSnapshot(completionDispatchFailureKey), dispatchFailureSnapshot,
      'same-key replay leaves pending reservation and case unchanged');

    const lostResponseText = 'Morgan Bell confirmed the north gate volunteer shift.';
    const lostResponseBody = {
      expectedRevision: proofA.packet.revision,
      idempotencyKey: lostCompletionResponseKey,
      text: lostResponseText
    };
    const beforeLostResponse = providerCalls;
    const lostResponse = await api('POST', messagePathA, ownerA, lostResponseBody);
    assert.equal(lostResponse.status, 409);
    assert.equal(lostResponse.json.error, 'MESSAGE_PENDING',
      'the first HTTP response stays pending after the MCP completion reply is lost');
    assert.equal(providerCalls, beforeLostResponse + 1, 'lost MCP response follows exactly one extraction');
    assert.equal(await readFile(path.join(dataDir, 'completion-response-loss.injected'), 'utf8'),
      'injected-after-response');

    const committedBeforeReplay = mainMessageSnapshot(lostCompletionResponseKey);
    assert.equal(committedBeforeReplay.operation.length, 1,
      'the exact loopback MCP call committed before its response was discarded');
    assert.equal(committedBeforeReplay.reservation.length, 0,
      'committed completion consumed its reservation');
    assert.equal(committedBeforeReplay.packet.revision, proofA.packet.revision + 1);

    const completedReplay = await api('POST', messagePathA, ownerA, lostResponseBody);
    assert.equal(completedReplay.status, 200, 'same-key replay discovers the durable completion');
    const completedPacket = completedReplay.json.packet;
    assert.equal(completedPacket.revision, proofA.packet.revision + 1);
    assert.equal(completedPacket.facts.name.value, 'Morgan Bell');
    assert.equal(completedPacket.sources.at(-1).text, lostResponseText);
    const factEvidence = completedPacket.facts.name.evidence;
    const factSource = completedPacket.sources.find(source => source.id === factEvidence.sourceId);
    assert.ok(factSource);
    assert.equal(factSource.text.slice(factEvidence.start, factEvidence.end), 'Morgan Bell');
    assert.equal(providerCalls, beforeLostResponse + 1,
      'completed same-key replay adds no provider extraction');
    assert.deepEqual(mainMessageSnapshot(lostCompletionResponseKey), committedBeforeReplay,
      'completed replay leaves the committed operation and case stable');
  } finally {
    mainDb.close();
  }

  const crashCaseResult = await api('POST', '/api/cases', ownerA, {
    idempotencyKey: `caseCrash_${randomUUID()}`
  });
  assert.equal(crashCaseResult.status, 200);
  const crashCase = crashCaseResult.json.packet;
  const crashMessageKey = `msg_${randomUUID()}`;
  const crashMessageText = 'Morgan Bell is available for the east gate shift.';
  const crashMessageBody = {
    expectedRevision: crashCase.revision,
    idempotencyKey: crashMessageKey,
    text: crashMessageText
  };
  const crashMessagePath = `/api/cases/${crashCase.id}/message`;
  const providerCallsBeforeCrash = providerCalls;
  holdNextProviderResponse = true;
  const crashRequestOutcome = api('POST', crashMessagePath, ownerA, crashMessageBody).then(
    response => ({ kind: 'response', response }),
    error => ({ kind: 'network-error', error })
  );
  await waitUntil(() => providerCalls === providerCallsBeforeCrash + 1 && held.length === 1,
    'midflight-provider-request-held');
  assert.equal(providerCalls, providerCallsBeforeCrash + 1,
    'the provider mock received the request before the app process is terminated');

  await crashOwnedChild();
  const crashedRequest = await crashRequestOutcome;
  assert.equal(crashedRequest.kind, 'network-error',
    'the in-flight HTTP request loses its response when its app process crashes');

  function readCrashSnapshot() {
    const db = new DatabaseSync(path.join(dataDir, 'paperpath.sqlite'));
    try {
      return {
        operation: db.prepare('SELECT * FROM operations WHERE owner=? AND key=?').all(ownerAId, crashMessageKey),
        reservation: db.prepare('SELECT * FROM message_reservations WHERE owner=? AND key=?')
          .all(ownerAId, crashMessageKey),
        packet: db.prepare('SELECT revision,body FROM cases WHERE id=?').get(crashCase.id)
      };
    } finally {
      db.close();
    }
  }
  const pendingAfterCrash = readCrashSnapshot();
  assert.equal(pendingAfterCrash.operation.length, 0, 'the interrupted extraction did not complete an operation');
  assert.equal(pendingAfterCrash.reservation.length, 1, 'the in-flight reservation survives process death');
  const crashAttemptToken = pendingAfterCrash.reservation[0].attempt_token;
  assert.match(crashAttemptToken, /^[a-f0-9]{32}$/);
  assert.equal(pendingAfterCrash.packet.revision, crashCase.revision);
  assert.deepEqual(JSON.parse(pendingAfterCrash.packet.body), crashCase,
    'crash leaves the case facts and sources unchanged');

  await startMainChild();
  const crashReplay = await api('POST', crashMessagePath, ownerA, crashMessageBody);
  assert.equal(crashReplay.status, 409, 'same-key replay after crash remains pending');
  assert.equal(crashReplay.json.error, 'MESSAGE_PENDING', 'pending state is actionable to the HTTP client');
  assert.equal(JSON.stringify(crashReplay.json).includes(crashAttemptToken), false,
    'pending HTTP response does not expose the server attempt token');
  assert.equal(providerCalls, providerCallsBeforeCrash + 1,
    'restart and replay issue zero additional provider requests');
  assert.deepEqual(readCrashSnapshot(), pendingAfterCrash,
    'same-key replay preserves the reservation token, operation absence, and case snapshot');

  releaseHeld();
  const adapterResult = await verifyAdapterCompletion();
  const result = {
    schema: 'paperpath-message-single-flight-test-v1', result: 'PASS',
    providerEndpointGuarded: true, providerCalls: 10,
    firstWaveCalls: 2, ownerIsolation: true, identicalDedup: true, changedPayload409: true,
    committedReplayNoProviderCall: true, unknownFailureRemainsPendingWithoutRetry: true,
    completionMcpFailureLeavesReservationPendingWithoutRetry: true,
    unsupportedCompletionReturnsClarificationWithoutMutationOrRetry: true,
    productionDomainUnsupportedFactReturnsSanitizedClarificationWithoutMutationOrRetry: true,
    conflictingCompletionReachesStoreAndRemainsVisibleWithoutRetry: true,
    lostCompletionResponseReplayDiscoversCommitWithoutRetry: true,
    midflightProcessCrashRemainsPendingWithoutRetry: true,
    sourceEvidenceVerifiedForBothOwners: true,
    runtimeEvidenceScope: 'Production HTTP route, MCP transport, and domain validator; no browser UI and not a complete missing/conflict/unsupported journey.',
    mcpAdapterCompletion: adapterResult
  };
  console.log(JSON.stringify(result));
} finally {
  await cleanup();
}
