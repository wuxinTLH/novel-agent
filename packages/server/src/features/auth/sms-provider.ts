import { createHash, createHmac, randomUUID } from 'node:crypto';

/** Owner-configured SMS delivery; accepted by the provider does not guarantee handset delivery. */
export interface SmsTransport {
  (message: { to: string; purpose: 'register' | 'login'; code: string }): Promise<void>;
  send(message: { phone: string; code: string }): Promise<void>;
}

const MAX_RESPONSE_BYTES = 16 * 1024;
const SEND_TIMEOUT_MS = 10_000;
const ALI_HOST = 'dysmsapi.aliyuncs.com'; // China-site Dysmsapi 2017-05-25, NOT international 2018 API.
const TENCENT_HOST = 'sms.intl.tencentcloudapi.com';
const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

function configValue(env: NodeJS.ProcessEnv, name: string, pattern: RegExp, maxLength = 256): string {
  const value = env[name];
  if (!value || value.length > maxLength || !pattern.test(value)) throw new Error('SMS_CONFIG_INVALID');
  return value;
}

/** Bound both network wait and response consumption; never expose upstream payloads or errors. */
async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST', headers, body, signal: controller.signal, redirect: 'manual',
    });
    if (!response.ok || !response.body) throw new Error('SMS_SEND_FAILED');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('SMS_SEND_FAILED');
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
      if (!controller.signal.aborted && size > MAX_RESPONSE_BYTES) void response.body.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    // Even timeout or a malformed response might follow an accepted send: never retry here.
    throw new Error('SMS_SEND_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

function validateMessage({ phone, code }: { phone: string; code: string }): void {
  if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone) ||
      typeof code !== 'string' || !/^\d{4,8}$/.test(code)) throw new Error('SMS_MESSAGE_INVALID');
}

function aliyunTransport(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Pick<SmsTransport, 'send'> {
  const id = configValue(env, 'NOVEL_SMS_ALIYUN_ACCESS_KEY_ID', /^[A-Za-z0-9_-]+$/);
  const secret = configValue(env, 'NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET', /^[^\s\x00-\x1f\x7f]+$/);
  const sign = configValue(env, 'NOVEL_SMS_ALIYUN_SIGN_NAME', /^[^\x00-\x1f\x7f<>]+$/, 64);
  const template = configValue(env, 'NOVEL_SMS_ALIYUN_TEMPLATE_CODE', /^SMS_[A-Za-z0-9]+$/, 64);
  return {
    async send(message) {
      validateMessage(message);
      const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const nonce = randomUUID();
      const body = new URLSearchParams({
        PhoneNumbers: message.phone,
        SignName: sign,
        TemplateCode: template,
        TemplateParam: JSON.stringify({ code: message.code }),
      }).toString();
      const contentHash = sha256(body);
      const signedHeaders = 'content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version';
      const canonicalHeaders = `content-type:application/x-www-form-urlencoded
host:${ALI_HOST}
x-acs-action:SendSms
x-acs-content-sha256:${contentHash}
x-acs-date:${date}
x-acs-signature-nonce:${nonce}
x-acs-version:2017-05-25
`;
      const canonicalRequest = `POST
/

${canonicalHeaders}
${signedHeaders}
${contentHash}`;
      const signature = hmac(secret, `ACS3-HMAC-SHA256
${sha256(canonicalRequest)}`).toString('hex');
      const response = await postJson(fetchImpl, `https://${ALI_HOST}/`, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-acs-action': 'SendSms',
        'x-acs-version': '2017-05-25',
        'x-acs-date': date,
        'x-acs-signature-nonce': nonce,
        'x-acs-content-sha256': contentHash,
        authorization: `ACS3-HMAC-SHA256 Credential=${id},SignedHeaders=${signedHeaders},Signature=${signature}`,
      }, body);
      if (!response || typeof response !== 'object' || !('Code' in response) || response.Code !== 'OK') {
        throw new Error('SMS_SEND_FAILED');
      }
    },
  };
}

function tencentTransport(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Pick<SmsTransport, 'send'> {
  const id = configValue(env, 'NOVEL_SMS_TENCENT_SECRET_ID', /^[A-Za-z0-9_-]+$/);
  const secret = configValue(env, 'NOVEL_SMS_TENCENT_SECRET_KEY', /^[^\s\x00-\x1f\x7f]+$/);
  const appId = configValue(env, 'NOVEL_SMS_TENCENT_SDK_APP_ID', /^\d{6,20}$/);
  const sign = configValue(env, 'NOVEL_SMS_TENCENT_SIGN_NAME', /^[^\x00-\x1f\x7f<>]+$/, 64);
  const template = configValue(env, 'NOVEL_SMS_TENCENT_TEMPLATE_ID', /^\d{1,20}$/);
  return {
    async send(message) {
      validateMessage(message);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
      const body = JSON.stringify({ PhoneNumberSet: [message.phone], SmsSdkAppId: appId,
        SignName: sign, TemplateId: template, TemplateParamSet: [message.code] });
      const canonicalRequest = `POST
/

content-type:application/json; charset=utf-8
host:${TENCENT_HOST}

content-type;host
${sha256(body)}`;
      const scope = `${date}/sms/tc3_request`;
      const stringToSign = `TC3-HMAC-SHA256
${timestamp}
${scope}
${sha256(canonicalRequest)}`;
      const signingKey = hmac(hmac(hmac(`TC3${secret}`, date), 'sms'), 'tc3_request');
      const signature = hmac(signingKey, stringToSign).toString('hex');
      const response = await postJson(fetchImpl, `https://${TENCENT_HOST}/`, {
        'content-type': 'application/json; charset=utf-8',
        'x-tc-action': 'SendSms',
        'x-tc-version': '2021-01-11',
        'x-tc-region': 'ap-singapore',
        'x-tc-timestamp': timestamp,
        authorization: `TC3-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      }, body);
      if (!response || typeof response !== 'object' || !('Response' in response) ||
          !response.Response || typeof response.Response !== 'object' ||
          !('SendStatusSet' in response.Response) ||
          !Array.isArray(response.Response.SendStatusSet) ||
          response.Response.SendStatusSet.length !== 1 ||
          response.Response.SendStatusSet[0]?.Code !== 'Ok' ||
          response.Response.SendStatusSet[0]?.PhoneNumber !== message.phone ||
          'Error' in response.Response) throw new Error('SMS_SEND_FAILED');
    },
  };
}

/** Explicit provider only. Missing configuration fails closed; no SMS is sent during construction. */
export function createSmsTransport(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): SmsTransport | undefined {
  if (env.NOVEL_SMS_PROVIDER === undefined || env.NOVEL_SMS_PROVIDER === '') return undefined;
  const transport = env.NOVEL_SMS_PROVIDER === 'aliyun'
    ? aliyunTransport(env, fetchImpl)
    : env.NOVEL_SMS_PROVIDER === 'tencent'
      ? tencentTransport(env, fetchImpl)
      : undefined;
  if (!transport) throw new Error('SMS_CONFIG_INVALID');
  const callable = ((message: { to: string; purpose: 'register' | 'login'; code: string }) => {
    if (message.purpose !== 'register' && message.purpose !== 'login') {
      return Promise.reject(new Error('SMS_MESSAGE_INVALID'));
    }
    return transport.send({ phone: message.to, code: message.code });
  }) as SmsTransport;
  callable.send = (message) => transport.send(message);
  return callable;
}
