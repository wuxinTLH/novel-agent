import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Build explicitly before running: node scripts/smoke-locale-coverage.mjs.
// Never starts a dev server, reads .env/data, inherits integration credentials,
// opens a personal browser, runs a model, or performs platform operations.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-locale-coverage-'));
const artifacts = path.join(root, 'test-results', path.basename(temporary));
const report = {
  checkpoints: [], failures: [], browserErrors: [], failedRequests: [], httpErrors: [],
  forbidden: [], optionalFontRequests: [], optionalFontCsp: [], optionalFontFailures: [],
  boundaries: [
    'Only synthetic English project, chapter and reference content; no real user data.',
    'Editable input/textarea values and textarea default prompt text are not UI copy.',
    'No blanket exemption for built-in node titles/subtitles: locale mapping must translate them.',
    'Only the native language choice 中文 is exempt, inside the language switcher menu.',
    'No model execution, authenticated account setup, SMTP/SMS/OIDC, database connection, platform login or remote publication.',
    'Unreachable permission/connection-dependent states and generation result states are not covered.',
    'Han scan detects untranslated Chinese, not English semantic quality or non-Chinese untranslated languages.',
  ],
};
let server, browser, page;
let step = 'isolated deployment';
const fontUrl = (url) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url);
try {
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html'])
    assert.ok(fs.existsSync(path.join(root, entry)), 'Run npm run build first (this script never builds)');
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({
    name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'],
  }));
  for (const directory of ['build', 'dist'])
    fs.cpSync(path.join(root, directory), path.join(temporary, directory), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data);
  assert.equal(fs.existsSync(path.join(temporary, '.env')), false);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  // Deliberately whitelist OS essentials, not NODE_OPTIONS, proxy settings,
  // CoreModel, provider URLs, auth switches or any inherited application config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']
      .includes(key.toUpperCase())));
  Object.assign(env, {
    PORT: String(port), DATA_DIR: data, NODE_ENV: 'production', CoreModel: 'local',
    MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '',
  });
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], {
    cwd: temporary, env, stdio: 'ignore',
  });
  let startupError, session;
  server.on('error', (error) => { startupError = error; });
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { session = await response.json(); break; }
    } catch {}
    if (startupError || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(session, `isolated server starts: ${startupError?.message ?? server.exitCode}`);
  assert.equal(session.enabled, false, 'fresh local authentication disabled');
  const get = async (url) => {
    assert.ok(url.startsWith('/api/'));
    const response = await fetch(`${base}${url}`, { signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `GET ${url}: ${response.status}`);
    return response.json();
  };
  assert.equal((await get('/api/admin/status')).mode, 'local');
  const health = await get('/api/health');
  const mutate = async (url, body) => {
    // Fixture helper cannot call an arbitrary API or remote URL.
    assert.match(url, /^\/api\/projects(?:$|\/[^/]+\/(?:chapters|assets|workflows)$)/);
    const response = await fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok, `fixture POST ${url}: ${response.status}`);
    return response.json();
  };
  let project = await mutate('/api/projects', {
    title: 'Locale Coverage Synthetic Novel', genre: 'Fantasy',
    description: 'Disposable English fixture. No real manuscript or credentials.',
  });
  const projectPath = `/api/projects/${project.id}`;
  // Fresh deployments may seed a Chinese demonstration novel. Remove only
  // this disposable app-root's seed so authored titles are not false UI hits.
  for (const seed of await get('/api/projects')) {
    if (seed.id === project.id) continue;
    const response = await fetch(`${base}/api/projects/${encodeURIComponent(seed.id)}`, {
      method: 'DELETE', headers: { 'X-Platform-CSRF': health.platform.csrfToken },
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok, `remove isolated starter fixture: ${response.status}`);
  }
  project = await mutate(`${projectPath}/chapters`, {
    number: 1, title: 'Synthetic Dawn', content: 'A synthetic traveler reaches an imaginary city.', requestId: randomUUID(),
  });
  project = await mutate(`${projectPath}/assets`, {
    name: 'Synthetic Atlas', category: 'world', content: 'An imaginary English reference document.',
  });
  // Keep preset titles/subtitles intact so missing built-in locale mappings are
  // caught. Workflow names themselves are controlled English user content.
  for (const preset of ['chapter', 'character', 'world'])
    project = await mutate(`${projectPath}/workflows`, { name: `Synthetic ${preset} workflow`, preset });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 }, locale: 'en-US',
    reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(`${base}/`)) {
      const pathname = new URL(url).pathname;
      // The UI may only read local APIs, plus select an isolated workflow.
      // This blocks even a same-origin endpoint which could proxy remote calls.
      const localSelect = request.method() === 'POST' &&
        new RegExp(`^${projectPath}/workflows/[^/]+/select$`).test(pathname);
      const unsafeRead = /\/(?:login|verify|test|discover|read-works|refresh-works)(?:\/|$)/.test(pathname);
      if (pathname.startsWith('/api/') &&
          ((!['GET', 'HEAD'].includes(request.method()) && !localSelect) || unsafeRead)) {
        report.forbidden.push({ method: request.method(), path: pathname });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    }
    if (/^(data:|blob:)/.test(url)) return route.continue();
    if (fontUrl(url)) {
      report.optionalFontRequests.push(url);
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    report.forbidden.push({ method: request.method(), url });
    return route.abort('blockedbyclient');
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('https://fonts.googleapis.com/') && text.includes('Content Security Policy') && text.includes('stylesheet'))
      report.optionalFontCsp.push(text);
    else report.browserErrors.push(text);
  });
  page.on('requestfailed', (request) => {
    const item = { url: request.url(), error: request.failure()?.errorText };
    if (fontUrl(item.url) && request.resourceType() === 'stylesheet') report.optionalFontFailures.push(item);
    else if (item.error !== 'net::ERR_ABORTED') report.failedRequests.push(item);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) report.httpErrors.push({ url: response.url(), status: response.status() });
  });
  await page.addInitScript((id) => {
    localStorage.setItem('novel-project', id);
    localStorage.setItem('novel-theme', 'mtf');
    // Do not reset on every navigation: persistence and reverse switching are tested.
    if (!localStorage.getItem('novel-locale')) localStorage.setItem('novel-locale', 'en');
  }, project.id);

  const settle = async () => {
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const scan = async (name, { chinese = false, screenshot = false } = {}) => {
    step = name;
    await settle();
    const findings = await page.evaluate(() => {
      const han = /\p{Script=Han}/u;
      const hits = [];
      const visible = (element) => {
        if (element.closest('[hidden], [aria-hidden="true"], script, style, noscript, template')) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.getClientRects().length > 0;
      };
      const describe = (element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.getAttribute('class') ? `.${element.getAttribute('class').trim().replace(/\s+/g, '.')}` : ''}`;
      const add = (element, kind, text) => {
        const normalized = text?.replace(/\s+/g, ' ').trim();
        if (!normalized || !han.test(normalized)) return;
        // Native language names are language-selection UI, not untranslated copy.
        if (normalized === '中文' && element.closest('.language-switcher')) return;
        hits.push({ element: describe(element), kind, text: normalized.slice(0, 500) });
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        // Values/default prompts are authored/model content, not UI translation.
        if (!parent || parent.closest('textarea, input, [contenteditable="true"]')) continue;
        const visibilityTarget = parent.tagName === 'OPTION' ? parent.closest('select') : parent;
        if (visibilityTarget && visible(visibilityTarget)) add(parent, 'text', node.nodeValue);
      }
      for (const element of document.querySelectorAll('[title], [aria-label], [aria-description], [aria-valuetext], [placeholder], [alt]')) {
        if (!visible(element)) continue;
        // Attributes on an editable control ARE interface copy; its value is not.
        for (const attribute of ['title', 'aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'alt'])
          add(element, attribute, element.getAttribute(attribute));
      }
      if (han.test(document.title)) hits.push({ element: 'document', kind: 'title', text: document.title });
      return { hits, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, lang: document.documentElement.lang };
    });
    const entry = { name, path: new URL(page.url()).pathname, ...findings };
    report.checkpoints.push(entry);
    if (!chinese && findings.hits.length) report.failures.push({ name, kind: 'untranslated-han', hits: findings.hits });
    if (findings.scrollWidth > findings.width + 1)
      report.failures.push({ name, kind: 'horizontal-overflow', width: findings.width, scrollWidth: findings.scrollWidth });
    if (screenshot) await page.screenshot({ path: path.join(artifacts, `${name.replace(/[^a-z0-9-]/gi, '-')}.png`), fullPage: true });
  };
  const visit = async (route, name) => {
    step = `visit ${name}`;
    await page.goto(`${base}${route}`);
    await page.locator('main').waitFor();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await scan(`${name}-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await scan(`${name}-390`, { screenshot: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
  };
  const close = async () => {
    const dialog = page.getByRole('dialog').last();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  const modal = async (buttonName, name) => {
    step = `open ${name}`;
    await page.getByRole('button', { name: buttonName, exact: true }).first().click();
    await page.getByRole('dialog').last().waitFor();
    await scan(`${name}-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await scan(`${name}-390`, { screenshot: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await close();
  };
  // These routes are the actual App.tsx routePages, not guessed new URLs.
  for (const [route, name, creator] of [
    ['/workflow', 'workflow', 'Create novel workflow'],
    ['/character-workflow', 'character', 'Create character workflow'],
    ['/world-workflow', 'world', 'Create worldbuilding workflow'],
  ]) {
    await visit(route, name);
    await modal('Add node', `${name}-add-node`);
    await modal('Workflow settings', `${name}-schedule-settings`);
    await modal(creator, `${name}-create-workflow`);
    // Inspect each configured node, including boundary/detail/help copy.
    const nodes = page.locator('.react-flow__node');
    for (let index = 0; index < await nodes.count(); index++) {
      await nodes.nth(index).click({ force: true });
      await scan(`${name}-node-${index}`);
    }
    await page.getByRole('button', { name: 'Switch workflow', exact: true }).click();
    await scan(`${name}-workflow-picker`);
    await page.keyboard.press('Escape');
  }
  await visit('/assets', 'references');
  await modal('New reference', 'reference-create');
  await modal('Edit Synthetic Atlas', 'reference-edit');
  await visit('/assets/knowledge', 'knowledge');
  await visit('/chapters', 'chapters');
  // Prefix tolerates the current dictionary's deliberate shorter shell override.
  await modal(/^Add manuscript/, 'manual-chapter');
  await modal(/^Chapter history \(/, 'chapter-history');
  await modal('Document formatting & reading', 'document-workspace');
  await modal(/^Generate chapters \/ [Rr]equirements$/, 'generation-requirements');
  await visit('/settings', 'models');
  await visit('/project-settings', 'project-settings');
  await visit('/platforms', 'platforms');
  await modal('Connection guide', 'platform-connection-guide');
  // Enter actual provider cards; derive child URLs from navigation, never invent IDs.
  const providerCount = await page.locator('.platform-provider-entry').count();
  assert.ok(providerCount > 0, 'platform selector has provider entries');
  for (let index = 0; index < providerCount; index++) {
    await page.locator('.platform-provider-entry').nth(index).click();
    await scan(`platform-${index}-account`);
    const steps = page.locator('.platform-step-button');
    for (let tab = 0; tab < await steps.count(); tab++) {
      if (await steps.nth(tab).isEnabled()) {
        await steps.nth(tab).click();
        await scan(`platform-${index}-step-${tab}`);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await scan(`platform-${index}-390`, { screenshot: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${base}/platforms`);
    await page.locator('.platform-provider-entry').first().waitFor();
  }
  await visit('/projects', 'projects');
  await modal('Create novel', 'project-create');
  await modal('User guide', 'help');
  await page.getByRole('button', { name: 'Admin console', exact: true }).click();
  const administration = page.getByRole('dialog');
  for (const tab of ['Dashboard', 'Users', 'Database', 'Backup and maintenance', 'System and security']) {
    await administration.getByRole('tab', { name: tab, exact: true }).click();
    await scan(`admin-${tab}-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await scan(`admin-${tab}-390`, { screenshot: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
  await close();
  const language = () => page.getByRole('button', { name: /^(Language|语言): / });
  await language().click();
  await scan('language-menu-en');
  await page.getByRole('menuitemradio', { name: '中文', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await page.getByRole('button', { name: '管理控制台', exact: true }).waitFor();
  await scan('reverse-switch-zh', { chinese: true, screenshot: true });
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await page.getByRole('button', { name: '管理控制台', exact: true }).waitFor();
  await language().click();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.reload();
  await page.getByRole('button', { name: 'Admin console', exact: true }).waitFor();
  await scan('english-restored-after-reload');

  assert.deepEqual(report.forbidden, [], 'no external or side-effect requests attempted');
  assert.deepEqual(report.browserErrors, [], 'no console/page errors except separately recorded optional font CSP');
  assert.deepEqual(report.failedRequests, [], 'no unexpected failed requests');
  assert.deepEqual(report.httpErrors, [], 'no failed HTTP responses');
  assert.deepEqual(report.failures, [], 'all English visible text/attributes and viewport checks pass; see report.json');
  console.log(`PASS: ${report.checkpoints.length} locale checkpoints; synthetic artifacts: ${path.relative(root, artifacts)}`);
} catch (error) {
  report.failures.push({ name: step, kind: 'execution', message: error.message });
  console.error(`FAIL [${step}]: ${error.stack ?? error}`);
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (fs.existsSync(artifacts)) fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  try { if (browser) await browser.close(); }
  finally {
    try {
      if (server && server.exitCode === null && server.pid) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    } finally {
      assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('novel-locale-coverage-'));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
