import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, getExtractionOutcome } from '../src/inference.ts';
import { DomainError, candidateSchema } from '../src/domain.ts';

const MESSAGE = 'My name is Sam Lee. Contact sam@example.com. I am available weekends. I need no equipment. My motivation is community help.';
const MODEL = 'test-model';
const KEY = 'test-key';

function findValidCandidate(): unknown {
  const attempts: unknown[] = [
    { field: 'email', value: 'sam@example.com', quote: 'sam@example.com' },
    { field: 'name', value: 'Sam Lee', quote: 'Sam Lee' },
    { field: 'availability', value: 'available weekends', quote: 'available weekends' },
    { field: 'motivation', value: 'community help', quote: 'community help' },
    { field: 'equipment', value: false, quote: 'need no equipment' },
    { email: 'sam@example.com' },
    { name: 'Sam Lee' },
    { availability: 'available weekends' },
    { motivation: 'community help' },
    { equipment: false }
  ];
  for (const attempt of attempts) {
    const parsed = candidateSchema.safeParse(attempt);
    if (parsed.success) {
      return parsed.data;
    }
  }
  throw new Error('no candidate shape matched schema');
}

function okResponse(candidates: unknown): Response {
  const envelope = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: 'propose_facts',
                arguments: JSON.stringify({ candidates })
              }
            }
          ]
        }
      }
    ]
  };
  return new Response(JSON.stringify(envelope), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('missing key fails before fetch with not-started', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { model: MODEL, fetcher });
    assert.fail('expected missing key to throw');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.ok(err instanceof Error);
    assert.equal((err as DomainError).code, 'GROQ_KEY_REQUIRED');
    assert.equal(getExtractionOutcome(err), 'not-started');
    assert.equal(calls, 0);
  }
});

test('serialization failure fails before fetch with not-started', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  try {
    await extractCandidates(MESSAGE, circular, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected serialization to throw');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal(getExtractionOutcome(err), 'not-started');
    assert.equal(calls, 0);
  }
});

test('sync fetcher throw is unknown with one call', async () => {
  let calls = 0;
  const fetcher = (() => {
    calls += 1;
    throw new Error('boom');
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected sync throw to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'PROVIDER_TIMEOUT');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('rejected fetch is unknown with one call', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    throw new Error('timeout');
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected rejection to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'PROVIDER_TIMEOUT');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('429 with retry-after is unknown with one call and no retry', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('limited', { status: 429, headers: { 'retry-after': '1' } });
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected 429 to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'PROVIDER_RATE_LIMIT');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('5xx is unknown with one call and no retry', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('broken', { status: 500 });
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected 5xx to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'PROVIDER_UNAVAILABLE');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('401 preserves invalid key mapping as unknown', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('denied', { status: 401 });
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected 401 to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'GROQ_KEY_INVALID');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('403 preserves request failed mapping as unknown', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('forbidden', { status: 403 });
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected 403 to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'PROVIDER_REQUEST_FAILED');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('unreadable 2xx body is unknown', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('{{{not-json', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected unreadable to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'MALFORMED_MODEL_OUTPUT');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('malformed tool-call 2xx is unknown', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected malformed to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'MALFORMED_MODEL_OUTPUT');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('post-invocation json rejection with not-started provenance normalizes to unknown', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    const response = new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    (response as unknown as { json: () => Promise<unknown> }).json = async () => {
      throw Object.assign(new DomainError('GROQ_KEY_REQUIRED'), { outcome: 'not-started' });
    };
    return response;
  }) as unknown as typeof fetch;
  try {
    await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
    assert.fail('expected post-invocation rejection to fail');
  } catch (err) {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'MALFORMED_MODEL_OUTPUT');
    assert.equal(getExtractionOutcome(err), 'unknown');
    assert.equal(calls, 1);
  }
});

test('valid response returns candidates unchanged', async () => {
  const valid = findValidCandidate();
  const expected = [valid];
  let calls = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(init?.redirect, 'error', 'provider redirects are rejected');
    return okResponse(expected);
  }) as unknown as typeof fetch;
  const result = await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher });
  assert.deepStrictEqual(result, expected);
  assert.equal(calls, 1);
});

test('typed provenance preserves DomainError compatibility', async () => {
  assert.equal(getExtractionOutcome(new Error('plain')), undefined);
  const noKey: unknown = await extractCandidates(MESSAGE, {}, { model: MODEL, fetcher: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch }).then(() => null, (err: unknown) => err);
  assert.ok(noKey instanceof DomainError);
  assert.ok(noKey instanceof Error);
  assert.equal(getExtractionOutcome(noKey), 'not-started');
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response('forbidden', { status: 403 });
  }) as unknown as typeof fetch;
  const forbidden: unknown = await extractCandidates(MESSAGE, {}, { key: KEY, model: MODEL, fetcher }).then(() => null, (err: unknown) => err);
  assert.ok(forbidden instanceof DomainError);
  assert.equal((forbidden as DomainError).code, 'PROVIDER_REQUEST_FAILED');
  assert.equal(getExtractionOutcome(forbidden), 'unknown');
  assert.equal(calls, 1);
});
