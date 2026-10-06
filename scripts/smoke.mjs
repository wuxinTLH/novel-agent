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
  for (let i = 0; i < 50; i++) {
    project = await getProject();
    if (project.candidates.length === 0) break;
    await delay(100);
  }
  assert.equal(project.candidates.length, 0);
  assert.equal(project.chapters[0].revision, 3);
  assert.equal(project.chapters[0].revisions.at(-1).content, '这是一份必须保留的本地原稿。');
  await page.getByRole('button', { name: /^创作工作流$/ }).click();
  await page.getByRole('button', { name: '新建工作流', exact: true }).click();
  const workflowDialog = page.getByRole('dialog', { name: '新建工作流' });
  await workflowDialog.getByLabel('工作流名称', { exact: true }).fill('独立世界观');
  await workflowDialog.getByRole('button', { name: '创建工作流', exact: true }).click();
  await page.getByText('工作流已创建', { exact: true }).waitFor();
  const worldSession = await (await fetch(`${base}/api/platforms/session`)).json();
  const worldProject = await getProject();
  const worldRun = await fetch(`${base}/api/projects/${projectId}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-CSRF': worldSession.csrfToken,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ workflowId: worldProject.activeWorkflowId, target: { kind: 'single', number: 6 } }),
  });
  assert.equal(worldRun.status, 202);
  project = await waitRun();
  assert.equal(project.workflows.at(-1).name, '独立世界观');
  assert.equal(project.chapters.length, 1);
  await page.screenshot({ path: path.join(artifacts, 'chapters.png'), fullPage: true });
  await page.getByRole('button', { name: /^章节书稿(?:\s*\d+)?$/ }).click();
  await page.getByRole('button', { name: '同步此章到草稿', exact: true }).click();
  await page
    .getByText('真实页面适配尚未验收', { exact: false })
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  await page.screenshot({ path: path.join(artifacts, 'platform.png'), fullPage: true });
  const providers = await (await fetch(`${base}/api/platforms/providers`)).json();
  const tomato = providers.find((provider) => provider.id === 'tomato');
  assert.equal(tomato.capabilities.publishChapter, false);
  assert.equal(tomato.capabilities.saveDraft, false);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(badResponses, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        browser: process.env.SMOKE_BROWSER_CHANNEL || 'chromium',
        checks: [
          'production server from alternate cwd',
          'CSRF rejection',
          'workflow settings',
          'single chapter 5',
          'persisted global and chapter requirements',
          'chapter save revision',
          'regeneration preserves original',
          'explicit candidate adoption',
          'reload',
          'platform remains unverified',
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
