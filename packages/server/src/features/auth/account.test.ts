import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { AuthService, type AuthDocument, type AuthPersistence } from './auth.js';
import { totp } from './account.js';
import type { AccountMail } from './account-state.js';
const password = 'a very long password 123';
async function setup(
  fetcher?: typeof fetch,
  deliver?: () => Promise<void>,
  securityProfile?: 'local' | 'server',
  smsDelivery?: ((message: { to: string; purpose: 'register' | 'login'; code: string }) => Promise<void>) | null,
  persistence?: AuthPersistence,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-'));
  let now = Date.now();
  const mail: AccountMail[] = [];
  const sms: { to: string; purpose: 'register' | 'login'; code: string }[] = [];
  const service = new AuthService({
    dataDir: dir,
    enabled: true,
    securityProfile,
    persistence,
    now: () => now,
    smsTransport: securityProfile === 'server' && smsDelivery !== null ?
      Object.assign(async (message: { to: string; purpose: 'register' | 'login'; code: string }) => {
        sms.push(message);
        await smsDelivery?.(message);
      }, { send: async ({ phone, code }: { phone: string; code: string }) => {
        const message = { to: phone, purpose: 'register' as const, code };
        sms.push(message);
        await smsDelivery?.(message);
      } }) : undefined,
    emailTransport: async (m) => {
      mail.push(m);
      await deliver?.();
    },
    fetch: fetcher,
  });
  service.bootstrapSuperadmin('admin', password, securityProfile === 'server' ? '+15551234567' : undefined);
  const app = express();
  app.use(express.json());
  app.use('/auth', service.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const request = (route: string, method = 'GET', body?: unknown, cookie = '', csrf = '') =>
    fetch(`http://127.0.0.1:${addr.port}/auth${route}`, {
      method,
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
  async function pre() {
    const r = await request('/csrf');
    return { cookie: r.headers.getSetCookie()[0].split(';')[0], csrf: (await r.json()).csrfToken as string };
  }
  async function login() {
    const p = await pre();
    const r = await request('/login', 'POST', { username: 'admin', password }, p.cookie, p.csrf);
    let response = r;
    let body = await r.json();
    if (body.smsRequired) {
      const pending = r.headers.getSetCookie().find((v) => v.startsWith('novel_sms='))!.split(';')[0];
      const requested = await request('/account/sms/request', 'POST', {}, `${p.cookie}; ${pending}`, p.csrf);
      assert.equal(requested.status, 202);
      const challenge = requested.headers.getSetCookie().find((v) => v.startsWith('novel_sms='))!.split(';')[0];
      response = await request('/account/sms/verify', 'POST', { code: sms.at(-1)!.code },
        `${p.cookie}; ${challenge}`, p.csrf);
      body = await response.json();
    }
    return {
      r: response,
      body,
      cookie:
        response.headers
          .getSetCookie()
          .find((v) => v.startsWith('novel_session='))
          ?.split(';')[0] ?? '',
      csrf: body.csrfToken as string,
    };
  }
  const admin = await login();
  const config = {
    registration: true,
    emailVerification: true,
    passwordRecovery: true,
    mfa: true,
    publicOrigin: 'https://app.example',
    oidc: {
      enabled: false,
      issuer: '',
      clientId: '',
      authorizationEndpoint: '',
      tokenEndpoint: '',
      jwksUri: '',
      redirectUri: '',
    },
  };
  async function configure(value = config) {
    const r = await request('/account/config', 'PUT', value, admin.cookie, admin.csrf);
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
  }
  return {
    dir,
    service,
    request,
    pre,
    login,
    admin,
    config,
    configure,
    mail,
    sms,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    close: async () => {
      await service.waitForIdle();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('public registration and recovery accept generically on mail failure and revoke uncertain tokens', async () => {
  let failDelivery = false;
  const s = await setup(undefined, async () => {
    if (failDelivery) throw new Error('SMTP unavailable');
  });
  try {
    await s.configure();
    const email = await s.request(
      '/account/email',
      'POST',
      { email: 'admin@example.com' },
      s.admin.cookie,
      s.admin.csrf,
    );
    assert.equal(email.status, 202);
    await s.request(
      '/account/email/complete',
      'POST',
      { token: s.mail.at(-1)!.token },
      s.admin.cookie,
      s.admin.csrf,
    );
    failDelivery = true;
    const p = await s.pre();
    for (const address of ['admin@example.com', 'missing@example.com']) {
      const response = await s.request('/account/recovery', 'POST', { email: address }, p.cookie, p.csrf);
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const failed = s.mail.at(-1)!;
    assert.equal(
      (
        await s.request(
          '/account/recovery/complete',
          'POST',
          {
            token: failed.token,
            password: password + 'new',
          },
          p.cookie,
          p.csrf,
        )
      ).status,
      400,
    );
    for (const username of ['admin', 'newperson']) {
      const response = await s.request(
        '/account/register',
        'POST',
        {
          username,
          email: `${username}@example.com`,
          password,
        },
        p.cookie,
        p.csrf,
      );
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { ok: true });
    }
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8'));
    assert.equal(
      saved.account.tokens.filter((t: { kind: string }) => ['reset', 'register'].includes(t.kind)).length,
      0,
    );
    // Authenticated email updates still surface delivery failures to their owner.
    assert.equal(
      (await s.request('/account/email', 'POST', { email: 'new@example.com' }, s.admin.cookie, s.admin.csrf))
        .status,
      503,
    );
  } finally {
    await s.close();
  }
});
test('server policy covers registration and recovery without consuming reset token on rejected password', async () => {
  const s = await setup(undefined, undefined, 'server');
  try {
    await s.configure();
    const p = await s.pre();
    assert.equal(
      (
        await s.request(
          '/account/register',
          'POST',
          {
            username: 'newperson',
            email: 'person@example.com',
            password: 'a'.repeat(20),
          },
          p.cookie,
          p.csrf,
        )
      ).status,
      400,
    );
    assert.equal(s.mail.length, 0);
    await s.request('/account/email', 'POST', { email: 'admin@example.com' }, s.admin.cookie, s.admin.csrf);
    await s.request(
      '/account/email/complete',
      'POST',
      { token: s.mail.at(-1)!.token },
      s.admin.cookie,
      s.admin.csrf,
    );
    await s.request('/account/recovery', 'POST', { email: 'admin@example.com' }, p.cookie, p.csrf);
    const token = s.mail.at(-1)!.token;
    const reused = await s.request(
      '/account/recovery/complete',
      'POST',
      { token, password },
      p.cookie,
      p.csrf,
    );
    assert.deepEqual(await reused.json(), { error: 'AUTH_PASSWORD_REUSED' });
    assert.equal(
      (
        await s.request(
          '/account/recovery/complete',
          'POST',
          {
            token,
            password: 'a new and distinct secret phrase',
          },
          p.cookie,
          p.csrf,
        )
      ).status,
      200,
    );
    assert.equal((await s.request('/account', 'GET', undefined, s.admin.cookie)).status, 401);
  } finally {
    await s.close();
  }
});
test('maintenance idle waits for actual async mail handler completion', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const s = await setup(undefined, async () => {
    started();
    await gate;
  });
  try {
    await s.configure();
    const p = await s.pre();
    const pending = s.request(
      '/account/register',
      'POST',
      { username: 'waiting', email: 'waiting@example.com', password },
      p.cookie,
      p.csrf,
    );
    await entered;
    let settled = false;
    const idle = s.service.waitForIdle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    assert.equal((await pending).status, 202);
    await idle;
    assert.equal(settled, true);
  } finally {
    release();
    await s.close();
  }
});
test('account features default off and admin configuration enforces CSRF', async () => {
  const s = await setup();
  try {
    const p = await s.pre();
    assert.equal((await s.request('/account/register', 'POST', {}, p.cookie, p.csrf)).status, 404);
    assert.equal((await s.request('/account/config', 'PUT', s.config, s.admin.cookie)).status, 403);
    await s.configure();
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8'));
    assert.equal(saved.account.config.registration, true);
  } finally {
    await s.close();
  }
});
test('registration and verified email recovery tokens are hashed, expiring, single-use; reset revokes sessions', async () => {
  const s = await setup();
  try {
    await s.configure();
    const p = await s.pre();
    const body = { username: 'newuser', email: 'new@example.com', password };
    assert.equal(
      (await s.request('/account/register', 'POST', { ...body, role: 'superadmin' }, p.cookie, p.csrf))
        .status,
      400,
    );
    assert.equal((await s.request('/account/register', 'POST', body)).status, 403);
    assert.equal((await s.request('/account/register', 'POST', body, p.cookie, p.csrf)).status, 202);
    const token = s.mail[0].token;
    assert.ok(!fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8').includes(token));
    assert.equal(
      (await s.request('/account/register/complete', 'POST', { token }, p.cookie, p.csrf)).status,
      201,
    );
    const registered = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8'));
    assert.equal(
      registered.users.find((user: { username: string }) => user.username === 'newuser').role,
      'writer',
    );
    assert.equal(
      (await s.request('/account/register/complete', 'POST', { token }, p.cookie, p.csrf)).status,
      400,
    );
    assert.equal(
      (
        await s.request(
          '/account/email',
          'POST',
          { email: 'admin@example.com' },
          s.admin.cookie,
          s.admin.csrf,
        )
      ).status,
      202,
    );
    const emailToken = s.mail.at(-1)!.token;
    assert.equal(
      (
        await s.request(
          '/account/email/complete',
          'POST',
          { token: emailToken },
          s.admin.cookie,
          s.admin.csrf,
        )
      ).status,
      200,
    );
    assert.equal(
      (await s.request('/account/recovery', 'POST', { email: 'admin@example.com' }, p.cookie, p.csrf)).status,
      202,
    );
    const reset = s.mail.at(-1)!.token;
    assert.equal(
      (
        await s.request(
          '/account/recovery/complete',
          'POST',
          { token: reset, password: password + 'new' },
          p.cookie,
          p.csrf,
        )
      ).status,
      200,
    );
    assert.equal((await s.request('/account', 'GET', undefined, s.admin.cookie)).status, 401);
    assert.equal(
      (await s.request('/account/recovery/complete', 'POST', { token: reset, password }, p.cookie, p.csrf))
        .status,
      400,
    );
    await s.request('/account/recovery', 'POST', { email: 'new@example.com' }, p.cookie, p.csrf);
    const expired = s.mail.at(-1)!.token;
    s.advance(16 * 60000);
    const fresh = await s.pre();
    assert.equal(
      (
        await s.request(
          '/account/recovery/complete',
          'POST',
          { token: expired, password },
          fresh.cookie,
          fresh.csrf,
        )
      ).status,
      400,
    );
  } finally {
    await s.close();
  }
});
test('email replacement revokes reset link for previously verified address', async () => {
  const s = await setup();
  try {
    await s.configure();
    const p = await s.pre();
    const sendEmail = async (address: string) => {
      assert.equal(
        (await s.request('/account/email', 'POST', { email: address }, s.admin.cookie, s.admin.csrf)).status,
        202,
      );
      assert.equal(
        (
          await s.request(
            '/account/email/complete',
            'POST',
            { token: s.mail.at(-1)!.token },
            s.admin.cookie,
            s.admin.csrf,
          )
        ).status,
        200,
      );
    };
    await sendEmail('old@example.com');
    assert.equal(
      (await s.request('/account/recovery', 'POST', { email: 'old@example.com' }, p.cookie, p.csrf)).status,
      202,
    );
    const oldReset = s.mail.at(-1)!.token;
    await sendEmail('new@example.com');
    assert.equal(
      (
        await s.request(
          '/account/recovery/complete',
          'POST',
          { token: oldReset, password: password + 'new' },
          p.cookie,
          p.csrf,
        )
      ).status,
      400,
    );
    assert.equal(
      (await s.request('/account/recovery', 'POST', { email: 'new@example.com' }, p.cookie, p.csrf)).status,
      202,
    );
    assert.equal(
      (
        await s.request(
          '/account/recovery/complete',
          'POST',
          { token: s.mail.at(-1)!.token, password: password + 'new' },
          p.cookie,
          p.csrf,
        )
      ).status,
      200,
    );
  } finally {
    await s.close();
  }
});
test('MFA pending login grants no session; TOTP and recovery codes cannot replay', async () => {
  const s = await setup();
  try {
    await s.configure();
    const setup = await s.request('/account/mfa/setup', 'POST', {}, s.admin.cookie, s.admin.csrf);
    const enrolled = await setup.json();
    const enabled = await s.request(
      '/account/mfa/enable',
      'POST',
      { token: enrolled.token, code: totp(enrolled.secret, Math.floor(s.now() / 30000)) },
      s.admin.cookie,
      s.admin.csrf,
    );
    const { recoveryCodes } = await enabled.json();
    assert.equal(enabled.status, 200);
    assert.equal(recoveryCodes.length, 10);
    assert.ok(!fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8').includes(enrolled.secret));
    assert.ok(!fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8').includes(recoveryCodes[0]));
    const login = await s.login();
    assert.equal(login.body.mfaRequired, true);
    assert.equal((await s.request('/account', 'GET', undefined, login.cookie)).status, 401);
    const pending = login.r.headers
      .getSetCookie()
      .find((v) => v.startsWith('novel_mfa='))!
      .split(';')[0];
    const p = await s.pre();
    assert.equal(
      (await s.request('/account/mfa/verify', 'POST', { code: recoveryCodes[0] }, pending)).status,
      403,
    );
    assert.equal(
      (await s.request('/account/mfa/verify', 'POST', { code: '000000' }, `${pending}; ${p.cookie}`, p.csrf))
        .status,
      401,
    );
    const verified = await s.request(
      '/account/mfa/verify',
      'POST',
      { code: recoveryCodes[0] },
      `${pending}; ${p.cookie}`,
      p.csrf,
    );
    assert.equal(verified.status, 200);
    assert.equal(
      (
        await s.request(
          '/account/mfa/verify',
          'POST',
          { code: recoveryCodes[0] },
          `${pending}; ${p.cookie}`,
          p.csrf,
        )
      ).status,
      401,
    );
    const again = await s.login();
    const pending2 = again.r.headers
      .getSetCookie()
      .find((v) => v.startsWith('novel_mfa='))!
      .split(';')[0];
    assert.equal(
      (
        await s.request(
          '/account/mfa/verify',
          'POST',
          { code: recoveryCodes[0] },
          `${pending2}; ${p.cookie}`,
          p.csrf,
        )
      ).status,
      401,
    );
  } finally {
    await s.close();
  }
});
test('OIDC validates signed JWT issuer audience nonce and browser binding; no auto-link', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test';
  let nonce = '',
    audience = 'client';
  const s = await setup(async (url) => {
    if (String(url).endsWith('/keys'))
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'content-type': 'application/json' },
      });
    const jwt = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('provider-user')
      .setIssuer('https://provider.example')
      .setAudience(audience)
      .setIssuedAt(Math.floor(s.now() / 1000))
      .setExpirationTime(Math.floor(s.now() / 1000) + 300)
      .sign(privateKey);
    return new Response(JSON.stringify({ id_token: jwt }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const c = structuredClone(s.config);
    c.oidc = {
      enabled: true,
      issuer: 'https://provider.example',
      clientId: 'client',
      authorizationEndpoint: 'https://provider.example/authorize',
      tokenEndpoint: 'https://provider.example/token',
      jwksUri: 'https://provider.example/keys',
      redirectUri: 'https://app.example/api/auth/account/oidc/callback',
    };
    await s.configure(c);
    const session = await s.request('/session', 'GET', undefined, s.admin.cookie);
    const id = (await session.json()).user.id;
    assert.equal(
      (
        await s.request(
          `/account/oidc/users/${id}`,
          'PUT',
          { issuer: c.oidc.issuer, subject: 'provider-user' },
          s.admin.cookie,
          s.admin.csrf,
        )
      ).status,
      200,
    );
    const start = async () => {
      const p = await s.pre();
      const r = await s.request('/account/oidc/start', 'POST', {}, p.cookie, p.csrf);
      const url = new URL((await r.json()).url);
      nonce = url.searchParams.get('nonce')!;
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      return { state: url.searchParams.get('state')!, cookie: r.headers.getSetCookie()[0].split(';')[0] };
    };
    const a = await start();
    assert.equal(
      (await s.request(`/account/oidc/callback?state=${a.state}&code=ok`, 'GET', undefined, a.cookie)).status,
      200,
    );
    assert.equal(
      (await s.request(`/account/oidc/callback?state=${a.state}&code=ok`, 'GET', undefined, a.cookie)).status,
      400,
    );
    const b = await start();
    audience = 'wrong';
    assert.equal(
      (await s.request(`/account/oidc/callback?state=${b.state}&code=ok`, 'GET', undefined, b.cookie)).status,
      401,
    );
    const d = await start();
    assert.equal((await s.request(`/account/oidc/callback?state=${d.state}&code=ok`)).status, 401);
    audience = 'client';
    const e = await start();
    nonce = 'wrong-nonce';
    assert.equal(
      (await s.request(`/account/oidc/callback?state=${e.state}&code=ok`, 'GET', undefined, e.cookie)).status,
      401,
    );
    s.advance(16 * 60000);
    const success = await start();
    const navigate = await fetch(
      `http://127.0.0.1:${new URL((await s.request('/csrf')).url).port}/auth/account/oidc/callback?state=${success.state}&code=ok`,
      { headers: { cookie: success.cookie, accept: 'text/html' }, redirect: 'manual' },
    );
    assert.equal(navigate.status, 303);
    assert.equal(navigate.headers.get('location'), '/account/complete?oidc=success');
    assert.ok(!navigate.headers.get('location')?.includes(success.state));
    const expired = await start();
    const failHtml = await fetch(
      `http://127.0.0.1:${new URL((await s.request('/csrf')).url).port}/auth/account/oidc/callback?state=${expired.state}&code=bad`,
      { headers: { accept: 'text/html' }, redirect: 'manual' },
    );
    assert.equal(failHtml.status, 303);
    assert.equal(failHtml.headers.get('location'), '/account/complete?oidc=failed');
  } finally {
    await s.close();
  }
});
test('server registration requires SMS and email proofs; login requires SMS before session', async () => {
  const s = await setup(undefined, undefined, 'server');
  try {
    await s.configure();
    const p = await s.pre();
    const data = { username: 'smsuser', email: 'sms@example.com', phone: '+15557654321',
      password: 'long unique credential for visitor' };
    assert.equal((await s.request('/account/register', 'POST', data, p.cookie, p.csrf)).status, 403);
    const initial = await s.request('/account/register/sms/request', 'POST',
      { username: data.username, email: data.email, phone: data.phone }, p.cookie, p.csrf);
    assert.equal(initial.status, 202);
    assert.ok(initial.headers.getSetCookie().some((v) => v.startsWith('novel_register_sms=')));
    const requested = await s.request('/account/register/sms/request', 'POST',
      { username: data.username, email: data.email, phone: data.phone }, p.cookie, p.csrf);
    assert.equal(requested.status, 429);
    s.advance(16 * 60000);
    const fresh = await s.pre();
    const challenge = await s.request('/account/register/sms/request', 'POST',
      { username: data.username, email: data.email, phone: data.phone }, fresh.cookie, fresh.csrf);
    assert.equal(challenge.status, 202);
    const cookie = challenge.headers.getSetCookie().find((v) => v.startsWith('novel_register_sms='))!.split(';')[0];
    const code = s.sms.at(-1)!.code;
    assert.ok(!fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8').includes(code));
    assert.equal((await s.request('/account/register/sms/verify', 'POST', { code: '999999' },
      `${fresh.cookie}; ${cookie}`, fresh.csrf)).status, 401);
    const proof = await s.request('/account/register/sms/verify', 'POST', { code },
      `${fresh.cookie}; ${cookie}`, fresh.csrf);
    assert.equal(proof.status, 200);
    const proofCookie = proof.headers.getSetCookie().find((v) => v.startsWith('novel_register_sms_proof='))!.split(';')[0];
    const bound = `${fresh.cookie}; ${proofCookie}`;
    assert.equal((await s.request('/account/register', 'POST', data, bound, fresh.csrf)).status, 202);
    const emailToken = s.mail.at(-1)!.token;
    assert.equal((await s.request('/account/register/complete', 'POST', { token: emailToken },
      fresh.cookie, fresh.csrf)).status, 403);
    assert.equal((await s.request('/account/register/complete', 'POST', { token: emailToken },
      bound, fresh.csrf)).status, 201);
    assert.equal((await s.request('/account/register/complete', 'POST', { token: emailToken },
      bound, fresh.csrf)).status, 400);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8'));
    assert.equal(saved.account.profiles.find((profile: { phone?: string }) => profile.phone === data.phone).phoneVerified, true);
    const start = await s.pre();
    const login = await s.request('/login', 'POST', { username: data.username, password: data.password },
      start.cookie, start.csrf);
    assert.deepEqual(await login.json(), { smsRequired: true });
    const pending = login.headers.getSetCookie().find((v) => v.startsWith('novel_sms='))!.split(';')[0];
    assert.equal((await s.request('/account', 'GET', undefined, pending)).status, 401);
    assert.equal((await s.request('/account/sms/request', 'POST', {}, pending)).status, 403);
    const send = await s.request('/account/sms/request', 'POST', {}, `${start.cookie}; ${pending}`, start.csrf);
    assert.equal(send.status, 202);
    const challengeLogin = send.headers.getSetCookie().find((v) => v.startsWith('novel_sms='))!.split(';')[0];
    const verified = await s.request('/account/sms/verify', 'POST', { code: s.sms.at(-1)!.code },
      `${start.cookie}; ${challengeLogin}`, start.csrf);
    assert.equal(verified.status, 200);
    assert.ok((await verified.json()).csrfToken);
    s.advance(16 * 60000);
    const replayCsrf = await s.pre();
    assert.equal((await s.request('/account/sms/verify', 'POST', { code: s.sms.at(-1)!.code },
      `${replayCsrf.cookie}; ${challengeLogin}`, replayCsrf.csrf)).status, 401);
  } finally {
    await s.close();
  }
});
test('server SMS fails closed on provider failure and absent transport', async () => {
  let failDelivery = false;
  const s = await setup(undefined, undefined, 'server', async () => {
    if (failDelivery) throw new Error('provider unavailable');
  });
  try {
    const p = await s.pre();
    const login = await s.request('/login', 'POST', { username: 'admin', password }, p.cookie, p.csrf);
    assert.equal((await login.json()).smsRequired, true);
    const pending = login.headers.getSetCookie().find((v) => v.startsWith('novel_sms='))!.split(';')[0];
    assert.equal((await s.request('/account/sms/verify', 'POST', { code: '123456' },
      `${p.cookie}; ${pending}`, p.csrf)).status, 401);
    s.advance(60001);
    const currentPrelogin = await s.pre();
    failDelivery = true;
    const response = await s.request('/account/sms/request', 'POST', {},
      `${currentPrelogin.cookie}; ${pending}`, currentPrelogin.csrf);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'ACCOUNT_SMS_UNAVAILABLE');
    const current = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8'));
    assert.equal(current.account.tokens.filter((t: { kind: string; payload: { codeHash?: string } }) =>
      t.kind === 'sms-login' && t.payload.codeHash).length, 0);
    assert.equal((await s.request('/account/sms/verify', 'POST', { code: s.sms.at(-1)!.code },
      `${currentPrelogin.cookie}; ${pending}`, currentPrelogin.csrf)).status, 401);
  } finally {
    await s.close();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-no-sms-'));
  const service = new AuthService({ dataDir: dir, enabled: true, securityProfile: 'server' });
  try {
    service.bootstrapSuperadmin('admin', password, '+15551234567');
    const app = express();
    app.use(express.json());
    app.use('/auth', service.router);
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}/auth`;
      const csrf = await fetch(`${base}/csrf`);
      const nonce = (await csrf.json()).csrfToken;
      const cookie = csrf.headers.getSetCookie()[0].split(';')[0];
      const response = await fetch(`${base}/login`, { method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': nonce },
        body: JSON.stringify({ username: 'admin', password }) });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'ACCOUNT_SMS_UNAVAILABLE');
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  } finally {
    await service.waitForIdle();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('SMS codes expire and lock after five wrong attempts', async () => {
  const s = await setup(undefined, undefined, 'server');
  try {
    await s.configure();
    const p = await s.pre();
    const input = { username: 'locked', email: 'locked@example.com', phone: '+15557890001' };
    const first = await s.request('/account/register/sms/request', 'POST', input, p.cookie, p.csrf);
    assert.equal(first.status, 202);
    const cookie = first.headers.getSetCookie().find((v) => v.startsWith('novel_register_sms='))!.split(';')[0];
    const actual = s.sms.at(-1)!.code;
    const wrong = actual === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt++) {
      const rejected = await s.request('/account/register/sms/verify', 'POST', { code: wrong },
        `${p.cookie}; ${cookie}`, p.csrf);
      assert.equal(rejected.status, 401);
    }
    assert.equal((await s.request('/account/register/sms/verify', 'POST', { code: actual },
      `${p.cookie}; ${cookie}`, p.csrf)).status, 401);
    s.advance(16 * 60000);
    const next = await s.pre();
    assert.equal((await s.request('/account/register/sms/verify', 'POST', { code: actual },
      `${next.cookie}; ${cookie}`, next.csrf)).status, 401);
  } finally {
    await s.close();
  }
});
test('server password, SMS and TOTP chain never issues an intermediate session', async () => {
  const s = await setup(undefined, undefined, 'server');
  try {
    await s.configure();
    const enrollment = await s.request('/account/mfa/setup', 'POST', {}, s.admin.cookie, s.admin.csrf);
    assert.equal(enrollment.status, 200);
    const setup = await enrollment.json();
    assert.equal((await s.request('/account/mfa/enable', 'POST',
      { token: setup.token, code: totp(setup.secret, Math.floor(s.now() / 30000)) },
      s.admin.cookie, s.admin.csrf)).status, 200);
    s.advance(16 * 60000);
    const p = await s.pre();
    const login = await s.request('/login', 'POST', { username: 'admin', password }, p.cookie, p.csrf);
    assert.deepEqual(await login.json(), { smsRequired: true });
    const pending = login.headers.getSetCookie().find((v) => v.startsWith('novel_sms='))!.split(';')[0];
    const requested = await s.request('/account/sms/request', 'POST', {}, `${p.cookie}; ${pending}`, p.csrf);
    assert.equal(requested.status, 202);
    const challenge = requested.headers.getSetCookie().find((v) => v.startsWith('novel_sms='))!.split(';')[0];
    const sms = await s.request('/account/sms/verify', 'POST', { code: s.sms.at(-1)!.code },
      `${p.cookie}; ${challenge}`, p.csrf);
    assert.deepEqual(await sms.json(), { mfaRequired: true });
    const mfaCookie = sms.headers.getSetCookie().find((v) => v.startsWith('novel_mfa='))!.split(';')[0];
    assert.equal((await s.request('/account', 'GET', undefined, mfaCookie)).status, 401);
    const verified = await s.request('/account/mfa/verify', 'POST',
      { code: totp(setup.secret, Math.floor(s.now() / 30000) + 1) },
      `${p.cookie}; ${mfaCookie}`, p.csrf);
    assert.equal(verified.status, 200);
    assert.ok((await verified.json()).csrfToken);
  } finally {
    await s.close();
  }
});
test('phone binding and credential revocation commit atomically on persistence failure', async () => {
  let stored: AuthDocument | null = null;
  const readStored = (): AuthDocument | null => stored;
  let fail = false;
  const persistence: AuthPersistence = {
    read: readStored,
    write: (value) => {
      if (fail && value.account?.profiles.some((p) => p.phone === '+15552345678'))
        throw new Error('disk unavailable');
      stored = structuredClone(value);
    },
  };
  const s = await setup(undefined, undefined, 'server', undefined, persistence);
  try {
    const original = JSON.stringify(stored);
    s.advance(60001);
    const request = await s.request('/account/phone/request', 'POST', { phone: '+15552345678' },
      s.admin.cookie, s.admin.csrf);
    assert.equal(request.status, 202);
    const phoneCookie = request.headers.getSetCookie().find((v) => v.startsWith('novel_phone_sms='))!.split(';')[0];
    fail = true;
    const failed = await s.request('/account/phone/verify', 'POST', { code: s.sms.at(-1)!.code },
      `${s.admin.cookie}; ${phoneCookie}`, s.admin.csrf);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'AUTH_STORAGE_UNAVAILABLE');
    assert.ok(!failed.headers.getSetCookie().some((v) => v.startsWith('novel_session=')));
    assert.ok(!readStored()?.account?.profiles.some((p) => p.phone === '+15552345678'));
    assert.equal((await s.request('/account', 'GET', undefined, s.admin.cookie)).status, 200);
    assert.ok(original.includes('+15551234567'));
  } finally {
    await s.close();
  }
});
