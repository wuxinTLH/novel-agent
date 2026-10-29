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
  const registry = parseThemeRegistry(JSON.parse(await readFile(new URL('../../../../../public/themes/themes.json', import.meta.url), 'utf8')));
  assert.deepEqual(registry.themes.map((item: RegisteredTheme) => item.id).sort(), ['theme-dark','theme-light','theme-mtf','theme-system']);
  for (const theme of registry.themes) assert.ok((await readFile(new URL(`../../../../../public/themes/${theme.css}`, import.meta.url), 'utf8')).trim());
});
test('MTF palette keeps flag colors, scoped gradients and dark readable controls', async () => {
  const css = await readFile(new URL('../../../../../public/themes/theme-mtf.css', import.meta.url), 'utf8');
  for (const color of ['#5bcefa', '#f5a9b8', '#ffffff']) assert.ok(css.includes(color), `missing ${color}`);
  for (const selector of ['body', '.sidebar', '.topbar', '.project-strip', '.workflow-node', '.primary']) {
    assert.ok(css.includes(`:root[data-theme='theme-mtf'] ${selector}`), `missing ${selector}`);
  }
  assert.match(css, /background: linear-gradient\(122deg,[^;]+var\(--mtf-white\)/);
  assert.match(css, /:root\[data-theme='theme-mtf'\] \.primary,[\s\S]*?background: linear-gradient\(105deg, var\(--mtf-blue\)[^;]+var\(--mtf-white\) 50%[^;]+var\(--mtf-pink\) 100%\);\s*color: #25364d;/);
  for (const state of [':hover:not(:disabled)', ':active:not(:disabled)', ':focus-visible', ':disabled']) {
    assert.ok(css.includes(`.primary${state}`), `missing primary state ${state}`);
  }
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  const contrast = (foreground: string, background: string) => {
    const luminance = (hex: string) => {
      const channels = hex.match(/[0-9a-f]{2}/gi)!.map((v) => parseInt(v, 16) / 255);
      const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  assert.ok(contrast('#25364d', '#ffffff') >= 4.5, 'main text must remain readable on cards');
  for (const background of ['#5bcefa', '#d9f3ff', '#ffffff', '#ffe5ed', '#f5a9b8', '#79d8fb', '#e5f7ff', '#ffedf3', '#f7bac7']) {
    assert.ok(contrast('#25364d', background) >= 4.5, `button label must remain readable on ${background}`);
  }
});
