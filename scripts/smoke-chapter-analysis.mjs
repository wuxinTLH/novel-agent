import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Run only after the parent authorizes browser validation and completes build/dist.
// No build is performed here. Browser analysis/model responses are synthetic frontend
// fixtures, NOT evidence of backend authentication, authorization, or model execution.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chapter-analysis-'));
const artifacts = path.join(root, 'test-results', path.basename(temporary));
const timestamp = '2026-01-01T00:00:00.000Z';
const modelId = 'analysis-smoke-model';
const payload = '<script>window.__analysisExecuted = true</script><img src=x onerror="window.__analysisExecuted = true">';
const reportText = `SYNTHETIC ANALYSIS REPORT\n${payload}\n${'Long synthetic report line, no real manuscript. '.repeat(35)}\nEND OF ANALYSIS`;
const violations = [], pageErrors = [], consoleErrors = [], requestFailures = [], expectedConsoleErrors = [], fontBaseline = [], checks = [];
let server, browser, page;
let stage = 'isolated deployment';
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const isFont = url => url.protocol === 'https:' && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);

try {
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html'])
    assert.ok(fs.existsSync(path.join(root, entry)), `Missing ${entry}; build before running this smoke.`);
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }));
  for (const entry of ['build', 'dist']) fs.cpSync(path.join(root, entry), path.join(temporary, entry), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data);
  fs.mkdirSync(artifacts, { recursive: true });
  assert.equal(fs.existsSync(path.join(temporary, '.env')), false);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(env, { PORT: String(port), DATA_DIR: data, NODE_ENV: 'production', CoreModel: 'local', MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '' });
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
  assert.ok(realSession, 'copied server starts');
  assert.equal(realSession.enabled, false, 'fresh temporary deployment has no real accounts');
  // Only this disposable project template is persisted. All browser mutations below
  // are intercepted; neither analyses nor model configuration reach the server.
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
    body: JSON.stringify({ title: 'Synthetic analysis alpha', genre: '奇幻', description: 'Disposable synthetic UI fixture.' }),
  });
  assert.equal(created.ok, true);
  const template = await created.json();
  const chapters = Array.from({ length: 4 }, (_, index) => ({
    id: `analysis-chapter-${index + 1}`, number: index + 1, title: `Synthetic chapter ${index + 1}`,
    content: `Synthetic saved body ${index + 1}.`, revision: index + 2, mode: 'demo', updatedAt: timestamp, revisions: [],
  }));
  const projectA = { ...template, chapters, candidates: [], run: undefined };
  const projectB = { ...projectA, id: 'analysis-project-beta', title: 'Synthetic analysis beta' };
  const originals = JSON.stringify(chapters);
  const sources = selected => selected.map(({ id, number, title, revision, content }) => ({ id, number, title, revision, hash: createHash('sha256').update(content).digest('hex') }));
  const makeRecord = (overrides = {}) => ({
    id: randomUUID(), requestId: randomUUID(), selection: { kind: 'recent', count: 1 }, status: 'done', modelId,
    modelName: 'Synthetic analysis model', createdAt: timestamp, completedAt: '2026-01-01T00:01:00.000Z',
    sourceChapters: sources(chapters.slice(-1)), report: reportText, ...overrides,
  });
  const history = makeRecord({ report: 'OLDER SYNTHETIC REPORT — independent stored result' });
  const betaHistory = makeRecord({ report: 'BETA PROJECT ONLY REPORT' });
  const settings = {
    baseUrl: 'https://invalid.example', model: 'synthetic-model', hasKey: true, mode: 'live', activeModelId: modelId,
    models: [
      { id: modelId, name: 'Synthetic analysis model', baseUrl: 'https://invalid.example', model: 'synthetic-model', protocol: 'responses', enabled: true, hasKey: true, createdAt: timestamp },
      { id: 'unavailable-model', name: 'Unavailable synthetic model', baseUrl: 'https://invalid.example', model: 'unavailable', protocol: 'responses', enabled: false, hasKey: false, createdAt: timestamp },
    ],
  };
  browser = await chromium.launch({ headless: true });

  async function setup(locale = 'zh-CN') {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const state = { posts: [], gets: 0, records: [history], outcome: 'done', runningReads: 0, holdPost: undefined, holdGet: undefined, expectedHttpErrors: 0, expectedAborts: new Set() };
    await context.addInitScript(({ locale, projectId }) => {
      localStorage.setItem('novel-locale', locale);
      localStorage.setItem('novel-project', projectId);
      localStorage.setItem('novel-page', 'chapters');
      localStorage.setItem('novel-theme', 'mtf');
    }, { locale, projectId: projectA.id });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) {
        if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
        if (isFont(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        violations.push(`external ${url.origin}${url.pathname}`);
        return route.abort();
      }
      const method = request.method();
      const analysisMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/chapter-analyses$/);
      if (analysisMatch) {
        assert.ok([projectA.id, projectB.id].includes(analysisMatch[1]), 'analysis belongs to known synthetic project');
        if (method === 'POST') {
          const body = request.postDataJSON();
          state.posts.push(body);
          assert.deepEqual(Object.keys(body).sort(), ['modelId', 'requestId', 'selection']);
          assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
          assert.equal(body.modelId, modelId);
          if (state.holdPost) { state.holdPost.seen.resolve(); await state.holdPost.release.promise; }
          if (state.outcome === 'unknown') {
            state.expectedHttpErrors++;
            return route.fulfill({ status: 503, json: { error: 'SYNTHETIC_SUBMISSION_UNKNOWN' } });
          }
          const selected = body.selection.kind === 'range'
            ? chapters.filter(chapter => chapter.number >= body.selection.from && chapter.number <= body.selection.to)
            : chapters.slice(-body.selection.count);
          const running = makeRecord({ ...body, status: 'running', completedAt: undefined, report: undefined, sourceChapters: sources(selected) });
          state.records = [running, ...state.records];
          state.runningReads = 0;
          return route.fulfill({ status: 202, json: running });
        }
        assert.equal(method, 'GET');
        state.gets++;
        if (state.holdGet && analysisMatch[1] === projectA.id) {
          const hold = state.holdGet;
          state.holdGet = undefined;
          state.expectedAborts.add(request.url());
          hold.seen.resolve();
          await hold.release.promise;
          try { await route.fulfill({ json: [makeRecord({ report: 'STALE ALPHA RESPONSE MUST NEVER DISPLAY' })] }); }
          catch (error) { if (!/closed|cancelled|canceled|aborted|Invalid InterceptionId/i.test(String(error))) throw error; }
          finally { hold.done.resolve(); }
          return;
        }
        if (analysisMatch[1] === projectB.id) return route.fulfill({ json: [betaHistory] });
        if (state.records[0]?.status === 'running' && ++state.runningReads >= 3) {
          state.records[0] = { ...state.records[0], status: state.outcome === 'error' ? 'error' : 'done', completedAt: '2026-01-01T00:01:00.000Z',
            ...(state.outcome === 'error' ? { errorCode: 'MODEL_UNAVAILABLE' } : { report: reportText }) };
        }
        return route.fulfill({ json: state.records });
      }
      if (!['GET', 'HEAD'].includes(method)) {
        violations.push(`unexpected mutation ${method} ${url.pathname}`);
        return route.abort();
      }
      if (url.pathname === '/api/settings') return route.fulfill({ json: settings });
      if (url.pathname === '/api/projects') return route.fulfill({ json: [projectA, projectB] });
      if (url.pathname === `/api/projects/${projectA.id}`) return route.fulfill({ json: projectA });
      if (url.pathname === `/api/projects/${projectB.id}`) return route.fulfill({ json: projectB });
      if (/\/api\/.*(?:models|generation|platforms\/[^/]+\/|publication)/.test(url.pathname) && url.pathname !== '/api/platforms/session') {
        violations.push(`unexpected integration read ${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const current = await context.newPage();
    page = current;
    current.setDefaultTimeout(20000);
    current.on('pageerror', error => pageErrors.push(error.message));
    current.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // Only the pre-existing Google Fonts stylesheet CSP baseline is allowed.
      if (text.includes('https://fonts.googleapis.com/') && /Content Security Policy/.test(text) && /stylesheet|style-src/.test(text)) { fontBaseline.push('Google Fonts stylesheet CSP'); return; }
      const location = message.location().url;
      if (state.expectedHttpErrors > 0 && location === `${base}/api/projects/${projectA.id}/chapter-analyses` && /^Failed to load resource: the server responded with a status of 503\b/.test(text)) {
        state.expectedHttpErrors--; expectedConsoleErrors.push('explicit synthetic 503 submission'); return;
      }
      consoleErrors.push({ text, location });
    });
    current.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2' && request.failure()?.errorText === 'csp') { fontBaseline.push('Google Fonts /css2 CSP request failure'); return; }
      if (state.expectedAborts.has(request.url()) && request.failure()?.errorText === 'net::ERR_ABORTED') return;
      requestFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText });
    });
    await current.goto(base);
    await current.getByRole('button', { name: /^(章节解析|Chapter analysis)$/ }).waitFor();
    return { context, page: current, state };
  }
  async function open(current) {
    await current.getByRole('button', { name: /^(章节解析|Chapter analysis)$/ }).click();
    const dialog = current.getByRole('dialog', { name: /^(章节解析|Chapter analysis)$/ });
    await dialog.getByRole('combobox', { name: /^(解析历史|Analysis history)/ }).locator('option').filter({ hasText: 'Synthetic analysis model' }).first().waitFor({ state: 'attached' });
    await current.waitForFunction(() => !document.querySelector('.chapter-analysis-form button[type="submit"]')?.disabled);
    return dialog;
  }
  const start = dialog => dialog.getByRole('button', { name: /^(开始解析|Start analysis)$/ });
  const report = dialog => dialog.locator('.chapter-analysis-report pre');
  async function waitReport(current, dialog, text) {
    await current.waitForFunction(text => document.querySelector('.chapter-analysis-report pre')?.textContent.includes(text), text);
    assert.match(await report(dialog).innerText(), new RegExp(text));
  }
  async function layout(current, dialog, name) {
    await current.setViewportSize({ width: 390, height: 844 });
    await paint(current);
    const geometry = await current.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(geometry.document <= 391, `${name}: document fits 390px`);
    for (const locator of [dialog, dialog.locator('.chapter-analysis-panel'), dialog.locator('.chapter-analysis-report')]) {
      const size = await locator.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(size.scroll <= size.client + 1, `${name}: panel contains horizontal overflow`);
    }
    for (const control of await dialog.locator('input, select, button').all()) {
      const box = await control.boundingBox();
      assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= 391, `${name}: control fits viewport`);
    }
    await current.screenshot({ path: path.join(artifacts, `${name}-390.png`), fullPage: true });
    await report(dialog).scrollIntoViewIfNeeded();
    await report(dialog).focus();
    assert.equal(await report(dialog).evaluate(element => element === document.activeElement), true, `${name}: report is keyboard reachable`);
    await current.screenshot({ path: path.join(artifacts, `${name}-390-report.png`) });
  }

  stage = 'explicit range, duplicate click, polling, revision snapshot and safe report';
  const local = await setup();
  assert.equal(local.state.posts.length, 0, 'mount does not POST');
  const dialog = await open(local.page);
  assert.equal(local.state.posts.length, 0, 'opening history does not POST');
  await dialog.getByRole('combobox', { name: /^解析范围/ }).selectOption('range');
  await dialog.getByLabel('起始章号').fill('2');
  await dialog.getByLabel('结束章号').fill('3');
  await dialog.getByRole('combobox', { name: /^解析模型/ }).selectOption(modelId);
  assert.equal(await dialog.getByRole('combobox', { name: /^解析模型/ }).locator('option[value="unavailable-model"]').count(), 0);
  const postGate = { seen: deferred(), release: deferred() };
  local.state.holdPost = postGate;
  await start(dialog).evaluate(button => { button.click(); button.click(); });
  await postGate.seen.promise;
  assert.equal(await dialog.locator('button[type="submit"]').isDisabled(), true);
  assert.equal(local.state.posts.length, 1, 'double click yields exactly one POST');
  postGate.release.resolve();
  local.state.holdPost = undefined;
  await dialog.getByRole('status').filter({ hasText: /^解析中$/ }).waitFor();
  await waitReport(local.page, dialog, 'END OF ANALYSIS');
  assert.deepEqual(local.state.posts[0].selection, { kind: 'range', from: 2, to: 3 });
  assert.ok(local.state.gets >= 3, 'running result is polled to completion');
  assert.match(await dialog.locator('.chapter-analysis-report ul').innerText(), /第 2 章 · 修订 v3/);
  assert.match(await dialog.locator('.chapter-analysis-report ul').innerText(), /第 3 章 · 修订 v4/);
  assert.match(await dialog.locator('.chapter-analysis-report dl').innerText(), /2026:01:01 08:00/);
  assert.match(await dialog.locator('.chapter-analysis-report dl').innerText(), /2026:01:01 08:01/);
  assert.ok((await report(dialog).innerText()).includes(payload), 'HTML-like model output is literal text');
  assert.equal(await dialog.locator('.chapter-analysis-report script, .chapter-analysis-report img').count(), 0);
  assert.equal(await local.page.evaluate(() => window.__analysisExecuted), undefined);
  checks.push('explicit range body; UUID; double-click suppression; running polling; source revisions; UTC+8 independent of browser timezone; inert HTML');

  stage = 'history reuse and invalid selections';
  const latest = local.state.records[0].id;
  const historySelect = dialog.getByRole('combobox', { name: /^解析历史/ });
  await historySelect.selectOption(history.id);
  await waitReport(local.page, dialog, 'OLDER SYNTHETIC REPORT');
  await historySelect.selectOption(latest);
  await waitReport(local.page, dialog, 'END OF ANALYSIS');
  await local.page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await open(local.page);
  await historySelect.selectOption(history.id);
  await waitReport(local.page, dialog, 'OLDER SYNTHETIC REPORT');
  assert.equal(local.state.posts.length, 1, 'history switching/reopening never submits');
  for (const [from, to] of [['3', '2'], ['0', '2'], ['1.5', '2'], ['1', '99']]) {
    await dialog.getByLabel('起始章号').fill(from);
    await dialog.getByLabel('结束章号').fill(to);
    assert.equal(await start(dialog).isDisabled(), true, 'invalid range is blocked');
  }
  await dialog.getByRole('combobox', { name: /^解析范围/ }).selectOption('recent');
  for (const value of ['0', '1.5', '101', '5']) {
    await dialog.getByLabel('最近章节数').fill(value);
    assert.equal(await start(dialog).isDisabled(), true, 'invalid or missing recent chapters are blocked');
  }
  assert.equal(local.state.posts.length, 1);
  checks.push('independent history can be revisited; invalid input never POSTs');

  stage = 'recent model failure and no automatic retry';
  local.state.outcome = 'error';
  await dialog.getByLabel('最近章节数').fill('2');
  await start(dialog).click();
  await dialog.getByRole('alert').filter({ hasText: 'MODEL_UNAVAILABLE' }).waitFor();
  assert.equal(local.state.posts.length, 2);
  assert.deepEqual(local.state.posts[1].selection, { kind: 'recent', count: 2 });
  assert.notEqual(local.state.posts[0].requestId, local.state.posts[1].requestId);
  assert.match(await dialog.locator('.chapter-analysis-report ul').innerText(), /第 4 章 · 修订 v5/);
  await dialog.getByRole('button', { name: '刷新解析状态', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'MODEL_UNAVAILABLE' }).waitFor();
  assert.equal(local.state.posts.length, 2, 'model failure refresh is GET only');
  await historySelect.selectOption(latest);
  await waitReport(local.page, dialog, 'END OF ANALYSIS');
  await layout(local.page, dialog, 'zh');
  checks.push('exact recent body; model failure preserved; refresh does not retry; zh 390px');

  stage = 'unknown submission never automatically resubmits';
  await local.page.setViewportSize({ width: 1440, height: 1000 });
  local.state.outcome = 'unknown';
  await start(dialog).click();
  await dialog.getByRole('alert').filter({ hasText: '提交结果未知' }).waitFor();
  assert.equal(await start(dialog).isDisabled(), true);
  const unknownPosts = local.state.posts.length;
  const getBefore = local.state.gets;
  const refreshed = local.page.waitForResponse(response => response.url().endsWith('/chapter-analyses') && response.request().method() === 'GET');
  await dialog.getByRole('button', { name: '刷新解析状态', exact: true }).click();
  await refreshed;
  assert.ok(local.state.gets > getBefore);
  // Observe a real scheduled reconciliation poll, not an arbitrary sleep.
  await local.page.waitForResponse(response => response.url().endsWith('/chapter-analyses') && response.request().method() === 'GET');
  assert.equal(local.state.posts.length, unknownPosts, 'unknown submission reconciles via GET, not retry');
  checks.push('explicit synthetic 503 result-unknown; disabled resubmit; GET-only reconciliation');

  stage = 'project switch rejects stale response';
  await local.page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const stale = { seen: deferred(), release: deferred(), done: deferred() };
  local.state.holdGet = stale;
  await local.page.getByRole('button', { name: '章节解析', exact: true }).click();
  await stale.seen.promise;
  await local.page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await local.page.getByRole('button', { name: '切换作品', exact: true }).click();
  await local.page.getByRole('option').filter({ hasText: projectB.title }).click();
  await local.page.getByRole('button', { name: /^章节书稿/ }).click();
  await local.page.getByRole('button', { name: '章节解析', exact: true }).click();
  await waitReport(local.page, dialog, 'BETA PROJECT ONLY REPORT');
  stale.release.resolve();
  await stale.done.promise;
  await paint(local.page);
  assert.equal((await dialog.innerText()).includes('STALE ALPHA RESPONSE'), false);
  assert.equal((await dialog.innerText()).includes('OLDER SYNTHETIC REPORT'), false);
  assert.equal(local.state.posts.length, unknownPosts);
  await local.context.close();
  checks.push('delayed old-project GET cannot overwrite the new project');

  stage = 'English narrow history and report';
  const english = await setup('en');
  const enDialog = await open(english.page);
  await english.page.waitForFunction(() => document.documentElement.lang === 'en');
  await waitReport(english.page, enDialog, 'OLDER SYNTHETIC REPORT');
  await enDialog.getByRole('combobox', { name: /^Analysis scope/ }).selectOption('recent');
  await enDialog.getByLabel('Number of recent chapters', { exact: true }).fill('2');
  await start(enDialog).click();
  await waitReport(english.page, enDialog, 'END OF ANALYSIS');
  assert.equal(english.state.posts.length, 1);
  assert.deepEqual(english.state.posts[0].selection, { kind: 'recent', count: 2 });
  await layout(english.page, enDialog, 'en');
  await english.context.close();
  checks.push('English labels and explicit submission; en 390px');

  stage = 'strict diagnostics and read-only invariants';
  assert.equal(JSON.stringify(chapters), originals, 'source chapters unchanged');
  assert.deepEqual(await fetch(`${base}/api/auth/session`).then(response => response.json()), realSession);
  assert.deepEqual(violations, [], 'no external/model/platform requests or chapter PATCH');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  assert.deepEqual(consoleErrors, [], 'no unexpected console errors');
  assert.deepEqual(requestFailures, [], 'no unexpected request failures');
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({
    result: 'PASS', checks, backendAuthorizationValidated: false, realModelCalls: false,
    isolation: 'copied-root build/dist; temporary DATA_DIR; environment whitelist; independent Chromium contexts',
    diagnostics: { pageErrors, consoleErrors, requestFailures, violations, expectedConsoleErrors, fontBaseline },
  }, null, 2));
  console.log(`PASS: ${checks.join('; ')}. Frontend mocks do NOT validate backend authentication or authorization.`);
  console.log(`Synthetic artifacts: ${path.relative(root, artifacts)}`);
} catch (error) {
  console.error(`FAIL [${stage}]: ${error instanceof Error ? error.message : 'unknown smoke failure'}`);
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'failure-diagnostics.json'), JSON.stringify({ stage, pageErrors, consoleErrors, requestFailures, violations, expectedConsoleErrors, fontBaseline }, null, 2));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); }
  finally {
    try {
      if (server && server.exitCode === null && server.pid) { const exited = once(server, 'exit'); server.kill(); await exited; }
    } finally {
      assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('novel-chapter-analysis-'));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
