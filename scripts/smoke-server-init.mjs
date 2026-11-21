import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Disposable copied deployment only. Dummy SMS credentials are validated but never used to send.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-init-smoke-'));
const data = path.join(temporary, 'data');
const token = 'init-smoke-owner-0123456789abcdef0123456789';
const modelKey = 'init-smoke-model-0123456789abcdef0123456789';
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
let child, browser;
let output = '';
async function stop() {
  if (child && child.exitCode === null) {
    const done = once(child, 'exit');
    child.send({ type: 'novel-agent:shutdown', signal: 'SIGTERM' });
    await Promise.race([done, delay(25000, undefined, { ref: false }).then(() => { throw Error('INIT_SMOKE_STOP_TIMEOUT'); })]);
  }
  child = undefined;
}
async function start(port) {
  output = '';
  child = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], {
    cwd: temporary, env: { ...inherited, CoreModel: 'server', PORT: String(port), DATA_DIR: data,
      NODE_ENV: 'production', NOVEL_INIT_TOKEN: token, MODEL_SECRETS_KEY: modelKey,
      NOVEL_SMS_PROVIDER: 'aliyun', NOVEL_SMS_ALIYUN_ACCESS_KEY_ID: 'dummy-init-id',
      NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET: 'dummy-init-secret', NOVEL_SMS_ALIYUN_SIGN_NAME: 'InitSmoke' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await Promise.race([
    new Promise((resolve, reject) => {
      child.on('message', message => { if (message?.type === 'novel-agent:ready') resolve(); });
      child.once('exit', () => reject(Error('INIT_SMOKE_START_FAILED')));
      child.once('error', reject);
    }),
    delay(60000, undefined, { ref: false }).then(() => { throw Error('INIT_SMOKE_READY_TIMEOUT'); }),
  ]);
}
async function trustedGet(base, route) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + route, { headers: { Host: 'novel.example', Origin: 'https://novel.example' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(Error('INIT_SMOKE_HTTP_TIMEOUT')));
  });
}
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }));
  for (const name of ['build', 'dist']) fs.cpSync(path.join(root, name), path.join(temporary, name), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  await start(port);
  assert.deepEqual(await (await fetch(base + '/api/init/status')).json(), { required: true });
  assert.equal((await fetch(base + '/api/init/config')).status, 401);
  assert.equal((await fetch(base + '/api/projects')).status, 404);
  assert.equal((await fetch(base + '/api/auth/session')).status, 404);
  assert.equal((await fetch(base + '/api/init/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const configResponse = await fetch(base + '/api/init/config', { headers: { 'X-Init-Token': token } });
  const configText = await configResponse.text();
  assert.equal(configText.includes(modelKey), false);
  assert.equal(configText.includes('dummy-init-secret'), false);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(20000);
  const errors = [], business = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page.on('request', request => { const url = new URL(request.url()); if (url.origin === base && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/init/')) business.push(url.pathname); });
  await page.goto(base);
  await page.getByTestId('init-token').fill(token);
  await page.getByTestId('init-load-config').click();
  const field = key => page.getByTestId('init-field-' + key);
  await field('NOVEL_SMS_PROVIDER').waitFor();
  assert.equal(await field('NOVEL_SMS_PROVIDER').inputValue(), 'aliyun');
  assert.equal(await field('MODEL_SECRETS_KEY').inputValue(), '');
  assert.equal(await field('MODEL_SECRETS_KEY').getAttribute('readonly'), '');
  assert.equal(await field('PLATFORM_SECRETS_KEY').inputValue(), '');
  const screenshots = path.join(root, '.tmp-build', 'init-ui'); fs.mkdirSync(screenshots, { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: path.join(screenshots, 'init-' + width + '.png'), fullPage: true });
  }
  await field('NOVEL_TRUSTED_PUBLIC_ORIGIN').fill('https://novel.example');
  await field('PLATFORM_SECRETS_KEY').fill('init-smoke-platform-0123456789abcdef0123456789');
  await field('NOVEL_SMS_ALIYUN_TEMPLATE_CODE').fill('SMS_123456');
  const dbField = key => page.getByTestId('init-db-' + key);
  assert.equal(await dbField('mode').inputValue(), 'local-json');
  await dbField('mode').selectOption('sql-later');
  assert.deepEqual(await dbField('driver').locator('option').evaluateAll(options => options.map(option => option.value).sort()), ['mysql', 'postgresql', 'sqlserver']);
  await dbField('driver').selectOption('postgresql');
  const prospectiveConnection = { driver: 'postgresql', host: 'init-smoke-db.invalid', port: 5432, database: 'init_smoke',
    user: 'init_smoke_user', password: 'dummy-init-db-password', tls: 'verify', timeoutMs: 1000 };
  for (const key of ['host', 'port', 'database', 'user', 'password']) await dbField(key).fill(String(prospectiveConnection[key]));
  await dbField('tls').selectOption('verify');
  await dbField('timeout').fill('1000');
  await page.getByTestId('init-username').fill('initsmokeadmin');
  await page.getByTestId('init-password').fill('Nebula!Quartz-Amber-9716');
  const phoneCode = page.getByTestId('init-phone-code');
  const phone = page.getByTestId('init-phone');
  assert.equal(await phoneCode.inputValue(), '+86');
  assert.deepEqual(await phoneCode.locator('option').evaluateAll(options => options.map(option => option.value)), ['+86', '+1']);
  const submissions = [];
  page.on('request', request => {
    if (request.url() === base + '/api/init/complete') {
      const body = request.postDataJSON();
      submissions.push({ method: request.method(), phone: body.phone });
      assert.deepEqual(body.database, { mode: 'sql-later', connection: prospectiveConnection });
    }
  });
  // A controlled 400 inspects the real browser POST without initializing a second account.
  await page.route('**/api/init/complete', route => route.request().postDataJSON().phone === '+12025550123'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: '{}' }) : route.continue());
  for (const [code, national] of [['+86', '12800000000'], ['+1', '2021550123']]) {
    await phoneCode.selectOption(code); await phone.fill(national);
    await page.getByTestId('init-complete').click();
    assert.equal(await phone.getAttribute('aria-invalid'), 'true');
    await page.locator('#init-phone-error').waitFor();
    assert.deepEqual(submissions, []);
  }
  await phone.fill('2025550123');
  const northAmericaPost = page.waitForResponse(response => response.url() === base + '/api/init/complete');
  await page.getByTestId('init-complete').click();
  assert.equal((await northAmericaPost).status(), 400);
  await page.getByRole('alert').waitFor();
  assert.deepEqual(submissions, [{ method: 'POST', phone: '+12025550123' }]);
  assert.equal(await phone.getAttribute('aria-invalid'), 'false');
  await phoneCode.selectOption('+86'); await phone.fill('13800000000');
  await page.getByTestId('init-complete').click();
  await page.getByTestId('init-restart-required').waitFor();
  assert.deepEqual(submissions, [{ method: 'POST', phone: '+12025550123' }, { method: 'POST', phone: '+8613800000000' }]);
  assert.deepEqual(business, []);
  assert.deepEqual(errors, []);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const secret of [token, modelKey, 'Nebula!', 'dummy-init-secret']) assert.equal(storage.includes(secret), false);
  assert.equal(output.includes(token), false); assert.equal(output.includes(modelKey), false);
  assert.equal(fs.statSync(path.join(data, 'auth.key')).size, 32);
  const assertDeferredDatabase = () => {
    const profiles = JSON.parse(fs.readFileSync(path.join(data, 'storage-profiles.json'), 'utf8'));
    assert.deepEqual(profiles, { version: 3, defaultProfileId: 'init-default',
      profiles: [{ id: 'init-default', connection: prospectiveConnection }], ownerProfiles: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'init-storage.json'), 'utf8')), {
      version: 1, mode: 'sql-later', activeBackend: 'local-json', schemaInitialized: false, sqlActivation: 'deferred-offline',
    });
    assert.equal(fs.existsSync(path.join(data, 'business-storage.json')), false);
  };
  assertDeferredDatabase();
  await browser.close(); browser = undefined;
  await stop();
  await start(port);
  assert.deepEqual((await trustedGet(base, '/api/init/status')).body, { required: false });
  const session = await trustedGet(base, '/api/auth/session'); assert.equal(session.status, 200); assert.equal(session.body.enabled, true);
  assert.equal((await trustedGet(base, '/api/projects')).status, 401);
  assert.equal((await trustedGet(base, '/api/init/config')).status, 401);
  assertDeferredDatabase();
  await stop();
  console.log('PASS isolated Server Init: environment autofill, blank missing fields, hidden secrets, token/origin/business boundaries, responsive UI, complete/manual restart and authenticated startup; no SMS/model calls or TLS claim');
} finally {
  if (browser) await browser.close();
  if (child?.exitCode === null) { try { await stop(); } catch { child?.kill(); } }
  fs.rmSync(temporary, { recursive: true, force: true });
}
