import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import NavigationFooter from './NavigationFooter';
import { fallbackAppearance, isNavigationStyle, isSiteAppearance, navigationStyleVariables } from './siteAppearance';
import { navigationEn, navigationZhCN } from '../../locals/navigation';

test('only bounded colors and numeric presentation values reach CSS variables', () => {
  for (const color of ['', '#123456', '#ABCDEF', '#abcdef']) {
    const style = { ...fallbackAppearance.header, backgroundColor: color };
    assert.equal(isNavigationStyle(style), true);
    assert.equal(navigationStyleVariables(style)['--navigation-background' as keyof ReturnType<typeof navigationStyleVariables>], color || 'var(--panel)');
  }
  for (const value of ['red', '#fff', 'url(https://x)', '#123456;display:none', 'var(--x)']) {
    const style = { ...fallbackAppearance.header, textColor: value };
    assert.equal(isNavigationStyle(style), false);
    assert.deepEqual(navigationStyleVariables(style), {});
  }
  for (const fontSize of [11, 25, 12.5, NaN, Infinity]) assert.equal(isNavigationStyle({ ...fallbackAppearance.header, fontSize }), false);
  for (const paddingY of [-1, 33, 2.5]) assert.equal(isNavigationStyle({ ...fallbackAppearance.header, paddingY }), false);
  assert.equal(isSiteAppearance({ ...fallbackAppearance, revision: -1 }), false);
});
test('footer attribution cannot be hidden or overridden and company is separate escaped text', () => {
  const initial = renderToStaticMarkup(createElement(NavigationFooter));
  assert.match(initial, /href="https:\/\/github.com\/wuxinTLH\/novel-agent" target="_blank" rel="noopener noreferrer">© SakuraMikku/);
  assert.doesNotMatch(initial, /navigation-company/);
  const custom = renderToStaticMarkup(createElement(NavigationFooter, { appearance: { ...fallbackAppearance, companyName: '<img onerror=x>' } }));
  assert.match(custom, /© SakuraMikku/);
  assert.match(custom, /navigation-company">© &lt;img onerror=x&gt;/);
});
test('real header owns shell controls, class names and accessible dialogs', () => {
  const source = readFileSync(new URL('./NavigationHeader.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="topbar navigation-header"/);
  for (const name of ['breadcrumbs', 'topbar-right', 'quick-settings', 'save-indicator', 'help-trigger', 'top-avatar-button']) assert.ok(source.includes(name));
  assert.equal((source.match(/aria-haspopup="dialog"/g) || []).length, 2);
  assert.match(source, /\{breadcrumbs\}/);
  assert.match(source, /\{themeControl\}/);
});
test('appearance strings retain exact bilingual key parity', () => {
  assert.deepEqual(Object.keys(navigationZhCN).sort(), Object.keys(navigationEn).sort());
  for (const value of Object.values(navigationEn)) assert.ok(value.trim());
});
test('explicit header colors override theme specificity without erasing inherited theme surfaces', () => {
  const css = readFileSync(new URL('./navigation.scss', import.meta.url), 'utf8');
  const header = readFileSync(new URL('./NavigationHeader.tsx', import.meta.url), 'utf8');
  assert.match(header, /const style = isNavigationStyle\(candidate\) \? candidate : undefined/);
  assert.match(header, /data-custom-background=\{!!style\?\.backgroundColor\}/);
  assert.match(css, /:root \.app-shell \.topbar\.navigation-header\[data-custom-background='true'\] \{ background: var\(--navigation-background\); \}/);
  assert.match(css, /:root \.app-shell \.topbar\.navigation-header\[data-custom-border='true'\]/);
  const general = css.match(/:root \.app-shell \.topbar\.navigation-header \{([^}]+)\}/)?.[1] ?? '';
  assert.doesNotMatch(general, /background:/);
  assert.match(general, /font-size: var\(--navigation-font-size, 14px\)/);
  assert.match(general, /padding-block: var\(--navigation-padding-y, 12px\)/);
});
test('App retains guarded breadcrumb navigation, portal slots and all page-local footers', () => {
  const app = readFileSync(new URL('../../app/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<NavigationHeader[\s\S]*?onSettings=\{\(\) => \{ void navigate\('settings'\)/);
  assert.match(app, /onClick=\{\(\) => void navigate\('projects'\)\}/);
  assert.match(app, /<NavigationFooter \/>\s*<\/main>/);
  assert.match(app, /id="shell-system-settings"/);
  assert.match(app, /className="page-footer"/);
});
