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

// Only copied build artifacts and synthetic API fixtures. Never load .env or real data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-generation-review-'));
const artifacts = path.join(root, 'test-results', path.basename(temporary));
const webDist = process.env.REVIEW_WEB_DIST ? path.resolve(process.env.REVIEW_WEB_DIST) : path.join(root, 'dist');
let server, browser, page;
let step = 'isolated startup';
const errors = [], failures = [], forbidden = [], geometry = [];
try {
  assert.ok(fs.existsSync(path.join(root, 'build/packages/server/src/index.js')), 'Build server first');
  assert.ok(fs.existsSync(path.join(webDist, 'index.html')), 'Build web first');
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }));
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.cpSync(webDist, path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(temporary, 'data'));
  fs.mkdirSync(artifacts, { recursive: true });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(env, { PORT: String(port), DATA_DIR: path.join(temporary, 'data'), NODE_ENV: 'production', CoreModel: 'local', MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '' });
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], { cwd: temporary, env, stdio: 'ignore' });
  let startupError;
  server.on('error', error => { startupError = error; });
  let session;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { session = await response.json(); break; }
    } catch {}
    if (startupError || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(session, `server starts: ${startupError?.message ?? server.exitCode}`);
  assert.equal(session.enabled, false);
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken }, body: JSON.stringify({ title: 'Synthetic review workbench', genre: '奇幻', description: 'Disposable UI review fixture, no model.' }) });
  assert.equal(created.ok, true);
  let project = await created.json();
  const now = new Date().toISOString();
  const longText = Array.from({ length: 100 }, (_, index) => `审阅测试段落 ${index + 1}。Synthetic manuscript review: a deliberately long paragraph for reading, comparing and keyboard scrolling. No real manuscript or model output.`).join('\n\n');
  const original = { id: 'review-original', number: 1, revision: 1, title: 'Synthetic original', content: longText, updatedAt: now, mode: 'demo', revisions: [] };
  const candidate = { id: 'review-candidate', number: 1, chapterId: original.id, baseRevision: 1, title: 'Synthetic replacement', content: `${longText}\nEND OF SYNTHETIC CANDIDATE`, issues: [], createdAt: now, mode: 'demo', generationMode: 'regenerate', workflowId: project.activeWorkflowId, runId: 'review-run', outputWriterNodeId: 'draft', requirements: {}, reviewOutput: 'Synthetic advice only; explicit author adoption required.' };
  project = { ...project, chapters: [original], candidates: [candidate], run: { id: 'review-run', status: 'done', mode: 'demo', currentChapter: 1, chapters: [{ number: 1, status: 'candidate', validationStatus: 'passed', reviewStatus: 'done', issues: [] }], targets: [1] } };
  let adopted = 0;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      if (/^(data:|blob:)/.test(request.url())) return route.continue();
      if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(request.url())) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      forbidden.push(request.url()); return route.abort();
    }
    // Initial boot activates the full project from the collection response.
    if (url.pathname === '/api/projects' && request.method() === 'GET') return route.fulfill({ json: [project] });
    if (url.pathname === `/api/projects/${project.id}` && request.method() === 'GET') return route.fulfill({ json: project });
    if (url.pathname === `/api/projects/${project.id}/generation-progress` && request.method() === 'GET') return route.fulfill({ json: { runId: 'review-run', nodes: [{ stepId: 'draft', text: longText, truncated: false, updatedAt: now }] } });
    if (url.pathname === `/api/projects/${project.id}/candidates/${candidate.id}/accept`) {
      assert.equal(request.method(), 'POST');
      assert.equal(request.postDataJSON().expectedRevision, 1);
      adopted++;
      project = { ...project, candidates: [], chapters: [{ ...original, revision: 2, title: candidate.title, content: candidate.content, revisions: [{ revision: 1, title: original.title, content: original.content, updatedAt: now, mode: 'demo' }] }] };
      return route.fulfill({ json: project });
    }
    if (request.method() !== 'GET' && /\/api\/.*(?:\/run(?:\/|$)|\/generate(?:\/|$)|\/publication|\/platforms\/)/.test(url.pathname)) { forbidden.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED' && !request.url().startsWith('https://fonts.googleapis.com/')) failures.push(request.url()); });
  await page.addInitScript(id => { localStorage.setItem('novel-project', id); localStorage.setItem('novel-page', 'chapters'); localStorage.setItem('novel-theme', 'mtf'); }, project.id);
  await page.goto(base);
  await page.getByRole('button', { name: /^章节书稿/ }).click();
  const workbench = page.locator('.generation-review-workbench');
  const card = workbench.locator('.generation-candidate');
  await card.waitFor();
  const checkGeometry = async width => {
    const values = await page.evaluate(() => {
      const box = selector => { const node = document.querySelector(selector); const r = node.getBoundingClientRect(); const css = getComputedStyle(node); return { height: r.height, width: r.width, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflow: css.overflowY }; };
      return { candidate: box('.candidate-saved > pre'), workbench: box('.generation-review-workbench'), page: box('.page-content'), editor: box('.chapter-workspace'), viewport: innerWidth, documentWidth: document.documentElement.scrollWidth };
    });
    assert.ok(values.candidate.height >= 360, 'long candidate has at least 360px reading height');
    assert.ok(values.candidate.scrollHeight > values.candidate.clientHeight, 'synthetic body actually exercises overflow');
    assert.ok(values.workbench.height > 500, 'review container is not capped to a cramped panel');
    assert.equal(values.page.overflow, 'visible', 'page has no nested vertical scrolling');
    assert.ok(values.editor.height >= 620, 'manuscript editor remains usable below review');
    assert.ok(values.documentWidth <= width + 1, 'no horizontal page overflow');
    geometry.push({ width, ...values });
  };
  step = 'desktop long candidate and comparison';
  await checkGeometry(1440);
  await card.getByRole('button', { name: '对比原稿', exact: true }).click();
  const compare = card.locator('.candidate-compare pre');
  assert.equal(await compare.count(), 2);
  for (const pane of await compare.all()) assert.ok((await pane.boundingBox()).height >= 360);
  await card.locator('.candidate-saved > pre').focus();
  await page.keyboard.press('End');
  await page.screenshot({ path: path.join(artifacts, 'review-desktop.png'), fullPage: true });
  step = 'full text and collapse preserve candidate';
  await card.locator('.candidate-full-text > summary').click();
  assert.equal(await card.locator('.candidate-full-text > pre').evaluate(node => getComputedStyle(node).overflowY), 'visible');
  await card.locator('.candidate-full-text > summary').click();
  await workbench.locator(':scope > summary').click();
  assert.equal(await card.isVisible(), false);
  assert.ok((await page.locator('.chapter-workspace').boundingBox()).height >= 620);
  await workbench.locator(':scope > summary').click();
  assert.equal(await card.isVisible(), true);
  step = '390px candidate and actions';
  await page.setViewportSize({ width: 390, height: 844 });
  await checkGeometry(390);
  for (const button of await card.getByRole('button').all()) {
    const box = await button.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 391, 'review controls fit narrow viewport');
  }
  assert.equal(await card.locator('.candidate-compare').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
  await page.screenshot({ path: path.join(artifacts, 'review-390.png'), fullPage: true });
  step = 'dirty manuscript protects adoption';
  const adopt = card.getByRole('button', { name: '采用新稿', exact: true });
  const editor = page.getByRole('textbox', { name: '章节正文', exact: true });
  await editor.fill(`${original.content}\nUNSAVED SYNTHETIC EDIT`);
  assert.equal(await adopt.isDisabled(), true, 'unsaved manuscript blocks adoption');
  await editor.fill(original.content);
  assert.equal(await adopt.isEnabled(), true);
  step = 'adoption cancel then explicit adoption and history';
  await adopt.click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(adopted, 0, 'cancel never adopts');
  await adopt.click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确定', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(adopted, 1);
  await page.getByRole('button', { name: '章节历史（1）', exact: true }).click();
  await page.getByRole('heading', { name: '章节历史比较', exact: true }).waitFor();
  assert.match(await page.getByRole('combobox', { name: '历史版本', exact: true }).innerText(), /v1/);
  assert.equal(await page.getByRole('button', { name: '恢复此版本', exact: true }).isVisible(), true);
  step = 'long synthetic live preview';
  project = { ...project, run: { ...project.run, status: 'running' } };
  await page.reload();
  await page.getByRole('button', { name: /^章节书稿/ }).click();
  const livePreview = page.locator('.generation-live-preview');
  await livePreview.waitFor();
  assert.ok((await livePreview.boundingBox()).height >= 360, 'live preview also has a readable narrow pane');
  assert.equal(await livePreview.evaluate(node => node.scrollHeight > node.clientHeight), true);
  assert.ok((await workbench.boundingBox()).height > 500, 'live preview container is not capped');
  const unexpected = errors.filter(error => !(error.includes('https://fonts.googleapis.com/') && error.includes('Content Security Policy') && error.includes('stylesheet')));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(failures, []);
  assert.deepEqual(forbidden, []);
  fs.writeFileSync(path.join(artifacts, 'geometry.json'), JSON.stringify(geometry, null, 2));
  console.log('PASS: synthetic long review; desktop/390 geometry; comparison; full text; disclosure; cancel/explicit adoption; revision history; no external/model requests.');
  console.log(`Synthetic artifacts: ${path.relative(root, artifacts)}`);
} catch (error) {
  console.error(`FAIL [${step}]: ${error.stack ?? error}`);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); }
  finally {
    try { if (server && server.exitCode === null && server.pid) { const exited = once(server, 'exit'); server.kill(); await exited; } }
    finally { assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('novel-generation-review-')); fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}
