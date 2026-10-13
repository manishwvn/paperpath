/* global AbortSignal, Buffer, URL, clearTimeout, console, fetch, process, setTimeout */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.equal(failed.status, 503);
  assert.equal(providerCalls, beforeFailure + 1, 'provider failure uses exactly one call');
  const retry = await api('POST', messagePathA, ownerA, failBody);
  assert.equal(retry.status, 200);
  assert.equal(providerCalls, beforeFailure + 2, 'retry uses exactly one additional provider call');
  assert.equal(retry.json.packet.revision, proofA.packet.revision + 1);
  assert.equal(retry.json.packet.facts.name.value, 'Morgan Bell');

  releaseHeld();
  const result = {
    schema: 'paperpath-message-single-flight-test-v1', result: 'PASS',
    providerEndpointGuarded: true, providerCalls: 4,
    firstWaveCalls: 2, ownerIsolation: true, identicalDedup: true, changedPayload409: true,
    committedReplayNoProviderCall: true, failure503AndSameKeyRetry200: true,
    sourceEvidenceVerifiedForBothOwners: true
  };
  console.log(JSON.stringify(result));
} finally {
  await cleanup();
}
