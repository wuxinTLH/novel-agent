import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { once } from 'node:events';
import { readLocalGatewayConfig, startLocalGateway, type LocalGatewayLimits } from './local-gateway.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function fixture(handler: http.RequestListener, limits: LocalGatewayLimits = {}) {
  const upstream = http.createServer(handler);
  const targetPort = await listen(upstream);
  const port = await freePort();
  const gateway = await startLocalGateway(readLocalGatewayConfig({
    GATEWAY_ENABLED: 'true', GATEWAY_PORTS: String(port),
    GATEWAY_TARGET: `http://127.0.0.1:${targetPort}`,
  }), limits);
  return { port, upstream, gateway, async close() {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  } };
}
function request(port: number, options: http.RequestOptions = {}, body = '') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('gateway defaults off and validates enabled configuration without DNS or URL normalization', async () => {
  assert.deepEqual(readLocalGatewayConfig({}), { enabled: false, ports: [], target: '' });
  assert.deepEqual((await startLocalGateway(readLocalGatewayConfig({}))).addresses, []);
  const env = { GATEWAY_ENABLED: 'true', GATEWAY_PORTS: '5173, 5174' };
  assert.deepEqual(readLocalGatewayConfig(env), { enabled: true, ports: [5173, 5174], target: 'http://127.0.0.1:3001' });
  assert.equal(readLocalGatewayConfig({ ...env, GATEWAY_TARGET: 'http://localhost:3001' }).target, 'http://127.0.0.1:3001');
  assert.equal(readLocalGatewayConfig({ ...env, GATEWAY_TARGET: 'http://[::1]:3001' }).target, 'http://[::1]:3001');
  for (const target of ['https://127.0.0.1:3001', 'http://example.com:3001', 'http://0.0.0.0:3001',
    'http://169.254.169.254:3001', 'http://127.1:3001', 'http://2130706433:3001',
    'http://127.0.0.1:80', 'http://user@127.0.0.1:3001', 'http://127.0.0.1:3001/path',
    'http://127.0.0.1:3001?x=1', 'http://127.0.0.1:3001#fragment', 'http://[::ffff:127.0.0.1]:3001'])
    assert.throws(() => readLocalGatewayConfig({ ...env, GATEWAY_TARGET: target }), /GATEWAY_/);
  for (const ports of ['', '5173,5173', '3001', '80', '65536', '0', '1e4', '5173,', '0.0.0.0:5173'])
    assert.throws(() => readLocalGatewayConfig({ ...env, GATEWAY_PORTS: ports }), /GATEWAY_/);
  assert.throws(() => readLocalGatewayConfig({ ...env, GATEWAY_TARGET: 'http://localhost:5173' }), /TARGET_PORT_CONFLICT/);
  assert.throws(() => readLocalGatewayConfig({ GATEWAY_ENABLED: 'yes' }), /ENABLED_INVALID/);
});

test('GET/POST preserve path, headers, body, status and redirect without retries', async () => {
  let calls = 0;
  const f = await fixture(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(307, { location: 'http://example.com/never-follow', 'set-cookie': ['a=1', 'b=2'], 'x-result': 'ok' });
    res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host,
      custom: req.headers['x-custom'], forwarded: req.headers['x-forwarded-for'], body: Buffer.concat(chunks).toString() }));
  });
  try {
    for (const method of ['GET', 'POST']) {
      const body = method === 'POST' ? '{"hello":"世界"}' : '';
      const result = await request(f.port, { method, path: '/a?b=%2F', headers: {
        host: 'localhost:5173', 'x-custom': 'yes', 'x-forwarded-for': '8.8.8.8',
      } }, body);
      assert.equal(result.status, 307);
      assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
      assert.equal(result.headers['x-result'], 'ok');
      assert.deepEqual(JSON.parse(result.body), { method, url: '/a?b=%2F', host: 'localhost:5173', custom: 'yes', body });
    }
    assert.equal(calls, 2);
    assert.equal((await request(f.port, { path: 'http://example.com/' })).status, 400);
  } finally { await f.close(); }
});

test('bounds upload and response bytes, deadlines and concurrency', async () => {
  let calls = 0;
  const f = await fixture((req, res) => {
    calls++;
    if (req.url === '/large') res.end('123456789');
    else if (req.url === '/hang') { /* deadline ends this exchange */ }
    else res.end('ok');
  }, { maxRequestBytes: 4, maxResponseBytes: 8, timeoutMs: 200, maxConcurrent: 1 });
  try {
    assert.equal((await request(f.port, { method: 'POST' }, '12345')).status, 413);
    assert.equal(calls, 0);
    assert.equal((await request(f.port, { path: '/large' })).status, 502);
    const arrived = once(f.upstream, 'request');
    const pending = request(f.port, { path: '/hang' });
    await arrived;
    assert.equal((await request(f.port)).status, 503);
    assert.equal((await pending).status, 504);
    assert.equal((await request(f.port)).status, 200);
  } finally { await f.close(); }
});

test('client disconnect cancels upstream and releases concurrency without retry', async () => {
  let calls = 0;
  let disconnected!: Promise<unknown>;
  const f = await fixture((_req, res) => {
    calls++;
    disconnected = once(res, 'close');
  }, { maxConcurrent: 1, timeoutMs: 1000 });
  try {
    const arrived = once(f.upstream, 'request');
    const req = http.get({ hostname: '127.0.0.1', port: f.port });
    req.on('error', () => {});
    await arrived;
    req.destroy();
    await disconnected;
    assert.equal(calls, 1);
    const secondArrived = once(f.upstream, 'request');
    const second = http.get({ hostname: '127.0.0.1', port: f.port });
    second.on('error', () => {});
    await secondArrived;
    second.destroy();
  } finally { await f.close(); }
});

test('startup rolls back earlier listeners if a later port is occupied', async () => {
  const occupied = http.createServer();
  const taken = await listen(occupied);
  const first = await freePort();
  try {
    await assert.rejects(startLocalGateway({ enabled: true, ports: [first, taken], target: 'http://127.0.0.1:3001' }), /EADDRINUSE/);
    const probe = http.createServer();
    probe.listen(first, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
});
