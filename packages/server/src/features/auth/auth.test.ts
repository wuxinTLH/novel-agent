import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Request } from 'express';
import { AuthService, bootstrapSuperadmin, type AuthDocument, type AuthPersistence } from './auth.js';

import { ROLE_IDS, ROLES, hasPermission, canManageUser } from '../../../../../shared/permissions.js';

const password = 'a long test password 123!';
async function setup(
  options: {
    ttl?: number;
    fetch?: typeof fetch;
    persistence?: AuthPersistence;
    authorize?: (req: Request) => boolean;
  } = {},
) {
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
  if (options.authorize) app.use('/api/auth/management', service.createManagementRouter(options.authorize));
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
test('password change verifies current password, revokes every session and persists across restart', async () => {
  const s = await setup();
  try {
    const first = await s.login(),
      second = await s.login();
    const body = { currentPassword: password, newPassword: 'a different strong password!' };
    assert.equal((await s.request('/password', 'POST', body, first.cookie, 'wrong')).status, 403);
    assert.equal(
      (await s.request('/password', 'POST', { ...body, currentPassword: 'wrong' }, first.cookie, first.csrf))
        .status,
      401,
    );
    assert.equal(
      (await s.request('/password', 'POST', { ...body, newPassword: 'short' }, first.cookie, first.csrf))
        .status,
      400,
    );
    const response = await s.request('/password', 'POST', body, first.cookie, first.csrf);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.match(response.headers.getSetCookie()[0], /Max-Age=0/);
    const restarted = new AuthService({ dataDir: s.dir, enabled: true });
    for (const auth of [first, second]) {
      const req = { headers: { cookie: auth.cookie } } as Request;
      assert.equal(await s.service.resolve(req), null);
      assert.equal(await restarted.resolve(req), null);
    }
    assert.equal((await s.login()).response.status, 401);
    assert.equal((await s.login('admin', body.newPassword)).response.status, 200);
    assert.ok(!fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8').includes(body.newPassword));
  } finally {
    await s.close();
  }
});
test('admin password reset requires admin reauth, revokes target only and redacts credentials', async () => {
  const s = await setup();
  try {
    const admin = await s.login();
    const created = await s.request(
      '/users',
      'POST',
      { username: 'writer', password },
      admin.cookie,
      admin.csrf,
    );
    const { user } = await created.json();
    const writer = await s.login('writer'),
      other = await s.login('writer');
    const route = `/users/${user.id}/password`;
    const body = { currentPassword: password, newPassword: 'new writer password 123!' };
    assert.equal((await s.request(route, 'POST', body)).status, 401);
    assert.equal((await s.request(route, 'POST', body, writer.cookie, writer.csrf)).status, 403);
    assert.equal(
      (await s.request(route, 'POST', { newPassword: body.newPassword }, admin.cookie, admin.csrf)).status,
      401,
    );
    assert.equal(
      (await s.request(route, 'POST', { ...body, currentPassword: 'incorrect' }, admin.cookie, admin.csrf))
        .status,
      401,
    );
    const response = await s.request(route, 'POST', body, admin.cookie, admin.csrf);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await s.request('/users', 'GET', undefined, admin.cookie)).status, 200);
    for (const auth of [writer, other])
      assert.equal((await s.request('/sessions', 'GET', undefined, auth.cookie)).status, 401);
    assert.equal((await s.login('writer')).response.status, 401);
    assert.equal((await s.login('writer', body.newPassword)).response.status, 200);
    assert.equal(
      (await s.request('/users/missing/password', 'POST', body, admin.cookie, admin.csrf)).status,
      404,
    );
  } finally {
    await s.close();
  }
});
test('role updates protect last active superadmin, reject invalid patches and revoke affected sessions', async () => {
  const s = await setup();
  try {
    const admin = await s.login();
    const patch = (id: string, body: unknown) =>
      s.request(`/users/${id}`, 'PATCH', body, admin.cookie, admin.csrf);
    assert.equal((await patch(admin.result.user.id, { role: 'writer' })).status, 409);
    assert.equal((await patch(admin.result.user.id, {})).status, 400);
    assert.equal((await patch(admin.result.user.id, { role: 'bogus' })).status, 400);
    const created = await s.request(
      '/users',
      'POST',
      { username: 'other', password },
      admin.cookie,
      admin.csrf,
    );
    const { user } = await created.json();
    const other = await s.login('other');
    assert.equal((await patch(user.id, { role: 'superadmin' })).status, 200);
    assert.equal((await s.request('/sessions', 'GET', undefined, other.cookie)).status, 401);
    assert.equal((await patch(user.id, { disabled: true })).status, 200);
    assert.equal((await patch(admin.result.user.id, { role: 'writer' })).status, 409);
    assert.equal((await patch(user.id, { disabled: false })).status, 200);
    assert.equal((await patch(admin.result.user.id, { role: 'writer' })).status, 200);
    assert.equal((await s.request('/sessions', 'GET', undefined, admin.cookie)).status, 401);
    const restarted = new AuthService({ dataDir: s.dir, enabled: true });
    assert.equal(await restarted.resolve({ headers: { cookie: admin.cookie } } as Request), null);
    assert.equal((await s.login()).result.user.role, 'writer');
  } finally {
    await s.close();
  }
});
test('session listing redacts secrets and own/admin revocation enforces ownership and CSRF', async () => {
  const s = await setup();
  try {
    const admin = await s.login();
    const created = await s.request(
      '/users',
      'POST',
      { username: 'writer', password },
      admin.cookie,
      admin.csrf,
    );
    const { user } = await created.json();
    const first = await s.login('writer'),
      second = await s.login('writer');
    const own = await s.request('/sessions', 'GET', undefined, first.cookie).then((r) => r.json());
    assert.equal(own.sessions.length, 2);
    const current = own.sessions.find((v: { current: boolean }) => v.current);
    assert.deepEqual(Object.keys(current).sort(), ['current', 'expiresAt', 'id']);
    assert.notEqual(current.id, first.cookie.split('=')[1]);
    assert.ok(!JSON.stringify(own).includes(first.csrf));
    assert.equal(
      (await s.request(`/sessions/${current.id}`, 'DELETE', {}, admin.cookie, admin.csrf)).status,
      404,
    );
    assert.equal((await s.request(`/users/${user.id}/sessions`, 'GET', undefined, first.cookie)).status, 403);
    assert.equal((await s.request(`/sessions/${current.id}`, 'DELETE', {}, first.cookie, 'bad')).status, 403);
    assert.equal(
      (await s.request(`/sessions/${current.id}`, 'DELETE', {}, first.cookie, first.csrf)).status,
      200,
    );
    assert.equal((await s.request('/sessions', 'GET', undefined, first.cookie)).status, 401);
    const target = await s
      .request(`/users/${user.id}/sessions`, 'GET', undefined, admin.cookie)
      .then((r) => r.json());
    assert.equal(target.sessions.length, 1);
    assert.equal(
      (
        await s.request(
          `/users/${user.id}/sessions/${target.sessions[0].id}`,
          'DELETE',
          {},
          admin.cookie,
          admin.csrf,
        )
      ).status,
      200,
    );
    assert.equal((await s.request('/sessions', 'GET', undefined, second.cookie)).status, 401);
    const again = await s.login('writer');
    assert.equal((await s.request('/sessions', 'DELETE', {}, again.cookie, again.csrf)).status, 200);
    assert.equal(
      (await s.request(`/users/${user.id}/sessions`, 'DELETE', {}, admin.cookie, admin.csrf)).status,
      200,
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
test('lifecycle failed writes leave passwords, roles and sessions unchanged', async () => {
  let document: AuthDocument | null = null;
  let broken = false;
  const persistence: AuthPersistence = {
    read: () => document,
    write(value) {
      if (broken) throw new Error('disk failed');
      document = structuredClone(value);
    },
  };
  const s = await setup({ persistence });
  try {
    const admin = await s.login();
    const response = await s.request(
      '/users',
      'POST',
      { username: 'writer', password },
      admin.cookie,
      admin.csrf,
    );
    const { user } = await response.json();
    const writer = await s.login('writer');
    const before = structuredClone(document);
    broken = true;
    for (const [route, method, body] of [
      ['/password', 'POST', { currentPassword: password, newPassword: 'a changed admin password!' }],
      [
        `/users/${user.id}/password`,
        'POST',
        { currentPassword: password, newPassword: 'a changed writer password!' },
      ],
      [`/users/${user.id}`, 'PATCH', { role: 'superadmin' }],
      [`/users/${user.id}/sessions`, 'DELETE', {}],
    ] as const) {
      assert.equal((await s.request(route, method, body, admin.cookie, admin.csrf)).status, 503);
      assert.deepEqual(document, before);
      assert.equal((await s.request('/sessions', 'GET', undefined, writer.cookie)).status, 200);
    }
    assert.equal((await s.request('/sessions', 'DELETE', {}, writer.cookie, writer.csrf)).status, 503);
    broken = false;
    assert.equal((await s.login('writer')).response.status, 200);
    const restarted = new AuthService({ dataDir: s.dir, enabled: true, persistence });
    assert.equal(
      (await restarted.resolve({ headers: { cookie: writer.cookie } } as Request))?.role,
      'writer',
    );
  } finally {
    await s.close();
  }
});
test('concurrent password changes cannot commit using revoked authorization', async () => {
  const s = await setup();
  try {
    const first = await s.login(),
      second = await s.login();
    const bodies = [
      { currentPassword: password, newPassword: 'first competing password 123!' },
      { currentPassword: password, newPassword: 'second competing password 123!' },
    ];
    const responses = await Promise.all(
      [first, second].map((auth, index) =>
        s.request('/password', 'POST', bodies[index], auth.cookie, auth.csrf),
      ),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
    const winner = responses.findIndex((r) => r.status === 200);
    assert.equal((await s.login('admin', bodies[winner].newPassword)).response.status, 200);
    assert.equal((await s.login('admin', bodies[1 - winner].newPassword)).response.status, 401);
    const restarted = new AuthService({ dataDir: s.dir, enabled: true });
    assert.equal(await restarted.resolve({ headers: { cookie: first.cookie } } as Request), null);
    assert.equal(await restarted.resolve({ headers: { cookie: second.cookie } } as Request), null);
  } finally {
    await s.close();
  }
});
test('management authorization is required again after async password hashing', async () => {
  let checks = 0;
  const s = await setup({ authorize: () => ++checks <= 2 });
  try {
    const response = await s.request('/management/users', 'POST', { username: 'blocked', password });
    assert.equal(response.status, 403);
    assert.equal(checks, 3);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8')) as AuthDocument;
    assert.equal(saved.users.length, 1);
    checks = 0;
    const reset = await s.request(`/management/users/${saved.users[0].id}/password`, 'POST', {
      newPassword: 'another secure password!',
    });
    assert.equal(reset.status, 403);
    assert.equal(checks, 3);
    assert.equal((await s.login()).response.status, 200);
  } finally {
    await s.close();
  }
});
test('management works independently while auth stays off, rejects untrusted callers and cannot bootstrap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-management-'));
  let allowed = false;
  let document: AuthDocument | null = null;
  let writes = 0;
  const persistence: AuthPersistence = {
    read: () => document,
    write(value) {
      writes++;
      document = structuredClone(value);
    },
  };
  const service = new AuthService({ dataDir: dir, persistence, secretKey: Buffer.alloc(32, 1) });
  const app = express();
  app.use(express.json());
  app.use(
    '/admin',
    service.createManagementRouter(() => allowed),
  );
  app.use('/auth', service.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, body?: unknown) =>
    fetch(
      `${base}${route}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  try {
    assert.equal((await request('/admin/users')).status, 403);
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(path.join(dir, 'auth.key')), false);
    allowed = true;
    assert.equal((await request('/admin/users')).status, 200);
    assert.equal(
      (await request('/admin/users', { username: 'admin', password, role: 'superadmin' })).status,
      409,
    );
    assert.equal(writes, 0);
    bootstrapSuperadmin({
      dataDir: dir,
      persistence,
      secretKey: Buffer.alloc(32, 1),
      username: 'admin',
      password,
    });
    // A running single-writer instance does not reload out-of-band writes; restart after CLI bootstrap.
    const restarted = new AuthService({ dataDir: dir, persistence, secretKey: Buffer.alloc(32, 1) });
    app.use(
      '/restarted',
      restarted.createManagementRouter(() => allowed),
    );
    assert.equal((await request('/restarted/users', { username: 'writer', password })).status, 201);
    assert.equal(restarted.enabled, false);
    assert.equal((await request('/auth/users')).status, 404);
    assert.equal((await request('/auth/session').then((r) => r.json())).enabled, false);
    assert.equal((await request('/admin/login', { username: 'admin', password })).status, 404);
    assert.equal((await request('/restarted/users').then((r) => r.json())).users.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('shared roles use explicit permissions rather than weight ordering', () => {
  assert.deepEqual(ROLE_IDS, ['superadmin', 'admin', 'operations', 'writer']);
  assert.deepEqual(
    ROLE_IDS.map((role) => ROLES[role].weight),
    [1000, 99, 100, 10],
  );
  assert.equal(hasPermission('operations', 'admin.access'), true);
  assert.equal(hasPermission('operations', 'users.manage'), false);
  assert.equal(hasPermission('admin', 'security.read'), true);
  assert.equal(hasPermission('admin', 'security.manage'), false);
  assert.equal(canManageUser('admin', 'operations'), true);
  assert.equal(canManageUser('admin', 'admin'), false);
});

test('four-role requests enforce manager boundaries, role assignment and security permissions', async () => {
  const s = await setup();
  try {
    const owner = await s.login();
    const users: Record<string, { id: string }> = {};
    for (const role of ['admin', 'operations', 'writer'] as const) {
      const response = await s.request(
        '/users',
        'POST',
        { username: `test-${role}`, password, role },
        owner.cookie,
        owner.csrf,
      );
      assert.equal(response.status, 201);
      users[role] = (await response.json()).user;
    }
    const admin = await s.login('test-admin');
    const operations = await s.login('test-operations');
    const writer = await s.login('test-writer');
    const act = (route: string, method = 'GET', body?: unknown) =>
      s.request(route, method, body, admin.cookie, admin.csrf);
    assert.equal((await act('/users')).status, 200);
    for (const role of ['writer', 'operations']) {
      assert.equal(
        (await act('/users', 'POST', { username: `created-${role}`, password, role })).status,
        201,
      );
    }
    const defaultWriter = await act('/users', 'POST', { username: 'default-writer', password });
    assert.equal((await defaultWriter.json()).user.role, 'writer');
    for (const role of ['admin', 'superadmin']) {
      assert.equal((await act('/users', 'POST', { username: `forged-${role}`, password, role })).status, 403);
    }
    for (const role of ['user', 'bogus']) {
      assert.equal((await act('/users', 'POST', { username: 'invalid-role', password, role })).status, 400);
    }
    for (const id of [users.admin.id, owner.result.user.id]) {
      assert.equal((await act(`/users/${id}`, 'PATCH', { disabled: true })).status, 403);
      assert.equal(
        (await act(`/users/${id}/password`, 'POST', { currentPassword: password, newPassword: password }))
          .status,
        403,
      );
      assert.equal((await act(`/users/${id}/sessions`, 'DELETE')).status, 403);
    }
    assert.equal((await act(`/users/${users.writer.id}`, 'PATCH', { role: 'writer' })).status, 403);
    assert.equal((await act(`/users/${users.operations.id}`, 'PATCH', { role: 'admin' })).status, 403);
    assert.equal(
      (await s.request(`/users/${users.writer.id}`, 'PATCH', { disabled: true }, admin.cookie)).status,
      403,
    );
    assert.equal(
      (await act(`/users/${users.writer.id}/password`, 'POST', { newPassword: password })).status,
      401,
    );
    assert.equal(
      (
        await act(`/users/${users.writer.id}/password`, 'POST', {
          currentPassword: password,
          newPassword: password,
        })
      ).status,
      200,
    );
    assert.equal(
      (await s.request('/session', 'GET', undefined, writer.cookie).then((r) => r.json())).authenticated,
      false,
    );
    assert.equal((await act(`/users/${users.operations.id}/sessions`, 'DELETE')).status, 200);
    const operator = await s.login('test-operations');
    for (const [route, method, body] of [
      ['/users', 'GET', undefined],
      ['/users', 'POST', { username: 'forged-user', password }],
      [`/users/${users.writer.id}`, 'PATCH', { disabled: true }],
      [`/users/${users.writer.id}/sessions`, 'GET', undefined],
      ['/turnstile', 'GET', undefined],
      ['/account/config', 'GET', undefined],
      ['/account/oidc/users/' + users.writer.id, 'PUT', {}],
    ] as const) {
      assert.equal((await s.request(route, method, body, operator.cookie, operator.csrf)).status, 403);
    }
    assert.equal((await act('/turnstile')).status, 200);
    assert.equal((await act('/turnstile', 'PUT', {})).status, 403);
    const config = await act('/account/config').then((r) => r.json());
    assert.equal((await act('/account/config', 'PUT', config)).status, 403);
    assert.equal((await act('/account/oidc/users/' + users.writer.id, 'PUT', {})).status, 403);
    assert.equal((await act(`/users/${users.operations.id}`, 'PATCH', { disabled: true })).status, 200);
    assert.equal(
      (await s.request('/session', 'GET', undefined, operations.cookie).then((r) => r.json())).authenticated,
      false,
    );
    // Headers are not authorization: an unauthenticated caller cannot forge a principal.
    const forged = await fetch(`${(await s.request('/session')).url.replace('/session', '/users')}`, {
      headers: { 'x-user-role': 'superadmin', 'x-user-id': owner.result.user.id },
    });
    assert.equal(forged.status, 401);
  } finally {
    await s.close();
  }
});

test('legacy persisted users normalize to writer and invalid persisted roles fail closed', async () => {
  const s = await setup();
  try {
    const owner = await s.login();
    const response = await s.request(
      '/users',
      'POST',
      { username: 'legacy-writer', password },
      owner.cookie,
      owner.csrf,
    );
    const { user } = await response.json();
    const legacy = await s.login('legacy-writer');
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8'));
    saved.users.find((u: { id: string }) => u.id === user.id).role = 'user';
    const restarted = new AuthService({
      dataDir: s.dir,
      enabled: true,
      persistence: { read: () => saved, write() {} },
    });
    assert.equal(
      (await restarted.resolve({ headers: { cookie: legacy.cookie } } as Request))?.role,
      'writer',
    );
    saved.users.find((u: { id: string }) => u.id === user.id).role = 'unknown';
    assert.throws(
      () =>
        new AuthService({ dataDir: s.dir, enabled: true, persistence: { read: () => saved, write() {} } }),
      /AUTH_STORAGE_UNAVAILABLE/,
    );
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
