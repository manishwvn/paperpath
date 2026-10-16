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
function toolResponse() {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ type: 'function', function: {
    name: 'propose_facts', arguments: JSON.stringify({ candidates: [{ field: 'name', value: 'Morgan Bell', quote: 'Morgan Bell' }] })
  } }] }, finish_reason: 'tool_calls' }] });
}
function finishProvider(res, status = 200) {
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? toolResponse() : JSON.stringify({ error: 'synthetic-failure' }));
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
        try { await removeKnown(dataDir, ['service-secret.txt', 'paperpath.sqlite', 'paperpath.sqlite-journal', 'paperpath.sqlite-wal', 'paperpath.sqlite-shm', 'mcp-events.jsonl']); }
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
  const headers = { Accept: 'application/json', Origin: base };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-PaperPath-CSRF'] = session.csrf;
  }
  const response = await fetch(new URL(route, base), {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs), redirect: 'manual'
  });
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`invalid-json:${method}:${route}:${response.status}`); }
  return { status: response.status, json };
}
async function localFetch(input, init = {}) {
  const response = await fetch(input, { ...init, redirect: 'manual' });
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
        // The owned app may not have bound its loopback listener yet.
      }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'adapter app readiness deadline');

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

    const pendingHttp = await adapterApi('POST', '/api/cases/' + packet.id + '/message', ownerA, {
      expectedRevision: packet.revision, idempotencyKey: messageKey, text: sourceText
    });
    assert.equal(pendingHttp.status, 409, 'an already acquired reservation is reported pending');
    assert.equal(pendingHttp.json.error, 'MESSAGE_PENDING');
    assert.equal(providerCalls, priorProviderCalls, 'a pending reservation does not invoke extraction');
    assert.equal(snapshot().reservations[0]?.attempt_token, attemptToken,
      'pending HTTP request leaves the original server token unchanged');

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
    assert.equal(providerCalls, priorProviderCalls, 'adapter phase preserves the four-call mock-provider count');

    return {
      sdkInitializeListCall: true, validOwnerTokenCompletesOnce: true,
      fiveRejectionsIncludingUnknownFieldLeaveRowsUnchanged: true,
      unknownFieldRejectedWithoutMutation: true, repeatAddsNoOperationOrSource: true,
      proposeFactsSchemaRetained: true, tokenAbsentFromResultsAndLogs: true,
      correctedHttpReplayWithoutProvider: true, providerCredentialAbsent: true,
      pendingHttpReservationIsNotReinferred: true, knownNotStartedReservationIsReleased: true
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
      if (providerCalls <= 2) { held.push(res); return; }
      finishProvider(res);
    });
  });
  mockPort = await listen(mock);
  mockBase = `http://127.0.0.1:${mockPort}`;
  const appProbe = net.createServer();
  appPort = await listen(appProbe);
  await closeServer(appProbe);
  base = `http://127.0.0.1:${appPort}`;

  const preload = `const appBase=${JSON.stringify(base)}; const provider='https://api.groq.com/openai/v1/chat/completions'; const mockBase=${JSON.stringify(mockBase)}; const nativeFetch=globalThis.fetch; globalThis.fetch=async(input,init={})=>{const u=typeof input==='string'?new URL(input):input instanceof URL?input:new URL(input.url); let target; if(u.href===provider){if(typeof input!=='string')throw new Error('provider-request-shape-rejected'); target=new URL('/chat/completions',mockBase)} else if(u.origin===appBase && u.hostname==='127.0.0.1') target=input; else throw new Error('network-guard-rejected'); const response=await nativeFetch(target,{...init,redirect:'manual'}); if(response.status>=300&&response.status<400)throw new Error('redirect-rejected'); return response};`;
  await writeFile(preloadPath, preload, { flag: 'wx', mode: 0o600 });
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

  releaseHeld();
  const adapterResult = await verifyAdapterCompletion();
  const result = {
    schema: 'paperpath-message-single-flight-test-v1', result: 'PASS',
    providerEndpointGuarded: true, providerCalls: 3,
    firstWaveCalls: 2, ownerIsolation: true, identicalDedup: true, changedPayload409: true,
    committedReplayNoProviderCall: true, unknownFailureRemainsPendingWithoutRetry: true,
    sourceEvidenceVerifiedForBothOwners: true,
    mcpAdapterCompletion: adapterResult
  };
  console.log(JSON.stringify(result));
} finally {
  await cleanup();
}
