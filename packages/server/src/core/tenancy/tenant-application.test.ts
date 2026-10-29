import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import type { Project } from '../../../../../shared/types.js';
import { AuthService } from '../../features/auth/auth.js';
import { createTenantApplication } from './tenant-application.js';

const password = 'tenant test password 123!';
// The HTTP listener is ephemeral; the Host header must match the policy's configured port.
const policyPort = 3001;
const host = `localhost:${policyPort}`;
interface Identity {
  id: string;
  cookie: string;
  csrf: string;
}

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-tenants-'));
  const auth = new AuthService({
    dataDir: dir,
    enabled: true,
    fetch: async () => {
      throw new Error('External network is forbidden in tenant tests');
    },
  });
  const owner = auth.bootstrapSuperadmin('admin', password);
  fs.writeFileSync(
    path.join(dir, 'auth-enabled.json'),
    JSON.stringify({ enabled: true, legacyOwnerId: null }),
  );
  const tenant = createTenantApplication({ dir, port: policyPort, appRoot: dir, auth });
  const server = http.createServer(tenant.app);
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await tenant.close();
      assert.equal(tenant.contexts.size, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  async function request(
    method: string,
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const payload =
      body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Promise<{ status: number; body: any; bytes: Buffer; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method,
            path: route,
            headers: {
              host,
              'content-type': 'application/json',
              ...(payload ? { 'content-length': String(payload.length) } : {}),
              ...headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
              const bytes = Buffer.concat(chunks);
              try {
                resolve({
                  status: res.statusCode!,
                  body: res.headers['content-type']?.includes('application/json')
                    ? JSON.parse(bytes.toString('utf8'))
                    : undefined,
                  bytes,
                  headers: res.headers,
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on('error', reject);
        req.end(payload);
      },
    );
  }
  async function login(username: string): Promise<Identity> {
    const prelogin = await request('GET', '/api/auth/csrf');
    assert.equal(prelogin.status, 200);
    assert.equal(prelogin.body.authenticated, false);
    assert.match(prelogin.body.csrfToken, /^[a-f0-9]{64}$/);
    const preCookie = prelogin.headers['set-cookie']!.find((value) => value.startsWith('novel_prelogin='))!;
    assert.match(preCookie, /Path=\/(?:;|$)/);
    const response = await request(
      'POST',
      '/api/auth/login',
      { username, password },
      {
        cookie: preCookie.split(';')[0],
        'x-csrf-token': prelogin.body.csrfToken,
      },
    );
    assert.equal(response.status, 200);
    const sessionCookie = response.headers['set-cookie']!.find((value) =>
      value.startsWith('novel_session='),
    )!;
    assert.match(sessionCookie, /Path=\/(?:;|$)/);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Strict/);
    return { id: response.body.user.id, cookie: sessionCookie.split(';')[0], csrf: response.body.csrfToken };
  }
  async function users() {
    const admin = await login('admin');
    assert.equal(admin.id, owner.id);
    const created = await request(
      'POST',
      '/api/auth/users',
      { username: 'writer', password },
      {
        cookie: admin.cookie,
        'x-csrf-token': admin.csrf,
      },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.user.role, 'writer');
    const writer = await login('writer');
    assert.equal(writer.id, created.body.user.id);
    return { admin, writer };
  }
  async function runtime(user: Identity) {
    const response = await request('GET', '/api/health', undefined, { cookie: user.cookie });
    assert.equal(response.status, 200);
    assert.match(response.body.platform.csrfToken, /^[a-f0-9]{64}$/);
    return response.body.platform.csrfToken as string;
  }
  function headers(user: Identity, token: string) {
    return { cookie: user.cookie, 'x-csrf-token': user.csrf, 'X-Platform-CSRF': token };
  }
  return { dir, tenant, request, users, runtime, headers };
}

async function imageUpload(marker: string) {
  const boundary = 'novel-tenant-test-boundary';
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#3478abcd' } })
    .png().toBuffer();
  const image = Buffer.concat([png, Buffer.from(marker)]);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nworld\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="private.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, image, contentType: `multipart/form-data; boundary=${boundary}` };
}

test('tenant outer policy precedes authentication and anonymous APIs/uploads never create contexts', async (t) => {
  const f = await fixture(t);
  const session = await f.request('GET', '/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.enabled, true);
  assert.equal(session.body.authenticated, false);
  assert.equal(
    (await f.request('GET', '/api/auth/csrf', undefined, { host: 'evil.example:3001' })).body.code,
    'LOCAL_ORIGIN_REJECTED',
  );
  const badOrigin = await f.request('GET', '/api/auth/csrf', undefined, { origin: 'https://evil.example' });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.code, 'LOCAL_ORIGIN_REJECTED');
  const login = await f.request('POST', '/api/auth/login', { username: 'admin', password });
  assert.equal(login.status, 403);
  assert.equal(login.body.error, 'AUTH_CSRF_INVALID');
  const adminApi = await f.request('GET', '/api/auth/users');
  assert.equal(adminApi.status, 401);
  assert.equal(adminApi.body.error, 'AUTH_REQUIRED');
  for (const route of ['/api/projects', '/api/health', '/api/missing', '/uploads', '/uploads/private.png']) {
    const response = await f.request('GET', route, undefined, { 'x-user-id': 'admin' });
    assert.equal(response.status, 401, route);
    assert.equal(response.body.code, 'AUTH_REQUIRED', route);
  }
  const upload = await imageUpload('anonymous');
  for (const [route, body, contentType] of [
    ['/api/projects', { title: 'Anonymous' }, 'application/json'],
    ['/api/projects/missing/assets/upload', upload.body, upload.contentType],
  ] as const) {
    const response = await f.request('POST', route, body, { 'content-type': contentType });
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'AUTH_REQUIRED');
  }
  assert.equal(f.tenant.contexts.size, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'users')), false);
});

test('mixed-case API and upload paths retain authentication and SQLconnect role guards', async (t) => {
  const f = await fixture(t);
  for (const route of ['/API/projects', '/Api/health', '/UPLOADS/private.png']) {
    assert.equal((await f.request('GET', route)).status, 401, route);
  }
  const { writer } = await f.users();
  const runtime = await f.runtime(writer);
  for (const prefix of ['/api/sqlconnect', '/api/SQLconnect', '/API/SQLCONNECT']) {
    for (const [method, suffix] of [
      ['GET', '/status'],
      ['PUT', '/config'],
      ['POST', '/initialize'],
    ]) {
      const response = await f.request(
        method,
        prefix + suffix,
        method === 'GET' ? undefined : {},
        f.headers(writer, runtime),
      );
      assert.equal(response.status, 403, `${method} ${prefix}${suffix}`);
      assert.equal(response.body.code, 'AUTH_FORBIDDEN');
    }
  }
});

test('authenticated tenants keep projects, lists, uploads and immutable runtime contexts separate', async (t) => {
  const f = await fixture(t);
  const { admin, writer } = await f.users();
  const [adminToken, writerToken] = await Promise.all([f.runtime(admin), f.runtime(writer)]);
  assert.notEqual(adminToken, writerToken);
  const adminContext = f.tenant.contexts.get(admin.id)!.context;
  const writerContext = f.tenant.contexts.get(writer.id)!.context;
  assert.notEqual(adminContext, writerContext);
  assert.notEqual(adminContext.store, writerContext.store);
  assert.notEqual(adminContext.runner, writerContext.runner);
  assert.notEqual(adminContext.platformRuntime, writerContext.platformRuntime);
  assert.notEqual(adminContext.modelProvider, writerContext.modelProvider);
  for (const user of [admin, writer]) {
    const context = f.tenant.contexts.get(user.id)!.context;
    assert.equal(context.dir, path.join(f.dir, 'users', createHash('sha256').update(user.id).digest('hex')));
    assert.equal(context.modelProvider.settings.mode, 'demo');
    assert.equal(context.modelProvider.settings.apiKey, '');
  }
  const created = await Promise.all([
    f.request('POST', '/api/projects', { title: 'Admin private project' }, f.headers(admin, adminToken)),
    f.request('POST', '/api/projects', { title: 'Writer private project' }, f.headers(writer, writerToken)),
  ]);
  for (const response of created) assert.equal(response.status, 201);
  const projects = created.map((response) => response.body as Project);
  for (const [user, token, own, other] of [
    [admin, adminToken, projects[0], projects[1]],
    [writer, writerToken, projects[1], projects[0]],
  ] as const) {
    const list = await f.request('GET', '/api/projects', undefined, { cookie: user.cookie });
    assert.equal(list.status, 200);
    assert.ok(list.body.some((project: Project) => project.id === own.id));
    assert.ok(!list.body.some((project: Project) => project.id === other.id));
    const detail = await f.request('GET', `/api/projects/${own.id}`, undefined, { cookie: user.cookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.title, own.title);
    assert.equal(
      (await f.request('GET', `/api/projects/${other.id}`, undefined, { cookie: user.cookie })).status,
      404,
    );
    assert.equal(
      (await f.request('PATCH', `/api/projects/${other.id}`, { title: 'stolen' }, f.headers(user, token)))
        .status,
      404,
    );
  }
  const uploads: { user: Identity; url: string; image: Buffer }[] = [];
  for (const [user, token, project] of [
    [admin, adminToken, projects[0]],
    [writer, writerToken, projects[1]],
  ] as const) {
    const upload = await imageUpload(user.id);
    const result = await f.request('POST', `/api/projects/${project.id}/assets/upload`, upload.body, {
      ...f.headers(user, token),
      'content-type': upload.contentType,
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.assets.length, 1);
    const url = result.body.assets[0].url as string;
    assert.match(url, /^\/uploads\/[a-f0-9-]+\.png$/);
    uploads.push({ user, url, image: upload.image });
  }
  for (const { user, url, image } of uploads) {
    const own = await f.request('GET', url, undefined, { cookie: user.cookie });
    assert.equal(own.status, 200);
    const expectedPixels = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ownPixels = await sharp(own.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(ownPixels.info.width, expectedPixels.info.width);
    assert.equal(ownPixels.info.height, expectedPixels.info.height);
    assert.deepEqual(ownPixels.data, expectedPixels.data);
    assert.equal(own.bytes.includes(Buffer.from(user.id)), false, 're-encoding removes appended upload marker');
    assert.equal(own.headers['cache-control'], 'private, no-store');
    const other = await f.request('GET', url, undefined, {
      cookie: user.id === admin.id ? writer.cookie : admin.cookie,
    });
    assert.equal(other.status, 404);
    assert.equal(other.body.code, 'UPLOAD_NOT_FOUND');
    const anonymous = await f.request('GET', url);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.code, 'AUTH_REQUIRED');
  }
  assert.equal(await f.runtime(admin), adminToken);
  assert.equal(await f.runtime(writer), writerToken);
  assert.equal(f.tenant.contexts.get(admin.id)!.context, adminContext);
  assert.equal(f.tenant.contexts.get(writer.id)!.context, writerContext);
  assert.equal(f.tenant.contexts.size, 2);
  assert.equal(adminContext.store.get(projects[0].id)!.title, projects[0].title);
  assert.equal(writerContext.store.get(projects[1].id)!.title, projects[1].title);
  assert.equal(fs.existsSync(path.join(f.dir, 'projects.json')), false);
});

test('session CSRF and per-tenant runtime CSRF are independent required guards', async (t) => {
  const f = await fixture(t);
  const { admin, writer } = await f.users();
  const adminToken = await f.runtime(admin);
  const writerToken = await f.runtime(writer);
  for (const [headers, code] of [
    [{ cookie: writer.cookie, 'X-Platform-CSRF': writerToken }, 'AUTH_CSRF_REQUIRED'],
    [{ ...f.headers(writer, writerToken), 'x-csrf-token': admin.csrf }, 'AUTH_CSRF_REQUIRED'],
    [{ cookie: writer.cookie, 'x-csrf-token': writer.csrf }, 'PLATFORM_CSRF_REQUIRED'],
    [{ ...f.headers(writer, adminToken) }, 'PLATFORM_CSRF_REQUIRED'],
    [{ ...f.headers(admin, writerToken) }, 'PLATFORM_CSRF_REQUIRED'],
  ] as const) {
    const response = await f.request('POST', '/api/projects', { title: 'Must not persist' }, headers);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, code);
  }
  // An origin allowed by the outer LAN policy still must match the authenticated session's Host.
  const foreignOrigin = await f.request(
    'POST',
    '/api/projects',
    { title: 'Wrong origin' },
    {
      ...f.headers(writer, writerToken),
      origin: `http://127.0.0.1:${policyPort}`,
    },
  );
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.body.code, 'AUTH_CSRF_REQUIRED');
  for (const user of [admin, writer]) {
    const list = await f.request('GET', '/api/projects', undefined, { cookie: user.cookie });
    assert.ok(
      !list.body.some((project: Project) => ['Must not persist', 'Wrong origin'].includes(project.title)),
    );
  }
  const accepted = await f.request(
    'POST',
    '/api/projects',
    { title: 'Both guards satisfied' },
    {
      ...f.headers(writer, writerToken),
      origin: `http://${host}`,
    },
  );
  assert.equal(accepted.status, 201);
  const adminOnly = await f.request('GET', '/api/auth/users', undefined, { cookie: writer.cookie });
  assert.equal(adminOnly.status, 403);
  assert.equal(adminOnly.body.error, 'AUTH_PERMISSION_DENIED');
  const sql = await f.request('GET', '/api/sqlconnect/status', undefined, { cookie: writer.cookie });
  assert.equal(sql.status, 403);
  assert.equal(sql.body.code, 'AUTH_FORBIDDEN');
});
