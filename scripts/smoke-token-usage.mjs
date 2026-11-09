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

// Prerequisite: finish npm run build. This script never builds or contacts a real model.
// Usage responses and authenticated identities below are BROWSER FIXTURES, not backend
// authorization evidence. Real permission/storage tests belong to the backend suite.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-token-usage-'));
const data = path.join(temporary, 'data');
const artifacts = path.join(root, 'test-results', 'token-usage');
const modelA = 'smoke-model-alpha';
const modelB = 'smoke-model-beta';
let server;
let browser;
let stage = 'isolated deployment';
const violations = [];
const browserErrors = [];
const consoleErrors = [];
const requestFailures = [];
const expectedFailedPaths = new Set(['/api/admin/token-usage']);
const checks = [];
let activePage;

function metrics(inputTokens = 1200, outputTokens = 800, requests = 4) {
  return {
    requests, succeeded: requests, failed: 0, pending: 0,
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    estimatedRequests: requests ? 1 : 0,
    rpm: { average: requests / 1440, peak: requests },
    tokenPm: { average: (inputTokens + outputTokens) / 1440, peak: inputTokens + outputTokens },
  };
}
function fixture(url, empty = false) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  assert.match(from ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.match(to ?? '', /^\d{4}-\d{2}-\d{2}$/);
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  assert.ok(days >= 1 && days <= 31, 'only valid inclusive UTC ranges reach usage endpoint');
  const selected = url.searchParams.get('model');
  const rows = empty ? [] : selected === modelA
    ? [{ model: modelA, ...metrics(900, 300, 3) }]
    : selected === modelB ? [{ model: modelB, ...metrics(300, 500, 1) }]
      : [{ model: modelA, ...metrics(900, 300, 3) }, { model: modelB, ...metrics(300, 500, 1) }];
  const total = empty ? metrics(0, 0, 0) : selected === modelA ? metrics(900, 300, 3)
    : selected === modelB ? metrics(300, 500, 1) : { ...metrics(), estimatedRequests: 2 };
  const daily = Array.from({ length: days }, (_, index) => ({
    day: new Date(Date.parse(from) + index * 86400000).toISOString().slice(0, 10),
    ...(index === 0 ? total : metrics(0, 0, 0)),
  }));
  return {
    range: { from, to, timeZone: 'UTC' }, windowMinutes: days * 1440,
    models: [modelA, modelB],
    totals: { ...total, rpm: { ...total.rpm, average: total.requests / (days * 1440) },
      tokenPm: { ...total.tokenPm, average: total.totalTokens / (days * 1440) } },
    byModel: rows.map((row) => ({ ...row, rpm: { ...row.rpm, average: row.requests / (days * 1440) },
      tokenPm: { ...row.tokenPm, average: row.totalTokens / (days * 1440) } })),
    daily,
    coverage: {
      startedAt: '2026-01-01T00:00:00.000Z', retentionDays: 31,
      earliestDay: new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) - 30 * 86400000).toISOString().slice(0, 10),
      complete: false,
    },
  };
}
const paint = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

try {
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html']) {
    assert.ok(fs.existsSync(path.join(root, entry)), `Missing ${entry}; finish npm run build first.`);
  }
  // index.js resolves appRoot/.env: cwd and DATA_DIR alone do not isolate deployment.
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({
    name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'],
  }));
  for (const entry of ['build', 'dist']) fs.cpSync(path.join(root, entry), path.join(temporary, entry), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(data);
  fs.mkdirSync(artifacts, { recursive: true });
  assert.equal(fs.existsSync(path.join(temporary, '.env')), false);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(env, { PORT: String(port), DATA_DIR: data, NODE_ENV: 'production', CoreModel: 'local',
    MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '' });
  // Deliberately discard server output rather than risk logging a bootstrap secret.
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], { cwd: temporary, env, stdio: 'ignore' });
  let startupError = false;
  server.on('error', () => { startupError = true; });
  let realSession;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { realSession = await response.json(); break; }
    } catch {}
    if (startupError || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(realSession, 'copied production server starts');
  assert.equal(realSession.enabled, false, 'temporary local server has no real accounts');
  const localStatus = await (await fetch(`${base}/api/admin/status`)).json();
  assert.equal(localStatus.mode, 'local');
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  async function setup({ locale = 'zh-CN', role, noWebGL = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'en-US', serviceWorkers: 'block' });
    const state = { requests: [], mode: 'normal', release: undefined, held: undefined, completed: undefined };
    await context.addInitScript(({ locale, noWebGL }) => {
      localStorage.setItem('novel-locale', locale);
      localStorage.setItem('novel-theme', 'mtf');
      if (noWebGL) Object.defineProperty(window, 'WebGLRenderingContext', { value: undefined, configurable: true });
    }, { locale, noWebGL });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) {
        if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
        // Optional font loads are fulfilled locally; never perform external requests.
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        violations.push('external request blocked');
        return route.abort();
      }
      if (!['GET', 'HEAD'].includes(request.method())) {
        violations.push(`unexpected mutation ${request.method()} ${url.pathname}`);
        return route.abort();
      }
      if (role && url.pathname === '/api/auth/session') return route.fulfill({ json: {
        enabled: true, authenticated: true,
        user: { id: `smoke-${role}`, username: `smoke-${role}`, role, disabled: false, createdAt: '2026-01-01T00:00:00Z' },
        turnstile: { enabled: false, siteKey: '', action: '', hostname: '' },
      } });
      if (role && url.pathname === '/api/admin/status') return route.fulfill({ json: { ...localStatus, mode: 'authenticated', authenticationEnabled: true } });
      if (url.pathname !== '/api/admin/token-usage') return route.continue();
      state.requests.push({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), model: url.searchParams.get('model') });
      if (state.mode === 'error') return route.fulfill({ status: 503, json: { error: 'SMOKE_USAGE_UNAVAILABLE' } });
      const response = fixture(url, state.mode === 'empty');
      if (state.mode === 'race' && url.searchParams.get('model') === modelA) {
        state.held?.();
        await new Promise((resolve) => { state.release = resolve; });
        // Aborted old requests can no longer be fulfilled; either cancellation or
        // client generation checks must keep this older response off the screen.
        try { await route.fulfill({ json: response }); } catch (error) {
          if (!/closed|canceled|cancelled|aborted|Invalid InterceptionId/i.test(String(error))) throw error;
        } finally { state.completed?.(); }
        return;
      }
      return route.fulfill({ json: response });
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(20000);
    page.on('pageerror', () => browserErrors.push('uncaught browser exception'));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        // No raw console payloads: requests may contain credentials in other smoke contexts.
        const text = message.text();
        if (/503|SMOKE_USAGE_UNAVAILABLE/.test(text)) return;
        if (/Content Security Policy/.test(text) && /fonts.googleapis.com/.test(text)) return;
        consoleErrors.push('unexpected browser console error');
      }
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (request.failure()?.errorText.includes('ERR_ABORTED')) return;
      if (url.origin === base && !expectedFailedPaths.has(url.pathname)) requestFailures.push(url.pathname);
    });
    await page.goto(`${base}/projects`);
    await page.waitForFunction((expected) => document.documentElement.lang === expected, locale);
    return { context, page, state };
  }
  async function open(page) {
    await page.getByRole('button', { name: /^(管理控制台|Admin console)$/ }).click();
    const dialog = page.getByRole('dialog', { name: /^(管理控制台|Admin console)$/ });
    const tab = dialog.getByRole('tab', { name: /^(Token 使用统计|Token usage analytics)$/ });
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    const panel = dialog.getByRole('tabpanel', { name: /^(Token 使用统计|Token usage analytics)$/ });
    await panel.getByLabel(/开始日期|Start date/).waitFor();
    return { dialog, panel };
  }
  const table = (panel) => panel.getByRole('table', { name: /按模型统计|Usage by model/ });
  async function expectModels(panel, expected) {
    const body = table(panel).locator('tbody');
    await body.getByRole('row').first().waitFor();
    await activePage.waitForFunction(({ names }) => {
      const target = [...document.querySelectorAll('table')].find((element) => element.textContent.includes('smoke-model-'));
      if (!target) return false;
      const text = target.querySelector('tbody')?.textContent ?? '';
      return names.every((name) => text.includes(name)) && ['smoke-model-alpha', 'smoke-model-beta'].filter((name) => text.includes(name)).length === names.length;
    }, { names: expected });
    assert.equal(await body.getByRole('row').count(), expected.length);
  }
  async function apply(panel, from, to, model = '') {
    await panel.getByLabel(/开始日期|Start date/).fill(from);
    await panel.getByLabel(/结束日期|End date/).fill(to);
    await panel.getByRole('combobox').selectOption(model);
    const button = panel.getByRole('button', { name: /^(查询用量|Apply filters)$/ });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > 31) {
      assert.equal(await button.isDisabled(), true, 'invalid range disables query');
    } else await button.click();
  }
  async function layout(page, dialog, panel, width) {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 1050 });
    await paint(page);
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))); });
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(size.scroll <= size.viewport + 1, `document fits ${width}px`);
    for (const [name, locator] of [['dialog', dialog], ['usage panel', panel]]) {
      const dimensions = await locator.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(dimensions.scroll <= dimensions.width + 1, `${name} contains overflow at ${width}px`);
    }
    for (const input of await panel.locator('input, select, button[type="submit"]').all()) {
      const box = await input.boundingBox();
      assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1, 'filter control within viewport');
    }
  }

  stage = 'Chinese local-admin semantic data and real software WebGL';
  const local = await setup();
  const { dialog, panel } = await open(local.page);
  await expectModels(panel, [modelA, modelB]);
  const modelRows = table(panel).locator('tbody');
  assert.match(await modelRows.innerText(), /1[,\s]?200/);
  const totals = panel.locator('dl');
  for (const [label, value] of [['输入 Token', '1,200'], ['输出 Token', '800'], ['总 Token', '2,000'], ['请求次数', '4']]) {
    const metric = totals.locator('div').filter({ has: local.page.getByText(label, { exact: true }) });
    assert.equal((await metric.locator('dd').innerText()).replaceAll(',', ''), value.replaceAll(',', ''), `semantic total ${label}`);
  }
  const alphaCells = await modelRows.getByRole('row').filter({ hasText: modelA }).locator('td').allTextContents();
  assert.deepEqual(alphaCells.slice(0, 6), ['900', '300', '1,200', '3', '3 / 0 / 0', '1'], 'model row exact source metrics');
  await panel.getByRole('table', { name: /按日统计/ }).waitFor();
  await panel.getByText(/不作为账单依据/).waitFor();
  await panel.getByText(/统计覆盖不保证完整/).waitFor();
  const started = await panel.getByText(/统计起始时间/).innerText();
  assert.equal(started, '统计起始时间：2026:01:01 08:00', 'fixed UTC+8 minute display without timezone suffix');
  assert.ok(!started.includes('UTC') && !started.includes('T00:'), 'no ISO or zone marker in visible timestamp');
  await local.page.waitForFunction(() => document.querySelectorAll('.token-usage-chart canvas').length === 2 || document.querySelectorAll('.token-usage-chart__fallback').length === 2);
  const canvases = panel.locator('.token-usage-chart canvas');
  const canvasCount = await canvases.count();
  if (canvasCount) {
    assert.equal(canvasCount, 2, 'pie and daily bar charts render');
    for (let index = 0; index < canvasCount; index++) {
      const canvas = canvases.nth(index);
      const rendered = await canvas.evaluate((element) => {
        const gl = element.getContext('webgl2') || element.getContext('webgl');
        return { width: element.width, height: element.height, live: !!gl && !gl.isContextLost() };
      });
      assert.ok(rendered.live && rendered.width > 50 && rendered.height > 50, 'actual live WebGL canvas');
      await canvas.screenshot({ path: path.join(artifacts, `zh-chart-${index}.png`) });
    }
  } else {
    assert.equal(await panel.locator('.token-usage-chart__fallback').count(), 2, 'WebGL failure has readable fallback');
  }
  await layout(local.page, dialog, panel, 1440);
  await local.page.screenshot({ path: path.join(artifacts, 'zh-desktop.png'), fullPage: true });
  checks.push(canvasCount ? 'software WebGL canvases captured' : 'runtime WebGL fallback observed (no canvas claim)');

  stage = 'inclusive 31-day boundary, invalid 32-day no-request, model filter';
  await apply(panel, '2026-01-01', '2026-01-31');
  await expectModels(panel, [modelA, modelB]);
  await local.page.waitForFunction(() => [...document.querySelectorAll('tbody')].some((body) => body.textContent.includes('2026:01:31')));
  assert.deepEqual(local.state.requests.at(-1), { from: '2026-01-01', to: '2026-01-31', model: null });
  const beforeInvalid = local.state.requests.length;
  await apply(panel, '2026-01-01', '2026-02-01');
  await panel.getByRole('alert').filter({ hasText: /1–31/ }).waitFor();
  // A bounded negative observation window is intentional, not a readiness sleep.
  await delay(300);
  assert.equal(local.state.requests.length, beforeInvalid, '32 inclusive days rejected before network');
  await apply(panel, '2026-01-01', '2026-01-31', modelA);
  await expectModels(panel, [modelA]);
  assert.equal(local.state.requests.at(-1).model, modelA);
  checks.push('31 days inclusive accepted; 32 rejected without request; model query and rows match');

  stage = 'rapid filter changes do not resurrect old results';
  local.state.mode = 'race';
  const held = new Promise((resolve) => { local.state.held = resolve; });
  const completed = new Promise((resolve) => { local.state.completed = resolve; });
  await apply(panel, '2026-01-02', '2026-01-31', modelA);
  await Promise.race([held, delay(20000).then(() => { throw new Error('older request was not held'); })]);
  assert.equal(await panel.getByRole('button', { name: '查询用量', exact: true }).isDisabled(), true, 'in-flight submit prevents duplicate queries');
  // User can still leave the tab and return while the previous request is pending.
  // This real navigation tests cleanup/abort without artificially enabling a disabled button.
  await dialog.getByRole('tab', { name: '工作台', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Token 使用统计', exact: true }).click();
  await expectModels(panel, [modelA, modelB]);
  await apply(panel, '2026-01-02', '2026-01-31', modelB);
  await expectModels(panel, [modelB]);
  local.state.release();
  await completed;
  await paint(local.page);
  await expectModels(panel, [modelB]);
  checks.push('older delayed model response cannot replace newer results');

  stage = 'empty state, failed request and retry recovery';
  local.state.mode = 'empty';
  await apply(panel, '2026-01-03', '2026-01-31');
  await panel.getByText('此日期范围与模型下暂无调用记录。', { exact: true }).waitFor();
  assert.equal(await panel.locator('tbody').getByText(modelB, { exact: true }).count(), 0, 'empty response clears prior model data');
  local.state.mode = 'error';
  await apply(panel, '2026-01-04', '2026-01-31');
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.locator('dl').count(), 0, 'error state does not present stale totals');
  assert.equal(await panel.getByRole('table').count(), 0, 'error state does not present stale tables');
  local.state.mode = 'normal';
  await panel.getByRole('button', { name: /^(重试|Retry)$/ }).click();
  await expectModels(panel, [modelA, modelB]);
  await layout(local.page, dialog, panel, 390);
  await local.page.screenshot({ path: path.join(artifacts, 'zh-mobile-390.png'), fullPage: true });
  await local.context.close();
  checks.push('empty and error states clear stale data; retry recovers; Chinese 390px geometry');

  stage = 'English semantics, mobile geometry and forced graceful WebGL fallback';
  const english = await setup({ locale: 'en', noWebGL: true });
  const en = await open(english.page);
  await expectModels(en.panel, [modelA, modelB]);
  await en.panel.getByText('Charts unavailable. Equivalent data tables are available below.', { exact: true }).first().waitFor();
  assert.equal(await en.panel.locator('.token-usage-chart canvas').count(), 0);
  assert.equal(await en.panel.locator('.token-usage-chart__fallback').count(), 2);
  await en.panel.getByRole('table', { name: 'Usage by model (equivalent chart data)', exact: true }).waitFor();
  await en.panel.getByRole('table', { name: 'Daily usage (UTC, equivalent chart data)', exact: true }).waitFor();
  await en.panel.getByText(/not a billing statement/).waitFor();
  await layout(english.page, en.dialog, en.panel, 1440);
  await english.page.screenshot({ path: path.join(artifacts, 'en-desktop-fallback.png'), fullPage: true });
  await layout(english.page, en.dialog, en.panel, 390);
  await english.page.screenshot({ path: path.join(artifacts, 'en-mobile-390.png'), fullPage: true });
  await english.context.close();
  checks.push('English desktop/mobile and forced no-WebGL fallback retain equivalent tables');

  stage = 'mock-session frontend role gating (not backend authorization)';
  for (const role of ['admin', 'operations', 'writer']) {
    const fixtureContext = await setup({ role, locale: 'en' });
    const adminButton = fixtureContext.page.getByRole('button', { name: 'Admin console', exact: true });
    if (role === 'writer') {
      await fixtureContext.page.getByText('smoke-writer', { exact: true }).first().waitFor();
      assert.equal(await adminButton.count(), 0, 'writer has no administration entry');
    } else {
      await adminButton.click();
      const modal = fixtureContext.page.getByRole('dialog', { name: 'Admin console', exact: true });
      await modal.getByRole('tab', { name: /^(Overview|Dashboard|Workspace)$/ }).waitFor();
      const tab = modal.getByRole('tab', { name: 'Token usage analytics', exact: true });
      if (role === 'operations') assert.equal(await tab.count(), 0, 'operations role cannot see usage tab');
      else {
        await tab.click();
        await expectModels(modal, [modelA, modelB]);
      }
    }
    if (role !== 'admin') assert.equal(fixtureContext.state.requests.length, 0, 'denied frontend role never requests usage');
    await fixtureContext.context.close();
  }
  checks.push('mocked admin/operations/writer frontend gating only');

  stage = 'read-only and isolation invariants';
  const finalSession = await (await fetch(`${base}/api/auth/session`)).json();
  assert.deepEqual(finalSession, realSession, 'UI fixtures never enable real authentication');
  assert.deepEqual(violations, [], 'no external requests or browser mutation attempts');
  assert.deepEqual(browserErrors, [], 'no uncaught browser exceptions');
  assert.deepEqual(consoleErrors, [], 'no unexpected console errors');
  assert.deepEqual(requestFailures, [], 'no unexpected failed application requests');
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({
    result: 'PASS', checks, backendAuthorizationValidated: false, realModelCalls: false,
    dataIsolation: 'copied build/dist, fresh temporary data, strict environment, new browser contexts',
  }, null, 2));
  console.log(`PASS: ${checks.join('; ')}. Backend authorization is NOT validated by these browser fixtures.`);
  console.log(`Artifacts: ${artifacts}`);
} catch (error) {
  // Never print raw network/console objects, cookies, server logs or environment values.
  console.error(`FAIL [${stage}]: ${error instanceof Error ? error.message : 'unknown smoke failure'}`);
  if (activePage && !activePage.isClosed()) {
    try { await activePage.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true, timeout: 5000 }); } catch {}
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.pid) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('novel-token-usage-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
