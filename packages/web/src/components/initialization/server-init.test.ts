import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { relevantFields, validInitDraft, initialValues, initRequest, parseInitConfig, parseInitStatus, submissionValues } from './server-init';
import { composeInitPhone, isSupportedInitPhone } from '../../../../../shared/init-phone';
import { serverInitEn, serverInitZhCN } from '../../locals/server-init';

test('only a boolean status can unlock; restart flag survives ready status', () => {
  for (const value of [null, {}, { required: 'false' }, { required: 0 }, { required: false, restartRequired: 'true' }]) assert.throws(() => parseInitStatus(value));
  assert.deepEqual(parseInitStatus({ required: false }), { required: false, restartRequired: false });
  assert.deepEqual(parseInitStatus({ required: false, restartRequired: true }), { required: false, restartRequired: true });
});
test('environment values prefill, secrets never echo, configured environment fields remain read-only', () => {
  const config = parseInitConfig({ fields: [
    { key: 'NOVEL_TRUSTED_PUBLIC_ORIGIN', secret: false, configured: true, value: 'https://novel.example' },
    { key: 'MODEL_SECRETS_KEY', secret: false, configured: true, value: 'must-not-echo' },
    { key: 'NOVEL_SMS_ALIYUN_ACCESS_KEY_ID', secret: false, configured: true, value: 'must-not-echo' },
    { key: 'NOVEL_SMS_PROVIDER', secret: false, configured: false },
  ] });
  assert.equal(config.fields[1].value, undefined);
  assert.equal(config.fields[2].value, undefined);
  assert.equal(config.fields[0].readOnly, true);
  assert.deepEqual(initialValues(config), { NOVEL_TRUSTED_PUBLIC_ORIGIN: 'https://novel.example', MODEL_SECRETS_KEY: '', NOVEL_SMS_ALIYUN_ACCESS_KEY_ID: '', NOVEL_SMS_PROVIDER: '' });
  assert.deepEqual(submissionValues(config, { MODEL_SECRETS_KEY: 'injected', NOVEL_SMS_PROVIDER: 'aliyun', UNLISTED: 'no' }), { NOVEL_SMS_PROVIDER: 'aliyun' });
});
test('malformed config and duplicate fields fail closed', () => {
  const field = { key: 'KEY', secret: false, configured: false };
  for (const value of [{}, { fields: [field, field] }, { fields: [{ ...field, key: '__proto__' }] }, { fields: [{ ...field, secret: undefined }] }]) assert.throws(() => parseInitConfig(value));
});
test('bootstrap transport uses a token header, no-store, no business CSRF or query secrets', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const transport: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return new Response(JSON.stringify({ required: false, restartRequired: true }), { status: 200 });
  };
  await initRequest('status', {}, transport);
  await initRequest('config', { token: 'fixture-token' }, transport);
  await initRequest('complete', { token: 'fixture-token', body: { values: {}, username: 'fixture', phone: '+12025550123', password: 'fixture-only-password' } }, transport);
  assert.deepEqual(calls.map((call) => call.url), ['/api/init/status', '/api/init/config', '/api/init/complete']);
  assert.deepEqual(calls.map((call) => call.options.method), ['GET', 'GET', 'POST']);
  assert.equal(calls[2].options.cache, 'no-store');
  assert.equal(calls[2].options.redirect, 'error');
  assert.deepEqual(calls[1].options.headers, { 'X-Init-Token': 'fixture-token' });
});
test('failed POST is never retried and raw server error never escapes', async () => {
  let count = 0;
  const transport: typeof fetch = async () => { count++; return new Response(JSON.stringify({ error: 'sensitive-raw-message' }), { status: 400 }); };
  await assert.rejects(initRequest('complete', { token: 'fixture' }, transport), { message: 'INIT_REQUEST_FAILED' });
  assert.equal(count, 1);
});
test('gate source maintains mount, secret cleanup, explicit POST and accessibility boundaries', () => {
  const source = readFileSync(new URL('./ServerInitGate.tsx', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8');
  assert.ok(main.indexOf('<ServerInitGate>') < main.indexOf('<AuthGate>'));
  assert.ok(source.includes('if (status.restartRequired)'));
  assert.ok(source.includes("if (phase === 'ready') return children"));
  assert.ok(source.includes("setToken(''); setPassword(''); setValues({}); setConfig(null)"));
  assert.ok(source.includes('onSubmit={complete}'));
  assert.ok(source.includes('lock.current || !config'));
  assert.match(source, /role="alert"/);
  assert.match(source, /htmlFor="init-token"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|URLSearchParams|console./);
});
test('provider filtering and draft validation require only the selected provider', () => {
  const config = parseInitConfig({ fields: [
    { key: 'NOVEL_TRUSTED_PUBLIC_ORIGIN', secret: false, configured: false },
    { key: 'MODEL_SECRETS_KEY', secret: true, configured: false },
    { key: 'PLATFORM_SECRETS_KEY', secret: true, configured: true },
    { key: 'NOVEL_SMS_PROVIDER', secret: false, configured: false },
    { key: 'NOVEL_SMS_ALIYUN_SIGN_NAME', secret: false, configured: false },
    { key: 'NOVEL_SMS_TENCENT_SIGN_NAME', secret: false, configured: false },
  ] });
  const draft = { NOVEL_TRUSTED_PUBLIC_ORIGIN: 'https://novel.example', MODEL_SECRETS_KEY: 'a'.repeat(32), PLATFORM_SECRETS_KEY: '', NOVEL_SMS_PROVIDER: 'aliyun', NOVEL_SMS_ALIYUN_SIGN_NAME: 'fixture' };
  assert.ok(!relevantFields(config, draft).some((field) => field.key === 'NOVEL_SMS_TENCENT_SIGN_NAME'));
  assert.equal(validInitDraft(config, draft, 'admin', '+12025550123', 'a-fixture-long-password'), true);
  for (const invalid of [{ ...draft, NOVEL_TRUSTED_PUBLIC_ORIGIN: 'http://novel.example' }, { ...draft, MODEL_SECRETS_KEY: '' }, { ...draft, NOVEL_SMS_PROVIDER: 'tencent' }]) assert.equal(validInitDraft(config, invalid, 'admin', '+12025550123', 'a-fixture-long-password'), false);
});
test('phone contract composes only supported national formats and validates canonical submission', () => {
  for (const [code, national, expected] of [['+86', '13800138000', '+8613800138000'], ['+86', '19912345678', '+8619912345678'], ['+1', '2025550123', '+12025550123'], ['+1', '9999999999', '+19999999999']]) {
    assert.equal(composeInitPhone(code, national), expected);
    assert.equal(isSupportedInitPhone(expected), true);
  }
  for (const [code, numbers] of [['+86', ['', '12800138000', '1380013800', '138001380000', '+8613800138000', '138 0013 8000', '１３８００１３８０００']], ['+1', ['', '1025550123', '2021550123', '202555012', '20255501234', '+12025550123', '(202)5550123', '202-555-0123']]] as const) {
    for (const national of numbers) assert.equal(composeInitPhone(code, national), null, code + national);
  }
  assert.equal(composeInitPhone('+44', '7700900123'), null);
  for (const phone of ['+447700900123', '+8612800138000', '+11025550123', '+12021550123', '13800138000', ' +12025550123', '+12025550123 ']) assert.equal(isSupportedInitPhone(phone), false, phone);
});
test('shared form keeps national selector, explicit localized errors and canonical submission for live and demo', () => {
  const source = readFileSync(new URL('./ServerInitGate.tsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./InitTestPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /<ServerInitForm/);
  assert.match(source, /data-testid="init-phone-code"/);
  assert.match(source, /data-testid="init-phone" type="tel" inputMode="numeric"/);
  assert.match(source, /phone: e164Phone/);
  assert.ok(source.includes('if (!e164Phone) return'));
  assert.match(source, /aria-invalid={phoneInvalid}/);
  assert.match(source, /id="init-phone-error" role="alert"/);
  assert.doesNotMatch(source, /pattern=/);
});
test('initialization dictionary is static and exactly bilingual', () => {
  assert.deepEqual(Object.keys(serverInitEn).sort(), Object.keys(serverInitZhCN).sort());
  for (const value of Object.values(serverInitEn)) assert.doesNotMatch(value, /[\p{Script=Han}]/u);
});
