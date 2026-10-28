import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { AuthService } from './auth.js';
import { totp } from './account.js';
import type { AccountMail } from './account-state.js';
const password = 'a very long password 123';
async function setup(fetcher?: typeof fetch, deliver?: () => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-'));
  let now = Date.now();
  const mail: AccountMail[] = [];
  const service = new AuthService({
    dataDir: dir,
    enabled: true,
    now: () => now,
    emailTransport: async (m) => {
      mail.push(m);
      await deliver?.();
    },
    fetch: fetcher,
  });
  service.bootstrapSuperadmin('admin', password);
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
    const body = await r.json();
    return {
      r,
      body,
      cookie:
        r.headers
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
