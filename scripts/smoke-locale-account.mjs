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

// Run `npm run build` first. This exercises built production code, never dev/user data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-locale-account-'));
const data = path.join(temporary, 'data');
const screenshots = path.join(root, '.tmp-build', 'locale-account');
let server;
let browser;
let stage = 'prepare isolated production deployment';
const errors = [];
const externalRequests = [];
try {
  // index.js resolves .env from its app root: cwd/DATA_DIR alone do not isolate it.
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
  assert.ok(sessionBefore, `isolated server starts (${startupError?.message ?? server.exitCode})`);
  assert.equal(sessionBefore.enabled, false, 'fresh deployment has authentication disabled');
  const getJson = async (url) => {
    const response = await fetch(`${base}${url}`);
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    return response.json();
  };
  const adminStatus = await getJson('/api/admin/status');
  assert.equal(adminStatus.mode, 'local', 'real loopback administration is available');
  assert.equal(adminStatus.authenticationEnabled, false);
  const initialConfig = await getJson('/api/admin/account/config');
  for (const flag of ['registration', 'emailVerification', 'passwordRecovery', 'mfa']) {
    assert.equal(initialConfig[flag], false, `fresh ${flag} is disabled`);
  }
  assert.equal(initialConfig.oidc.enabled, false, 'fresh OIDC is disabled');
  const health = await getJson('/api/health');
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': health.platform.csrfToken },
    body: JSON.stringify({
      title: 'Locale account smoke',
      genre: '科幻',
      description: 'Isolated UI fixture.',
    }),
  });
  assert.ok(created.ok, `isolated project fixture: HTTP ${created.status}`);
  const project = await created.json();

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    locale: 'en-US',
    serviceWorkers: 'block',
  });
  // A deliberately English browser proves the application default is Chinese, not navigator.language.
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${base}/`)) return route.continue();
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    externalRequests.push(url);
    // Locally fulfill optional fonts so no external network or artificial ERR_FAILED noise occurs.
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    return route.abort();
  });
  await page.addInitScript((id) => {
    localStorage.setItem('novel-project', id);
    localStorage.setItem('novel-theme', 'mtf');
  }, project.id);
  const language = () => page.getByRole('combobox', { name: /语言|Language/ });
  const expectLocale = async (locale) => {
    await page.waitForFunction((value) => document.documentElement.lang === value, locale);
    assert.equal(await language().inputValue(), locale, 'language selector matches document language');
  };
  const openAccount = async (heading) => {
    await page.getByRole('button', { name: /^(管理控制台|Admin console)$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: /^(系统与安全|System and security)$/ }).click();
    const account = dialog.locator('form.account-admin');
    await account.getByRole('heading', { name: heading, exact: true }).waitFor();
    return { dialog, account };
  };
  const layout = async (dialog, account, width, expanded) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1050 : 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const documentSize = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(documentSize.scroll <= documentSize.width + 1, `document has no overflow at ${width}px`);
    for (const [name, target] of [
      ['dialog', dialog],
      ['account', account],
    ]) {
      const size = await target.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
      assert.ok(
        size.scroll <= size.client + 1,
        `${name} has no overflow at ${width}px (${expanded ? 'expanded' : 'collapsed'})`,
      );
    }
    const rows = await account.locator('label.account-admin__toggle').evaluateAll((labels) =>
      labels.map((label) => {
        const input = label.querySelector('input');
        const copy = label.querySelector('.account-admin__toggle-copy');
        const a = input.getBoundingClientRect();
        const b = copy.getBoundingClientRect();
        const row = label.getBoundingClientRect();
        return {
          name: input.getAttribute('aria-label'),
          type: input.type,
          inputWidth: a.width,
          inputHeight: a.height,
          horizontalGap: a.left - b.right,
          centerDifference: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)),
          rowLeft: row.left,
          rowRight: row.right,
          inputLeft: a.left,
          inputRight: a.right,
        };
      }),
    );
    assert.equal(rows.length, 5, 'all five feature switches are present');
    for (const row of rows) {
      assert.equal(row.type, 'checkbox', `${row.name}: native checkbox semantics`);
      assert.ok(
        row.inputWidth >= 20 && row.inputWidth <= 64 && row.inputHeight >= 16,
        `${row.name}: compact visible switch at ${width}px`,
      );
      assert.ok(
        row.horizontalGap >= 0,
        `${row.name}: switch sits next to description at ${width}px (gap ${row.horizontalGap})`,
      );
      assert.ok(row.centerDifference <= 2, `${row.name}: vertically centered beside copy at ${width}px`);
      assert.ok(
        row.inputLeft >= row.rowLeft && row.inputRight <= row.rowRight + 1,
        `${row.name}: switch stays inside its row at ${width}px`,
      );
    }
  };

  stage = 'Chinese default and English persistence';
  await page.goto(`${base}/projects`);
  await expectLocale('zh-CN');
  assert.deepEqual(
    await language()
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.value)),
    ['zh-CN', 'en'],
    'supported language options are explicit',
  );
  await language().selectOption('en');
  await expectLocale('en');
  await page.reload();
  await expectLocale('en');

  stage = 'localized account panel and English feature descriptions';
  let { dialog, account } = await openAccount('Account feature configuration');
  const names = [
    'Email-confirmed registration',
    'Email verification',
    'Password recovery',
    'Two-factor authentication',
    'Enable OIDC sign-in',
  ];
  for (const name of names) {
    const control = account.getByRole('switch', { name, exact: true });
    await control.waitFor();
    assert.equal(await control.isChecked(), false, `${name} is off by default`);
  }
  await account
    .getByText('Allow users to link and verify their own email address.', { exact: true })
    .waitFor();
  await account
    .getByText(
      'All features are disabled by default. Email features require server-side SMTP configuration. This does not automatically enable global authentication.',
      { exact: true },
    )
    .waitFor();
  const details = account.locator('details.account-admin__oidc');
  assert.equal(await details.evaluate((element) => element.open), false, 'OIDC details collapsed by default');
  assert.equal(
    await account.getByLabel('Issuer', { exact: true }).isVisible(),
    false,
    'OIDC field hidden initially',
  );
  for (const width of [1440, 390]) await layout(dialog, account, width, false);

  stage = 'OIDC disclosure and desktop/mobile geometry';
  await details.locator('summary').filter({ hasText: 'Connection and secret settings' }).click();
  assert.equal(
    await details.evaluate((element) => element.open),
    true,
    'OIDC details expand without enabling OIDC',
  );
  for (const name of [
    'Issuer',
    'Client ID',
    'Authorization endpoint',
    'Token endpoint',
    'JWKS URL',
    'Redirect URL',
  ]) {
    await account.getByLabel(name, { exact: true }).waitFor({ state: 'visible' });
  }
  await account.locator('label.account-admin__secret input[type=password]').waitFor({ state: 'visible' });
  assert.equal(
    await account.getByRole('switch', { name: 'Enable OIDC sign-in', exact: true }).isChecked(),
    false,
  );
  for (const width of [1440, 390]) {
    await layout(dialog, account, width, true);
    await account.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshots, `${width === 1440 ? 'desktop' : 'mobile'}-english.png`),
      fullPage: true,
    });
  }

  stage = 'dirty-save with real local-admin CSRF and unchanged authentication';
  const save = account.getByRole('button', { name: 'Save configuration', exact: true });
  assert.equal(await save.isDisabled(), true, 'clean config cannot be submitted');
  await account.getByRole('switch', { name: 'Two-factor authentication', exact: true }).check();
  await account.getByText('Unsaved changes', { exact: true }).waitFor();
  assert.equal(await save.isEnabled(), true, 'dirty config can be saved');
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${base}/api/admin/account/config` && response.request().method() === 'PUT',
  );
  await save.click();
  const response = await savedResponse;
  assert.equal(response.status(), 200, 'actual isolated server accepts UI save');
  const headers = await response.request().allHeaders();
  const adminSession = await getJson('/api/admin/session');
  assert.equal(adminSession.mode, 'local');
  assert.ok(adminSession.csrfToken, 'real local admin session provides CSRF');
  assert.equal(headers['x-admin-csrf'], adminSession.csrfToken, 'UI uses local administrator CSRF token');
  assert.equal(headers['x-csrf-token'], undefined, 'no authenticated-user CSRF fallback');
  assert.equal(headers['x-platform-csrf'], undefined, 'platform token is not used for admin save');
  const saved = await response.json();
  assert.equal(saved.mfa, true);
  assert.equal(saved.oidc.enabled, false, 'expanding fields did not enable OIDC');
  assert.deepEqual(
    await getJson('/api/admin/account/config'),
    saved,
    'configuration persisted on real server',
  );
  await account.getByText('Configuration up to date', { exact: true }).waitFor();
  await account.getByRole('status').filter({ hasText: 'Configuration saved.' }).waitFor();
  assert.equal(await save.isDisabled(), true, 'saved configuration is clean');
  assert.deepEqual(
    await getJson('/api/auth/session'),
    sessionBefore,
    'account save never enables global authentication',
  );

  stage = 'saved-state reload and restore Chinese';
  await page.reload();
  await expectLocale('en');
  ({ dialog, account } = await openAccount('Account feature configuration'));
  assert.equal(
    await account.getByRole('switch', { name: 'Two-factor authentication', exact: true }).isChecked(),
    true,
    'saved feature remains enabled after reload',
  );
  assert.equal(
    await account.locator('details.account-admin__oidc').evaluate((element) => element.open),
    false,
    'disabled OIDC is collapsed on fresh mount',
  );
  await page.reload();
  await language().selectOption('zh-CN');
  await expectLocale('zh-CN');
  await page.reload();
  await expectLocale('zh-CN');
  ({ dialog, account } = await openAccount('账户功能配置'));
  await account.getByRole('switch', { name: '邮箱确认注册', exact: true }).waitFor();
  await account.getByRole('button', { name: '保存配置', exact: true }).waitFor();
  for (const width of [1440, 390]) await layout(dialog, account, width, false);
  assert.deepEqual(
    await getJson('/api/auth/session'),
    sessionBefore,
    'restored locale leaves authentication unchanged',
  );
  assert.deepEqual(
    externalRequests.filter((url) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)),
    [],
    'no external integration requests (optional fonts fulfilled locally)',
  );
  // The production CSP already rejects the optional Google Fonts stylesheet before
  // Playwright routing. Match only that known scaffold exception, not other errors.
  const expectedFontCsp = errors.filter(
    (error) =>
      error.includes('https://fonts.googleapis.com/') &&
      error.includes('Content Security Policy') &&
      error.includes('stylesheet'),
  );
  assert.deepEqual(
    errors.filter((error) => !expectedFontCsp.includes(error)),
    [],
    'no browser runtime or console errors beyond the known optional-font CSP block',
  );
  if (expectedFontCsp.length) console.log(`Known optional-font CSP blocks: ${expectedFontCsp.length}`);
  console.log(
    'PASS: isolated production; auth-disabled local admin; default zh-CN; English persisted across reload; localized account switches/descriptions; native switches adjacent/centered at 1440/390; no overflow; collapsed/expanded OIDC; dirty-save with local-admin CSRF; persisted config; unchanged auth; Chinese restored; no external network or browser errors.',
  );
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
  // Verify this invocation's owned mkdtemp target before deleting anything.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('novel-locale-account-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
