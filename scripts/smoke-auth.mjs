import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

// Production browser acceptance with disposable local data only. No real database,
// third-party captcha, platform account, credentials or existing data is touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-auth-smoke-'));
const data = path.join(temporary, 'data');
const passwords = { smokeadmin: `smoke-admin-${randomUUID()}`, smokewriter: `smoke-writer-${randomUUID()}` };
// Never inherit application configuration, NODE_OPTIONS, or credentials from the host.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
let child;
let browser;
try {
  for (const entry of ['build/packages/server/src/index.js', 'dist/index.html'])
    assert.ok(fs.existsSync(path.join(root, entry)), `Production artifact unavailable: ${entry}; finish npm run build first.`);
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }));
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(data);
  const { runAdmin, parseAdminArguments } = await import(pathToFileURL(path.join(temporary, 'build/packages/server/src/features/administration/admin.js')).href);
  const options = (command, ...args) => parseAdminArguments([command, '--data-dir', data, '--confirm', ...args]);
  const admin = await runAdmin(options('bootstrap-admin', '--username', 'smokeadmin'), {
    NOVEL_BOOTSTRAP_PASSWORD: passwords.smokeadmin,
  });
  assert.ok(admin.ownerId);
  await runAdmin(options('enable-auth', '--no-legacy'), {});
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  const aliasProbe = createServer();
  aliasProbe.listen(0, '127.0.0.1');
  await once(aliasProbe, 'listening');
  const aliasPort = aliasProbe.address().port;
  await Promise.all([probe, aliasProbe].map((server) => new Promise((resolve) => server.close(resolve))));
  const base = `http://127.0.0.1:${port}`;
  const alias = `http://127.0.0.1:${aliasPort}`;
  const startServer = async () => {
    child = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], {
      cwd: temporary,
      env: {
        ...environment,
        NODE_ENV: 'production',
        PORT: String(port),
        DATA_DIR: data,
        GATEWAY_ENABLED: 'true',
        GATEWAY_PORTS: String(aliasPort),
        GATEWAY_TARGET: base,
        MODEL_API_KEY: '',
        MODEL_SECRETS_KEY: '',
        PLATFORM_SECRETS_KEY: '',
      },
      stdio: 'ignore',
    });
    let startupError;
    child.on('error', (error) => { startupError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(`${base}/api/auth/session`)).ok && (await fetch(`${alias}/api/auth/session`)).ok;
      } catch {}
      if (startupError) throw startupError;
      if (ready || child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, 'production auth server must start');
  };
  const stopServer = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
  await startServer();
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().route('**/*', (route) => {
    const url = route.request().url();
    return [base, alias].some((origin) => url.startsWith(`${origin}/`)) ? route.continue() : route.abort();
  });
  await page.goto(base);
  const login = async (username) => {
    await page.getByRole('heading', { name: '登录 Novel Agent' }).waitFor();
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(passwords[username]);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  };
  const seedIdentityCache = async (target = page) => target.evaluate(() => {
    for (const storage of [localStorage, sessionStorage]) {
      storage.setItem('novel-smoke-private', 'private-identity-cache');
      storage.setItem('platform-hidden:smoke', 'private-identity-cache');
      storage.setItem('publication-auto-approve:smoke', 'private-identity-cache');
      storage.setItem('novel-locale', 'zh-CN');
      storage.setItem('smoke-unrelated', 'preserve-me');
    }
  });
  const assertIdentityCacheCleared = async (target = page) => {
    const state = await target.evaluate(() => [localStorage, sessionStorage].map((storage) => ({
      private: ['novel-smoke-private', 'platform-hidden:smoke', 'publication-auto-approve:smoke'].map((key) => storage.getItem(key)),
      locale: storage.getItem('novel-locale'),
      unrelated: storage.getItem('smoke-unrelated'),
    })));
    for (const storage of state) {
      assert.deepEqual(storage.private, [null, null, null], 'identity-owned caches must be cleared');
      assert.equal(storage.locale, 'zh-CN', 'locale survives identity transition');
      assert.equal(storage.unrelated, 'preserve-me', 'unrelated origin storage is not cleared');
    }
  };
  await login('smokeadmin');
  await page.getByRole('button', { name: '管理控制台', exact: true }).click();
  await page.getByRole('tab', { name: '系统与安全', exact: true }).click();
  assert.equal(await page.getByLabel('启用登录人机验证').isChecked(), false);
  await page.getByRole('tab', { name: /用户/ }).click();
  const userPanel = page.getByRole('tabpanel').filter({ visible: true });
  await userPanel.getByLabel('用户名', { exact: true }).fill('smokewriter');
  await userPanel.getByLabel(/^初始密码/).fill(passwords.smokewriter);
  await userPanel.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认创建', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'smokewriter' }).waitFor();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
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
    return { status: response.status, body: await response.json(), csrf: session.csrfToken, platformCsrf: health.platform.csrfToken };
  });
  assert.equal(privateProject.status, 201);
  const aliasPage = await page.context().newPage();
  aliasPage.on('pageerror', (error) => errors.push(error.message));
  let aliasNavigations = 0;
  aliasPage.on('framenavigated', (frame) => { if (frame === aliasPage.mainFrame()) aliasNavigations++; });
  await aliasPage.goto(alias);
  await aliasPage.getByRole('button', { name: '管理控制台', exact: true }).waitFor();
  await aliasPage.getByTitle('smokeadmin', { exact: true }).waitFor();
  assert.equal(await aliasPage.evaluate(async () => (await (await fetch('/api/auth/session')).json()).user.username), 'smokeadmin', 'same-host aliases share the authenticated cookie');
  const revalidateAlias = async () => {
    const checked = aliasPage.waitForResponse((response) => response.url() === `${alias}/api/auth/session` && response.request().method() === 'GET');
    await aliasPage.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal((await checked).status(), 200);
  };
  const sameIdentityNavigations = aliasNavigations;
  const sameIdentityCheck = aliasPage.waitForResponse((response) => response.url() === `${alias}/api/auth/session` && response.request().method() === 'GET');
  await aliasPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await (await sameIdentityCheck).json()).user.username, 'smokeadmin');
  await delay(200);
  assert.equal(aliasNavigations, sameIdentityNavigations, 'same-identity focus does not reload alias app');
  await seedIdentityCache(aliasPage);
  await page.reload();
  await seedIdentityCache();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 Novel Agent' }).waitFor();
  await assertIdentityCacheCleared();
  // Seed again on the anonymous identity to check the login transition independently.
  await seedIdentityCache();
  await login('smokewriter');
  await assertIdentityCacheCleared();
  await revalidateAlias();
  await aliasPage.getByTitle('smokewriter', { exact: true }).waitFor();
  assert.equal(await aliasPage.evaluate(async () => (await (await fetch('/api/auth/session')).json()).user.username), 'smokewriter', 'alias server and rendered identity agree after reload');
  assert.equal(await aliasPage.getByRole('button', { name: '管理控制台', exact: true }).count(), 0, 'alias drops old admin UI after shared cookie changes');
  assert.ok(aliasNavigations > sameIdentityNavigations, 'changed identity reloads alias app');
  await assertIdentityCacheCleared(aliasPage);
  await aliasPage.close();
  assert.equal(await page.getByRole('button', { name: '管理控制台', exact: true }).count(), 0);
  const isolation = await page.evaluate(async (id) => {
    const list = await fetch('/api/projects');
    const detail = await fetch(`/api/projects/${id}`);
    const users = await fetch('/api/auth/users');
    const session = await (await fetch('/api/auth/session')).json();
    const health = await (await fetch('/api/health')).json();
    const foreignWrite = await fetch(`/api/projects/${id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify({ number: 1, title: 'Forbidden', content: 'Must not write', requestId: crypto.randomUUID() }),
    });
    return { list: await list.text(), detail: detail.status, users: users.status, foreignWrite: foreignWrite.status };
  }, privateProject.body.id);
  assert.ok(!isolation.list.includes(privateProject.body.id));
  assert.equal(isolation.detail, 404);
  assert.equal(isolation.users, 403);
  assert.equal(isolation.foreignWrite, 404, 'writer cannot mutate admin project');
  const writerProject = await page.evaluate(async ({ oldCsrf, oldPlatformCsrf, requestId }) => {
    const session = await (await fetch('/api/auth/session')).json();
    const health = await (await fetch('/api/health')).json();
    const write = async (url, csrf, platformCsrf, body) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-Platform-CSRF': platformCsrf },
      body: JSON.stringify(body),
    });
    const input = { title: 'Writer private browser smoke', genre: '科幻', description: 'Writer-owned content' };
    const staleSession = await write('/api/projects', oldCsrf, health.platform.csrfToken, input);
    const staleRuntime = await write('/api/projects', session.csrfToken, oldPlatformCsrf, input);
    const created = await write('/api/projects', session.csrfToken, health.platform.csrfToken, input);
    const project = await created.json();
    if (created.status !== 201) return { status: created.status, body: project };
    const chapter = await write(`/api/projects/${project.id}/chapters`, session.csrfToken, health.platform.csrfToken, {
      number: 1, title: 'Writer-only chapter', content: 'Only this writer owns this private chapter.', requestId,
    });
    return {
      status: created.status, body: project, chapterStatus: chapter.status, updated: await chapter.json(),
      staleSession: staleSession.status, staleRuntime: staleRuntime.status,
      csrf: session.csrfToken, platformCsrf: health.platform.csrfToken,
    };
  }, { oldCsrf: privateProject.csrf, oldPlatformCsrf: privateProject.platformCsrf, requestId: randomUUID() });
  assert.equal(writerProject.status, 201);
  assert.equal(writerProject.chapterStatus, 201);
  assert.equal(writerProject.updated.chapters[0].content, 'Only this writer owns this private chapter.');
  assert.equal(writerProject.staleSession, 403, 'previous identity session CSRF rejected');
  assert.equal(writerProject.staleRuntime, 403, 'previous tenant runtime CSRF rejected');
  await stopServer();
  await startServer();
  await page.reload();
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  const recovered = await page.evaluate(
    async ({ foreignId, ownId }) => ({
      session: await (await fetch('/api/auth/session')).json(),
      foreignStatus: (await fetch(`/api/projects/${foreignId}`)).status,
      ownProject: await (await fetch(`/api/projects/${ownId}`)).json(),
    }),
    { foreignId: privateProject.body.id, ownId: writerProject.body.id },
  );
  assert.equal(recovered.session.user.username, 'smokewriter');
  assert.equal(recovered.foreignStatus, 404);
  assert.equal(recovered.ownProject.chapters[0].content, 'Only this writer owns this private chapter.');
  await seedIdentityCache();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 Novel Agent' }).waitFor();
  await assertIdentityCacheCleared();
  await seedIdentityCache();
  await login('smokeadmin');
  await assertIdentityCacheCleared();
  const reverseIsolation = await page.evaluate(async ({ id, oldCsrf }) => {
    const list = await (await fetch('/api/projects')).json();
    const detail = await fetch(`/api/projects/${id}`);
    const health = await (await fetch('/api/health')).json();
    const session = await (await fetch('/api/auth/session')).json();
    const foreignWrite = await fetch(`/api/projects/${id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify({ number: 2, title: 'Forbidden', content: 'Must not write', requestId: crypto.randomUUID() }),
    });
    const stale = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': oldCsrf, 'X-Platform-CSRF': health.platform.csrfToken },
      body: JSON.stringify({ title: 'Must never be created' }),
    });
    return { ids: list.map((project) => project.id), detail: detail.status, foreignWrite: foreignWrite.status, stale: stale.status };
  }, { id: writerProject.body.id, oldCsrf: writerProject.csrf });
  assert.ok(!reverseIsolation.ids.includes(writerProject.body.id), 'admin list excludes writer private project');
  assert.equal(reverseIsolation.detail, 404, 'admin cannot read writer private project');
  assert.equal(reverseIsolation.foreignWrite, 404, 'admin cannot mutate writer private project');
  assert.equal(reverseIsolation.stale, 403, 'writer CSRF cannot authorize the new admin session');
  const restored = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}`);
    return { status: response.status, body: await response.json() };
  }, privateProject.body.id);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.title, 'Admin private browser smoke');
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
          'production auth boot with ephemeral gateway alias',
          'same-host cross-port session cookie sharing',
          'alias focus/visibility revalidation updates identity and clears old caches',
          'same-identity alias focus does not reload',
          'anonymous rejection',
          'browser login',
          'superadmin user creation',
          'captcha default off',
          'admin and writer dual CSRF private project writes',
          'writer private chapter persists across restart',
          'previous identity session and runtime CSRF rejection',
          'identity-owned cache cleanup with locale and unrelated storage preservation',
          'logout and account switch',
          'bidirectional cross-tenant list and detail isolation',
          'ordinary-user administration rejection',
          'session survives reload',
          'session and tenant isolation survive backend restart',
          'owner project persists across backend restart',
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
  assert.equal(path.dirname(temporary), os.tmpdir());
  assert.ok(path.basename(temporary).startsWith('novel-auth-smoke-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
