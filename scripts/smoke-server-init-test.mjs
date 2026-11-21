import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Static production assets only: no core, data directory, environment or initialization API.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const api = [], errors = [];
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) { api.push(url.pathname); res.writeHead(500).end(); return; }
  try {
    const relative = url.pathname === '/init-test' ? 'index.html' : decodeURIComponent(url.pathname).split('/').filter(Boolean).join('/');
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end(); }
});
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page.on('request', request => { const u = new URL(request.url()); if (u.pathname.startsWith('/api/')) api.push(u.pathname); });
  await page.goto(base + '/init-test');
  await page.getByTestId('init-token').fill('init-test-dummy-token');
  await page.getByTestId('init-load-config').click();
  await page.getByTestId('init-username').waitFor();
  await page.getByTestId('init-username').fill('demo-admin');
  await page.getByTestId('init-phone-code').selectOption('+86');
  await page.getByTestId('init-phone').fill('13800000000');
  await page.getByTestId('init-password').fill('demo-password-strong-123456');
  await page.getByTestId('init-complete').click();
  assert.equal(await page.getByTestId('init-test-success').count(), 0);
  assert.equal(await page.getByTestId('init-username').isVisible(), true);
  await page.getByRole('alert').waitFor();
  assert.deepEqual(api, []);
  await page.getByTestId('init-test-language').selectOption('en');
  await page.getByRole('heading', { name: 'Test only — no effect' }).waitFor();
  await page.getByTestId('init-test-language').selectOption('zh-CN');
  const origin = page.getByTestId('init-field-NOVEL_TRUSTED_PUBLIC_ORIGIN');
  assert.equal(await origin.inputValue(), 'https://init-test.invalid');
  // Fill every writable field with dummy data according to its contract.
  const fillDummyFields = async () => {
    const fields = page.locator('[data-testid^="init-field-"]');
    for (const field of await fields.all()) {
      if (await field.getAttribute('readonly') !== null) continue;
      const key = (await field.getAttribute('data-testid')).slice('init-field-'.length);
      const value = key === 'NOVEL_TRUSTED_PUBLIC_ORIGIN' ? 'https://demo.example' : key === 'NOVEL_SMS_PROVIDER' ? 'aliyun' : key.includes('SECRETS_KEY') ? key + '-demo-0123456789abcdef0123456789abcdef' : 'demo-value';
      await field.fill(value);
    }
  };
  await fillDummyFields();
  const dbField = key => page.getByTestId('init-db-' + key);
  assert.equal(await dbField('mode').inputValue(), 'local-json');
  await dbField('mode').selectOption('sql-later');
  assert.deepEqual(await dbField('driver').locator('option').evaluateAll(options => options.map(option => option.value).sort()), ['mysql', 'postgresql', 'sqlserver']);
  await dbField('driver').selectOption('sqlserver');
  for (const [key, value] of Object.entries({ host: 'init-demo-db.invalid', port: '1433', database: 'init_demo', user: 'demo_user', password: 'dummy-demo-db-password', timeout: '1000' })) await dbField(key).fill(value);
  await dbField('tls').selectOption('verify');
  assert.equal(await dbField('password').getAttribute('type'), 'password');
  await page.getByTestId('init-username').fill('demo-admin');
  await page.getByTestId('init-phone-code').selectOption('+86');
  await page.getByTestId('init-phone').fill('13800000000');
  await page.getByTestId('init-password').fill('demo-password-strong-123456');
  await fs.mkdir(path.join(root, '.tmp-build/init-test-ui'), { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: path.join(root, '.tmp-build/init-test-ui/test-' + width + '.png'), fullPage: true });
  }
  const phoneCode = page.getByTestId('init-phone-code');
  const phone = page.getByTestId('init-phone');
  assert.deepEqual(await phoneCode.locator('option').evaluateAll(options => options.map(option => option.value)), ['+86', '+1']);
  for (const [code, national] of [['+86', '12800000000'], ['+1', '2021550123']]) {
    await phoneCode.selectOption(code); await phone.fill(national);
    await page.getByTestId('init-complete').click();
    assert.equal(await phone.getAttribute('aria-invalid'), 'true');
    await page.locator('#init-phone-error').waitFor();
    assert.equal(await page.getByTestId('init-test-success').count(), 0);
    assert.deepEqual(api, []);
  }
  await phone.fill('2025550123');
  await page.getByTestId('init-complete').click();
  await page.getByTestId('init-test-success').waitFor();
  assert.deepEqual(api, []);
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  assert.deepEqual(await page.context().cookies(), []);
  await page.getByTestId('init-test-reset').click();
  await page.getByTestId('init-load-config').waitFor();
  assert.equal(await page.getByTestId('init-username').count(), 0);
  await page.getByTestId('init-load-config').click();
  await page.getByTestId('init-username').waitFor();
  assert.equal(await page.getByTestId('init-username').inputValue(), '');
  assert.equal(await phoneCode.inputValue(), '+86');
  assert.equal(await phone.inputValue(), '');
  await fillDummyFields();
  await page.getByTestId('init-username').fill('demo-admin');
  await phone.fill('13800000000');
  await page.getByTestId('init-password').fill('demo-password-strong-123456');
  await page.getByTestId('init-complete').click();
  await page.getByTestId('init-test-success').waitFor();
  assert.deepEqual(api, []);
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  await page.reload();
  await page.getByTestId('init-load-config').waitFor();
  assert.equal(await page.getByTestId('init-username').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.deepEqual(api, []);
  assert.deepEqual(errors, []);
  console.log('Init test page passed: memory-only completion, reload reset, zero API requests, no storage, responsive 1440/768/390.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
