import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadLease, type UploadLease } from './upload-lease.js';
import express from 'express';
import http from 'node:http';
import { quarantinedUpload } from './upload.js';
import { reserveUpload } from './sandbox.js';
import { assetsService } from '../assets/assets.js';
import type { ServiceContext } from '../../core/context.js';

test('disconnect after parsing aborts scanner but retains its slot until work settles', async () => {
  let active = 2;
  const lease = createUploadLease(() => active--);
  assert.equal(lease.handoff(), true);
  let scannerStopped!: () => void;
  const stopped = new Promise<void>(resolve => { scannerStopped = resolve; });
  const work = stopped.finally(() => lease.release());
  lease.disconnect();
  assert.equal(lease.signal.aborted, true);
  assert.equal(active, 2, 'disconnect must not admit another scanner while native work is still alive');
  scannerStopped();
  await work;
  assert.equal(active, 1);
  lease.disconnect(); lease.release();
  assert.equal(active, 1, 'all cleanup paths return the slot exactly once');
});

test('disconnect during multipart buffering releases admission and forbids scanner handoff', () => {
  let releases = 0;
  const lease = createUploadLease(() => releases++);
  lease.disconnect();
  assert.equal(lease.signal.aborted, true);
  assert.equal(releases, 1);
  assert.equal(lease.handoff(), false, 'late multer callback cannot start work after disconnect');
  lease.disconnect(); lease.release();
  assert.equal(releases, 1);
});

test('multipart failure and completed handler release once without waiting for response close', () => {
  let releases = 0;
  const parseFailure = createUploadLease(() => releases++);
  parseFailure.release();
  assert.equal(parseFailure.handoff(), false);
  const handler = createUploadLease(() => releases++);
  assert.equal(handler.handoff(), true);
  handler.release(); handler.disconnect();
  assert.equal(releases, 2);
});

test('real asset handler returns admission on invalid category and empty-file early exit', { timeout: 15000 }, async () => {
  const app = express();
  // These early exits must not touch project storage.
  assetsService.register(app, { store: {} } as ServiceContext);
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.sendStatus(error.status || 400); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const post = (category: string) => new Promise<number>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/api/projects/test/assets/upload', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } }, response => { response.resume(); resolve(response.statusCode!); });
    request.on('error', reject);
    request.end(`--x\r\nContent-Disposition: form-data; name="category"\r\n\r\n${category}\r\n--x--\r\n`);
  });
  try {
    // Repetition exceeds the two-slot capacity if any early-return path leaks.
    for (const category of ['invalid', 'world', 'invalid', 'world']) assert.equal(await post(category), 400);
    const one = reserveUpload();
    try { const two = reserveUpload(); two(); } finally { one(); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP response disconnect cannot recycle a slot owned by an unfinished scanner', { timeout: 15000 }, async () => {
  const app = express();
  let resolveEntered!: (lease: UploadLease) => void;
  const entered = new Promise<UploadLease>(resolve => { resolveEntered = resolve; });
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  app.post('/upload', quarantinedUpload('file', 1, 1024), async (_req, res) => {
    const lease = res.locals.uploadLease as UploadLease;
    resolveEntered(lease);
    try { await stopped; if (!lease.signal.aborted) res.sendStatus(200); }
    finally { lease.release(); }
  });
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.sendStatus(error.status || 500); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const first = http.request({ host: '127.0.0.1', port, path: '/upload', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } });
  first.on('error', () => {});
  first.end('--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\ntext\r\n--x--\r\n');
  const lease = await entered;
  try {
    const aborted = new Promise<void>(resolve => lease.signal.addEventListener('abort', () => resolve(), { once: true }));
    first.destroy();
    await aborted;
    // First scan still owns one slot. Occupy the other and prove the next HTTP
    // multipart request is rejected before its handler can start.
    const second = createUploadLease(reserveUpload());
    try {
      const status = await new Promise<number>(resolve => {
        const request = http.request({ host: '127.0.0.1', port, path: '/upload', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } }, response => { response.resume(); resolve(response.statusCode!); });
        request.end('--x--\r\n');
      });
      assert.equal(status, 429);
    } finally { second.release(); }
  } finally {
    stop();
    await stopped;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
