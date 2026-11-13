import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Run ONLY after the parent authorizes browser validation of the FINAL build/dist.
// No build, live .env/data, real accounts, model calls or platform writes are used.
// Role sessions below are frontend fixtures, NOT backend authorization evidence.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-site-appearance-'));
const data = path.join(temporary, 'data');
const artifacts = path.join(root, 'test-results', path.basename(temporary));
const defaults = () => ({ backgroundColor: '', textColor: '', accentColor: '', borderColor: '', fontSize: 14, paddingY: 16 });
const initial = { version: 1, revision: 0, companyName: '', header: defaults(), footer: defaults() };
const company = '<img src=x onerror=window.__appearanceExecuted=1> Synthetic Co';
const draft = {
  companyName: company,
  header: { backgroundColor: '#112233', textColor: '#ddeeff', accentColor: '#aabbcc', borderColor: '#334455', fontSize: 17, paddingY: 19 },
  footer: { backgroundColor: '#221133', textColor: '#ffeedd', accentColor: '#ccbbaa', borderColor: '#554433', fontSize: 13, paddingY: 7 },
};
const violations = [], pageErrors = [], consoleErrors = [], requestFailures = [], checks = [];
let server, browser, activePage, base, env;
let stage = 'isolated deployment';
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const tabName = /^(站点外观|Site appearance)$/;
const adminName = /^(管理控制台|Admin console)$/;

async function stopServer() {
  if (server && server.exitCode === null && server.pid) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
async function startServer() {
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], { cwd: temporary, env, stdio: 'ignore' });
  let startupError = false;
  server.on('error', () => { startupError = true; });
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch {}
    if (startupError || server.exitCode !== null) break;
    await delay(100);
  }
  assert.fail('copied production server did not start');
}
async function readAppearance() {
  const response = await fetch(`${base}/api/site-appearance`);
  assert.equal(response.status, 200, 'public appearance GET succeeds');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return response.json();
}
async function putAppearance(value) {
  const session = await fetch(`${base}/api/admin/session`).then(response => response.json());
  assert.equal(session.mode, 'local');
  return fetch(`${base}/api/admin/site-appearance`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-csrf': session.csrfToken, Origin: base },
    body: JSON.stringify(value),
  });
}
async function open(page) {
  await page.getByRole('button', { name: adminName }).click();
  const dialog = page.getByRole('dialog', { name: adminName });
  const tab = dialog.getByRole('tab', { name: tabName });
  await tab.click();
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  const panel = dialog.getByRole('tabpanel', { name: tabName });
  await panel.getByTestId('appearance-company').waitFor();
  return { dialog, panel };
}
const companyInput = panel => panel.getByTestId('appearance-company');
const saveButton = panel => panel.getByRole('button', { name: /^(保存外观|Save appearance)$/ });
const reloadButton = panel => panel.getByRole('button', { name: /^(重新载入外观|Reload appearance)$/ });
async function fillDraft(panel, value) {
  await companyInput(panel).fill(value.companyName);
  for (const section of ['header', 'footer']) {
    for (const key of ['backgroundColor', 'textColor', 'accentColor', 'borderColor', 'fontSize', 'paddingY'])
      await panel.getByTestId(`appearance-${section}-${key}`).fill(String(value[section][key]));
  }
  await panel.page().waitForFunction(value => {
    const keys = { backgroundColor: '--navigation-background', textColor: '--navigation-text', accentColor: '--navigation-accent', borderColor: '--navigation-border', fontSize: '--navigation-font-size', paddingY: '--navigation-padding-y' };
    if (document.querySelector('[data-testid="appearance-company"]')?.value !== value.companyName) return false;
    return ['header', 'footer'].every(section => {
      const preview = document.querySelector(`[data-testid="appearance-preview-${section}"]`);
      return preview && Object.entries(keys).every(([key, property]) => {
        const expected = String(value[section][key]);
        const input = document.querySelector(`[data-testid="appearance-${section}-${key}"]`);
        const cssValue = ['fontSize', 'paddingY'].includes(key) ? `${expected}px` : expected;
        return input?.value === expected && preview.style.getPropertyValue(property).trim().toLowerCase() === cssValue.toLowerCase();
      });
    });
  }, value);
}
async function attribution(footer) {
  const link = footer.getByRole('link', { name: '© SakuraMikku', exact: true });
  await link.waitFor({ state: 'visible' });
  assert.equal(await link.count(), 1, 'mandatory author attribution appears exactly once per footer');
  assert.equal(await link.getAttribute('href'), 'https://github.com/wuxinTLH/novel-agent');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.deepEqual((await link.getAttribute('rel')).split(/\s+/).sort(), ['noopener', 'noreferrer']);
}
async function styles(locator, expected) {
  // React commits and theme/CSS application may finish after input events. Wait for
  // the exact final computed values, never accept an intermediate or fallback style.
  let settleError;
  const handle = await locator.elementHandle();
  assert.ok(handle, 'style target exists');
  try {
    await locator.page().waitForFunction(({ element, expected }) => {
      const css = getComputedStyle(element);
      const rgb = hex => `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
      return css.backgroundColor === rgb(expected.backgroundColor) && css.color === rgb(expected.textColor) &&
        css.borderTopColor === rgb(expected.borderColor) && css.fontSize === `${expected.fontSize}px` &&
        css.paddingTop === `${expected.paddingY}px` && css.paddingBottom === `${expected.paddingY}px` &&
        css.getPropertyValue('--navigation-accent').trim().toLowerCase() === expected.accentColor;
    }, { element: handle, expected }, { timeout: 5000 });
  } catch (error) { settleError = error; }
  finally { await handle.dispose(); }
  const actual = await locator.evaluate(element => {
    const css = getComputedStyle(element);
    const matchedRules = [];
    const visit = (rules, ancestry = []) => {
      for (const rule of rules) {
        if (rule.selectorText && rule.style && element.matches(rule.selectorText)) {
          const properties = ['background', 'background-color', 'background-image', 'color', 'border', 'border-color', 'border-top', 'border-top-color', 'font-size', 'font', 'padding', 'padding-block', 'padding-top', '--navigation-background', '--navigation-text', '--navigation-border', '--navigation-accent', '--navigation-font-size', '--navigation-padding-y'];
          const declarations = Object.fromEntries(properties.filter(key => rule.style.getPropertyValue(key)).map(key => [key, `${rule.style.getPropertyValue(key)}${rule.style.getPropertyPriority(key) ? ' !important' : ''}`]));
          if (Object.keys(declarations).length) matchedRules.push({ selector: rule.selectorText, ancestry, declarations });
        }
        if (rule.cssRules) {
          if (rule.type === CSSRule.MEDIA_RULE && !matchMedia(rule.conditionText).matches) continue;
          if (rule.constructor.name === 'CSSSupportsRule' && !CSS.supports(rule.conditionText)) continue;
          visit(rule.cssRules, [...ancestry, `${rule.constructor.name}${rule.name ? ` ${rule.name}` : ''}${rule.conditionText ? ` ${rule.conditionText}` : ''}`]);
        }
      }
    };
    for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch { /* cross-origin styles remain unreadable */ } }
    return { backgroundColor: css.backgroundColor, textColor: css.color, borderColor: css.borderTopColor,
      fontSize: css.fontSize, paddingY: css.paddingTop, paddingBottom: css.paddingBottom,
      accentColor: css.getPropertyValue('--navigation-accent').trim(),
      diagnostic: { tag: element.tagName, testId: element.getAttribute('data-testid'), className: element.className,
        inlineStyle: element.getAttribute('style'), navigationFontSize: css.getPropertyValue('--navigation-font-size').trim(),
        navigationBackground: css.getPropertyValue('--navigation-background').trim(), navigationText: css.getPropertyValue('--navigation-text').trim(),
        navigationBorder: css.getPropertyValue('--navigation-border').trim(), navigationAccent: css.getPropertyValue('--navigation-accent').trim(),
        navigationPaddingY: css.getPropertyValue('--navigation-padding-y').trim(), matchedRules } };
  });
  const rgb = hex => `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
  const { diagnostic: elementDiagnostic, ...computed } = actual;
  const diagnostic = JSON.stringify({ ...elementDiagnostic, computed, settleTimedOut: !!settleError });
  assert.equal(actual.backgroundColor, rgb(expected.backgroundColor), `backgroundColor must match draft; ${diagnostic}`);
  assert.equal(actual.textColor, rgb(expected.textColor), `textColor must match draft; ${diagnostic}`);
  assert.equal(actual.borderColor, rgb(expected.borderColor), `borderColor must match draft; ${diagnostic}`);
  assert.equal(actual.fontSize, `${expected.fontSize}px`, `fontSize must match draft; ${diagnostic}`);
  assert.equal(actual.paddingY, `${expected.paddingY}px`, `paddingTop must match draft; ${diagnostic}`);
  assert.equal(actual.paddingBottom, `${expected.paddingY}px`, `paddingBottom must match draft; ${diagnostic}`);
  assert.equal(actual.accentColor.toLowerCase(), expected.accentColor, `accentColor must match draft; ${diagnostic}`);
}
async function shell(page, value) {
  const header = page.locator('.navigation-header').first();
  const footer = page.locator('.navigation-footer').first();
  await attribution(footer);
  await page.waitForFunction(company => document.querySelector('.navigation-footer .navigation-company')?.textContent === `© ${company}`, value.companyName);
  assert.equal(await footer.locator('img, script').count(), 0, 'company HTML stays literal');
  assert.equal(await page.evaluate(() => window.__appearanceExecuted), undefined);
  await styles(header, value.header);
  assert.equal(await header.evaluate(element => getComputedStyle(element).backgroundImage), 'none', 'explicit saved header background replaces theme gradient');
  await styles(footer, value.footer);
}
async function layout(page, dialog, panel, locale) {
  await page.setViewportSize({ width: 390, height: 844 });
  await paint(page);
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
  assert.ok(size.scroll <= size.width + 1, `${locale}: document fits 390px`);
  for (const [name, locator] of [['header', page.locator('.navigation-header').first()], ['footer', page.locator('.navigation-footer').first()], ['dialog', dialog], ['panel', panel]]) {
    const size = await locator.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(size.scroll <= size.client + 1, `${locale}: ${name} has no horizontal overflow`);
  }
  for (const control of await panel.locator('input, select, button').all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= 391, `${locale}: editor control fits viewport`);
  }
  await page.screenshot({ path: path.join(artifacts, `${locale}-390.png`), fullPage: true });
}

try {
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html'])
    assert.ok(fs.existsSync(path.join(root, entry)), `Missing ${entry}; finish final build first.`);
  // appRoot resolves .env; merely changing cwd and DATA_DIR is insufficient isolation.
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }));
  for (const entry of ['build', 'dist']) fs.cpSync(path.join(root, entry), path.join(temporary, entry), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(data);
  fs.mkdirSync(artifacts, { recursive: true });
  assert.equal(fs.existsSync(path.join(temporary, '.env')), false);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(env, { PORT: String(port), DATA_DIR: data, NODE_ENV: 'production', CoreModel: 'local', MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '' });
  const realSession = await startServer();
  assert.equal(realSession.enabled, false, 'fresh temporary local deployment has no real accounts');
  assert.deepEqual(await readAppearance(), initial, 'real public API defaults');
  const localStatus = await fetch(`${base}/api/admin/status`).then(response => response.json());
  browser = await chromium.launch({ headless: true });

  async function setup(locale = 'zh-CN', role) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const state = { puts: [], adminReads: 0, expected409: 0 };
    await context.addInitScript(locale => {
      localStorage.setItem('novel-locale', locale);
      localStorage.setItem('novel-theme', 'mtf');
    }, locale);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) {
        if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname))
          return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        violations.push('external request blocked');
        return route.abort();
      }
      if (role && url.pathname === '/api/auth/session') return route.fulfill({ json: {
        enabled: true, authenticated: true,
        user: { id: `smoke-${role}`, username: `smoke-${role}`, role, disabled: false, createdAt: '2026-01-01T00:00:00Z' },
        turnstile: { enabled: false, siteKey: '', action: '', hostname: '' },
      } });
      if (role && url.pathname === '/api/admin/status') return route.fulfill({ json: { ...localStatus, mode: 'authenticated', authenticationEnabled: true } });
      if (url.pathname === '/api/admin/site-appearance') {
        if (request.method() === 'GET') state.adminReads++;
        if (request.method() === 'PUT' && !role) {
          const body = request.postDataJSON();
          assert.deepEqual(Object.keys(body).sort(), ['companyName', 'expectedRevision', 'footer', 'header']);
          state.puts.push(body);
          return route.continue(); // Only this one real mutation reaches disposable local data.
        }
      }
      if (!['GET', 'HEAD'].includes(request.method())) {
        violations.push(`unexpected mutation ${request.method()} ${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(20000);
    page.on('pageerror', () => pageErrors.push('uncaught browser exception'));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/Content Security Policy/.test(text) && /https:\/\/fonts.googleapis.com\//.test(text)) return;
      if (state.expected409 > 0 && message.location().url === `${base}/api/admin/site-appearance` && /^Failed to load resource: the server responded with a status of 409\b/.test(text)) { state.expected409--; return; }
      consoleErrors.push('unexpected browser console error');
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.hostname === 'fonts.googleapis.com' && request.failure()?.errorText === 'csp') return;
      if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
      requestFailures.push(url.pathname);
    });
    await page.goto(`${base}/projects`);
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    await page.locator('.navigation-footer').first().waitFor();
    return { context, page, state };
  }

  stage = 'default footer and preserved shell controls';
  const local = await setup();
  const footer = local.page.locator('.navigation-footer').first();
  await attribution(footer);
  assert.equal(await footer.locator('.navigation-company').count(), 0, 'default company copyright is absent');
  const header = local.page.locator('.navigation-header').first();
  await local.page.waitForFunction(() => {
    const header = document.querySelector('.navigation-header');
    return header && getComputedStyle(header).backgroundImage.includes('gradient(');
  }, undefined, { timeout: 5000 });
  const themeGradient = await header.evaluate(element => getComputedStyle(element).backgroundImage);
  assert.match(themeGradient, /gradient\(/, 'empty default header color preserves theme gradient');
  const language = header.getByRole('button', { name: /^(语言|Language):/ });
  await language.click();
  await header.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await local.page.waitForFunction(() => document.documentElement.lang === 'en');
  await header.getByRole('button', { name: /^Language:/ }).click();
  await header.getByRole('menuitemradio', { name: '中文', exact: true }).click();
  await local.page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await header.getByRole('button', { name: /^(主题|Theme)\s*·/ }).click();
  await header.getByRole('menu').waitFor();
  await header.getByRole('button', { name: /^(主题|Theme)\s*·/ }).click();
  checks.push('default no company; exact mandatory author link; existing language and theme controls');

  stage = 'draft preview and real isolated save';
  let { dialog, panel } = await open(local.page);
  assert.equal(local.state.puts.length, 0, 'opening does not save');
  await fillDraft(panel, draft);
  // Preview is local-only: style drafts must not update the public API before Save.
  const previewHeader = panel.getByTestId('appearance-preview-header');
  const previewFooter = panel.getByTestId('appearance-preview-footer');
  await previewHeader.waitFor();
  await attribution(previewFooter);
  await styles(previewHeader, draft.header);
  await styles(previewFooter, draft.footer);
  assert.ok((await previewFooter.innerText()).includes(company), 'preview renders company as literal text');
  assert.equal(await panel.locator('.appearance-preview img, .appearance-preview script').count(), 0);
  assert.equal(await local.page.evaluate(() => window.__appearanceExecuted), undefined);
  assert.deepEqual(await readAppearance(), initial, 'editing preview does not persist');
  assert.equal(await header.evaluate(element => getComputedStyle(element).backgroundImage), themeGradient, 'unsaved preview preserves live header theme gradient');
  const savedResponse = local.page.waitForResponse(response => response.url() === `${base}/api/admin/site-appearance` && response.request().method() === 'PUT');
  await saveButton(panel).click();
  assert.equal((await savedResponse).status(), 200);
  const saved = { version: 1, revision: 1, ...draft };
  assert.deepEqual(await readAppearance(), saved);
  assert.deepEqual(local.state.puts, [{ expectedRevision: 0, ...draft }]);
  await shell(local.page, saved);
  checks.push('local-only safe HTML preview; independent header/footer colors/font/padding; real temporary backend save');

  stage = 'reload persistence and real competing revision conflict';
  await local.page.reload();
  await shell(local.page, saved);
  ({ dialog, panel } = await open(local.page));
  assert.equal(await companyInput(panel).inputValue(), company);
  await companyInput(panel).fill('Stale browser draft must not overwrite');
  const competing = { ...draft, companyName: 'Newer competing administrator' };
  const competingResponse = await putAppearance({ expectedRevision: 1, ...competing });
  assert.equal(competingResponse.status, 200);
  const winner = await competingResponse.json();
  local.state.expected409++;
  const conflict = local.page.waitForResponse(response => response.url() === `${base}/api/admin/site-appearance` && response.request().method() === 'PUT');
  await saveButton(panel).click();
  assert.equal((await conflict).status(), 409, 'stale UI save reaches real CAS conflict');
  await panel.getByRole('alert').waitFor();
  assert.deepEqual(await readAppearance(), winner, '409 never overwrites newer settings');
  const putCount = local.state.puts.length;
  assert.equal(await saveButton(panel).isDisabled(), true, '409 disables save until explicit refresh');
  assert.equal(await companyInput(panel).inputValue(), 'Stale browser draft must not overwrite', '409 retains edits');
  await reloadButton(panel).click();
  const confirmation = local.page.getByRole('alertdialog');
  await confirmation.getByRole('button', { name: /^(确定|Confirm|OK)$/ }).click();
  await local.page.waitForFunction(company => document.querySelector('[data-testid="appearance-company"]')?.value === company, winner.companyName);
  assert.equal(await companyInput(panel).inputValue(), winner.companyName);
  assert.equal(local.state.puts.length, putCount, 'conflict refresh is read-only');
  await layout(local.page, dialog, panel, 'zh-CN');
  await local.context.close();
  await stopServer();
  const restartedSession = await startServer();
  assert.deepEqual(restartedSession, realSession);
  assert.deepEqual(await readAppearance(), winner, 'appearance persists across actual server restart');
  checks.push('browser reload and server restart persistence; real 409 no overwrite; explicit refresh reads winning revision');

  stage = 'English mobile layout';
  const english = await setup('en');
  await shell(english.page, winner);
  const englishEditor = await open(english.page);
  await layout(english.page, englishEditor.dialog, englishEditor.panel, 'en');
  await english.context.close();
  checks.push('zh-CN/en 390px shell and admin panel without horizontal overflow');

  stage = 'mocked role frontend visibility only';
  for (const role of ['writer', 'operations', 'admin', 'superadmin']) {
    const fixture = await setup('en', role);
    const button = fixture.page.getByRole('button', { name: adminName });
    if (role === 'writer') assert.equal(await button.count(), 0, 'writer has no admin entry');
    else {
      await button.click();
      const modal = fixture.page.getByRole('dialog', { name: adminName });
      await modal.getByRole('tab').first().waitFor();
      const tab = modal.getByRole('tab', { name: tabName });
      if (role === 'operations') assert.equal(await tab.count(), 0, 'operations cannot customize appearance');
      else {
        await tab.click();
        await companyInput(modal).waitFor();
        assert.ok(fixture.state.adminReads > 0, `${role} can read editor`);
      }
    }
    if (['writer', 'operations'].includes(role)) assert.equal(fixture.state.adminReads, 0, 'denied frontend role never requests admin appearance');
    assert.equal(fixture.state.puts.length, 0);
    await fixture.context.close();
  }
  checks.push('mocked writer/operations hidden and admin/superadmin visible: FRONTEND GATING ONLY');

  stage = 'isolation and browser diagnostics';
  assert.deepEqual(await readAppearance(), winner, 'layout and role checks do not mutate saved appearance');
  assert.deepEqual(await fetch(`${base}/api/auth/session`).then(response => response.json()), realSession);
  assert.deepEqual(violations, [], 'all external network blocked; no unexpected mutation');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  assert.deepEqual(consoleErrors, [], 'no unexpected console errors');
  assert.deepEqual(requestFailures, [], 'no unexpected request failures');
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({
    result: 'PASS', checks, backendAuthorizationValidated: false, backendPersistenceValidated: true,
    realModelCalls: false, platformWrites: false, dataIsolation: 'copied build/dist; fresh temporary data; OS environment whitelist; disposable browser contexts',
  }, null, 2));
  console.log(`PASS: ${checks.join('; ')}. Mocked roles are NOT backend authorization evidence.`);
  console.log(`Artifacts: ${artifacts}`);
} catch (error) {
  // Never print server logs, raw console/network objects, cookies or environment.
  console.error(`FAIL [${stage}]: ${error instanceof Error ? error.message : 'unknown smoke failure'}`);
  if (activePage && !activePage.isClosed()) {
    try { await activePage.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true, timeout: 5000 }); } catch {}
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await stopServer();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('novel-site-appearance-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
