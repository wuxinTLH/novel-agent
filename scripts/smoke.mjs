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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-production-smoke-'));
const artifacts = path.join(root, 'test-results', 'production-smoke');
fs.mkdirSync(artifacts, { recursive: true });
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(root, 'build/server/index.js')], {
  cwd: os.tmpdir(),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: data,
    MODEL_API_KEY: '',
    MODEL_SECRETS_KEY: '',
    PLATFORM_SECRETS_KEY: '',
  },
  stdio: 'pipe',
});
let logs = '';
child.stdout.on('data', (chunk) => {
  logs += chunk;
});
child.stderr.on('data', (chunk) => {
  logs += chunk;
});
const exited = once(child, 'exit');
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch(`${base}/api/health`)).ok;
    } catch {}
    if (ready || child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, logs);
  const htmlResponse = await fetch(base);
  assert.match(htmlResponse.headers.get('cache-control') || '', /no-cache/);
  const html = await htmlResponse.text();
  const cssPath = html.match(/href="([^"]+\.css)"/)?.[1];
  assert.ok(cssPath, 'production HTML should reference a CSS bundle');
  const cssResponse = await fetch(new URL(cssPath, base));
  assert.match(cssResponse.headers.get('cache-control') || '', /public, max-age=31536000, immutable/);
  assert.equal(
    (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const isolationSession = await (await fetch(`${base}/api/platforms/session`)).json();
  const isolationProjectResponse = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': isolationSession.csrfToken },
    body: JSON.stringify({ title: '工作流隔离测试', genre: '奇幻小说', description: '' }),
  });
  assert.equal(isolationProjectResponse.status, 201);
  let isolationProject = await isolationProjectResponse.json();
  const chapterWorkflow = isolationProject.workflows.find(
    (graph) => graph.id === isolationProject.activeWorkflowId,
  );
  const worldWorkflowResponse = await fetch(`${base}/api/projects/${isolationProject.id}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': isolationSession.csrfToken },
    body: JSON.stringify({ name: '独立世界观', preset: 'world' }),
  });
  assert.equal(worldWorkflowResponse.status, 201);
  isolationProject = await worldWorkflowResponse.json();
  const worldWorkflowId = isolationProject.activeWorkflowId;
  const switchWorkflow = (workflowId) => fetch(
    `${base}/api/projects/${isolationProject.id}/workflows/${workflowId}/select`,
    { method: 'POST', headers: { 'X-Platform-CSRF': isolationSession.csrfToken } },
  );
  let switched = await switchWorkflow(chapterWorkflow.id);
  assert.equal(switched.status, 200);
  isolationProject = await switched.json();
  assert.equal(isolationProject.workflow.name, chapterWorkflow.name);
  assert.deepEqual(isolationProject.steps.map((step) => step.id), chapterWorkflow.steps.map((step) => step.id));
  switched = await switchWorkflow(worldWorkflowId);
  assert.equal(switched.status, 200);
  isolationProject = await switched.json();
  assert.equal(isolationProject.workflow.name, '独立世界观');
  assert.deepEqual(isolationProject.steps.map((step) => step.id), [
    'system-start',
    'world-draft',
    'world-expand',
    'system-end',
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SMOKE_BROWSER_CHANNEL ? { channel: process.env.SMOKE_BROWSER_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const badResponses = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().startsWith(`${base}/api/`) && response.status() >= 400)
      badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.goto(base);
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const assertNeutralTheme = async () => {
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--bg', '--text', '--accent', '--green', '--surface'].map((name) => style.getPropertyValue(name).trim());
    });
    for (const color of colors) {
      assert.match(color, /^#([0-9a-f]{6})$/i);
      assert.equal(color.slice(1, 3), color.slice(3, 5), color);
      assert.equal(color.slice(3, 5), color.slice(5, 7), color);
    }
  };
  await page.getByRole('button', { name: '主题 · 跟随系统' }).waitFor();
  await assertNeutralTheme();
  for (const label of ['极简黑', '极简白', '跟随系统']) {
    await page.getByRole('button', { name: /主题 ·/ }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await page.getByRole('button', { name: `主题 · ${label}`, exact: true }).waitFor();
    await assertNeutralTheme();
    if (label !== '跟随系统') assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()),
      label === '极简黑' ? '#141414' : '#fafafa',
    );
    if (label !== '跟随系统') await page.screenshot({ path: path.join(artifacts, label === '极简黑' ? 'minimal-dark.png' : 'minimal-light.png'), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await assertNeutralTheme();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#141414');
  await page.emulateMedia({ colorScheme: 'light' });
  await assertNeutralTheme();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#fafafa');
  await page.getByRole('button', { name: /主题 ·/ }).click();
  await page.getByRole('menuitem', { name: '蓝粉白', exact: true }).click();
  await page.getByRole('button', { name: '主题 · 蓝粉白', exact: true }).waitFor();
  assert.match(await page.evaluate(() => getComputedStyle(document.body).backgroundImage), /linear-gradient/);
  await page.getByRole('button', { name: /主题 ·/ }).click();
  await page.getByRole('menuitem', { name: '跟随系统', exact: true }).click();
  await page.getByRole('button', { name: '主题 · 跟随系统', exact: true }).waitFor();
  // Registry-driven additions require no React change; failed resources keep the active theme.
  const shippedThemes = await (await fetch(`${base}/themes/themes.json`)).json();
  await page.route('**/themes/themes.json', route => route.fulfill({ json: {
    ...shippedThemes,
    themes: [...shippedThemes.themes,
      { id: 'theme-smoke', name: '注册测试主题', css: 'theme-smoke.css' },
      { id: 'theme-broken', name: '失效测试主题', css: 'theme-broken.css' }],
  } }));
  await page.route('**/themes/theme-smoke.css', route => route.fulfill({ contentType: 'text/css', body: ':root[data-theme="theme-smoke"] { --bg: #123456; }' }));
  await page.route('**/themes/theme-broken.css', route => route.fulfill({ status: 404, body: '' }));
  await page.getByRole('button', { name: /主题 ·/ }).click();
  await page.getByRole('menuitem', { name: '重新加载主题', exact: true }).click();
  await page.getByRole('menuitem', { name: '注册测试主题', exact: true }).click();
  await page.getByRole('button', { name: '主题 · 注册测试主题', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#123456');
  await page.getByRole('button', { name: /主题 ·/ }).click();
  await page.getByRole('menuitem', { name: '失效测试主题', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '样式加载失败' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'theme-smoke');
  await page.unroute('**/themes/themes.json');
  await page.getByRole('menuitem', { name: '重新加载主题', exact: true }).click();
  await page.getByRole('button', { name: '主题 · 跟随系统', exact: true }).waitFor();
  await page.getByRole('button', { name: /主题 ·/ }).click();
  await page.evaluate(() => localStorage.setItem('novel-theme', 'dark'));
  await page.reload();
  await page.getByRole('button', { name: '主题 · 极简黑', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('novel-theme')), 'theme-dark');
  await page.getByRole('button', { name: /主题 ·/ }).click();
  await page.getByRole('menuitem', { name: '跟随系统', exact: true }).click();
  await page.getByRole('button', { name: '主题 · 跟随系统', exact: true }).waitFor();
  const assetProjectId = (await (await fetch(`${base}/api/projects`)).json())[0].id;
  const originalAssetCount = (await (await fetch(`${base}/api/projects/${assetProjectId}`)).json()).assets.length;
  for (const [name, category] of [['烟雨城', 'world'], ['巡夜人', 'characters'], ['城门地图', 'world']]) {
    const created = await fetch(`${base}/api/projects/${assetProjectId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': isolationSession.csrfToken },
      body: JSON.stringify({ name, category, content: '测试设定内容' }),
    });
    assert.equal(created.status, 201);
  }
  const assetsBeforeDelete = (await (await fetch(`${base}/api/projects/${assetProjectId}`)).json()).assets;
  const badDelete = await fetch(`${base}/api/projects/${assetProjectId}/assets/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': isolationSession.csrfToken },
    body: JSON.stringify({ ids: [assetsBeforeDelete[0].id, crypto.randomUUID()] }),
  });
  assert.equal(badDelete.status, 409);
  assert.equal((await (await fetch(`${base}/api/projects/${assetProjectId}`)).json()).assets.length, assetsBeforeDelete.length);
  await page.reload();
  await page.getByRole('button', { name: /小说设定库/ }).click();
  await page.getByRole('button', { name: '世界与地图' }).click();
  await page.getByLabel('选择当前列表全部资料').check();
  assert.match(await page.locator('.asset-bulk-toolbar').innerText(), /已选择 3 \/ /);
  await page.getByLabel('选择当前列表全部资料').uncheck();
  await page.getByRole('button', { name: /全部资料/ }).click();
  await page.getByLabel('选择 烟雨城').check();
  await page.getByLabel('选择 巡夜人').check();
  assert.match(await page.locator('.asset-bulk-toolbar').innerText(), new RegExp(`已选择 2 / ${originalAssetCount + 3} 份`));
  await page.getByRole('button', { name: '删除所选' }).click();
  await page.getByRole('alertdialog', { name: '请确认' }).getByText(/已选中的 2 份资料/).waitFor();
  await page.getByRole('alertdialog', { name: '请确认' }).getByRole('button', { name: '确定' }).click();
  await page.getByLabel('选择 烟雨城').waitFor({ state: 'detached' });
  assert.equal((await (await fetch(`${base}/api/projects/${assetProjectId}`)).json()).assets.length, originalAssetCount + 1);
  await page.getByRole('button', { name: '删除全部' }).click();
  await page.getByRole('alertdialog', { name: '请确认' }).getByText(new RegExp(`全部 ${originalAssetCount + 1} 份资料`)).waitFor();
  await page.getByRole('alertdialog', { name: '请确认' }).getByRole('button', { name: '确定' }).click();
  await page.getByLabel('选择 城门地图').waitFor({ state: 'detached' });
  assert.equal((await (await fetch(`${base}/api/projects/${assetProjectId}`)).json()).assets.length, 0);
  await page.getByRole('button', { name: /^创作工作流$/ }).click();
  await page.locator('.react-flow__node[data-id="outline"]').click();
  await page.getByLabel('结果名称', { exact: false }).fill('剧情结果测试');
  await page.getByLabel('结果名称', { exact: false }).press('Tab');
  await page.getByText('结果名称已更新', { exact: true }).waitFor();
  await page.locator('.react-flow__node[data-id="plan"]').click();
  assert.equal(await page.locator('#node-output-name').inputValue(), '');
  await page.locator('.react-flow__node[data-id="outline"]').click();
  assert.equal(await page.locator('#node-output-name').inputValue(), '剧情结果测试');
  await page.getByRole('button', { name: '工作流设置', exact: true }).click();
  await page
    .getByRole('dialog', { name: '自动化小说工作流' })
    .getByRole('button', { name: '保存工作流', exact: true })
    .click();
  await page.getByText('自动化工作流设置已保存', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^章节书稿(?:\s*\d+)?$/ }).click();
  await page.getByRole('button', { name: '生成章节 / 要求', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '生成章节与创作要求' });
  await modal.getByLabel('本次目标', { exact: true }).selectOption('single');
  await modal.getByLabel('章号', { exact: true }).fill('5');
  await modal.getByLabel('按章保存额外要求', { exact: true }).fill('5');
  await modal.getByLabel('创作要求', { exact: true }).first().fill('使用第三人称，以人物行动推进情节。');
  await modal.getByLabel('创作要求', { exact: true }).last().fill('以一封遗失的信作为线索。');
  await page.screenshot({ path: path.join(artifacts, 'generation.png'), fullPage: true });
  await modal.getByRole('button', { name: '保存要求并开始', exact: true }).click();
  const projects = await (await fetch(`${base}/api/projects`)).json();
  const projectId = projects[0].id;
  const getProject = async () => (await fetch(`${base}/api/projects/${projectId}`)).json();
  const waitRun = async () => {
    for (let i = 0; i < 200; i++) {
      const project = await getProject();
      if (project.run && project.run.status !== 'running') return project;
      await delay(100);
    }
    throw new Error('Generation did not finish.');
  };
  let project = await waitRun();
  assert.equal(project.run.status, 'done', project.run.error);
  assert.deepEqual(
    project.chapters.map((chapter) => chapter.number),
    [5],
  );
  assert.equal(project.chapterRequirements['5'].instructions, '以一封遗失的信作为线索。');
  await page.getByRole('button', { name: /^章节书稿(?:\s*\d+)?$/ }).click();
  await page.getByLabel('章节正文', { exact: true }).waitFor();
  await page.getByLabel('章节正文', { exact: true }).fill('这是一份必须保留的本地原稿。');
  await page.getByRole('button', { name: '保存书稿', exact: true }).click();
  await page.getByRole('button', { name: '保存书稿', exact: true }).waitFor({ state: 'visible' });
  for (let i = 0; i < 50; i++) {
    project = await getProject();
    if (project.chapters[0].content === '这是一份必须保留的本地原稿。') break;
    await delay(100);
  }
  assert.equal(project.chapters[0].revision, 2);
  await page.reload();
  await page.getByRole('button', { name: /^章节书稿(?:\s*\d+)?$/ }).click();
  await page.getByLabel('章节正文', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('章节正文', { exact: true }).inputValue(), '这是一份必须保留的本地原稿。');
  await page.getByRole('button', { name: '重生成此章', exact: true }).click();
  const session = await (await fetch(`${base}/api/platforms/session`)).json();
  const regeneration = await fetch(`${base}/api/projects/${projectId}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-CSRF': session.csrfToken,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      workflowId: project.activeWorkflowId,
      target: { kind: 'single', number: 5 },
      mode: 'regenerate',
      outputWriterNodeId: 'draft',
    }),
  });
  assert.equal(regeneration.status, 202);
  await page.reload();
  project = await waitRun();
  assert.equal(project.run.request.mode, 'regenerate', JSON.stringify(project.run.request));
  assert.equal(project.chapters[0].content, '这是一份必须保留的本地原稿。');
  assert.equal(project.candidates.length, 1);
  await page.getByRole('button', { name: /^章节书稿(?:\s*\d+)?$/ }).click();
  await page.getByRole('button', { name: '对比原稿', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'candidate.png'), fullPage: true });
  await page.getByRole('button', { name: '采用新稿', exact: true }).click();
  await page.getByRole('alertdialog', { name: '请确认' }).getByRole('button', { name: '确定', exact: true }).click();
  for (let i = 0; i < 50; i++) {
    project = await getProject();
    if (project.candidates.length === 0) break;
    await delay(100);
  }
  assert.equal(project.candidates.length, 0);
  assert.equal(project.chapters[0].revision, 3);
  assert.equal(project.chapters[0].revisions.at(-1).content, '这是一份必须保留的本地原稿。');
  await page.getByRole('button', { name: /^创作工作流$/ }).click();
  const createdWorldWorkflow = await fetch(`${base}/api/projects/${projectId}/workflows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-CSRF': session.csrfToken,
    },
    body: JSON.stringify({ name: '独立世界观', preset: 'world' }),
  });
  assert.equal(createdWorldWorkflow.status, 201);
  const worldProject = await createdWorldWorkflow.json();
  const chapterIdsBeforeWorldRun = worldProject.chapters.map((chapter) => chapter.id);
  const worldRun = await fetch(`${base}/api/projects/${projectId}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-CSRF': session.csrfToken,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ workflowId: worldProject.activeWorkflowId, workflowMode: 'world' }),
  });
  assert.equal(worldRun.status, 202);
  project = await waitRun();
  assert.equal(project.workflows.at(-1).name, '独立世界观');
  assert.equal(project.chapters.length, 1);
  assert.deepEqual(project.chapters.map((chapter) => chapter.id), chapterIdsBeforeWorldRun);
  await page.screenshot({ path: path.join(artifacts, 'chapters.png'), fullPage: true });
  await page.getByRole('button', { name: /^章节书稿(?:\s*\d+)?$/ }).click();
  await page.getByRole('button', { name: '同步此章到草稿', exact: true }).click();
  await page
    .getByText('番茄支持人工登录、作者与作品读取、单章草稿保存、回读核验和明确确认后的草稿删除', { exact: false })
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  await page.screenshot({ path: path.join(artifacts, 'platform.png'), fullPage: true });
  const stepNavigation = page.getByRole('navigation', { name: '平台操作步骤' });
  assert.equal(await stepNavigation.getByRole('button', { name: /核验账号/ }).isEnabled(), true);
  assert.equal(await stepNavigation.getByRole('button', { name: /绑定作品/ }).isDisabled(), true);
  assert.equal(await stepNavigation.getByRole('button', { name: /选择章节/ }).isDisabled(), true);
  assert.equal(await stepNavigation.getByRole('button', { name: /预览并批准/ }).isDisabled(), true);
  await stepNavigation.getByRole('button', { name: /核对结果/ }).click();
  await page.getByRole('heading', { name: '草稿操作与核实回执' }).waitFor();
  await stepNavigation.getByRole('button', { name: /核验账号/ }).click();
  await page.getByRole('heading', { name: '平台连接与能力' }).waitFor();
  const providers = await (await fetch(`${base}/api/platforms/providers`)).json();
  const tomato = providers.find((provider) => provider.id === 'tomato');
  assert.equal(tomato.capabilities.publishChapter, false);
  assert.equal(tomato.capabilities.saveDraft, true);
  assert.equal(tomato.capabilities.readDraft, true);
  assert.equal(tomato.capabilities.deleteDraft, true);
  const userService = await (await fetch(`${base}/api/services/user`)).json();
  assert.equal(userService.enabled, false);
  const sqlStatus = await (await fetch(`${base}/api/sqlconnect/status`)).json();
  assert.equal(sqlStatus.storage, 'local-json');
  assert.equal(sqlStatus.configured, false);
  const sqlDrivers = await (await fetch(`${base}/api/sqlconnect/drivers`)).json();
  assert.deepEqual(sqlDrivers.drivers.map(driver => driver.id).sort(), ['mysql', 'postgresql', 'sqlserver']);
  const sqlRejected = await fetch(`${base}/api/sqlconnect/initialize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(sqlRejected.status, 403);
  const assertNoDocumentOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.getByRole('button', { name: /^创作工作流$/ }).click();
  await page.getByRole('button', { name: /主题 ·/ }).click();
  await page.getByRole('menuitem', { name: '蓝粉白', exact: true }).click();
  await page.getByRole('button', { name: '主题 · 蓝粉白', exact: true }).waitFor();
  await page.setViewportSize({ width: 1270, height: 1000 });
  await assertNoDocumentOverflow();
  await page.screenshot({ path: path.join(artifacts, 'desktop-mtf.png'), fullPage: true });
  for (const width of [390, 360, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const navigation of [/^创作工作流$/, /^小说设定库(?:\s*\d+)?$/, /^章节书稿(?:\s*\d+)?$/, /^平台作品$/, /^模型设置$/]) {
      await page.getByRole('button', { name: navigation }).click();
      await assertNoDocumentOverflow();
      if (width === 390) await page.screenshot({ path: path.join(artifacts, `mobile-${navigation.source.includes('创作') ? 'workflow' : navigation.source.includes('设定库') ? 'assets' : navigation.source.includes('章节') ? 'chapters' : navigation.source.includes('平台') ? 'platforms' : 'settings'}.png`), fullPage: true });
    }
  }
  await page.getByRole('heading', { name: 'SQLconnect · 数据库连接' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '初始化数据库', exact: true }).isDisabled(), true);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(badResponses, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        browser: process.env.SMOKE_BROWSER_CHANNEL || 'chromium',
        checks: [
          'production server from alternate cwd',
          'hashed static asset cache headers',
          'CSRF rejection',
          'isolated multi-workflow switching',
          'setting-library filtered multi-select and confirmed batch/delete-all',
          'batch asset deletion rejects unknown IDs without partial changes',
          'neutral light/dark/system themes and OS color-scheme switching',
          'editable node result name persists and stays isolated when switching nodes',
          'registry-driven theme loading, legacy migration and failed CSS preservation',
          'editable result name persists across node selection',
          'registered dormant User service and SQLconnect drivers behind CSRF guards',
          'desktop blue/pink/white composition and mobile 360/390/768px no-overflow pages',
          'workflow settings',
          'single chapter 5',
          'persisted global and chapter requirements',
          'chapter save revision',
          'regeneration preserves original',
          'explicit candidate adoption',
          'reload',
          'platform manual steps gate setup and preview but keep read-only results accessible',
          'platform supports verified draft capabilities and keeps publication disabled',
        ],
        artifacts,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page)
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill();
  await exited;
  fs.rmSync(data, { recursive: true, force: true });
}
