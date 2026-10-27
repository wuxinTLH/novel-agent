import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseThemeRegistry, resolveTheme, themesLoad, ThemeLoader, type RegisteredTheme } from './themes-load';
const raw = { version: 1, defaultTheme: 'theme-light', themes: [
  { id: 'theme-light', name: '极简白', css: 'theme-light.css' },
  { id: 'theme-dark', name: '极简黑', css: 'theme-dark.css' },
] };
test('theme registry validates IDs, local stylesheets, duplicates and default without executing entries', () => {
  assert.equal(parseThemeRegistry(raw).themes.length, 2);
  for (const value of [null, {}, { ...raw, version: 2 }, { ...raw, themes: [] },
    { ...raw, defaultTheme: 'theme-missing' }, { ...raw, themes: [raw.themes[0], raw.themes[0]] },
    ...['dark', 'theme-../dark', 'theme-Dark'].map(id => ({ ...raw, themes: [{ ...raw.themes[0], id }] })),
    ...['https://evil.invalid/a.css', '../theme-dark.css', '/theme-dark.css', 'theme-dark.css?x', 'theme-dark.js'].map(css => ({ ...raw, themes: [{ ...raw.themes[0], css }] })),
  ]) assert.throws(() => parseThemeRegistry(value));
});
test('themes-load reads registry uncached, rejects HTTP and malformed data, migrates old selection', async () => {
  const registry = await themesLoad(async (url, options) => {
    assert.equal(url, '/themes/themes.json'); assert.equal(options?.cache, 'no-store');
    return new Response(JSON.stringify(raw));
  });
  assert.equal(resolveTheme(registry, 'dark').id, 'theme-dark');
  assert.equal(resolveTheme(registry, 'theme-dark').id, 'theme-dark');
  assert.equal(resolveTheme(registry, 'removed').id, 'theme-light');
  await assert.rejects(themesLoad(async () => new Response('', { status: 404 })), /404/);
  await assert.rejects(themesLoad(async () => new Response('{}')), /无效/);
});
test('theme loader preserves old style on failure, removes stale loads and cleans up on disposal', async () => {
  const pending: Array<{ resolve: (remove: () => void) => void; reject: (error: Error) => void }> = [];
  const loader = new ThemeLoader(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const applied: string[] = [], removed: string[] = [];
  const select = (id: string) => loader.select({ id, name: id, css: `${id}.css` }, theme => applied.push(theme.id));
  const initial = select('theme-light'); pending[0].resolve(() => removed.push('light')); await initial;
  const failed = select('theme-failed'); pending[1].reject(new Error('missing')); await assert.rejects(failed);
  assert.equal(removed.length, 0);
  const stale = select('theme-stale'), fresh = select('theme-dark');
  pending[3].resolve(() => removed.push('dark')); await fresh;
  pending[2].resolve(() => removed.push('stale')); assert.equal(await stale, false);
  assert.deepEqual(applied, ['theme-light', 'theme-dark']);
  const late = select('theme-late'); loader.dispose(); pending[4].resolve(() => removed.push('late')); await late;
  assert.deepEqual(removed, ['light', 'stale', 'dark', 'late']);
});
test('shipped registry registers all existing themes and each resource exists', async () => {
  const registry = parseThemeRegistry(JSON.parse(await readFile('public/themes/themes.json', 'utf8')));
  assert.deepEqual(registry.themes.map((item: RegisteredTheme) => item.id).sort(), ['theme-dark','theme-light','theme-mtf','theme-system']);
  for (const theme of registry.themes) assert.ok((await readFile(`public/themes/${theme.css}`, 'utf8')).trim());
});
