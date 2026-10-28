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

// Isolated production UI acceptance. Never accesses existing user data or live platforms.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-projects-ui-'));
const screenshots = path.join(root, '.tmp-build', 'projects-ui');
let server;
let browser;
try {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, 'build/packages/server/src/index.js')], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: data,
      MODEL_API_KEY: '',
      MODEL_SECRETS_KEY: '',
      PLATFORM_SECRETS_KEY: '',
    },
    stdio: 'ignore',
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      ready = (await fetch(`${base}/api/auth/session`)).ok;
    } catch {}
    if (ready || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, 'isolated production server starts');
  const health = await (await fetch(`${base}/api/health`)).json();
  const create = async (body) => {
    const result = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify(body),
    });
    assert.ok(result.ok);
    return result.json();
  };
  const first = await create({
    title: '星海回函验收',
    genre: '科幻冒险',
    description: '在遥远的星海边缘，一封来信让两个人的命运重新交汇。',
  });
  const second = await create({
    title: '长安夜行记',
    genre: '历史传奇',
    description: '灯火照见旧城，一位年轻捕快循着失落的线索，走进长安的秘密。',
  });
  await create({
    title: '山野有风',
    genre: '成长治愈',
    description: '慢下来，在山野之间，重新听见自己的声音。',
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.addInitScript((id) => {
    localStorage.setItem('novel-project', id);
    localStorage.setItem('novel-theme', 'mtf');
  }, first.id);
  await page.goto(`${base}/projects`);
  await page.getByRole('heading', { name: /^全部作品/ }).waitFor();
  await page.getByRole('button', { name: '管理控制台', exact: true }).waitFor();
  await page.getByLabel('排序', { exact: true }).selectOption('title');
  await page.getByLabel('排序', { exact: true }).selectOption('updated');
  const total = await page.locator('.projects-library__card').count();
  assert.ok(total >= 3);
  await page.getByRole('searchbox').fill('星海回函验收');
  await page.waitForFunction(() => document.querySelectorAll('.projects-library__card').length === 1);
  assert.equal(await page.locator('.projects-library__card').count(), 1);
  await page.getByRole('searchbox').fill('不存在的书名');
  await page.getByRole('heading', { name: '没有找到匹配的作品' }).waitFor();
  await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
  await page.getByLabel('类型', { exact: true }).selectOption('genre:历史传奇');
  await page.waitForFunction(() => document.querySelectorAll('.projects-library__card').length === 1);
  assert.equal(await page.locator('.projects-library__card').count(), 1);
  await page.getByRole('button', { name: '打开作品：长安夜行记', exact: true }).click();
  await page.waitForURL(`${base}/workflow`);
  assert.equal(await page.evaluate(() => localStorage.getItem('novel-project')), second.id);
  await page.locator('.workspace-library-link').click();
  await page.waitForURL(`${base}/projects`);
  await page.getByRole('button', { name: '编辑作品设置：星海回函验收', exact: true }).click();
  await page.waitForURL(`${base}/project-settings`);
  assert.equal(await page.evaluate(() => localStorage.getItem('novel-project')), first.id);
  await page.locator('.breadcrumbs').getByRole('button', { name: '全部作品', exact: true }).click();
  await page.getByRole('heading', { name: /^全部作品/ }).waitFor();
  await page.getByRole('button', { name: '新建作品', exact: true }).click();
  await page.getByPlaceholder('为你的故事起个名字').fill('新增作品验收');
  await page.getByRole('dialog').getByRole('button', { name: '创建小说', exact: true }).click();
  await page.waitForURL(`${base}/workflow`);
  await page.locator('.workspace-library-link').click();
  await page.reload();
  await page.getByRole('heading', { name: /^全部作品/ }).waitFor();
  assert.equal(await page.locator('.projects-library__card').count(), total + 1);
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, 'desktop.png'), fullPage: true });
  for (const width of [1100, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await delay(100);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `no viewport overflow at ${width}px`,
    );
    await page.screenshot({ path: path.join(screenshots, `width-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(
    'PASS: local account toolbar, direct/reloaded gallery route, search/empty/filter, selection and edit route, creation, sidebar and breadcrumb entry, responsive widths 1440/1100/768/390, no runtime errors.',
  );
  console.log(`Screenshots: ${screenshots}`);
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  // This directory was created by this exact invocation under the OS temp directory.
  fs.rmSync(data, { recursive: true, force: true });
}
