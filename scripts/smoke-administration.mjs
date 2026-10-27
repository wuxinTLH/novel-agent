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

// Real production API + browser UI, with disposable data and no database connections.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-administration-smoke-'));
const password = `smoke-${randomUUID()}`;
const databasePassword = `database-${randomUUID()}`;
let child;
let browser;
const stopServer = async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
};
try {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const startServer = async () => {
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
    assert.ok(ready, 'disposable production server starts within ten seconds');
  };
  await startServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  const open = async () => {
    await page.goto(base);
    await page.getByRole('button', { name: '管理控制台', exact: true }).click();
    await page.getByRole('heading', { name: '管理控制台', exact: true }).waitFor();
  };
  const panel = () => page.getByRole('tabpanel').filter({ visible: true });
  const confirm = async (name) => {
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name, exact: true }).click();
  };
  const authOff = async () => {
    const status = await (await fetch(`${base}/api/auth/session`)).json();
    assert.equal(status.enabled, false, 'admin operations must never enable login authentication');
  };
  await open();
  await authOff();
  await page.getByText('尚未初始化认证', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '创建账号', exact: true }).count(), 0);
  await page.getByRole('tab', { name: '备份与维护' }).click();
  await page.getByRole('heading', { name: '首次创建超级管理员', exact: true }).waitFor();
  await stopServer();
  await runAdmin(
    parseAdminArguments(['bootstrap-admin', '--data-dir', data, '--confirm', '--username', 'smokeadmin']),
    {
      NOVEL_BOOTSTRAP_PASSWORD: password,
    },
  );
  await startServer();
  await open();
  await authOff();
  await panel().getByLabel('用户名', { exact: true }).fill('smokewriter');
  await panel()
    .getByLabel(/^初始密码/)
    .fill(password);
  await panel().getByRole('button', { name: '创建账号', exact: true }).click();
  await confirm('确认创建');
  const row = page.getByRole('row').filter({ hasText: 'smokewriter' });
  await row.waitFor();
  await row.getByRole('button', { name: '停用', exact: true }).click();
  await confirm('确认变更');
  await row.getByText('已停用', { exact: true }).waitFor();
  await row.getByRole('button', { name: '启用', exact: true }).click();
  await confirm('确认变更');
  await row.getByText('正常', { exact: true }).waitFor();
  await row.getByRole('combobox').selectOption('superadmin');
  await confirm('确认变更');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('tr')]
        .find((row) => row.textContent.includes('smokewriter'))
        ?.querySelector('select')?.value === 'superadmin',
  );
  await row.getByRole('button', { name: '重置密码', exact: true }).click();
  await panel()
    .getByLabel(/^新密码/)
    .fill(`changed-${password}`);
  await panel().getByRole('button', { name: '确认重置密码', exact: true }).click();
  await confirm('确认重置');
  await page.getByText('密码已重置，旧会话已撤销。', { exact: true }).waitFor();
  await row.getByRole('button', { name: '会话', exact: true }).click();
  await page.getByText('没有有效会话。', { exact: true }).waitFor();

  await page.getByRole('tab', { name: '数据库', exact: true }).click();
  await panel().getByRole('button', { name: '添加数据库配置', exact: true }).click();
  await panel().getByLabel('数据库用户', { exact: true }).fill('smoke_database_user');
  await panel()
    .getByLabel(/^数据库密码/)
    .fill(databasePassword);
  await panel().getByRole('button', { name: '保存配置与映射', exact: true }).click();
  await confirm('确认已完成离线准备');
  await page
    .getByText('配置已保存；未连接、初始化或迁移数据库，请按离线维护流程生效。', { exact: true })
    .waitFor();
  const storage = await (await fetch(`${base}/api/admin/storage`)).json();
  assert.equal(storage.profiles.length, 1);
  assert.equal(storage.defaultProfileId, storage.profiles[0].id);
  assert.equal(storage.profiles[0].connection.hasPassword, true);
  assert.equal('password' in storage.profiles[0].connection, false);
  assert.ok(!JSON.stringify(storage).includes(databasePassword));
  assert.equal(
    await panel()
      .getByLabel(/^数据库密码/)
      .inputValue(),
    '',
  );

  await page.getByRole('tab', { name: '系统与安全', exact: true }).click();
  await panel().getByText('保持关闭', { exact: true }).waitFor();
  assert.equal(await panel().getByLabel('启用登录人机验证', { exact: true }).isChecked(), false);
  await page.getByRole('tab', { name: '备份与维护' }).click();
  assert.equal(
    await panel()
      .getByRole('button', { name: /恢复|迁移|备份/ })
      .count(),
    0,
    'no online destructive action buttons',
  );
  const commands = await (await fetch(`${base}/api/admin/maintenance`)).json();
  assert.ok(commands.commands.length > 0);
  assert.ok(!JSON.stringify(commands).includes(databasePassword));
  assert.ok(!JSON.stringify(commands).includes(password));
  await page.setViewportSize({ width: 360, height: 780 });
  for (const name of ['用户', '数据库', '备份与维护', '系统与安全']) {
    await page.getByRole('tab', { name, exact: name !== '用户' }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `${name}: no document overflow at 360px`,
    );
  }
  const tab = page.getByRole('tab', { name: '系统与安全', exact: true });
  await tab.focus();
  await page.keyboard.press('Home');
  await page
    .getByRole('tab', { name: /用户/ })
    .getAttribute('aria-selected')
    .then((selected) => assert.equal(selected, 'true'));
  await authOff();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'unconfigured local administration and CLI-only bootstrap guidance',
          'auth stays OFF after CLI bootstrap and web mutations',
          'real UI create, disable, enable, role change, password reset, empty sessions',
          'database config save without connection and password redaction',
          'Turnstile remains disabled',
          'offline-only maintenance commands',
          '360px responsive tabs without document overflow',
          'keyboard tab navigation',
          'no browser runtime errors',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await stopServer();
  // Only remove the exact newly-created disposable directory, never supplied user paths.
  assert.equal(path.dirname(data), os.tmpdir());
  assert.ok(path.basename(data).startsWith('novel-administration-smoke-'));
  fs.rmSync(data, { recursive: true, force: true });
}
