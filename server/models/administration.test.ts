import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Request } from 'express';
import { AuthService } from './auth.js';
import { createAdministrationRouter, isLocalAdministrator } from './administration.js';
import { readStorageProfiles } from './storage-config.js';

const password = 'strong administration password 123!';
function mockRequest(address: string, headers: Record<string, string | undefined> = {}): Request {
  return {
    socket: { remoteAddress: address },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}
async function setup(enabled = false, address?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-administration-'));
  const auth = new AuthService({ dataDir: dir, enabled });
  if (enabled) auth.bootstrapSuperadmin('admin', password);
  const app = express();
  if (address)
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: address, configurable: true });
      next();
    });
  app.use('/api/admin', createAdministrationRouter({ dir, auth, tenantCount: () => 2 }));
  app.use('/api/auth', express.json(), auth.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const info = server.address();
  assert.ok(info && typeof info !== 'string');
  const base = `http://127.0.0.1:${info.port}`;
  const request = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async () => {
    const pre = await request('/api/auth/csrf');
    const { csrfToken } = await pre.json();
    const response = await request(
      '/api/auth/login',
      'POST',
      { username: 'admin', password },
      {
        cookie: pre.headers.getSetCookie()[0].split(';')[0],
        'x-csrf-token': csrfToken,
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    return {
      cookie: response.headers.getSetCookie()[0].split(';')[0],
      'x-csrf-token': body.csrfToken as string,
    };
  };
  return {
    dir,
    auth,
    request,
    login,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const profile = () => ({
  version: 3,
  defaultProfileId: 'main',
  profiles: [
    {
      id: 'main',
      label: 'Main database',
      connection: {
        driver: 'postgresql',
        host: '127.0.0.1',
        port: 5432,
        database: 'novels',
        user: 'writer',
        password: 'database secret 123!',
        tls: 'verify',
        timeoutMs: 10000,
      },
    },
  ],
  ownerProfiles: [],
});

test('local administrator ignores forwarded identity and rejects LAN, DNS rebinding and cross-site requests', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    assert.equal(
      isLocalAdministrator(mockRequest(address, { host: 'localhost:3001', origin: 'http://127.0.0.1:3001' })),
      true,
    );
  for (const address of ['192.168.1.22', '10.0.0.1', '::ffff:192.168.1.22'])
    assert.equal(
      isLocalAdministrator(
        mockRequest(address, {
          host: 'localhost:3001',
          'x-forwarded-for': '127.0.0.1',
          'x-forwarded-host': 'localhost',
          'x-user-id': 'admin',
        }),
      ),
      false,
    );
  for (const headers of [
    { host: 'evil.example' },
    { host: '127.0.0.1.evil.example' },
    { host: 'localhost', origin: 'http://evil.example' },
    { host: 'localhost', origin: 'null' },
    { host: 'localhost', 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal(isLocalAdministrator(mockRequest('127.0.0.1', headers)), false);
});
test('LAN requests cannot obtain management token or profile data even with forwarded claims', async () => {
  const s = await setup(false, '192.168.1.22');
  try {
    for (const route of ['/session', '/status', '/storage', '/users', '/maintenance']) {
      const response = await s.request(`/api/admin${route}`, 'GET', undefined, {
        'x-forwarded-for': '127.0.0.1',
        'x-forwarded-host': 'localhost',
        'x-user-id': 'admin',
      });
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.csrfToken, undefined);
      assert.equal(body.profiles, undefined);
    }
    assert.equal(fs.existsSync(path.join(s.dir, 'auth.key')), false);
  } finally {
    await s.close();
  }
});
test('local reads leave auth off; mutations require CSRF including malformed unicode tokens', async () => {
  const s = await setup();
  try {
    const session = await s.request('/api/admin/session').then((r) => r.json());
    assert.equal(session.mode, 'local');
    assert.match(session.csrfToken, /^[a-f0-9]{64}$/);
    const status = await s.request('/api/admin/status').then((r) => r.json());
    assert.equal(status.authenticationEnabled, false);
    assert.equal(status.runtime.tenantCount, 2);
    assert.equal((await s.request('/api/admin/storage')).status, 200);
    for (const token of ['', 'wrong', 'é'.repeat(64)]) {
      assert.equal(
        (await s.request('/api/admin/storage', 'PUT', profile(), { 'x-admin-csrf': token })).status,
        403,
      );
    }
    assert.equal(readStorageProfiles(s.dir), null);
    assert.equal(
      (
        await s.request('/api/admin/storage', 'PUT', profile(), {
          'x-admin-csrf': session.csrfToken,
          origin: 'http://evil.example',
        })
      ).status,
      403,
    );
    assert.equal(s.auth.enabled, false);
    assert.equal((await s.request('/api/auth/session').then((r) => r.json())).enabled, false);
    assert.equal(fs.existsSync(path.join(s.dir, 'auth-enabled.json')), false);
    assert.equal(fs.existsSync(path.join(s.dir, 'auth.key')), false);
  } finally {
    await s.close();
  }
});
test('auth-off management status loads offline bootstrapped identities after restart', async () => {
  const s = await setup();
  try {
    new AuthService({ dataDir: s.dir, enabled: true }).bootstrapSuperadmin('offlineadmin', password);
    assert.equal(s.auth.hasSuperadmin(), false);
    const status = await s.request('/api/admin/status').then((r) => r.json());
    assert.equal(status.configured, true);
    assert.equal(status.authenticationEnabled, false);
    assert.equal(s.auth.hasSuperadmin(), true);
    assert.equal((await s.request('/api/auth/session').then((r) => r.json())).enabled, false);
    assert.equal(fs.existsSync(path.join(s.dir, 'auth-enabled.json')), false);
  } finally {
    await s.close();
  }
});
test('profile endpoints redact passwords, preserve only unchanged connection secrets and lock active configuration', async () => {
  const s = await setup();
  try {
    const { csrfToken } = await s.request('/api/admin/session').then((r) => r.json());
    const headers = { 'x-admin-csrf': csrfToken };
    assert.equal((await s.request('/api/admin/storage', 'PUT', profile(), headers)).status, 200);
    const read = await s.request('/api/admin/storage').then((r) => r.json());
    assert.equal(read.profiles[0].connection.password, undefined);
    assert.equal(read.profiles[0].connection.hasPassword, true);
    assert.ok(!JSON.stringify(read).includes('database secret'));
    const status = await s.request('/api/admin/status').then((r) => r.json());
    assert.ok(!JSON.stringify(status).includes('database secret'));
    assert.equal((await s.request('/api/admin/storage', 'PUT', read, headers)).status, 200);
    assert.equal(readStorageProfiles(s.dir)?.profiles[0].connection.password, 'database secret 123!');
    read.profiles[0].connection.host = 'other.example';
    assert.equal((await s.request('/api/admin/storage', 'PUT', read, headers)).status, 200);
    assert.equal(readStorageProfiles(s.dir)?.profiles[0].connection.password, undefined);
    fs.writeFileSync(
      path.join(s.dir, 'business-storage.json'),
      JSON.stringify({
        version: 3,
        backend: 'relational',
        ownerId: '00000000-0000-4000-8000-000000000002',
        migrationHash: 'a'.repeat(64),
      }),
    );
    const before = fs.readFileSync(path.join(s.dir, 'storage-profiles.json'), 'utf8');
    const locked = await s.request('/api/admin/storage', 'PUT', profile(), headers);
    assert.equal(locked.status, 409);
    assert.equal((await locked.json()).code, 'ACTIVE_STORAGE_CONFIG_LOCKED');
    assert.equal(fs.readFileSync(path.join(s.dir, 'storage-profiles.json'), 'utf8'), before);
    assert.equal(s.auth.enabled, false);
  } finally {
    await s.close();
  }
});
test('authenticated administration requires acting admin password for resets, not just CSRF', async () => {
  const s = await setup(true);
  try {
    assert.equal((await s.request('/api/admin/session')).status, 403);
    const headers = await s.login();
    const session = await s.request('/api/admin/session', 'GET', undefined, headers).then((r) => r.json());
    assert.equal(session.mode, 'authenticated');
    assert.equal(session.csrfToken, undefined);
    const created = await s.request('/api/admin/users', 'POST', { username: 'writer', password }, headers);
    assert.equal(created.status, 201);
    const { user } = await created.json();
    const route = `/api/admin/users/${user.id}/password`;
    assert.equal(
      (await s.request(route, 'POST', { newPassword: 'a replacement strong password!' }, headers)).status,
      401,
    );
    assert.equal(
      (
        await s.request(
          route,
          'POST',
          { currentPassword: 'wrong', newPassword: 'a replacement strong password!' },
          headers,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await s.request(
          route,
          'POST',
          { currentPassword: password, newPassword: 'a replacement strong password!' },
          headers,
        )
      ).status,
      200,
    );
    assert.equal(
      (await s.request('/api/admin/storage', 'PUT', profile(), { cookie: headers.cookie })).status,
      403,
    );
  } finally {
    await s.close();
  }
});
