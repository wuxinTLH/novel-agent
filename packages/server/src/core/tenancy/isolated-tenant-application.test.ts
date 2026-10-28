import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import express from 'express';
import { AuthService } from '../../features/auth/auth.js';
import {
  createIsolatedTenantApplication,
  type IsolatedTenantService,
} from './isolated-tenant-application.js';

const policyPort = 3001;

test('only the exact OIDC GET callback admits cross-site navigation and still checks host and origin', async (t) => {
  const f = await fixture(t);
  const headers = { 'sec-fetch-site': 'cross-site', accept: 'text/html' };
  const callback = '/api/auth/account/oidc/callback?state=bad&code=bad';
  const admitted = await f.request('GET', callback, undefined, headers);
  // Auth is OFF: reaching the auth handler returns AUTH_DISABLED, not origin bypass elsewhere.
  assert.equal(admitted.status, 404);
  assert.equal((await f.request('POST', callback, undefined, headers)).status, 403);
  assert.equal((await f.request('GET', '/api/auth/session', undefined, headers)).status, 403);
  assert.equal((await f.request('GET', callback, undefined, { ...headers, host: 'evil.example:3001' })).status, 403);
  assert.equal((await f.request('GET', callback, undefined, { ...headers, origin: 'https://evil.example' })).status, 403);
  assert.equal(f.tenant.contexts.size, 0);
});
async function fixture(t: TestContext, enabled = false, services: IsolatedTenantService[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-isolated-'));
  const auth = new AuthService({ dataDir: dir, enabled });
  const tenant = createIsolatedTenantApplication({
    dir,
    port: policyPort,
    appRoot: dir,
    auth,
    enabled,
    services,
  });
  const server = http.createServer(tenant.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tenant.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const publicPort = address.port;
  async function request(
    method: string,
    route: string,
    body?: Buffer,
    headers: http.OutgoingHttpHeaders = {},
    port = publicPort,
  ) {
    return new Promise<{ status: number; body: any; bytes: Buffer; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: route,
            method,
            headers: {
              host: `localhost:${policyPort}`,
              ...(body ? { 'content-length': body.length } : {}),
              ...headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
              const bytes = Buffer.concat(chunks);
              resolve({
                status: res.statusCode!,
                bytes,
                headers: res.headers,
                body: res.headers['content-type']?.includes('application/json')
                  ? JSON.parse(bytes.toString())
                  : undefined,
              });
            });
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
  }
  return { dir, auth, tenant, request };
}

test('auth-off business stays in persistent isolated worker; raw JSON, CSRF and capability boundary survive proxy', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/api/auth/session')).status, 200);
  assert.equal(f.tenant.contexts.size, 0);
  const health = await f.request('GET', '/api/health', undefined, {
    'x-novel-runtime-capability': 'attacker',
  });
  assert.equal(health.status, 200);
  const csrf = health.body.platform.csrfToken;
  const entry = f.tenant.contexts.get('root')!;
  assert.ok(entry.worker.threadId > 0);
  assert.equal(entry.dir, f.dir);
  assert.equal((await f.request('GET', '/api/health')).body.platform.csrfToken, csrf);
  const privatePort = await entry.ready;
  assert.equal((await f.request('GET', '/api/health', undefined, {}, privatePort)).status, 403);
  const raw = Buffer.from('  { "title" : "Streamed JSON", "genre": "fantasy" }\n');
  assert.equal(
    (await f.request('POST', '/api/projects', raw, { 'content-type': 'application/json' })).status,
    403,
  );
  const created = await f.request('POST', '/api/projects', raw, {
    'content-type': 'application/json',
    'x-platform-csrf': csrf,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, 'Streamed JSON');
  const boundary = 'isolated-exact-upload';
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3sAAAAASUVORK5CYII=',
    'base64',
  );
  const upload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nworld\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="private.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const uploaded = await f.request('POST', `/api/projects/${created.body.id}/assets/upload`, upload, {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-platform-csrf': csrf,
  });
  assert.equal(uploaded.status, 201);
  const downloaded = await f.request('GET', uploaded.body.assets[0].url);
  assert.deepEqual(downloaded.bytes, image);
  await f.tenant.close();
  assert.equal(f.tenant.contexts.size, 0);
  assert.equal(entry.worker.threadId, -1);
  assert.equal((await f.request('GET', '/api/health')).status, 503);
});

test('outer SQL mutations require worker CSRF before parsing while reads stay lazy', async (t) => {
  let calls = 0;
  const f = await fixture(t, false, [{
    register(app) {
      app.use('/api/sqlconnect',
        (req, res, next) => f.tenant.requireRuntimeCsrf(req, res, next),
        express.json(),
        (_req, res) => { calls++; res.json({ ok: true }); });
    },
  }]);
  assert.equal((await f.request('GET', '/api/sqlconnect/status')).status, 200);
  assert.equal(f.tenant.contexts.size, 0);
  for (const token of [undefined, 'invalid', 'x'.repeat(300)]) {
    const rejected = await f.request('POST', '/API/SQLCONNECT/initialize', Buffer.from('{'), {
      'content-type': 'application/json', ...(token ? { 'X-Platform-CSRF': token } : {}),
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.code, 'PLATFORM_CSRF_REQUIRED');
  }
  assert.equal(calls, 1);
  assert.equal(f.tenant.contexts.size, 0);
  const token = (await f.request('GET', '/api/health')).body.platform.csrfToken;
  assert.equal((await f.request('POST', '/api/sqlconnect/initialize', Buffer.from('{}'), {
    'content-type': 'application/json', 'X-Platform-CSRF': token,
  })).status, 200);
  assert.equal(calls, 2);
  assert.equal((await f.request('DELETE', '/api/sqlconnect/config', undefined, {
    'X-Platform-CSRF': 'invalid',
  })).status, 403);
  assert.equal(calls, 2);
});

test('outer SQL CSRF is tenant-bound and independent of authenticated session guard', async (t) => {
  let calls = 0;
  const f = await fixture(t, true, [{
    register(app) {
      app.use('/api/sqlconnect',
        (req, res, next) => f.tenant.requireRuntimeCsrf(req, res, next),
        (_req, res) => { calls++; res.json({ ok: true }); });
    },
  }]);
  const ownerA = '11111111-1111-4111-8111-111111111111';
  const ownerB = '22222222-2222-4222-8222-222222222222';
  f.auth.resolve = async (req) => ({
    id: String(req.headers['x-test-owner']), role: 'superadmin', username: 'admin',
    disabled: false, createdAt: new Date().toISOString(), csrfToken: 'session',
  });
  f.auth.requireCsrf = (req) => req.get('X-CSRF-Token') === 'session';
  const a = (await f.request('GET', '/api/health', undefined, { 'x-test-owner': ownerA })).body.platform.csrfToken;
  const b = (await f.request('GET', '/api/health', undefined, { 'x-test-owner': ownerB })).body.platform.csrfToken;
  const headers = { 'x-test-owner': ownerA, 'X-CSRF-Token': 'session' };
  assert.equal((await f.request('POST', '/api/sqlconnect/test', undefined, {
    ...headers, 'X-CSRF-Token': '', 'X-Platform-CSRF': a,
  })).body.code, 'AUTH_CSRF_REQUIRED');
  assert.equal((await f.request('POST', '/api/sqlconnect/test', undefined, {
    ...headers, 'X-Platform-CSRF': b,
  })).body.code, 'PLATFORM_CSRF_REQUIRED');
  assert.equal((await f.request('POST', '/api/sqlconnect/test', undefined, {
    ...headers, 'X-Platform-CSRF': a,
  })).status, 200);
  assert.equal(calls, 1);
});

test('tenant authorization and superadmin protection run before outer services', async (t) => {
  let calls = 0;
  const f = await fixture(t, true, [
    {
      register(app) {
        app.use('/api/sqlconnect', (_req, res) => {
          calls++;
          res.json({ ok: true });
        });
      },
    },
  ]);
  assert.equal((await f.request('GET', '/API/SQLCONNECT/status')).status, 401);
  assert.equal((await f.request('GET', '/UPLOADS/private')).status, 401);
  const principal = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'writer' as const,
    username: 'writer',
    disabled: false,
    createdAt: new Date().toISOString(),
    csrfToken: 'test',
  };
  f.auth.resolve = async () => principal;
  assert.equal((await f.request('GET', '/api/SQLconnect/status')).status, 403);
  assert.equal((await f.request('POST', '/api/projects', Buffer.from('{}'))).body.code, 'AUTH_CSRF_REQUIRED');
  assert.equal(calls, 0);
  assert.equal(f.tenant.contexts.size, 0);
  assert.equal((await f.request('GET', '/api/admin/not-registered')).status, 404);
  assert.equal(f.tenant.contexts.size, 0);
});

test('independent tenant runtimes are concurrently responsive and a poisoned worker is never restarted', async (t) => {
  const f = await fixture(t, true);
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  f.auth.resolve = async (req) => ({
    id: String(req.headers['x-test-owner']),
    role: 'writer',
    username: 'writer',
    disabled: false,
    createdAt: new Date().toISOString(),
    csrfToken: 'test',
  });
  const [first, second] = await Promise.all(
    [a, b].map((id) => f.request('GET', '/api/health', undefined, { 'x-test-owner': id })),
  );
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.platform.csrfToken, second.body.platform.csrfToken);
  const ra = f.tenant.contexts.get(a)!;
  const rb = f.tenant.contexts.get(b)!;
  assert.notEqual(ra.worker.threadId, rb.worker.threadId);
  assert.equal(ra.dir, path.join(f.dir, 'users', createHash('sha256').update(a).digest('hex')));
  // Fill capacity using existing descriptors: the 33rd owner must not construct any Worker.
  for (let i = 0; i < 30; i++) f.tenant.contexts.set(`occupied-${i}`, ra);
  assert.equal(
    (await f.request('GET', '/api/health', undefined, { 'x-test-owner': 'another-owner' })).status,
    429,
  );
  assert.equal(f.tenant.contexts.size, 32);
  for (let i = 0; i < 30; i++) f.tenant.contexts.delete(`occupied-${i}`);
  await ra.worker.terminate();
  const [bad, good] = await Promise.all(
    [a, b].map((id) => f.request('GET', '/api/health', undefined, { 'x-test-owner': id })),
  );
  assert.equal(bad.status, 503);
  assert.equal(good.status, 200);
  assert.equal(f.tenant.contexts.get(a), ra);
  assert.equal(ra.state, 'failed');
});

test('startup failures stay poisoned and shutdown service failures are sanitized', async (t) => {
  const f = await fixture(t, false, [
    {
      register() {},
      async close() {
        throw new Error('secret-do-not-forward');
      },
    },
  ]);
  fs.writeFileSync(path.join(f.dir, 'business-storage.json'), '{invalid');
  const failed = await f.request('GET', '/api/health');
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'TENANT_RUNTIME_UNAVAILABLE');
  const runtime = f.tenant.contexts.get('root')!;
  if (runtime.worker.threadId !== -1) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Failed startup worker did not exit')), 17_000);
      runtime.worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  assert.equal(runtime.worker.threadId, -1);
  assert.equal((await f.request('GET', '/api/health')).status, 503);
  assert.equal(f.tenant.contexts.get('root'), runtime);
  await assert.rejects(f.tenant.close(), {
    message: 'Tenant runtime shutdown incomplete.',
    code: 'TENANT_RUNTIME_SHUTDOWN_FAILED',
  });
});

test('outer control plane stays accessible without starting a runtime and parses only its own body', async (t) => {
  const f = await fixture(t, false, [
    {
      register(app) {
        app.post('/api/admin/test', express.json(), (req, res) => res.json(req.body));
      },
    },
  ]);
  const response = await f.request('POST', '/api/admin/test', Buffer.from('{"value":3}'), {
    'content-type': 'application/json',
  });
  assert.equal(response.body.value, 3);
  assert.equal(f.tenant.contexts.size, 0);
});

test('online maintenance barrier drains workers, gates auth/business and resumes with fresh runtime', async (t) => {
  const f = await fixture(t, false, [{ register(app) {
    app.get('/api/admin/online-maintenance/tasks', (_req, res) => res.json({ ok: true }));
  } }]);
  const before = await f.request('GET', '/api/health');
  assert.equal(before.status, 200);
  const old = f.tenant.contexts.get('root')!;
  const lease = await f.tenant.acquireQuiescence();
  lease.assertHeld();
  assert.equal(old.worker.threadId, -1);
  assert.equal(f.tenant.contexts.size, 0);
  assert.equal((await f.request('GET', '/api/auth/session')).status, 503);
  assert.equal((await f.request('GET', '/api/health')).status, 503);
  assert.equal((await f.request('GET', '/api/admin/online-maintenance/tasks')).status, 200);
  await assert.rejects(f.tenant.acquireQuiescence(), /MAINTENANCE_ALREADY_ACTIVE/);
  await lease.release();
  assert.throws(() => lease.assertHeld(), /MAINTENANCE_LEASE_NOT_HELD/);
  const after = await f.request('GET', '/api/health');
  assert.equal(after.status, 200);
  assert.notEqual(after.body.platform.csrfToken, before.body.platform.csrfToken);
  assert.notEqual(f.tenant.contexts.get('root'), old);
});
