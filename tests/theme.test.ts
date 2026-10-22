import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const bootstrapUrl = new URL('../frontend/public/theme-init.js', import.meta.url);
const indexUrl = new URL('../frontend/index.html', import.meta.url);
const bootstrap = readFileSync(bootstrapUrl, 'utf8');

function initializeTheme(storedPreference: string | Error): { theme: string; requestedKey: string | null } {
  const document = { documentElement: { dataset: { theme: 'system' } } };
  let requestedKey: string | null = null;
  const localStorage = {
    getItem(key: string): string | null {
      requestedKey = key;
      if (storedPreference instanceof Error) throw storedPreference;
      return storedPreference;
    }
  };

  runInNewContext(bootstrap, { document, localStorage });
  return { theme: document.documentElement.dataset.theme, requestedKey };
}

test('startup applies each stored supported appearance preference immediately', async (t) => {
  for (const preference of ['system', 'light', 'dark']) {
    await t.test(preference, () => {
      const result = initializeTheme(preference);
      assert.equal(result.theme, preference);
      assert.equal(result.requestedKey, 'paperpath.theme');
    });
  }
});

test('invalid stored appearance leaves the HTML system fallback unchanged', () => {
  assert.deepEqual(initializeTheme('sepia'), {
    theme: 'system',
    requestedKey: 'paperpath.theme'
  });
});

test('blocked local storage does not prevent startup with the HTML fallback', () => {
  assert.deepEqual(initializeTheme(new Error('storage unavailable')), {
    theme: 'system',
    requestedKey: 'paperpath.theme'
  });
});

test('theme bootstrap runs before the stylesheet can render the page', () => {
  const html = readFileSync(indexUrl, 'utf8');
  const bootstrapPosition = html.indexOf('<script src="./theme-init.js"></script>');
  const stylesheetPosition = html.indexOf('rel="stylesheet"');

  assert.notEqual(bootstrapPosition, -1, 'the HTML includes the tracked theme bootstrap');
  assert.notEqual(stylesheetPosition, -1, 'the HTML includes its stylesheet');
  assert.ok(bootstrapPosition < stylesheetPosition, 'stored theme is applied before CSS loads');
});
