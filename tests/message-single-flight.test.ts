import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helperPath = fileURLToPath(new URL('./helpers/message-single-flight-verify.mjs', import.meta.url));

test('message requests preserve owner-scoped replay and pending behavior over HTTP and MCP', async (t) => {
  const child = spawn(process.execPath, ['--experimental-strip-types', helperPath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  let exited = false;
  let exitCode: number | null = null;
  child.once('exit', (code) => { exited = true; exitCode = code; });

  t.after(async () => {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('test-helper-exit-timeout')), 5_000)),
      ]);
      assert.equal(exitCode, 143, 'timed-out helper exits after its owned-process cleanup');
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('single-flight-test-timeout')), 90_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(exitCode, 0, `verification helper failed: ${stderr}`);
  const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
  assert.equal(result.schema, 'paperpath-message-single-flight-test-v1');
  assert.equal(result.result, 'PASS');
  assert.equal(result.providerEndpointGuarded, true);
  assert.equal(result.providerCalls, 3);
  assert.equal(result.firstWaveCalls, 2);
  assert.equal(result.ownerIsolation, true);
  assert.equal(result.identicalDedup, true);
  assert.equal(result.changedPayload409, true);
  assert.equal(result.committedReplayNoProviderCall, true);
  assert.equal(result.unknownFailureRemainsPendingWithoutRetry, true);
  assert.equal(result.sourceEvidenceVerifiedForBothOwners, true);
});
