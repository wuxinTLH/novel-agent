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

// Run `npm run build` first. Real local maintenance, never a user's data/configuration.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-administration-ui-'));
const data = path.join(temporary, 'data');
const screenshots = path.join(root, '.tmp-build', 'admin-ui');
let server;
let browser;
let stage = 'prepare isolated production deployment';
const errors = [];
try {
  // Merely changing cwd does not isolate index.js: it loads appRoot/.env. Copy only
  // built artifacts into a fresh deployment root, with no .env or storage profiles.
  fs.writeFileSync(
    path.join(temporary, 'package.json'),
    JSON.stringify({
      name: 'novel-agent',
      type: 'module',
      workspaces: ['packages/web', 'packages/server'],
    }),
  );
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(temporary, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.mkdirSync(data);
  fs.mkdirSync(screenshots, { recursive: true });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  // Deliberately do not inherit API keys, database credentials, mail or proxy settings.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(
        key.toUpperCase(),
      ),
    ),
  );
  Object.assign(env, {
    PORT: String(port),
    DATA_DIR: data,
    NODE_ENV: 'production',
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
  let sessionBefore;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${base}/api/auth/session`);
      if (response.ok) {
        sessionBefore = await response.json();
        break;
      }
    } catch {}
    if (startupError || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(sessionBefore, `isolated production server starts (${startupError?.message ?? server.exitCode})`);
  assert.equal(sessionBefore.enabled, false, 'fresh isolated deployment has authentication off');
  const health = await (await fetch(`${base}/api/health`)).json();
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
    body: JSON.stringify({
      title: '管理维护隔离验收',
      genre: '科幻',
      description: '只存在于临时数据目录的验收作品。',
    }),
  });
  assert.ok(created.ok, `create real isolated tenant fixture: HTTP ${created.status}`);
  const project = await created.json();

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // No external browser requests, including font CDNs and configured integrations.
  const blocked = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${base}/`)) return route.continue();
    if (!url.startsWith('data:') && !url.startsWith('blob:')) blocked.push(url);
    return route.abort();
  });
  await page.addInitScript((id) => {
    localStorage.setItem('novel-project', id);
    localStorage.setItem('novel-theme', 'mtf');
  }, project.id);
  const noOverflow = async (width, description) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1050 : 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const size = await page.evaluate(() => ({
      actual: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    assert.ok(
      size.actual <= size.viewport + 1,
      `${description}: document overflow at ${width}px (${size.actual}px)`,
    );
  };
  stage = 'open local Administration from top toolbar and verify overview';
  await page.goto(`${base}/projects`);
  await page
    .getByRole('region', { name: '本机模式状态' })
    .getByRole('button', { name: '管理控制台', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '管理控制台', exact: true });
  const overview = dialog.getByRole('tab', { name: '工作台', exact: true });
  const users = dialog.getByRole('tab', { name: /^用户/ });
  const backup = dialog.getByRole('tab', { name: '备份与维护', exact: true });
  await overview.waitFor();
  assert.equal(await overview.getAttribute('aria-selected'), 'true', 'overview is selected by default');
  await dialog.getByRole('heading', { name: '让管理更有条理，让数据更安心。' }).waitFor();
  assert.equal(await dialog.locator('.administration-sidebar').count(), 1, 'new sidebar exists');
  await noOverflow(1440, 'overview');
  const desktopWidth = (await dialog.boundingBox()).width;
  console.log(`Desktop Administration width: ${desktopWidth}px`);
  assert.ok(desktopWidth > 1000, 'desktop Administration uses expanded workspace width');
  await page.screenshot({ path: path.join(screenshots, 'desktop.png'), fullPage: true });

  stage = 'keyboard tab accessibility and unconfigured users explanation';
  const tabs = dialog.getByRole('tab');
  assert.equal(await tabs.count(), 5);
  const checkTab = async (tab) => {
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await tab.getAttribute('tabindex'), '0');
    assert.equal(await tab.evaluate((element) => document.activeElement === element), true);
    const panelId = await tab.getAttribute('aria-controls');
    assert.ok(panelId);
    const panel = page.locator(`[id="${panelId}"]`);
    assert.equal(await panel.getAttribute('role'), 'tabpanel');
    assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'));
    assert.equal(await panel.isVisible(), true);
    assert.equal(
      await tabs.evaluateAll((elements) => elements.filter((element) => element.tabIndex === 0).length),
      1,
    );
  };
  await overview.focus();
  await overview.press('ArrowDown');
  await checkTab(users);
  await dialog
    .getByText('完成 CLI 引导后，刷新状态即可管理用户。登录认证仍保持原有设置。', { exact: true })
    .waitFor();
  assert.equal(await dialog.getByRole('button', { name: '创建账号', exact: true }).count(), 0);
  await users.press('End');
  const system = dialog.getByRole('tab', { name: '系统与安全', exact: true });
  await checkTab(system);
  await system.press('Home');
  await checkTab(overview);
  await overview.press('ArrowLeft');
  await checkTab(system);
  await system.press('ArrowRight');
  await checkTab(overview);

  stage = 'maintenance consent and real local backup';
  await backup.click();
  const maintenance = dialog.getByRole('region', { name: '在线维护任务', exact: true });
  const createBackup = maintenance.getByRole('button', { name: '创建全应用备份', exact: true });
  await createBackup.waitFor();
  assert.equal(await createBackup.isDisabled(), true, 'backup disabled before sensitive-data consent');
  assert.equal(
    await maintenance.getByRole('list', { name: '备份与离线恢复准备步骤' }).locator(':scope > li').count(),
    3,
  );
  const advanced = dialog
    .getByRole('tabpanel', { name: '备份与维护', exact: true })
    .locator('details.administration-advanced');
  assert.equal(
    await advanced.evaluate((element) => element.open),
    false,
    'advanced CLI collapsed by default',
  );
  const validate = maintenance.getByRole('button', { name: '校验完整性', exact: true });
  const plan = maintenance.getByRole('button', { name: '生成离线恢复计划', exact: true });
  assert.equal(await validate.isDisabled(), true, 'validation needs known backup ID');
  assert.equal(await plan.isDisabled(), true, 'restore-plan needs known backup ID');
  await maintenance.getByRole('checkbox', { name: /我确认备份包含密码/ }).check();
  assert.equal(await createBackup.isEnabled(), true);
  const submitTask = async (button, kind) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${base}/api/admin/online-maintenance/tasks` &&
        response.request().method() === 'POST',
    );
    await button.click();
    const response = await responsePromise;
    assert.equal(response.status(), 202, `${kind} accepted by actual isolated server`);
    const task = await response.json();
    assert.equal(task.kind, kind);
    assert.ok(task.id, `${kind} task has real ID`);
    // Observe UI-driven GET polling instead of manufacturing completion or using API fixtures.
    await page.waitForFunction(
      ({ id }) =>
        [...document.querySelectorAll('.online-maintenance-jobs > li')].some(
          (element) =>
            element.textContent.includes(id) &&
            /已完成|安全错误代码|已取消|重启中断/.test(element.textContent),
        ),
      { id: task.id },
      { timeout: 60000 },
    );
    const row = maintenance
      .locator('.online-maintenance-jobs > li')
      .filter({ has: page.locator('code').filter({ hasText: task.id }) });
    const text = await row.innerText();
    assert.match(text, /已完成/, `${kind} completion: ${text}`);
    assert.doesNotMatch(text, /安全错误代码|已取消|重启中断/, `${kind} must succeed`);
    return { task, row };
  };
  const completed = await submitTask(createBackup, 'backup');
  await completed.row.getByRole('button', { name: '选用此备份', exact: true }).click();
  const selection = maintenance.getByRole('combobox', { name: /^选择成功备份/ });
  const backupId = await selection.inputValue();
  assert.match(backupId, /^[0-9a-f-]{36}$/i, 'select actual succeeded backup UUID');
  assert.equal(await selection.locator(`option[value="${backupId}"]`).count(), 1);
  const backupRoot = path.join(temporary, '.data-managed-backups');
  // The UI selection must correspond to a real backup artifact, not merely displayed history.
  assert.ok(fs.existsSync(path.join(backupRoot, backupId)), 'real managed backup exists on disk');
  stage = 'real integrity validation';
  await submitTask(validate, 'validate');
  await maintenance.getByText('此备份最近校验：已完成', { exact: true }).waitFor();
  stage = 'real restore-plan and offline safety copy';
  const planned = await submitTask(plan, 'restore-plan');
  await planned.row.getByText('离线恢复操作计划（必须停服）', { exact: true }).waitFor();
  const safety = await planned.row.innerText();
  assert.match(safety, /停止所有共享数据库运行时/);
  assert.match(safety, /新\/空数据目录及显式可信的空数据库目标/);
  assert.match(safety, /在线计划没有执行任何恢复/);
  assert.match(safety, /完整性校验通过/);
  for (const width of [1440, 768, 390]) await noOverflow(width, 'completed backup/validation/restore-plan');
  await noOverflow(1440, 'backup screenshot');
  await page.screenshot({ path: path.join(screenshots, 'backup.png'), fullPage: true });

  stage = 'advanced CLI expansion and mobile responsiveness';
  await advanced.locator('summary').click();
  assert.equal(await advanced.evaluate((element) => element.open), true);
  await advanced.getByRole('heading', { name: '高级运维 · 服务器命令', exact: true }).waitFor();
  assert.ok((await advanced.locator('pre').count()) > 0, 'server supplied offline commands visible');
  for (const width of [1440, 768, 390]) await noOverflow(width, 'expanded advanced maintenance');
  await page.screenshot({ path: path.join(screenshots, 'mobile.png'), fullPage: true });
  stage = 'auth/session invariant and browser runtime errors';
  const sessionAfter = await (await fetch(`${base}/api/auth/session`)).json();
  assert.deepEqual(
    sessionAfter,
    sessionBefore,
    'GET /api/auth/session unchanged; administration never enables auth',
  );
  // Font blocks are intentional; any other external request is a test failure.
  assert.deepEqual(
    blocked.filter((url) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)),
    [],
    'no external integrations requested',
  );
  assert.deepEqual(
    errors.filter(
      (error) =>
        !(error.includes('https://fonts.googleapis.com/') && error.includes('Content Security Policy')),
    ),
    [],
    'no browser runtime/console errors',
  );
  console.log(
    'PASS: local toolbar, overview/sidebar, keyboard tabs, unconfigured users, consent gate, real backup → UI polling → known success selection → validation → offline restore-plan, collapsed/expanded CLI, 1440/768/390 overflow, unchanged auth/session, no browser runtime errors.',
  );
  console.log(`Screenshots: ${screenshots}`);
} catch (error) {
  console.error(`FAIL [${stage}]: ${error.stack ?? error}`);
  if (errors.length) console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.pid) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  // Verified owned target: only this invocation's mkdtemp directory, not repository data.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('novel-administration-ui-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
