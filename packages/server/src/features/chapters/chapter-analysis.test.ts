import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import { ChapterAnalysisRuntime, chapterAnalysisInput, chapterAnalysisService } from './chapter-analysis.js';
import { chapterAnalysisRequestSchema, type ChapterAnalysisRequest } from '../../../../../shared/chapter-analysis.js';
import { createServiceContext } from '../../core/context.js';
import { createProject } from '../projects/defaults.js';
import { Store } from '../projects/store.js';
import { projectsService } from '../projects/projects.js';
import { installHttpFallbacks, installHttpPolicy } from '../../core/http.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-analysis-'));
  const context = createServiceContext(dir, false);
  const project = context.store.projects[0];
  project.chapters = [9, 1, 4].map(number => ({ id: randomUUID(), number, title: `Chapter ${number}`, revision: 2,
    content: `Canonical text ${number}`, updatedAt: new Date().toISOString(), mode: 'live' as const }));
  context.store.touch(project);
  context.modelProvider.models.set('live', { id: 'live', name: 'Model', model: 'stub-model', baseUrl: 'https://example.invalid/v1',
    apiKey: 'never-persist-secret', hasKey: true, mode: 'live', protocol: 'chat-completions' });
  let calls = 0;
  let handler = async (): Promise<Response> => new Response(JSON.stringify({ choices: [{ message: { content: '第4章观察：人物目标清晰。建议：调整节奏。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }), { headers: { 'content-type': 'application/json' } });
  const runtime = new ChapterAnalysisRuntime(context, { assertUrl: async () => {}, fetch: (async () => { calls++; return handler(); }) as typeof fetch });
  const request = (): ChapterAnalysisRequest => ({ requestId: randomUUID(), selection: { kind: 'recent', count: 2 }, modelId: 'live' });
  return { context, project, dir, runtime, request, calls: () => calls, setHandler: (value: typeof handler) => { handler = value; },
    close: async () => { await runtime.close(); await context.platformRuntime.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('analysis snapshots sorted canonical chapters, durable before fetch; completes without overwriting edits; idempotent forever', async () => {
  const f = fixture();
  try {
    const input = f.request();
    const before = structuredClone(f.project.steps);
    f.setHandler(async () => {
      const persisted = JSON.parse(fs.readFileSync(path.join(f.dir, 'projects.json'), 'utf8'))[0];
      assert.equal(persisted.chapterAnalyses[0].status, 'running');
      assert.equal(persisted.chapterAnalyses[0].report, undefined);
      f.project.title = 'Edited while running';
      f.project.chapters[0].content = 'Edited canonical text';
      return new Response(JSON.stringify({ choices: [{ message: { content: '第4章观察与建议' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    });
    const start = f.runtime.start(f.project, input);
    assert.equal(start.record.status, 'running');
    assert.deepEqual(start.record.sourceChapters.map(c => c.number), [4, 9]);
    assert.equal(f.runtime.start(f.project, input).created, false);
    assert.throws(() => f.runtime.start(f.project, f.request()), { code: 'ANALYSIS_BUSY' });
    await f.runtime.idle();
    assert.equal(f.project.chapterAnalyses![0].status, 'done');
    assert.equal(f.project.title, 'Edited while running');
    assert.equal(f.project.chapters[0].content, 'Edited canonical text');
    assert.deepEqual(f.project.steps, before);
    assert.equal(f.runtime.start(f.project, input).created, false);
    assert.equal(f.calls(), 1);
    assert.throws(() => f.runtime.start(f.project, { ...input, modelId: 'other' }), { code: 'ANALYSIS_REQUEST_CONFLICT' });
    const restarted = new Store(f.dir);
    assert.equal(restarted.get(f.project.id)!.chapterAnalyses![0].report, '第4章观察与建议');
    const persisted = fs.readFileSync(path.join(f.dir, 'projects.json'), 'utf8');
    assert.equal(persisted.includes('never-persist-secret'), false);
    assert.equal(persisted.includes('"content":"Canonical text'), false);
    const usage = JSON.parse(fs.readFileSync(path.join(f.dir, 'token-usage.json'), 'utf8'));
    assert.ok(usage);
  } finally { await f.close(); }
});

test('strict selection bounds, missing endpoints, empty chapters, full input limit and no model fail before admission/fetch', async () => {
  const f = fixture();
  try {
    for (const selection of [{ kind: 'recent', count: 101 }, { kind: 'range', from: 1, to: 101 }, { kind: 'range', from: 4, to: 1 }, { kind: 'recent', count: 0 }])
      assert.equal(chapterAnalysisRequestSchema.safeParse({ ...f.request(), selection }).success, false);
    assert.throws(() => chapterAnalysisInput(f.project, { ...f.request(), selection: { kind: 'range', from: 2, to: 9 } }), { code: 'ANALYSIS_SELECTION_UNAVAILABLE' });
    assert.throws(() => chapterAnalysisInput(f.project, { ...f.request(), selection: { kind: 'recent', count: 4 } }), { code: 'ANALYSIS_SELECTION_UNAVAILABLE' });
    f.project.chapters[0].content = ' ';
    assert.throws(() => f.runtime.start(f.project, f.request()), { code: 'ANALYSIS_SELECTION_UNAVAILABLE' });
    f.project.chapters[0].content = 'x'.repeat(150000);
    assert.throws(() => f.runtime.start(f.project, f.request()), { code: 'CONTEXT_TOO_LARGE' });
    assert.throws(() => f.runtime.start(f.project, { ...f.request(), modelId: 'default' }), { code: 'MODEL_UNAVAILABLE' });
    assert.equal(f.calls(), 0);
    assert.equal(f.project.chapterAnalyses, undefined);
  } finally { await f.close(); }
});

test('provider failure remains durable, sanitized and never retries; independent projects do not contaminate each other', async () => {
  const f = fixture();
  try {
    const other = createProject('other'); other.chapters = structuredClone(f.project.chapters); f.context.store.projects.push(other);
    f.setHandler(async () => { throw new Error('never-persist-secret Canonical text'); });
    const input = f.request(); f.runtime.start(f.project, input); f.runtime.start(other, f.request());
    await f.runtime.idle();
    assert.equal(f.calls(), 2);
    assert.equal(f.project.chapterAnalyses![0].errorCode, 'PROVIDER_CONNECTION_ERROR');
    assert.equal(other.chapterAnalyses![0].status, 'error');
    assert.notEqual(other.chapterAnalyses![0].id, f.project.chapterAnalyses![0].id);
    f.runtime.start(f.project, input); assert.equal(f.calls(), 2);
    assert.equal(fs.readFileSync(path.join(f.dir, 'projects.json'), 'utf8').includes('never-persist-secret'), false);
  } finally { await f.close(); }
});

test('admission save failure calls no model; completion save failure rolls back done and restart interrupts without retry', async () => {
  const f = fixture();
  try {
    const touch = f.context.store.touch.bind(f.context.store);
    f.context.store.touch = () => { throw new Error('storage unavailable'); };
    assert.throws(() => f.runtime.start(f.project, f.request()), /storage unavailable/);
    assert.equal(f.project.chapterAnalyses, undefined); assert.equal(f.calls(), 0);
    f.context.store.touch = touch;
    const input = f.request(); f.runtime.start(f.project, input);
    f.context.store.touch = () => { throw new Error('storage unavailable'); };
    await f.runtime.idle();
    assert.equal(f.project.chapterAnalyses![0].status, 'running'); assert.equal(f.project.chapterAnalyses![0].report, undefined);
    const restarted = new Store(f.dir);
    assert.equal(restarted.get(f.project.id)!.chapterAnalyses![0].status, 'interrupted');
    assert.equal(new Store(f.dir).get(f.project.id)!.chapterAnalyses![0].errorCode, 'ANALYSIS_INTERRUPTED');
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('oversized reports are rejected without truncation and close aborts/drains active request', async () => {
  const f = fixture();
  try {
    f.setHandler(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(100001) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }));
    f.runtime.start(f.project, f.request()); await f.runtime.idle();
    assert.equal(f.project.chapterAnalyses![0].errorCode, 'ANALYSIS_REPORT_TOO_LARGE');
    assert.equal(f.project.chapterAnalyses![0].report, undefined);
    await f.runtime.close();
    assert.throws(() => f.runtime.start(f.project, f.request()), { code: 'ANALYSIS_UNAVAILABLE' });
  } finally { await f.close(); }
});

test('history capacity preserves idempotency tombstones and close interrupts/drains in-flight fetch', async () => {
  const f = fixture();
  try {
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const runtime = new ChapterAnalysisRuntime(f.context, { assertUrl: async () => {}, fetch: (async (_url, options) => {
      began();
      return await new Promise<Response>((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    }) as typeof fetch });
    runtime.start(f.project, f.request()); await started; await runtime.close();
    assert.equal(f.project.chapterAnalyses![0].status, 'interrupted');
    const prior = f.project.chapterAnalyses![0];
    f.project.chapterAnalyses = Array.from({ length: 100 }, (_, i) => ({ ...prior, id: randomUUID(), requestId: i ? randomUUID() : prior.requestId }));
    assert.equal(f.runtime.start(f.project, { requestId: prior.requestId, selection: prior.selection, modelId: prior.modelId }).created, false);
    assert.throws(() => f.runtime.start(f.project, f.request()), { code: 'ANALYSIS_HISTORY_FULL' });
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test('separate tenant contexts cannot read or update one another despite matching project IDs', async () => {
  const a = fixture(), b = fixture();
  try {
    b.project.id = a.project.id;
    const sameRequest = a.request();
    a.runtime.start(a.project, sameRequest); b.runtime.start(b.project, sameRequest);
    await Promise.all([a.runtime.idle(), b.runtime.idle()]);
    assert.notEqual(a.project.chapterAnalyses![0].id, b.project.chapterAnalyses![0].id);
    assert.equal(a.calls(), 1); assert.equal(b.calls(), 1);
    assert.deepEqual(new Store(a.dir).get(a.project.id)!.chapterAnalyses, a.project.chapterAnalyses);
    assert.deepEqual(new Store(b.dir).get(b.project.id)!.chapterAnalyses, b.project.chapterAnalyses);
  } finally { await a.close(); await b.close(); }
});

for (const preserve of [false, true]) test(`delete rechecks running analysis after awaited platform cleanup (preserve=${preserve})`, async () => {
  const f = fixture();
  let releaseDelete!: () => void, enteredDelete!: () => void, releaseModel!: () => void;
  const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
  const entered = new Promise<void>(resolve => { enteredDelete = resolve; });
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  try {
    f.context.store.projects.push(createProject('other'));
    f.context.platformRuntime.removeProject = async () => { enteredDelete(); await deleteGate; };
    f.context.platformRuntime.removeProjectPreservingRecords = async (_id, commit) => { enteredDelete(); await deleteGate; commit(); };
    f.setHandler(async () => { await modelGate; return new Response(JSON.stringify({ choices: [{ message: { content: '第4章观察' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }); });
    const app = express(); installHttpPolicy(app, f.context, 3001); projectsService.register(app, f.context); installHttpFallbacks(app, f.dir, { serveWeb: false });
    const req = new http.IncomingMessage(new Socket()); req.method = 'DELETE'; req.url = `/api/projects/${f.project.id}`;
    const text = preserve ? JSON.stringify({ confirmed: true, preservePlatformRecords: true }) : '';
    req.headers = { host: '127.0.0.1:3001', ...(preserve ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } : {}), 'x-platform-csrf': f.context.platformRuntime.csrfToken };
    const res = new http.ServerResponse(req);
    const response = new Promise<{ status: number; code: string }>(resolve => { res.end = ((chunk: string) => { resolve({ status: res.statusCode, code: JSON.parse(String(chunk)).code }); return res; }) as typeof res.end; });
    app(req, res); req.push(text); req.push(null);
    await entered;
    f.runtime.start(f.project, f.request());
    releaseDelete();
    assert.deepEqual(await response, { status: 409, code: 'ANALYSIS_BUSY' });
    assert.equal(f.context.store.get(f.project.id), f.project);
    releaseModel(); await f.runtime.idle();
    assert.equal(new Store(f.dir).get(f.project.id)!.chapterAnalyses![0].report, '第4章观察');
  } finally { releaseDelete(); releaseModel(); await f.close(); }
});

test('analysis admission respects platform idle and unexpected completion lookup failure never fabricates done', async () => {
  const f = fixture();
  try {
    f.context.platformRuntime.assertProjectIdle = () => { throw Object.assign(new Error('busy'), { code: 'PLATFORM_BUSY' }); };
    assert.throws(() => f.runtime.start(f.project, f.request()), { code: 'PLATFORM_BUSY' });
    assert.equal(f.calls(), 0); assert.equal(f.project.chapterAnalyses, undefined);
    f.context.platformRuntime.assertProjectIdle = () => {};
    f.runtime.start(f.project, f.request());
    f.context.store.get = () => { throw new Error('lookup unavailable'); };
    await f.runtime.idle();
    assert.equal(f.project.chapterAnalyses![0].status, 'running');
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('HTTP route uses project lookup, CSRF and origin guard; foreign analysis IDs remain 404; delete blocked while running', async () => {
  const f = fixture();
  const app = express();
  installHttpPolicy(app, f.context, 3001); projectsService.register(app, f.context); chapterAnalysisService.register(app, f.context); installHttpFallbacks(app, f.dir, { serveWeb: false });
  const request = async (method: string, url: string, body?: unknown, csrf = f.context.platformRuntime.csrfToken, host = '127.0.0.1:3001') => {
    const req = new http.IncomingMessage(new Socket()); req.method = method; req.url = url;
    const text = body === undefined ? '' : JSON.stringify(body);
    req.headers = { host, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'x-platform-csrf': csrf };
    const res = new http.ServerResponse(req);
    const result = new Promise<{ status: number; body: any }>(resolve => { res.end = ((chunk: string) => { resolve({ status: res.statusCode, body: JSON.parse(String(chunk)) }); return res; }) as typeof res.end; });
    app(req, res); req.push(text); req.push(null); return result;
  };
  try {
    const base = `/api/projects/${f.project.id}/chapter-analyses`;
    assert.equal((await request('POST', base, f.request(), 'bad')).status, 403);
    assert.equal((await request('POST', base, f.request(), undefined, 'evil.example')).status, 403);
    assert.equal((await request('GET', '/api/projects/foreign/chapter-analyses')).status, 404);
    assert.equal((await request('GET', `${base}/${randomUUID()}`)).status, 404);
    assert.deepEqual((await request('GET', base)).body, []);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.setHandler(async () => { await held; return new Response(JSON.stringify({ choices: [{ message: { content: '第4章观察' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }); });
    const original = f.request(); f.runtime.start(f.project, original);
    f.context.store.projects.push(createProject('other'));
    assert.equal((await request('DELETE', `/api/projects/${f.project.id}`, { confirmed: true, preservePlatformRecords: true })).body.code, 'ANALYSIS_BUSY');
    release(); await f.runtime.idle();
    assert.equal((await request('POST', base, original)).status, 200);
    assert.equal((await request('GET', `${base}/${f.project.chapterAnalyses![0].id}`)).body.status, 'done');
  } finally { await f.close(); }
});
