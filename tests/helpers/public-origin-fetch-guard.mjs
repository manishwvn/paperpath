import { env } from 'node:process';
import { URL } from 'node:url';

const rawAllowedOrigin = env.PAPERPATH_TEST_ALLOWED_FETCH_ORIGIN;
if (!rawAllowedOrigin) throw new Error('test-fetch-origin-missing');

const allowed = new URL(rawAllowedOrigin);
if (allowed.protocol !== 'http:' || allowed.hostname !== '127.0.0.1') {
  throw new Error('test-fetch-origin-invalid');
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (target.origin !== allowed.origin || target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
    throw new Error('test-fetch-origin-rejected');
  }
  return originalFetch(input, {...init, redirect: 'manual'}).then(async response => {
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      await response.body?.cancel();
      throw new Error('test-fetch-redirect-rejected');
    }
    return response;
  });
};
