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

// Run after npm run build. Only a copied production deployment and owned temporary data.
// No .env, user data, inherited model/database/platform settings, or real model calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-completion-smoke-'));
const artifacts = path.join(root, '.tmp-build', 'completion-smoke');
const report = { passed: false, checks: [], browserErrors: [], externalRequests: [] };
let server, browser, page, base, projectId, csrf;
const request = async (suffix, method = 'GET', body, expected = 200) => {
  const response = await fetch(`${base}/api${suffix}`, {
    method,
    headers: { 'X-Platform-CSRF': csrf || '', ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${suffix}: ${JSON.stringify(value)}`);
  return value;
};
const getProject = () => request(`/projects/${projectId}`);
const openPage = async (name) => {
  await page.goto(`${base}/workflow`);
  await page.getByRole('button', { name, exact: false }).click();
};
const poll = async (action, predicate, label, limit = 200) => {
  for (let attempt = 0; attempt < limit; attempt++) {
    const result = await action();
    if (predicate(result)) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
};
const check = async (name, action) => {
  try { await action(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    report.checks.push({ name, passed: false, error: error.stack || String(error) });
    console.error(`FAIL ${name}: ${error.message}`);
    if (page) await page.screenshot({ path: path.join(artifacts, `failure-${report.checks.length}.png`), fullPage: true }).catch(() => {});
    // Each next check starts by navigating; dismiss any prior dialog without changing data.
    if (page) await page.goto(`${base}/workflow`).catch(() => {});
  }
};
try {
  fs.mkdirSync(artifacts, { recursive: true });
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html'])
    assert.ok(fs.existsSync(path.join(root, entry)), `Production artifact unavailable: ${entry}; finish npm run build first.`);
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }));
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(env, { PORT: String(port), DATA_DIR: data, NODE_ENV: 'production', MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '' });
  server = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], { cwd: temporary, env, stdio: 'ignore' });
  let startupError;
  server.on('error', error => { startupError = error; });
  await poll(async () => {
    if (startupError) throw startupError;
    assert.equal(server.exitCode, null, 'production service remains running');
    try { return (await fetch(`${base}/api/auth/session`)).ok; } catch { return false; }
  }, Boolean, 'production server startup', 150);
  const session = await request('/platforms/session');
  csrf = session.csrfToken;
  assert.equal((await request('/auth/session')).enabled, false, 'isolated app has no inherited auth configuration');
  const project = await request('/projects', 'POST', { title: 'P1 P2 P3 独立完成验收', genre: '科幻', description: '仅用于隔离 smoke 的演示作品。' }, 201);
  projectId = project.id;
  browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_CHANNEL ? { channel: process.env.SMOKE_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(`${base}/`)) return route.continue();
    if (!url.startsWith('data:') && !url.startsWith('blob:') && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) report.externalRequests.push(url);
    return route.abort();
  });
  await page.addInitScript(id => localStorage.setItem('novel-project', id), projectId);
  await page.goto(`${base}/workflow`);

  await check('model parameters saved through UI and API; demo remains active', async () => {
    await page.getByRole('button', { name: /^模型设置$/ }).click();
    await page.getByRole('button', { name: '修改模型', exact: true }).click();
    await page.getByLabel('温度', { exact: true }).fill('0');
    await page.getByLabel('最大输出 token', { exact: true }).fill('2048');
    await page.getByLabel('超时（毫秒）', { exact: true }).fill('45000');
    await page.getByLabel('上下文窗口（token）', { exact: true }).fill('32768');
    await page.getByLabel('输入价格 / 百万 token', { exact: true }).fill('1.5');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByRole('heading', { name: '切换模型', exact: true }).waitFor();
    let settings = await request('/settings');
    assert.equal(settings.temperature, 0);
    assert.equal(settings.maxOutputTokens, 2048);
    assert.equal(settings.timeoutMs, 45000);
    assert.equal(settings.contextWindow, 32768);
    assert.equal(settings.inputPricePerMillion, 1.5);
    assert.equal(settings.mode, 'demo');
    await request(`/models/${settings.activeModelId}`, 'PATCH', { maxOutputTokens: 4096 });
    await request(`/models/${settings.activeModelId}`, 'PATCH', { temperature: 3 }, 400);
    settings = await request('/settings');
    assert.equal(settings.temperature, 0, 'rejected update is atomic');
    assert.equal(settings.maxOutputTokens, 4096);
    await page.reload();
    await page.getByRole('button', { name: '修改模型', exact: true }).click();
    assert.equal(await page.getByLabel('最大输出 token', { exact: true }).inputValue(), '4096');
  });

  await check('UI demo generation produces a saved chapter without a model key', async () => {
    assert.equal((await request('/settings')).mode, 'demo');
    await openPage(/^章节书稿(?:\s*\d+)?$/);
    await page.getByRole('button', { name: '生成章节 / 要求', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '生成章节与创作要求' });
    await modal.getByLabel('本次目标', { exact: true }).selectOption('single');
    await modal.getByLabel('章号', { exact: true }).fill('1');
    await modal.getByLabel('创作要求', { exact: true }).first().fill('围绕一次星港夜航展开故事。');
    await modal.getByRole('button', { name: '保存要求并开始', exact: true }).click();
    const saved = await poll(getProject, value => value.run && value.run.status !== 'running', 'demo completion');
    assert.equal(saved.run.status, 'done', saved.run.error);
    assert.equal(saved.chapters.length, 1);
    assert.ok(saved.chapters[0].content.length > 50);
    assert.equal((await request('/settings')).mode, 'demo');
  });

  await check('chapter unsaved draft survives refresh; save and UI historical restore create revisions', async () => {
    const original = (await getProject()).chapters[0];
    assert.ok(original, 'generation prerequisite succeeded');
    await openPage(/^章节书稿(?:\s*\d+)?$/);
    const editor = page.getByLabel('章节正文', { exact: true });
    await editor.fill('未保存草稿：夜航船驶过群星之间，刷新后这段文字必须完整保留。');
    await page.getByText('修改尚未提交，已保留本地草稿；再次打开本章节可恢复。', { exact: true }).waitFor();
    await page.reload();
    assert.equal(await editor.inputValue(), '未保存草稿：夜航船驶过群星之间，刷新后这段文字必须完整保留。');
    assert.equal((await getProject()).chapters[0].content, original.content, 'draft does not overwrite server');
    await page.getByRole('button', { name: '保存书稿', exact: true }).click();
    await poll(getProject, value => value.chapters[0].revision === original.revision + 1, 'chapter save');
    await page.getByRole('button', { name: /^章节历史/ }).click();
    const history = page.getByRole('dialog', { name: '章节历史比较' });
    await history.getByLabel('历史版本', { exact: true }).selectOption(String(original.revision));
    await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确定', exact: true }).click();
    const restored = await poll(getProject, value => value.chapters[0].revision === original.revision + 2, 'history restore');
    assert.equal(restored.chapters[0].content, original.content);
    assert.ok(restored.chapters[0].revisions.some(version => version.content.startsWith('未保存草稿：')));
    await page.reload();
    assert.equal(await editor.inputValue(), original.content);
  });

  await check('asset CAS version rejects stale edits and retains history', async () => {
    const created = await request(`/projects/${projectId}/assets`, 'POST', { name: 'CAS 验收资料', category: 'world', content: '初始资料内容' }, 201);
    const asset = created.assets.find(value => value.name === 'CAS 验收资料');
    const updated = await request(`/projects/${projectId}/assets/${asset.id}`, 'PATCH', { expectedRevision: 1, content: '新资料内容' });
    const next = updated.assets.find(value => value.id === asset.id);
    assert.equal(next.revision, 2);
    assert.equal(next.revisions[0].content, '初始资料内容');
    const conflict = await request(`/projects/${projectId}/assets/${asset.id}`, 'PATCH', { expectedRevision: 1, content: '不得覆盖的新内容' }, 409);
    assert.equal(conflict.code, 'REVISION_CONFLICT');
    assert.equal((await getProject()).assets.find(value => value.id === asset.id).content, '新资料内容');
  });

  await check('KnowledgePanel visible and facts persist through UI', async () => {
    await openPage(/^小说设定库(?:\s*\d+)?$/);
    await page.getByLabel('搜索事实', { exact: true }).waitFor();
    await page.getByPlaceholder('事实标题', { exact: true }).fill('星港位置事实');
    await page.getByPlaceholder('事实内容（可关联章节）', { exact: true }).fill('星港位于赤道环带，所有章节应保持一致。');
    await page.getByRole('button', { name: '保存事实', exact: true }).click();
    await page.locator('.knowledge-list').getByText('星港位置事实', { exact: true }).waitFor();
    await page.reload();
    await page.locator('.knowledge-list').getByText('星港位置事实', { exact: true }).waitFor();
    const facts = await request(`/projects/${projectId}/knowledge`);
    assert.equal(facts.find(value => value.title === '星港位置事实').revision, 1);
    await page.getByRole('button', { name: '编辑事实：星港位置事实', exact: true }).click();
    await page.getByLabel('事实标题', { exact: true }).fill('星港位置已核对');
    await page.getByLabel('事实标签', { exact: true }).fill('canon,航线,canon');
    const chapter = (await getProject()).chapters[0];
    assert.ok(chapter, 'generated chapter available for fact link');
    await page.getByLabel('关联章节', { exact: true }).selectOption([chapter.id]);
    await page.getByRole('button', { name: '保存事实', exact: true }).click();
    await page.locator('.knowledge-list').getByText('星港位置已核对', { exact: true }).waitFor();
    await page.reload();
    const edited = (await request(`/projects/${projectId}/knowledge`)).find(value => value.title === '星港位置已核对');
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.tags, ['canon', '航线']);
    assert.deepEqual(edited.chapterIds, [chapter.id]);
  });

  await check('workflow condition and parallel cap truly save and survive reload', async () => {
    await page.goto(`${base}/workflow`);
    await page.getByRole('button', { name: '工作流设置', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '自动化小说工作流' });
    const form = modal.getByRole('form', { name: '工作流调度设置' });
    const before = await getProject();
    const edge = before.workflow.edges[0];
    assert.ok(edge, 'workflow has at least one edge');
    await form.getByLabel('普通节点并发上限', { exact: true }).fill('2');
    await form.getByPlaceholder('留空为普通依赖，例如 approved').first().fill('approved');
    const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/projects/${projectId}` && response.request().method() === 'PATCH');
    await form.getByRole('button', { name: '保存调度设置', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    await page.getByText('节点调度设置已保存', { exact: true }).waitFor();
    const saved = await getProject();
    assert.equal(saved.workflow.maxParallelNodes, 2);
    assert.equal(saved.workflow.edges.find(value => value.id === edge.id).when, 'approved');
    await page.reload();
    await page.getByRole('button', { name: '工作流设置', exact: true }).click();
    assert.equal(await page.getByRole('form', { name: '工作流调度设置' }).getByPlaceholder('留空为普通依赖，例如 approved').first().inputValue(), 'approved');
  });

  const upload = async (endpoint, field, name, bytes, mime, expected) => {
    const form = new FormData();
    if (endpoint === '/assets/upload') form.append('category', 'world');
    form.append(field, new Blob([bytes], { type: mime }), name);
    return request(`/projects/${projectId}${endpoint}`, 'POST', form, expected);
  };
  await check('valid image uploads are sanitized and serve only reencoded PNG bytes', async () => {
    const encoded = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2; const context = canvas.getContext('2d'); context.fillStyle = '#aabbcc'; context.fillRect(0, 0, 2, 2); return canvas.toDataURL('image/png').split(',')[1]; });
    const marker = Buffer.from('COMPLETION_SMOKE_ORIGINAL_TRAILER');
    const original = Buffer.concat([Buffer.from(encoded, 'base64'), marker]);
    const saved = await upload('/assets/upload', 'files', 'valid.png', original, 'image/png', 201);
    const image = saved.assets.find(value => value.name === 'valid.png');
    assert.equal(image.mime, 'image/png');
    const response = await fetch(`${base}${image.url}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /image\/png/);
    const clean = Buffer.from(await response.arrayBuffer());
    assert.ok(clean.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(clean.includes(marker), false, 'trailing source data stripped');
    assert.notDeepEqual(clean, original);
    assert.equal(image.size, clean.length);
  });
  await check('dangerous upload rejected atomically and PDF explicitly refused', async () => {
    const before = await getProject();
    const rejected = await upload('/assets/upload', 'files', 'disguised.png', Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png', 422);
    assert.equal(rejected.code, 'UPLOAD_UNSAFE');
    assert.equal((await getProject()).assets.length, before.assets.length);
    const pdf = await upload('/documents', 'file', 'unsafe.pdf', Buffer.from('%PDF-1.7\n/JavaScript (app.alert(1))\n%%EOF'), 'application/pdf', 415);
    assert.equal(pdf.code, 'UPLOAD_PDF_DISARM_REQUIRED');
    assert.match(pdf.error, /PDF/);
    assert.equal((await getProject()).assets.length, before.assets.length);
  });
  await check('extension pairing UI reachable with safe disabled input gate', async () => {
    await page.goto(`${base}/platforms/tomato`);
    await page.getByRole('heading', { name: '浏览器扩展配对', exact: true }).waitFor();
    const button = page.getByRole('button', { name: '生成两分钟配对码（撤销旧配对）', exact: true });
    assert.equal(await button.isDisabled(), true);
    await page.getByLabel('扩展 ID', { exact: true }).fill('a'.repeat(32));
    await poll(() => button.isEnabled(), Boolean, 'valid extension input gate');
    assert.deepEqual(await request(`/projects/${projectId}/platform-extension-pairings`), [], 'no actual external pairing started');
  });
  await check('no browser runtime errors or external integration requests', async () => {
    assert.deepEqual(report.browserErrors, []);
    assert.deepEqual(report.externalRequests, []);
  });
  report.passed = report.checks.every(value => value.passed);
} catch (error) {
  report.checks.push({ name: 'isolated production setup', passed: false, error: error.stack || String(error) });
} finally {
  await browser?.close();
  if (server?.pid && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('novel-completion-smoke-'));
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(artifacts, 'report.json')}`);
  if (!report.passed) process.exitCode = 1;
}
