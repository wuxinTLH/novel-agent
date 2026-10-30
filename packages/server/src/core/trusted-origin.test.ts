import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createOriginPolicy, trustedPublicOrigin } from './trusted-origin.js';
import { installHttpPolicy } from './http.js';
import { isLocalAdministrator } from '../features/administration/administration.js';
import type { ServiceContext } from './context.js';

const request = (headers: Record<string, string | undefined>) =>
  ({ get: (key: string) => headers[key.toLowerCase()] }) as Pick<Request, 'get'>;

test('public origin configuration accepts one HTTPS origin and rejects ambiguous destinations', () => {
  assert.equal(trustedPublicOrigin('https://NOVEL.example:443/'), 'https://novel.example');
  assert.equal(trustedPublicOrigin(''), undefined);
  for (const invalid of [
    'http://novel.example',
    'https://user:password@novel.example',
    'https://novel.example/path',
    'https://novel.example?x=1',
    'https://novel.example#x',
    'https://*.example',
    ' https://novel.example',
    'https://novel.example/../',
    'https://one.example,https://two.example',
  ]) {
    assert.throws(() => trustedPublicOrigin(invalid), /NOVEL_TRUSTED_PUBLIC_ORIGIN_INVALID/);
  }
});

test('trusted exact host requires its exact origin and preserves explicit callback-only cross-site exception', () => {
  const allowed = createOriginPolicy(3001, 'https://novel.example');
  assert.equal(allowed(request({ host: 'novel.example', origin: 'https://novel.example' })), true);
  assert.equal(allowed(request({ host: 'novel.example' })), true);
  for (const headers of [
    { host: 'novel.example', origin: 'https://evil.example' },
    { host: 'novel.example', origin: 'http://localhost:3001' },
    { host: 'evil.example', origin: 'https://novel.example' },
    { host: 'localhost:3001', origin: 'https://novel.example' },
    { host: 'novel.example', origin: 'null' },
    { host: 'novel.example', origin: 'https://novel.example', 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal(allowed(request(headers)), false);
  assert.equal(allowed(request({ host: 'novel.example', 'sec-fetch-site': 'cross-site' }), true), true);
  assert.equal(createOriginPolicy(3001, undefined)(request({ host: 'novel.example' })), false);
  assert.equal(allowed(request({ host: 'localhost:3001', origin: 'http://localhost:5173' })), true);
  assert.equal(
    isLocalAdministrator({
      ...request({ host: 'novel.example', origin: 'https://novel.example' }),
      socket: { remoteAddress: '127.0.0.1' },
    } as Request),
    false,
  );
});

test('private address trust rejects DNS names that merely start with private IPv4 prefixes', () => {
  const allowed = createOriginPolicy(3001, undefined);
  for (const hostname of [
    '10.attacker.example',
    '192.168.attacker.example',
    '172.16.attacker.example',
    '172.31.attacker.example',
  ]) {
    const host = `${hostname}:3001`;
    assert.equal(
      allowed(request({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' })),
      false,
      host,
    );
    assert.equal(allowed(request({ host })), false, host);
    assert.equal(allowed(request({ host: 'localhost:3001', origin: `http://${host}` })), false, host);
  }
  for (const hostname of [
    'localhost',
    '127.0.0.1',
    '[::1]',
    '10.0.0.1',
    '192.168.1.2',
    '172.16.0.1',
    '172.31.255.254',
  ]) {
    const host = `${hostname}:3001`;
    assert.equal(allowed(request({ host, origin: `http://${host}` })), true, host);
  }
  for (const hostname of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8'])
    assert.equal(allowed(request({ host: `${hostname}:3001` })), false, hostname);
});

test('HTTP policy blocks rebinding-shaped Host and Origin before a read-only API handler', async () => {
  const app = express();
  installHttpPolicy(app, undefined, 3001);
  let calls = 0;
  app.get('/api/private', (_req, res) => {
    calls++;
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (host: string, origin: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/private',
            headers: { host, origin, 'sec-fetch-site': 'same-origin' },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
          },
        )
        .once('error', reject);
    });
  try {
    for (const hostname of ['10.attacker.example', '192.168.attacker.example', '172.16.attacker.example']) {
      const host = `${hostname}:3001`;
      const response = await call(host, `http://${host}`);
      assert.equal(response.status, 403);
      assert.equal(JSON.parse(response.body).code, 'LOCAL_ORIGIN_REJECTED');
    }
    assert.equal(calls, 0);
    assert.equal((await call('127.0.0.1:3001', 'http://127.0.0.1:3001')).status, 200);
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('mixed-case API paths cannot bypass mutation CSRF and keep no-store on reads', async () => {
  const app = express();
  installHttpPolicy(
    app,
    { dir: process.cwd(), platformRuntime: { csrfToken: 'test-csrf' } } as ServiceContext,
    3001,
  );
  let mutations = 0;
  app.post('/api/write', (_req, res) => {
    mutations++;
    res.json({ ok: true });
  });
  app.get('/api/read', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, route: string, csrf?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: route,
          method,
          headers: { host: '127.0.0.1:3001', ...(csrf ? { 'x-platform-csrf': csrf } : {}) },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
        },
      );
      req.once('error', reject);
      req.end();
    });
  try {
    for (const route of ['/api/write', '/API/write', '/Api/write']) {
      assert.equal((await call('POST', route)).status, 403, route);
      assert.equal((await call('POST', route, 'wrong-token')).status, 403, route);
    }
    assert.equal(mutations, 0);
    assert.equal((await call('POST', '/API/write', 'test-csrf')).status, 200);
    assert.equal(mutations, 1);
    const read = await call('GET', '/API/read');
    assert.equal(read.status, 200);
    assert.equal(read.headers['cache-control'], 'no-store');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('worker policy accepts public origin without weakening mutation CSRF or forwarded-header denial', async () => {
  const previous = process.env.NOVEL_TRUSTED_PUBLIC_ORIGIN;
  process.env.NOVEL_TRUSTED_PUBLIC_ORIGIN = 'https://novel.example';
  const app = express();
  try {
    installHttpPolicy(
      app,
      { dir: process.cwd(), platformRuntime: { csrfToken: 'worker-token' } } as ServiceContext,
      3001,
    );
  } finally {
    if (previous === undefined) delete process.env.NOVEL_TRUSTED_PUBLIC_ORIGIN;
    else process.env.NOVEL_TRUSTED_PUBLIC_ORIGIN = previous;
  }
  app.post('/api/write', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/write`;
  const call = (headers: Record<string, string>) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const outgoing = http.request(url, { method: 'POST', headers }, (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolve({ status: incoming.statusCode! }));
      });
      outgoing.once('error', reject);
      outgoing.end();
    });
  try {
    assert.equal((await call({ host: 'novel.example', origin: 'https://novel.example' })).status, 403);
    assert.equal(
      (
        await call({
          host: 'novel.example',
          origin: 'https://novel.example',
          'x-platform-csrf': 'worker-token',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call({
          host: 'novel.example',
          origin: 'https://evil.example',
          'x-platform-csrf': 'worker-token',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call({
          host: 'novel.example',
          origin: 'https://novel.example',
          'sec-fetch-site': 'cross-site',
          'x-platform-csrf': 'worker-token',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call({
          host: 'evil.example',
          'x-forwarded-host': 'novel.example',
          'x-forwarded-proto': 'https',
          'x-platform-csrf': 'worker-token',
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
