import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Request } from 'express';
import { AuthService, bootstrapSuperadmin, type AuthDocument, type AuthPersistence } from './auth.js';

const password = 'a long test password 123!';
async function setup(options: { ttl?: number; fetch?: typeof fetch; persistence?: AuthPersistence } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-auth-'));
  let now = Date.now();
  const service = new AuthService({
    dataDir: dir,
    enabled: true,
    sessionTtlMs: options.ttl,
    now: () => now,
    fetch: options.fetch,
    persistence: options.persistence,
  });
  service.bootstrapSuperadmin('admin', password);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', service.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/auth`;
  async function request(route: string, method = 'GET', body?: unknown, cookies = '', csrf = '') {
    return fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookies, 'x-csrf-token': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login(name = 'admin', pwd = password, turnstileToken?: string) {
    const pre = await request('/csrf');
    const { csrfToken } = await pre.json();
    const preCookie = pre.headers.getSetCookie()[0].split(';')[0];
    const response = await request(
      '/login',
      'POST',
      { username: name, password: pwd, turnstileToken },
      preCookie,
      csrfToken,
    );
    const result = await response.json();
    return {
      response,
      result,
      cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? '',
      csrf: result.csrfToken as string,
    };
  }
  return {
    dir,
    service,
    request,
    login,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('auth defaults off, ignores client identity, and does not create files', async () => {
  const dir = path.join(os.tmpdir(), `absent-auth-${Date.now()}`);
  const service = new AuthService({ dataDir: dir });
  assert.equal(service.status().enabled, false);
  assert.equal(service.hasSuperadmin(), false);
  const app = express();
  app.use('/api/auth', service.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/auth`;
    const status = await fetch(`${base}/session`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).enabled, false);
    assert.equal((await fetch(`${base}/csrf`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  assert.equal(await service.resolve({ headers: { 'x-user-id': 'admin' } } as unknown as Request), null);
  assert.equal(fs.existsSync(dir), false);
});
test('local bootstrap uses scrypt and only permits initial superadmin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-bootstrap-'));
  try {
    assert.throws(
      () => bootstrapSuperadmin({ dataDir: dir, username: 'admin', password: 'short' }),
      /AUTH_PASSWORD_INVALID/,
    );
    const user = bootstrapSuperadmin({ dataDir: dir, username: 'Admin', password });
    assert.equal(user.username, 'admin');
    assert.equal(user.role, 'superadmin');
    assert.equal(new AuthService({ dataDir: dir, enabled: true }).hasSuperadmin(), true);
    assert.throws(
      () => bootstrapSuperadmin({ dataDir: dir, username: 'other', password }),
      /AUTH_ALREADY_BOOTSTRAPPED/,
    );
    const saved = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    assert.ok(!saved.includes(password));
    assert.match(saved, /scrypt\$/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(dir, 'auth.key')).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('prelogin CSRF, hashed persistent sessions, expiry, logout and session CSRF', async () => {
  const s = await setup({ ttl: 1000 });
  try {
    assert.equal((await s.request('/login', 'POST', { username: 'admin', password })).status, 403);
    const auth = await s.login();
    assert.equal(auth.response.status, 200);
    assert.match(auth.response.headers.getSetCookie()[0], /HttpOnly/);
    assert.match(auth.response.headers.getSetCookie()[0], /SameSite=Strict/);
    assert.match(auth.response.headers.getSetCookie()[0], /Path=\/(?:;|$)/);
    const rebootstrap = await s.request('/csrf', 'GET', undefined, auth.cookie);
    const fresh = await rebootstrap.json();
    const relogin = await s.request(
      '/login',
      'POST',
      { username: 'admin', password },
      rebootstrap.headers.getSetCookie()[0].split(';')[0],
      fresh.csrfToken,
    );
    assert.equal(relogin.status, 200);
    const foreignRequest = {
      headers: { cookie: auth.cookie },
      protocol: 'http',
      get: (key: string) =>
        ({ origin: 'https://evil.test', host: 'localhost', 'x-csrf-token': auth.csrf })[key],
    } as unknown as Request;
    assert.equal(s.service.requireCsrf(foreignRequest), false);
    const disk = fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8');
    assert.ok(!disk.includes(auth.cookie.split('=')[1]));
    const req = { headers: { cookie: auth.cookie } } as Request;
    assert.equal((await s.service.resolve(req))?.role, 'superadmin');
    const restarted = new AuthService({ dataDir: s.dir, enabled: true });
    assert.equal((await restarted.resolve(req))?.username, 'admin');
    assert.equal((await s.request('/logout', 'POST', {}, auth.cookie, 'bad')).status, 403);
    assert.equal((await s.request('/logout', 'POST', {}, auth.cookie, 'é'.repeat(64))).status, 403);
    assert.equal((await s.request('/logout', 'POST', {}, auth.cookie, auth.csrf)).status, 200);
    assert.equal(await s.service.resolve(req), null);
    const again = await s.login();
    s.advance(1001);
    assert.equal(await s.service.resolve({ headers: { cookie: again.cookie } } as Request), null);
  } finally {
    await s.close();
  }
});
test('roles, disabling revokes all sessions, and final superadmin is protected', async () => {
  const s = await setup();
  try {
    const admin = await s.login();
    const create = await s.request(
      '/users',
      'POST',
      { username: 'writer', password },
      admin.cookie,
      admin.csrf,
    );
    assert.equal(create.status, 201);
    const { user } = await create.json();
    const writer = await s.login('writer');
    assert.equal(writer.response.status, 200);
    assert.equal((await s.request('/users', 'GET', undefined, writer.cookie)).status, 403);
    assert.equal(
      (await s.request(`/users/${user.id}`, 'PATCH', { disabled: true }, admin.cookie, admin.csrf)).status,
      200,
    );
    assert.equal(
      (await s.request('/session', 'GET', undefined, writer.cookie).then((r) => r.json())).authenticated,
      false,
    );
    assert.equal((await s.login('writer')).response.status, 401);
    assert.equal(
      (
        await s.request(
          `/users/${admin.result.user.id}`,
          'PATCH',
          { disabled: true },
          admin.cookie,
          admin.csrf,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await s.request(
          '/users',
          'POST',
          { username: 'other', password, role: 'bogus' },
          admin.cookie,
          admin.csrf,
        )
      ).status,
      400,
    );
    assert.equal(
      (await s.request('/users', 'GET', undefined, admin.cookie).then((r) => r.json())).users.some(
        (u: object) => 'passwordHash' in u,
      ),
      false,
    );
  } finally {
    await s.close();
  }
});
test('rate limit bounds password attempts without trusting forwarded address', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await s.login('missing', 'incorrect')).response.status, 401);
    assert.equal((await s.login()).response.status, 429);
    s.advance(15 * 60000 + 1);
    assert.equal((await s.login()).response.status, 200);
  } finally {
    await s.close();
  }
});
test('Turnstile encrypts and redacts secrets; fixed endpoint checks hostname/action and fails closed', async () => {
  let result: unknown = { success: true, action: 'login', hostname: 'example.test' };
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.equal((init?.body as URLSearchParams).get('secret'), 'private-turnstile-secret');
    if (result === 'throw') throw new Error('network');
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const s = await setup({ fetch: fakeFetch });
  try {
    const admin = await s.login();
    const settings = await s.request(
      '/turnstile',
      'PUT',
      {
        enabled: true,
        siteKey: 'public-key',
        action: 'login',
        hostname: 'example.test',
        secret: 'private-turnstile-secret',
      },
      admin.cookie,
      admin.csrf,
    );
    assert.equal(settings.status, 200);
    const publicSettings = await settings.json();
    assert.equal(publicSettings.hasSecret, true);
    assert.ok(!('secret' in publicSettings));
    assert.ok(!('encryptedSecret' in publicSettings));
    assert.ok(!fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8').includes('private-turnstile-secret'));
    assert.equal((await s.login('admin', password, 'token')).response.status, 200);
    result = { success: true, action: 'wrong', hostname: 'example.test' };
    assert.equal((await s.login('admin', password, 'token')).response.status, 401);
    result = { success: true, action: 'login', hostname: 'other.test' };
    assert.equal((await s.login('admin', password, 'token')).response.status, 401);
    result = 'throw';
    assert.equal((await s.login('admin', password, 'token')).response.status, 401);
    const before = calls;
    assert.equal((await s.login('admin', password, 'x'.repeat(2049))).response.status, 401);
    assert.equal(calls, before);
    assert.doesNotThrow(() => new AuthService({ dataDir: s.dir, enabled: true }));
  } finally {
    await s.close();
  }
});
test('corrupt persistence fails closed and failed write never installs a session', async () => {
  let document: AuthDocument | null = null,
    broken = false;
  const persistence: AuthPersistence = {
    read: () => document,
    write: (value) => {
      if (broken) throw new Error('disk failed');
      document = structuredClone(value);
    },
  };
  const s = await setup({ persistence });
  try {
    broken = true;
    assert.equal((await s.login()).response.status, 503);
    const saved = persistence.read() as AuthDocument | null;
    assert.equal(saved?.sessions.length, 0);
    assert.throws(
      () =>
        new AuthService({
          dataDir: s.dir,
          enabled: true,
          persistence: { read: () => ({ garbage: true }), write() {} },
        }),
      /AUTH_STORAGE_UNAVAILABLE/,
    );
  } finally {
    await s.close();
  }
});
