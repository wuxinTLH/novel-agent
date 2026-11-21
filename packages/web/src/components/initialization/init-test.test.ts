import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createInitTestSession, INIT_TEST_TOKEN, isInitTestPath } from './init-test';
import { initialValues, parseInitConfig, parseInitStatus, submissionValues, validInitDraft } from './server-init';

const account = { username: 'dummy-admin', phone: '+12025550123', password: 'Dummy-only-password-476!' };
const missing = { PLATFORM_SECRETS_KEY: 'dummy-platform-key-not-real-123456789', NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET: 'dummy-sms-secret', NOVEL_SMS_ALIYUN_SIGN_NAME: 'dummy-sign', NOVEL_SMS_ALIYUN_TEMPLATE_CODE: 'dummy-template' };

test('demo matches only the exact /init-test pathname', () => {
  assert.equal(isInitTestPath('/init-test'), true);
  for (const path of ['/', '/init', '/INIT-TEST', '/init-test/', '/init-test/child', '/workflow', '/init-test?demo=1']) assert.equal(isInitTestPath(path), false);
});
test('dummy partial configuration preserves masking, read-only fields and missing-field validation', async () => {
  const session = createInitTestSession();
  assert.deepEqual(parseInitStatus(await session.request('status')), { required: true, restartRequired: false });
  await assert.rejects(session.request('config', { token: 'wrong-token' }), { status: 403 });
  const config = parseInitConfig(await session.request('config', { token: INIT_TEST_TOKEN }));
  const values = initialValues(config);
  assert.equal(values.NOVEL_TRUSTED_PUBLIC_ORIGIN, 'https://init-test.invalid');
  assert.equal(values.MODEL_SECRETS_KEY, '');
  assert.equal(config.fields.find((field) => field.key === 'MODEL_SECRETS_KEY')?.readOnly, true);
  assert.equal(values.PLATFORM_SECRETS_KEY, '');
  assert.equal(validInitDraft(config, values, account.username, account.phone, account.password), false);
  assert.equal(validInitDraft(config, { ...values, ...missing }, account.username, account.phone, account.password), true);
  for (const invalid of [{ ...missing, PLATFORM_SECRETS_KEY: 'short' }, { ...missing, NOVEL_SMS_ALIYUN_SIGN_NAME: '' }]) {
    await assert.rejects(session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, values: invalid } }), { status: 400 });
  }
  await assert.rejects(session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, password: 'short', values: missing } }), { status: 400 });
  assert.deepEqual(submissionValues(config, { ...values, ...missing }), missing);
});
test('demo rejects invalid regional phones and accepts composed mainland China and NANP phones', async () => {
  for (const phone of ['+8612800138000', '+11025550123', '+12021550123', '+447700900123', '13800138000']) {
    const session = createInitTestSession();
    await assert.rejects(session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, phone, values: missing } }), { status: 400 });
    assert.equal(parseInitStatus(await session.request('status')).required, true);
  }
  for (const phone of ['+8613800138000', '+12025550123']) {
    const session = createInitTestSession();
    assert.deepEqual(await session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, phone, values: missing } }), { required: false, restartRequired: true });
  }
});
test('demo SQL validates only configuration and never initializes or activates a database', async () => {
  const session = createInitTestSession();
  const config = parseInitConfig(await session.request('config', { token: INIT_TEST_TOKEN }));
  assert.equal(config.database?.activeBackend, 'local-json');
  assert.equal(config.database?.schemaInitialized, false);
  const connection = { driver: 'sqlserver', host: 'offline.invalid', port: 1433, database: 'fixture', user: 'dummy', tls: 'verify', timeoutMs: 10000 };
  await assert.rejects(session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, values: missing, database: { mode: 'sql-later', connection: { ...connection, port: 0 } } } }), { status: 400 });
  assert.deepEqual(await session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, values: missing, database: { mode: 'sql-later', connection } } }), { required: false, restartRequired: true });
  assert.equal(config.database?.activeBackend, 'local-json');
  assert.equal(config.database?.schemaInitialized, false);
});
test('completion changes only one session phase; fresh session resets and aborted calls do nothing', async () => {
  const session = createInitTestSession();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(session.request('complete', { signal: controller.signal, token: INIT_TEST_TOKEN, body: { ...account, values: missing } }), { name: 'AbortError' });
  assert.equal(parseInitStatus(await session.request('status')).required, true);
  assert.deepEqual(await session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, values: missing } }), { required: false, restartRequired: true });
  assert.equal(parseInitStatus(await session.request('status')).restartRequired, true);
  await assert.rejects(session.request('complete', { token: INIT_TEST_TOKEN, body: { ...account, values: missing } }), { status: 409 });
  assert.equal(parseInitStatus(await createInitTestSession().request('status')).required, true);
});
test('demo dependency and entrypoint boundaries exclude real transport, storage and authenticated children', () => {
  const fixture = readFileSync(new URL('./init-test.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./InitTestPage.tsx', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(fixture + page, /localStorage|sessionStorage|process\.env|import\.meta\.env|fetch\(|initRequest\(|useLocale|<AuthGate|<App\s|<DialogProvider/);
  assert.match(main, /isInitTestPath\(window\.location\.pathname\) \? <InitTestPage \/> : <DialogProvider>/);
  assert.match(page, /key=\{session\.generation\}/);
  assert.match(page, /init-test-banner/);
  assert.match(page, /init-test-reset/);
});
