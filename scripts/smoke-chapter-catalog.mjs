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

// Build first. Clone only production artifacts into a fresh app root: .env,
// real data, personal browser profiles and integration credentials are never used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chapter-catalog-'));
const artifacts = path.join(root, 'test-results', path.basename(temporary));
let server, browser, page;
let step = 'isolated deployment';
const browserErrors = [],
  failedRequests = [],
  knownOptionalFontRequestFailures = [],
  forbidden = [];
try {
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html'])
    assert.ok(fs.existsSync(path.join(root, entry)), 'Run npm run build first');
  fs.writeFileSync(
    path.join(temporary, 'package.json'),
    JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }),
  );
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(temporary, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.mkdirSync(path.join(temporary, 'data'));
  fs.mkdirSync(artifacts, { recursive: true });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(
        key.toUpperCase(),
      ),
    ),
  );
  Object.assign(env, {
    PORT: String(port),
    DATA_DIR: path.join(temporary, 'data'),
    NODE_ENV: 'production',
    CoreModel: 'local',
    MODEL_API_KEY: '',
    MODEL_SECRETS_KEY: '',
    PLATFORM_SECRETS_KEY: '',
  });
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], {
    cwd: temporary,
    env,
    stdio: 'ignore',
  });
  let startupError;
  server.on('error', (error) => {
    startupError = error;
  });
  let session;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        session = await response.json();
        break;
      }
    } catch {}
    if (startupError || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(session, `server starts: ${startupError?.message ?? server.exitCode}`);
  assert.equal(session.enabled, false);
  const get = async (url) => {
    const response = await fetch(`${base}${url}`);
    assert.ok(response.ok);
    return response.json();
  };
  const health = await get('/api/health');
  const request = (url, method, body) =>
    fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  const mutate = async (url, method, body) => {
    const response = await request(url, method, body);
    assert.ok(response.ok, `${method} ${url}: ${response.status}`);
    return response.json();
  };
  let project = await mutate('/api/projects', 'POST', {
    title: 'Chapter catalog synthetic smoke',
    genre: '奇幻',
    description: 'Disposable synthetic chapters only.',
  });
  const projectPath = `/api/projects/${project.id}`;
  for (let number = 1; number <= 45; number++)
    project = await mutate(`${projectPath}/chapters`, 'POST', {
      number,
      title: `测试章节${number}`,
      content: `Synthetic chapter ${number}; no real manuscript.`,
      requestId: randomUUID(),
    });
  const original = project.chapters;
  step = 'bulk atomic stale and missing conflicts';
  const good = original[0];
  for (const second of [
    { id: original[1].id, expectedRevision: 999 },
    { id: 'missing-smoke-chapter', expectedRevision: 1 },
  ]) {
    const response = await request(`${projectPath}/chapters/delete`, 'POST', {
      chapters: [{ id: good.id, expectedRevision: good.revision }, second],
    });
    assert.equal(response.status, 409);
    assert.equal((await get(projectPath)).chapters.length, 45);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    serviceWorkers: 'block',
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${base}/`)) {
      if (
        route.request().method() !== 'GET' &&
        /\/api\/.*(?:\/run(?:\/|$)|\/generate(?:\/|$)|\/publication|\/platforms\/)/.test(
          new URL(url).pathname,
        )
      ) {
        forbidden.push(new URL(url).pathname);
        return route.abort();
      }
      return route.continue();
    }
    if (/^(data:|blob:)/.test(url)) return route.continue();
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url))
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    forbidden.push(url);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const error = request.failure()?.errorText;
    if (request.resourceType() === 'stylesheet' && /^https:\/\/fonts\.googleapis\.com\/css2\?/.test(url)) {
      knownOptionalFontRequestFailures.push({ url, error });
      return;
    }
    if (error !== 'net::ERR_ABORTED') failedRequests.push({ url, error });
  });
  await page.addInitScript((id) => {
    localStorage.setItem('novel-project', id);
    localStorage.setItem('novel-theme', 'mtf');
  }, project.id);
  await page.goto(base);
  await page.getByRole('button', { name: /^章节书稿/ }).click();
  const catalog = page.getByRole('region', { name: '章节目录管理' });
  const dialog = page.getByRole('alertdialog');
  const next = catalog.getByRole('button', { name: '目录下一页', exact: true });
  const prev = catalog.getByRole('button', { name: '目录上一页', exact: true });
  const enter = () => catalog.getByRole('button', { name: '批量删除', exact: true }).click();
  const exit = () => catalog.getByRole('button', { name: '退出批量删除', exact: true }).click();
  const selectedDelete = () => catalog.getByRole('button', { name: /^删除所选/ }).click();
  step = 'default off and twenty chapter pagination';
  await catalog.waitFor();
  assert.equal(await catalog.getByRole('checkbox').count(), 0);
  assert.equal(await catalog.getByRole('combobox', { name: '每页章节数' }).inputValue(), '20');
  // Initial selected latest chapter is deliberately revealed on the final page.
  await prev.click();
  await prev.click();
  assert.equal(await catalog.locator('.chapter-row').count(), 20);
  await enter();
  assert.equal(await catalog.getByRole('checkbox', { checked: true }).count(), 0);
  await catalog.getByRole('checkbox', { name: '选择本页全部章节' }).check();
  await next.click();
  assert.match(await catalog.getByRole('status').innerText(), /已选 20 章（本页 0 · 其他页 20）/);
  await exit();
  assert.equal(await catalog.getByRole('checkbox').count(), 0);
  step = 'cancel and confirm destructive batch';
  await prev.click();
  await enter();
  await catalog.getByRole('checkbox', { name: '选择第 1 章 测试章节1', exact: true }).check();
  await selectedDelete();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await get(projectPath)).chapters.length, 45);
  assert.equal(
    await catalog.getByRole('checkbox', { name: '选择第 1 章 测试章节1', exact: true }).isChecked(),
    true,
  );
  await selectedDelete();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${base}${projectPath}/chapters/delete` && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '永久删除 1 章', exact: true }).click();
  assert.equal((await responsePromise).status(), 200);
  await catalog.getByRole('button', { name: '批量删除', exact: true }).waitFor();
  assert.equal((await get(projectPath)).chapters.length, 44);
  assert.equal(await catalog.getByRole('checkbox').count(), 0);
  step = 'dirty draft deletion blocked and draft preserved';
  await catalog.locator('.chapter-row-open').first().click();
  await page.getByRole('textbox', { name: '章节正文', exact: true }).fill('Synthetic unsaved draft retained');
  const dirtyNumber = await page.getByRole('textbox', { name: '章节标题', exact: true }).inputValue();
  await enter();
  await catalog.getByRole('checkbox', { name: new RegExp(`^选择第 .* ${dirtyNumber}$`) }).check();
  await selectedDelete();
  await page
    .getByText('所选章节可能有未保存的本地草稿，请先保存或丢弃草稿，再删除章节。', { exact: true })
    .waitFor();
  assert.equal(await dialog.count(), 0);
  assert.equal((await get(projectPath)).chapters.length, 44);
  assert.equal(
    await page.getByRole('textbox', { name: '章节正文', exact: true }).inputValue(),
    'Synthetic unsaved draft retained',
  );
  await exit();
  await page.getByRole('button', { name: '丢弃本地草稿', exact: true }).click();
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  step = 'picker jump reveals selected catalog page';
  await page.locator('.chapter-picker > button').click();
  await page.getByRole('textbox', { name: '搜索章节', exact: true }).fill('测试章节45');
  await page.getByRole('option', { name: '第 45 章 · 测试章节45', exact: true }).click();
  await catalog.locator('.chapter-row.active').filter({ hasText: '测试章节45' }).waitFor();
  step = '390px catalog batch layout';
  await page.setViewportSize({ width: 390, height: 844 });
  await enter();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'no horizontal page overflow',
  );
  for (const control of await catalog.getByRole('button').all()) {
    const box = await control.boundingBox();
    if (box) assert.ok(box.x >= 0 && box.x + box.width <= 391, 'catalog controls fit 390px');
  }
  const actionBoxes = await page.locator('.chapter-page-actions > button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        scrollWidth: button.scrollWidth,
        clientWidth: button.clientWidth,
      };
    }),
  );
  assert.equal(actionBoxes.length, 6);
  for (let index = 0; index < actionBoxes.length; index++) {
    const box = actionBoxes[index];
    assert.ok(
      box.x >= 0 && box.right <= 391 && box.width >= 140,
      'chapter header action has readable width inside viewport',
    );
    assert.ok(box.scrollWidth <= box.clientWidth + 1, 'chapter header text fits its button');
    for (const other of actionBoxes.slice(index + 1)) {
      const overlap =
        Math.min(box.right, other.right) - Math.max(box.x, other.x) > 1 &&
        Math.min(box.bottom, other.bottom) - Math.max(box.y, other.y) > 1;
      assert.equal(overlap, false, 'chapter header action buttons never overlap');
    }
  }
  await page.screenshot({ path: path.join(artifacts, 'chapter-catalog-390.png'), fullPage: true });
  await exit();
  await page.reload();
  await catalog.waitFor();
  assert.equal(await catalog.getByRole('checkbox').count(), 0, 'batch mode resets on unmount/reload');
  // Baseline production CSP blocks the optional Google Fonts stylesheet before
  // routing; keep these visible separately and reject every other console error.
  const knownOptionalFontWarnings = browserErrors.filter(
    (error) =>
      error.includes('https://fonts.googleapis.com/') &&
      error.includes('Content Security Policy') &&
      error.includes('stylesheet'),
  );
  assert.deepEqual(
    browserErrors.filter((error) => !knownOptionalFontWarnings.includes(error)),
    [],
    'no browser errors beyond the known optional-font stylesheet CSP block',
  );
  console.log('knownOptionalFontWarnings:', JSON.stringify(knownOptionalFontWarnings));
  console.log('knownOptionalFontRequestFailures:', JSON.stringify(knownOptionalFontRequestFailures));
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(forbidden, []);
  console.log(
    'PASS: isolated production chapter catalog; default-off batch; 45 chapters/20-page; crosspage selection; exit clears; cancel/confirm; atomic stale/missing409; dirty draft protection; picker page reveal; 390px layout; no external/model calls.',
  );
  console.log(`Synthetic artifacts: ${path.relative(root, artifacts)}`);
} catch (error) {
  console.error(`FAIL [${step}]: ${error.stack ?? error}`);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    console.error('Synthetic page excerpt:', (await page.locator('body').innerText()).slice(0, 2200));
  }
  process.exitCode = 1;
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (server && server.exitCode === null && server.pid) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    } finally {
      assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('novel-chapter-catalog-'));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
