import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { bindTokenUsageWorker } from './token-usage-channel.js';
import { TokenUsageLedger, usageRange } from './token-usage.js';
import { createAdministrationRouter } from './administration.js';
import type { AuthService } from '../auth/auth.js';

const now = () => new Date('2026-05-31T12:00:00.000Z');
const event = { model: 'model-a', at: '2026-05-31T10:00:01.000Z', succeeded: true, inputTokens: 10, outputTokens: 5, estimated: false };
test('strict dates and inclusive 31-day bound', () => {
  assert.equal(usageRange('2026-05-01', '2026-05-31').days, 31);
  assert.equal(usageRange('2024-02-29', '2024-02-29').days, 1);
  for (const [from, to] of [['2026-04-30', '2026-05-31'], ['2026-02-29', '2026-03-01'], ['2026-02-30', '2026-03-01'], ['2026-5-01', '2026-05-01'], ['2026-05-02', '2026-05-01'], ['', ''], ['2026-13-01', '2026-13-02']]) assert.throws(() => usageRange(from, to));
  assert.throws(() => usageRange(['2026-05-01'], '2026-05-01'));
  assert.throws(() => usageRange('2026-05-01', '2026-05-01', ['a']));
});
test('durable global aggregation, exact minute peaks, estimates, filtering and retention', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-usage-'));
  try {
    const ledger = new TokenUsageLedger(dir, now);
    await Promise.all(Array.from({ length: 20 }, async (_, index) => ledger.record({ ...event, model: index % 2 ? 'model-b' : 'model-a', succeeded: index % 2 === 0, estimated: index % 2 !== 0 })));
    ledger.record({ ...event, at: '2026-05-31T10:01:01.000Z' });
    ledger.record({ ...event, at: '2026-04-01T00:00:00.000Z' });
    const result = new TokenUsageLedger(dir, now).query('2026-05-30', '2026-05-31');
    assert.equal(result.totals.requests, 21); assert.equal(result.totals.succeeded, 11); assert.equal(result.totals.failed, 10);
    assert.equal(result.totals.estimatedRequests, 10); assert.equal(result.totals.totalTokens, 315);
    assert.equal(result.totals.rpm.peak, 20); assert.equal(result.totals.tokenPm.peak, 300);
    assert.equal(result.totals.rpm.average, 21 / 2880); assert.equal(result.daily[0].requests, 0);
    assert.deepEqual(ledger.query('2026-05-31', '2026-05-31', 'model-a').models, ['model-a', 'model-b']);
    assert.equal(ledger.query('2026-05-31', '2026-05-31', 'model-a').totals.requests, 11);
    assert.equal(result.coverage.complete, false);
    const text = fs.readFileSync(path.join(dir, 'token-usage.json'), 'utf8');
    assert.ok(!text.includes('ownerId') && !text.includes('apiKey'));
    assert.throws(() => ledger.record({ ...event, inputTokens: -1 }));
    assert.throws(() => ledger.query('2026-05-31', '2026-05-31'), /UNAVAILABLE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('begin is durable, restart retains indeterminate pending and finish is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-usage-pending-'));
  try {
    const attemptId = randomUUID();
    const ledger = new TokenUsageLedger(dir, now);
    ledger.record({ ...event, phase: 'begin', attemptId, succeeded: false, inputTokens: 0, outputTokens: 0 });
    ledger.record({ ...event, phase: 'begin', attemptId, succeeded: false, inputTokens: 0, outputTokens: 0 });
    const restarted = new TokenUsageLedger(dir, now);
    assert.equal(restarted.query('2026-05-31', '2026-05-31').totals.pending, 1);
    restarted.record({ ...event, phase: 'finish', attemptId });
    restarted.record({ ...event, phase: 'finish', attemptId });
    const totals = restarted.query('2026-05-31', '2026-05-31').totals;
    assert.equal(totals.requests, 1); assert.equal(totals.pending, 0); assert.equal(totals.succeeded, 1); assert.equal(totals.totalTokens, 15);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('private worker channel acknowledges durable writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-usage-worker-'));
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); parentPort.on('message', m=>{ if(m.type==='go') parentPort.postMessage({type:'token-usage-v1',requestId:workerData.id,event:workerData.event}); else if(m.type==='token-usage-v1') parentPort.postMessage({type:'test-result',ok:m.ok}); });`, { eval: true, workerData: { id: randomUUID(), event: { ...event, at: new Date().toISOString() } } });
  bindTokenUsageWorker(worker, dir);
  try {
    const result = new Promise<boolean>(resolve => worker.on('message', m => { if (m.type === 'test-result') resolve(m.ok); }));
    worker.postMessage({ type: 'go' }); assert.equal(await result, true);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(new TokenUsageLedger(dir).query(day, day).totals.requests, 1);
  } finally { await worker.terminate(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('corrupt telemetry never becomes an empty successful report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-usage-'));
  try { fs.writeFileSync(path.join(dir, 'token-usage.json'), '{broken'); assert.throws(() => new TokenUsageLedger(dir), /UNAVAILABLE/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('admin/superadmin only including mixed-case route and invalid query', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-usage-http-'));
  const auth = { enabled: true, session: (req: express.Request) => ({ user: { role: req.get('x-test-role') } }), requireCsrf: () => false, router: express.Router() } as unknown as AuthService;
  const app = express(); app.use('/api/admin', createAdministrationRouter({ dir, auth }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (role: string, query = 'from=2026-05-01&to=2026-05-31') => fetch(`http://127.0.0.1:${address.port}/api/admin/ToKeN-uSaGe?${query}`, { headers: { 'x-test-role': role } });
  try {
    for (const role of ['', 'operations', 'writer', 'user', 'unknown']) assert.equal((await request(role)).status, 403);
    for (const role of ['admin', 'superadmin']) assert.equal((await request(role)).status, 200);
    const trailing = `http://127.0.0.1:${address.port}/api/admin/token-usage/?from=2026-05-01&to=2026-05-31`;
    assert.equal((await fetch(trailing, { headers: { 'x-test-role': 'operations' } })).status, 403);
    assert.equal((await fetch(trailing, { headers: { 'x-test-role': 'admin' } })).status, 200);
    assert.equal((await fetch(trailing, { method: 'POST', headers: { 'x-test-role': 'admin' } })).status, 403);
    assert.equal((await request('admin', 'from=2026-02-30&to=2026-03-01')).status, 400);
    assert.equal((await request('admin', 'from=2026-05-01&from=2026-05-02&to=2026-05-31')).status, 400);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); fs.rmSync(dir, { recursive: true, force: true }); }
});
