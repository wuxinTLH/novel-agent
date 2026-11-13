import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { defaultSiteAppearance, updateSiteAppearanceSchema } from '../../../../../shared/site-appearance.js';
import { SiteAppearanceStore, appearanceHandler } from './appearance.js';
import { createAdministrationRouter } from './administration.js';
import { AuthService } from '../auth/auth.js';
import { createIsolatedTenantApplication } from '../../core/tenancy/isolated-tenant-application.js';

const update = () => {
  const { version: _v, revision, ...value } = defaultSiteAppearance();
  return { expectedRevision: revision, ...value };
};
function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'novel-appearance-'));
}

test('strict safe primitives, complete styles, trimmed company and bounded integers', () => {
  assert.equal(
    updateSiteAppearanceSchema.parse({ ...update(), companyName: '  Acme  ' }).companyName,
    'Acme',
  );
  assert.equal(
    updateSiteAppearanceSchema.parse({ ...update(), companyName: 'Sakura / Example 2026' }).companyName,
    'Sakura / Example 2026',
  );
  for (const color of ['', '#aB09fF', '#FFFFFF'])
    assert.ok(
      updateSiteAppearanceSchema.safeParse({ ...update(), header: { ...update().header, textColor: color } })
        .success,
    );
  const invalid: unknown[] = [
    { ...update(), css: 'display:none' },
    { ...update(), revision: 1 },
    { ...update(), companyName: 'x'.repeat(121) },
    ...['\nAcme', 'Acme\u0000', 'Acme\u0085'].map((companyName) => ({ ...update(), companyName })),
    ...[
      '\n',
      '#123456\n',
      '#123456\r',
      'red',
      '#fff',
      '#12345678',
      'url(https://evil)',
      'expression(alert(1))',
      '#fff;display:none',
      '<script>',
      'var(--x)',
    ].map((textColor) => ({ ...update(), header: { ...update().header, textColor } })),
    { ...update(), header: {} },
    { ...update(), footer: null },
    { ...update(), header: { ...update().header, fontFamily: 'evil' } },
    ...[11, 25, 14.5, '14'].map((fontSize) => ({ ...update(), header: { ...update().header, fontSize } })),
    ...[-1, 33, 0.5].map((paddingY) => ({ ...update(), footer: { ...update().footer, paddingY } })),
    ...[-1, 0.1, '0', Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => ({
      ...update(),
      expectedRevision,
    })),
  ];
  for (const value of invalid)
    assert.equal(updateSiteAppearanceSchema.safeParse(value).success, false, JSON.stringify(value));
});

test('defaults are absent-only; CAS persists restart and returns isolated copies', () => {
  const dir = temporary();
  try {
    const store = new SiteAppearanceStore(dir);
    assert.deepEqual(store.read(), defaultSiteAppearance());
    assert.equal(fs.existsSync(path.join(dir, 'site-appearance.json')), false);
    const result = store.update({
      ...update(),
      companyName: ' Acme ',
      header: { ...update().header, textColor: '#abCDEF' },
    });
    assert.equal(result.revision, 1);
    assert.equal(result.companyName, 'Acme');
    assert.deepEqual(new SiteAppearanceStore(dir).read(), result);
    assert.throws(() => store.update(update()), /CONFLICT/);
    result.header.fontSize = 24;
    assert.equal(store.read().header.fontSize, 14);
    const competing = new SiteAppearanceStore(dir);
    store.update({ ...update(), expectedRevision: 1 });
    assert.throws(() => competing.update({ ...update(), expectedRevision: 1 }), /CONFLICT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fsync and rename failures retain committed memory and disk; corruption never overwrites', (t) => {
  const dir = temporary();
  try {
    const store = new SiteAppearanceStore(dir);
    const saved = store.update(update());
    const file = path.join(dir, 'site-appearance.json');
    const before = fs.readFileSync(file, 'utf8');
    for (const method of ['fsyncSync', 'renameSync'] as const) {
      const mock = t.mock.method(fs, method, () => {
        throw new Error('simulated disk failure secret');
      });
      assert.throws(
        () => store.update({ ...update(), expectedRevision: 1, companyName: 'not saved' }),
        /UNAVAILABLE/,
      );
      mock.mock.restore();
      assert.deepEqual(store.read(), saved);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.deepEqual(fs.readdirSync(dir), ['site-appearance.json']);
    }
    fs.writeFileSync(file, '{broken');
    assert.throws(() => store.read(), /UNAVAILABLE/);
    assert.throws(() => store.update({ ...update(), expectedRevision: 1 }), /UNAVAILABLE/);
    assert.throws(() => new SiteAppearanceStore(dir).read(), /UNAVAILABLE/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function httpFixture(enabled = false, roles = false) {
  const dir = temporary();
  const auth = roles
    ? ({
        enabled: true,
        router: express.Router(),
        session: (req: express.Request) => ({ user: { role: req.get('x-test-role') } }),
        requireCsrf: (req: express.Request) => req.get('x-test-csrf') === 'valid',
      } as unknown as AuthService)
    : new AuthService({ dataDir: dir, enabled });
  const store = new SiteAppearanceStore(dir);
  const tenant = createIsolatedTenantApplication({
    dir,
    appRoot: dir,
    port: 3001,
    auth,
    enabled: roles ? false : enabled,
    services: [
      {
        register(app) {
          app.get('/api/site-appearance', appearanceHandler(store));
          app.use('/api/admin', createAdministrationRouter({ dir, auth, appearance: store }));
        },
      },
    ],
  });
  const server = tenant.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    dir,
    store,
    tenant,
    request: (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
      new Promise<Response>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: route,
            method,
            headers: { host: '127.0.0.1:3001', 'content-type': 'application/json', ...headers },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () =>
              resolve(
                new Response(method === 'HEAD' ? null : Buffer.concat(chunks), { status: res.statusCode! }),
              ),
            );
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      }),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await tenant.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('public anonymous GET/HEAD is exact, safe and outside tenant workers, not origin/auth bypass', async () => {
  const f = await httpFixture(true);
  try {
    for (const route of ['/api/site-appearance', '/API/SiTe-ApPeArAnCe/']) {
      const response = await f.request(route);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), defaultSiteAppearance());
      assert.equal((await f.request(route, 'HEAD')).status, 200);
      for (const method of ['PUT', 'POST', 'DELETE', 'OPTIONS'])
        assert.equal((await f.request(route, method)).status, 401);
    }
    for (const route of [
      '/api/site-appearance/extra',
      '/api/site-appearanceevil',
      '/api/projects',
      '/api/admin/site-appearance',
    ])
      assert.ok([401, 403].includes((await f.request(route)).status));
    assert.equal(
      (await f.request('/api/site-appearance', 'GET', undefined, { origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal(f.tenant.contexts.size, 0);
    fs.writeFileSync(path.join(f.dir, 'site-appearance.json'), '{bad');
    const broken = await f.request('/api/site-appearance');
    assert.equal(broken.status, 503);
    assert.deepEqual(Object.keys(await broken.json()).sort(), ['code', 'error']);
  } finally {
    await f.close();
  }
});

test('local admin writes require loopback CSRF, public and admin share committed state', async (t) => {
  const f = await httpFixture();
  try {
    const session = await f.request('/api/admin/session').then((r) => r.json());
    for (const token of ['', 'wrong', 'é'.repeat(64)])
      assert.equal(
        (await f.request('/api/admin/site-appearance', 'PUT', update(), { 'x-admin-csrf': token })).status,
        403,
      );
    const headers = { 'x-admin-csrf': session.csrfToken };
    assert.equal(
      (
        await f.request('/api/admin/site-appearance', 'PUT', update(), {
          ...headers,
          origin: 'http://evil.example',
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.request('/api/admin/site-appearance', 'PUT', { ...update(), css: 'evil' }, headers)).status,
      400,
    );
    const response = await f.request(
      '/api/admin/SiTe-ApPeArAnCe/',
      'PUT',
      { ...update(), companyName: 'Acme' },
      headers,
    );
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.deepEqual(await f.request('/api/site-appearance').then((r) => r.json()), saved);
    assert.deepEqual(await f.request('/api/admin/site-appearance').then((r) => r.json()), saved);
    assert.equal((await f.request('/api/admin/site-appearance', 'PUT', update(), headers)).status, 409);
    const failure = t.mock.method(fs, 'renameSync', () => {
      throw new Error('private disk detail');
    });
    const failed = await f.request(
      '/api/admin/site-appearance',
      'PUT',
      { ...update(), expectedRevision: 1 },
      headers,
    );
    assert.equal(failed.status, 503);
    assert.ok(!JSON.stringify(await failed.json()).includes('private disk detail'));
    failure.mock.restore();
    assert.deepEqual(await f.request('/api/site-appearance').then((r) => r.json()), saved);
  } finally {
    await f.close();
  }
});

test('admin and superadmin only for GET/PUT including mixed case; authenticated CSRF required', async () => {
  const f = await httpFixture(false, true);
  try {
    for (const role of ['', 'operations', 'writer', 'user', 'unknown', 'Admin']) {
      const headers = { 'x-test-role': role, 'x-test-csrf': 'valid' };
      for (const route of ['/api/admin/site-appearance', '/API/ADMIN/SiTe-ApPeArAnCe/']) {
        assert.equal((await f.request(route, 'GET', undefined, headers)).status, 403);
        assert.equal((await f.request(route, 'PUT', update(), headers)).status, 403);
      }
    }
    for (const role of ['admin', 'superadmin']) {
      const headers = { 'x-test-role': role };
      assert.equal((await f.request('/api/admin/SiTe-ApPeArAnCe/', 'GET', undefined, headers)).status, 200);
      assert.equal((await f.request('/api/admin/site-appearance', 'PUT', update(), headers)).status, 403);
      const revision = f.store.read().revision;
      assert.equal(
        (
          await f.request(
            '/api/admin/SiTe-ApPeArAnCe/',
            'PUT',
            { ...update(), expectedRevision: revision },
            { ...headers, 'x-test-csrf': 'valid' },
          )
        ).status,
        200,
      );
    }
  } finally {
    await f.close();
  }
});
