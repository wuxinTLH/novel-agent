import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import {
  installSecurityKernel,
  type SecurityKernelOptions,
  type SecurityKernelAuditEvent,
} from './security-kernel.js';
import { installHttpPolicy } from './http.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthService } from '../features/auth/auth.js';
import { createIsolatedTenantApplication } from './tenancy/isolated-tenant-application.js';

async function fixture(options: SecurityKernelOptions = {}) {
  const app = express();
  app.set('trust proxy', true);
  installSecurityKernel(app, options);
  app.use((req, res) => res.json({ url: req.url, ip: req.ip, id: res.locals.requestId }));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  return { app, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function request(port: number, path = '/api/ok', method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    },
  );
}
async function wire(port: number, payload: string) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  let result = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    result += chunk;
  });
  socket.write(payload);
  await once(socket, 'close');
  return result;
}

test('normal mixed-case and Unicode/query requests preserve routing and receive security headers', async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.get('trust proxy'), false);
    for (const target of [
      '/Api/Projects',
      '/%E4%B8%AD%E6%96%87?q=%E4%BD%A0%E5%A5%BD&redirect=https%3A%2F%2Fexample.test%2Fa',
      '/100%25',
      '/api?q=%2F%5C%2F',
    ]) {
      const response = await request(f.port, target, 'GET', {
        'x-request-id': 'attacker',
        'x-forwarded-for': '203.0.113.1',
      });
      assert.equal(response.status, 200, target);
      const body = JSON.parse(response.body);
      assert.equal(body.url, target);
      assert.equal(body.ip, '127.0.0.1');
      assert.match(response.headers['x-request-id'] as string, /^[0-9a-f-]{36}$/);
      assert.equal(body.id, response.headers['x-request-id']);
      assert.equal(response.headers['x-powered-by'], undefined);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.match(response.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
      assert.match(
        response.headers['content-security-policy'] as string,
        /https:\/\/challenges.cloudflare.com/,
      );
    }
  } finally {
    await f.close();
  }
});

test('ambiguous routing syntax is denied before routing while query separators remain legal', async () => {
  const f = await fixture();
  try {
    for (const target of [
      '/api//admin',
      '//api/admin',
      '/api\\admin',
      '/api/%2fadmin',
      '/api/%5Cadmin',
      '/api/%252Fadmin',
      '/api/%00',
      '/api/%2500',
      '/api/%0a',
      '/api/%7f',
      '/api/%C2%85',
      '/api/%GG',
      '/api/%E4',
      '/api/../admin',
      '/api/%2e%2e/admin',
      '/api?q=%00',
      '/api?q=%GG',
      '/api#fragment',
    ]) {
      const response = await request(f.port, target);
      assert.equal(response.status, 400, target);
      assert.equal(JSON.parse(response.body).code, 'REQUEST_TARGET_REJECTED');
      assert.equal(response.headers['x-frame-options'], 'DENY');
    }
    assert.equal((await request(f.port, '/api', 'TRACE')).status, 405);
    // CONNECT is handled by Node's connection event, never Express routing.
    assert.doesNotMatch(
      await wire(
        f.port,
        'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n',
      ),
      /200 OK/,
    );
  } finally {
    await f.close();
  }
});

test('bounded URL, header count, header bytes and declared body preflight', async () => {
  const f = await fixture({ maxUrlBytes: 20, maxHeaderCount: 4, maxHeaderBytes: 140, maxContentLength: 10 });
  try {
    assert.equal((await request(f.port, '/' + 'a'.repeat(20))).status, 414);
    assert.equal((await request(f.port, '/api', 'GET', { a: '1', b: '2', c: '3', d: '4' })).status, 431);
    assert.equal((await request(f.port, '/api', 'GET', { a: 'x'.repeat(140) })).status, 431);
    assert.equal((await request(f.port, '/api', 'POST', { 'content-length': '11' })).status, 413);
    // Node rejects some malformed framing before middleware; both layers fail closed.
    for (const framing of [
      'Content-Length: 1\r\nContent-Length: 2',
      'Content-Length: 1\r\nTransfer-Encoding: chunked',
      'Transfer-Encoding: gzip',
      'Host: duplicate.test',
    ]) {
      assert.match(
        await wire(
          f.port,
          `POST /api HTTP/1.1\r\nHost: localhost\r\n${framing}\r\nConnection: close\r\n\r\n`,
        ),
        /^HTTP\/1\.1 400/,
      );
    }
  } finally {
    await f.close();
  }
});

test('audit admits before routing, reports only sanitized metadata, and fails closed', async () => {
  const events: SecurityKernelAuditEvent[] = [];
  const f = await fixture({
    audit: (event) => {
      events.push(event);
    },
  });
  try {
    await request(f.port, '/api?password=secret', 'GET', { authorization: 'Bearer secret' });
    await request(f.port, '/api/%00');
    assert.deepEqual(
      events.map((event) => event.event),
      ['request.accepted', 'request.completed', 'request.rejected'],
    );
    for (const event of events) {
      assert.deepEqual(
        Object.keys(event).sort(),
        ['durationMs', 'event', 'method', 'requestId', ...(event.reason ? ['reason'] : []), 'status'].sort(),
      );
      assert.doesNotMatch(JSON.stringify(event), /secret|password|authorization/);
    }
  } finally {
    await f.close();
  }
  for (const audit of [
    () => {
      throw new Error('secret');
    },
    async () => {
      throw new Error('secret');
    },
  ]) {
    const failed = await fixture({ audit });
    try {
      const response = await request(failed.port);
      assert.equal(response.status, 503);
      assert.equal(JSON.parse(response.body).code, 'SECURITY_AUDIT_UNAVAILABLE');
      assert.doesNotMatch(response.body, /secret/);
    } finally {
      await failed.close();
    }
  }
});

test('isolated app installs boundary before early extension response and retains audited ID across workers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-kernel-'));
  const events: SecurityKernelAuditEvent[] = [];
  const tenant = createIsolatedTenantApplication({
    dir,
    appRoot: dir,
    port: 3001,
    auth: new AuthService({ dataDir: dir, enabled: false }),
    enabled: false,
    securityKernel: {
      audit: (event) => {
        events.push(event);
      },
    },
  });
  const server = tenant.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  try {
    assert.equal(tenant.app.get('trust proxy'), false);
    const malformed = await request(port, '/api/%2fadmin');
    assert.equal(malformed.status, 400);
    const denied = await request(port, '/api/auth/session', 'GET', { host: 'evil.example' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['x-powered-by'], undefined);
    assert.equal(denied.headers['x-frame-options'], 'DENY');
    const delegated = await request(port, '/api/health', 'GET', {
      host: '127.0.0.1:3001',
      'x-request-id': 'caller-controlled',
    });
    assert.equal(delegated.status, 200);
    assert.equal(events.at(-1)?.event, 'request.completed');
    assert.equal(events.at(-1)?.requestId, delegated.headers['x-request-id']);
    assert.notEqual(delegated.headers['x-request-id'], 'caller-controlled');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tenant.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single-user policy installs common boundary before origin rejection; existing CSP retained', async () => {
  const app = express();
  installHttpPolicy(app, undefined, 9999);
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await request((server.address() as net.AddressInfo).port, '/api', 'GET', {
      origin: 'https://evil.example',
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.equal(app.get('trust proxy'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const strict = express();
  strict.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    next();
  });
  installSecurityKernel(strict);
  strict.use((_req, res) => res.end());
  const strictServer = strict.listen(0, '127.0.0.1');
  await once(strictServer, 'listening');
  try {
    assert.equal(
      (await request((strictServer.address() as net.AddressInfo).port)).headers['content-security-policy'],
      "default-src 'none'",
    );
  } finally {
    await new Promise<void>((resolve) => strictServer.close(() => resolve()));
  }
});
