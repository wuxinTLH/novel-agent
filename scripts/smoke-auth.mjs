import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { runAdmin, parseAdminArguments } from '../build/server/admin.js';

// Production browser acceptance with disposable local data only. No real database,
// third-party captcha, platform account, credentials or existing data is touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-auth-smoke-'));
const password = `smoke-${randomUUID()}`;
const options = (command, ...args) =>
  parseAdminArguments([command, '--data-dir', data, '--confirm', ...args]);
let child;
let browser;
try {
  const admin = await runAdmin(options('bootstrap-admin', '--username', 'smokeadmin'), {
    NOVEL_BOOTSTRAP_PASSWORD: password,
  });
  assert.ok(admin.ownerId);
  await runAdmin(options('enable-auth', '--no-legacy'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'build/server/index.js')], {
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
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`${base}/api/auth/session`)).ok;
    } catch {}
    if (ready || child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, 'production auth server must start');
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.goto(base);
  const login = async (username) => {
    await page.getByRole('heading', { name: '登录 Novel Agent' }).waitFor();
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  };
  await login('smokeadmin');
  await page.getByRole('button', { name: '用户与登录安全' }).click();
  await page.getByText('服务端密钥未配置', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('启用登录人机验证').isChecked(), false);
  await page.getByLabel('新用户名', { exact: true }).fill('smokewriter');
  await page.getByLabel('初始密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建用户', exact: true }).click();
  await page.getByText('smokewriter · user · 正常', { exact: false }).waitFor();
  // Use the same browser's real session and both CSRF tokens to create private content.
  const privateProject = await page.evaluate(async () => {
    const session = await (await fetch('/api/auth/session')).json();
    const health = await (await fetch('/api/health')).json();
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken,
        'X-Platform-CSRF': health.platform.csrfToken,
      },
      body: JSON.stringify({ title: 'Admin private browser smoke', genre: '奇幻', description: '' }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(privateProject.status, 201);
  await page.reload();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login('smokewriter');
  assert.equal(await page.getByRole('button', { name: '用户与登录安全' }).count(), 0);
  const isolation = await page.evaluate(async (id) => {
    const list = await fetch('/api/projects');
    const detail = await fetch(`/api/projects/${id}`);
    const users = await fetch('/api/auth/users');
    return { list: await list.text(), detail: detail.status, users: users.status };
  }, privateProject.body.id);
  assert.ok(!isolation.list.includes(privateProject.body.id));
  assert.equal(isolation.detail, 404);
  assert.equal(isolation.users, 403);
  await page.reload();
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 Novel Agent' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'production auth boot',
          'anonymous rejection',
          'browser login',
          'superadmin user creation',
          'captcha default off',
          'dual CSRF project write',
          'logout and account switch',
          'cross-tenant list and detail isolation',
          'ordinary-user administration rejection',
          'session survives reload',
          'no browser runtime errors',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  // This is the exact temp directory created above, never a supplied data path.
  assert.equal(path.dirname(data), os.tmpdir());
  assert.ok(path.basename(data).startsWith('novel-auth-smoke-'));
  fs.rmSync(data, { recursive: true, force: true });
}
