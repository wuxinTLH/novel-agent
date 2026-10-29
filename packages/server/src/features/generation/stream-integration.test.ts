import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Runner } from './engine.js';
import { generationService } from './routes/generation.js';
import { streamProgress } from './stream-progress.js';
import { Store } from '../projects/store.js';
import { SYSTEM_START_NODE_ID, SYSTEM_END_NODE_ID } from '../../../../../shared/types.js';

test('real SSE deltas appear through scoped HTTP progress before completion and disappear afterwards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-stream-http-'));
  let release!: () => void;
  const finish = new Promise<void>((resolve) => { release = resolve; });
  let sawDelta!: () => void;
  const deltaSent = new Promise<void>((resolve) => { sawDelta = resolve; });
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const text of ['真实流片段一', '真实流片段二']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    sawDelta();
    await finish;
    res.end(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const store = new Store(dir), project = store.projects[0];
  project.steps = project.steps.filter((step) => [SYSTEM_START_NODE_ID, 'draft', SYSTEM_END_NODE_ID].includes(step.id));
  project.workflow!.edges = [{ id: 'sd', source: SYSTEM_START_NODE_ID, target: 'draft' }, { id: 'de', source: 'draft', target: SYSTEM_END_NODE_ID }];
  delete project.workflow!.auditNodeId;
  const runner = new Runner(store);
  const app = express(); app.use(express.json());
  app.param('projectId', (_req, res, next, id) => { if (id !== project.id) return res.status(404).end(); res.locals.project = project; next(); });
  generationService.register(app, { store, runner, modelProvider: { models: new Map(), settings: { mode: 'demo' } } } as never);
  const api = app.listen(0, '127.0.0.1'); await once(api, 'listening');
  const base = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/projects`;
  const handle = runner.start(project, { mode: 'live', apiKey: 'stub', hasKey: true, model: 'stub', baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}` });
  const foreign = streamProgress.begin({ scopeId: `${dir}-other-tenant`, projectId: project.id, runId: handle.run.id, stepId: 'foreign' }); foreign.append('FOREIGN_TENANT');
  const old = streamProgress.begin({ scopeId: dir, projectId: project.id, runId: 'old-run', stepId: 'old' }); old.append('OLD_RUN');
  try {
    await deltaSent;
    let progress: { runId: string; nodes: { text: string }[] } = { runId: '', nodes: [] };
    // Bounded HTTP reads yield to the provider reader; no timer or real model dependency.
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(`${base}/${project.id}/generation-progress`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      progress = await response.json() as typeof progress;
      if (progress.nodes.some((node) => node.text.includes('真实流片段二'))) break;
    }
    assert.equal(project.run!.status, 'running');
    assert.equal(progress.runId, handle.run.id);
    assert.match(JSON.stringify(progress), /真实流片段一真实流片段二/);
    assert.doesNotMatch(JSON.stringify(progress), /FOREIGN_TENANT|OLD_RUN/);
    assert.equal((await fetch(`${base}/missing-project/generation-progress`)).status, 404);
    release(); await handle.promise;
    const completed = await (await fetch(`${base}/${project.id}/generation-progress`)).json() as { nodes: unknown[] };
    assert.deepEqual(completed.nodes, []);
    assert.equal(project.chapters[0].content, '真实流片段一真实流片段二');
  } finally {
    release(); await handle.promise;
    foreign.clear(); old.clear();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
