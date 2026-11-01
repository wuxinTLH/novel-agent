import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createSmsTransport } from './sms-provider.js';

const aliyunEnv = {
  NOVEL_SMS_PROVIDER: 'aliyun', NOVEL_SMS_ALIYUN_ACCESS_KEY_ID: 'testKey',
  NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET: 'testSecret', NOVEL_SMS_ALIYUN_SIGN_NAME: 'ApprovedSign',
  NOVEL_SMS_ALIYUN_TEMPLATE_CODE: 'SMS_123456',
};
const tencentEnv = {
  NOVEL_SMS_PROVIDER: 'tencent', NOVEL_SMS_TENCENT_SECRET_ID: 'testId',
  NOVEL_SMS_TENCENT_SECRET_KEY: 'testSecret', NOVEL_SMS_TENCENT_SDK_APP_ID: '1400006666',
  NOVEL_SMS_TENCENT_SIGN_NAME: 'ApprovedSign', NOVEL_SMS_TENCENT_TEMPLATE_ID: '1234',
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const acceptedAli = () => new Response(JSON.stringify({ Code: 'OK' }), { status: 200 });
const acceptedTencent = (phone = '+60198890000') => new Response(JSON.stringify({ Response: {
  SendStatusSet: [{ PhoneNumber: phone, Code: 'Ok' }],
} }), { status: 200 });

test('provider remains off without selection and rejects incomplete or unsafe configuration', () => {
  assert.equal(createSmsTransport({}), undefined);
  assert.throws(() => createSmsTransport({ NOVEL_SMS_PROVIDER: 'other' }), /SMS_CONFIG_INVALID/);
  for (const key of Object.keys(aliyunEnv)) {
    if (key === 'NOVEL_SMS_PROVIDER') {
      assert.equal(createSmsTransport({ ...aliyunEnv, [key]: '' }), undefined);
    } else {
      assert.throws(() => createSmsTransport({ ...aliyunEnv, [key]: '' }), /SMS_CONFIG_INVALID/);
    }
  }
  assert.throws(() => createSmsTransport({ ...aliyunEnv, NOVEL_SMS_ALIYUN_SIGN_NAME: 'ok\r\nHost:evil' }), /SMS_CONFIG_INVALID/);
  assert.throws(() => createSmsTransport({ ...tencentEnv, NOVEL_SMS_TENCENT_SECRET_ID: 'id\nAuthorization:evil' }), /SMS_CONFIG_INVALID/);
  assert.throws(() => createSmsTransport({ ...tencentEnv, NOVEL_SMS_TENCENT_TEMPLATE_ID: 'unapproved' }), /SMS_CONFIG_INVALID/);
});

test('Alibaba China RPC SendSms signs POST body with ACS3 and never uses international 2018 API', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, 'https://dysmsapi.aliyuncs.com/');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-acs-action'], 'SendSms');
    assert.equal(headers['x-acs-version'], '2017-05-25');
    const body = String(init?.body);
    const params = new URLSearchParams(body);
    assert.deepEqual(Object.fromEntries(params.entries()), {
      PhoneNumbers: '+60198890000', SignName: 'ApprovedSign',
      TemplateCode: 'SMS_123456', TemplateParam: '{"code":"123456"}',
    });
    const signedHeaders = 'content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version';
    const canonicalHeaders = `content-type:application/x-www-form-urlencoded\nhost:dysmsapi.aliyuncs.com\nx-acs-action:SendSms\nx-acs-content-sha256:${hash(body)}\nx-acs-date:${headers['x-acs-date']}\nx-acs-signature-nonce:${headers['x-acs-signature-nonce']}\nx-acs-version:2017-05-25\n`;
    const canonical = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hash(body)}`;
    const expected = hmac('testSecret', `ACS3-HMAC-SHA256\n${hash(canonical)}`).toString('hex');
    assert.equal(headers['x-acs-content-sha256'], hash(body));
    assert.equal(headers.authorization,
      `ACS3-HMAC-SHA256 Credential=testKey,SignedHeaders=${signedHeaders},Signature=${expected}`);
    return acceptedAli();
  };
  const transport = createSmsTransport(aliyunEnv, fetchImpl)!;
  await transport.send({ phone: '+60198890000', code: '123456' });
  await transport({ to: '+60198890000', purpose: 'register', code: '123456' });
  assert.equal(calls, 2);
  for (const phone of ['+6012,9999', '+6012\nInjected: 1', '60198890000', '+00000000']) {
    await assert.rejects(transport.send({ phone, code: '123456' }), /SMS_MESSAGE_INVALID/);
  }
  await assert.rejects(transport.send({ phone: '+60198890000', code: '123\n456' }), /SMS_MESSAGE_INVALID/);
  assert.equal(calls, 2);
});

test('Tencent international TC3 signs the exact JSON bytes and validates single-recipient acceptance', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, 'https://sms.intl.tencentcloudapi.com/');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-tc-action'], 'SendSms');
    assert.equal(headers['x-tc-version'], '2021-01-11');
    assert.equal(headers['x-tc-region'], 'ap-singapore');
    const body = String(init?.body);
    assert.deepEqual(JSON.parse(body), {
      PhoneNumberSet: ['+60198890000'], SmsSdkAppId: '1400006666',
      SignName: 'ApprovedSign', TemplateId: '1234', TemplateParamSet: ['123456'],
    });
    const timestamp = headers['x-tc-timestamp'];
    const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
    const scope = `${date}/sms/tc3_request`;
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:sms.intl.tencentcloudapi.com\n\ncontent-type;host\n${hash(body)}`;
    const signingKey = hmac(hmac(hmac('TC3testSecret', date), 'sms'), 'tc3_request');
    assert.equal(headers.authorization, `TC3-HMAC-SHA256 Credential=testId/${scope}, SignedHeaders=content-type;host, Signature=${hmac(signingKey, `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString('hex')}`);
    return acceptedTencent();
  };
  const send = createSmsTransport(tencentEnv, fetchImpl)!;
  await send({ to: '+60198890000', purpose: 'login', code: '123456' });
  assert.equal(calls, 1);
});

test('both providers reject non-acceptance, malformed payload, oversized reply, timeout, and never retry', async () => {
  for (const env of [aliyunEnv, tencentEnv]) {
    const responses = env.NOVEL_SMS_PROVIDER === 'aliyun'
      ? [new Response(JSON.stringify({ Code: 'FAILED', Message: 'secret 123456 +60198890000' })),
         new Response(JSON.stringify({ Code: 'OK' }), { status: 503 })]
      : [new Response(JSON.stringify({ Response: { Error: { Code: 'Rejected' }, SendStatusSet: [{ Code: 'Ok' }] } })),
         acceptedTencent('+18001234567')];
    responses.push(new Response('{not-json'));
    responses.push(new Response('x'.repeat(16_385)));
    for (const response of responses) {
      let calls = 0;
      const transport = createSmsTransport(env, async () => { calls++; return response; })!;
      await assert.rejects(transport.send({ phone: '+60198890000', code: '123456' }), (error: Error) => {
        assert.equal(error.message, 'SMS_SEND_FAILED');
        assert.doesNotMatch(error.message, /secret|123456|60198890000/);
        return true;
      });
      assert.equal(calls, 1);
    }
    const transport = createSmsTransport(env, async () => { throw new Error('secret +60198890000'); })!;
    await assert.rejects(transport.send({ phone: '+60198890000', code: '123456' }), /SMS_SEND_FAILED/);
    let aborts = 0;
    const timed = createSmsTransport(env, async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborts++; reject(new Error('secret')); }, { once: true });
    }))!;
    await assert.rejects(timed.send({ phone: '+60198890000', code: '123456' }), /SMS_SEND_FAILED/);
    assert.equal(aborts, 1);
  }
});
