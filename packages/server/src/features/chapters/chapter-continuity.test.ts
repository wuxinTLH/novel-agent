import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { Project, Step } from '../../../../../shared/types.js';
import type { ServiceContext } from '../../core/context.js';
import { installHttpFallbacks, installHttpPolicy } from '../../core/http.js';
import { Store } from '../projects/store.js';
import { createProject } from '../projects/defaults.js';
import { projectsService } from '../projects/projects.js';
import { prepareRun, resolveRequirements } from '../generation/generation.js';
import { chaptersService } from './chapters.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chapter-continuity-'));
  const store = new Store(dir);
  const project = store.projects[0];
  project.chapters = [{
    id: 'chapter-six', number: 6, revision: 2, title: 'Chapter six', content: 'Recovering in the car',
    mode: 'demo', updatedAt: '2026-01-01',
    revisions: [{ revision: 1, title: 'Chapter six', content: 'Earlier recovery', mode: 'demo', updatedAt: '2025-01-01' }],
  }];
  function stamp(step: Step, number: number, workflowId = project.activeWorkflowId!) {
    step.status = 'done';
    step.output = `Inspectable output ${number}`;
    step.generationContext = {
      runId: 'prior-run', workflowId, graphRevision: 0, number, mode: 'create',
      requirements: resolveRequirements(project, number),
    };
    return step;
  }
  stamp(project.steps.find((step) => step.id === 'plan')!, 7);
  const inactive = createProject('Inactive workflow').workflows![0];
  inactive.steps = [5, 6, 7, 8].map((number) => stamp({ ...structuredClone(project.steps.find((step) => step.id === 'plan')!), id: `inactive-${number}` }, number, inactive.id));
  project.workflows!.push(inactive);
  store.touch(project);
  const context = {
    dir, store,
    platformRuntime: { csrfToken: 'test-csrf', assertProjectIdle() {} },
  } as unknown as ServiceContext;
  const app = express();
  installHttpPolicy(app, context, 3001);
  projectsService.register(app, context);
  chaptersService.register(app, context);
  installHttpFallbacks(app, dir, { serveWeb: false });
  async function request(body: unknown, restore = false) {
    const req = new http.IncomingMessage(new Socket());
    req.method = restore ? 'POST' : 'PATCH';
    req.url = `/api/projects/${project.id}/chapters/chapter-six${restore ? '/restore' : ''}`;
    const text = JSON.stringify(body);
    req.headers = {
      host: '127.0.0.1:3001', 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)), 'x-platform-csrf': 'test-csrf',
    };
    const res = new http.ServerResponse(req);
    const result = new Promise<{ status: number; body: Project & { code?: string } }>((resolve, reject) => {
      res.end = ((chunk: string) => {
        try { resolve({ status: res.statusCode, body: JSON.parse(String(chunk)) }); }
        catch (error) { reject(error); }
        return res;
      }) as typeof res.end;
    });
    app(req, res);
    req.push(text);
    req.push(null);
    return result;
  }
  const persisted = () => fs.readFileSync(path.join(dir, 'projects.json'), 'utf8');
  return { project, store, request, persisted, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function assertInvalidated(project: Project) {
  const plan = project.steps.find((step) => step.id === 'plan')!;
  assert.equal(plan.status, 'idle');
  assert.equal(plan.generationContext, undefined);
  assert.equal(plan.output, 'Inspectable output 7');
  const inactive = project.workflows!.at(-1)!;
  for (const [index, step] of inactive.steps.entries()) {
    const number = index + 5;
    assert.equal(step.status, number < 6 ? 'done' : 'idle');
    assert.equal(step.generationContext?.number, number < 6 ? 5 : undefined);
    assert.equal(step.output, `Inspectable output ${number}`);
  }
  assert.throws(() => prepareRun(project, { stepId: 'draft', target: { kind: 'single', number: 7 } }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'DEPENDENCY_CONTEXT_MISMATCH');
}

for (const restore of [false, true]) {
  test(`${restore ? 'restore' : 'PATCH'} chapter six invalidates later chapter context in every workflow, retaining inspection output and lower targets`, async () => {
    const f = fixture();
    try {
      assert.doesNotThrow(() => prepareRun(f.project, { stepId: 'draft', target: { kind: 'single', number: 7 } }));
      const result = await f.request(restore
        ? { expectedRevision: 2, revision: 1 }
        : { expectedRevision: 2, title: 'Chapter six', content: 'Revised recovery in the car' }, restore);
      assert.equal(result.status, 200);
      assertInvalidated(f.project);
      assert.equal(f.project.chapters[0].revision, 3);
      assert.equal(f.project.chapters[0].revisions![0].content, 'Recovering in the car');
      assert.deepEqual(JSON.parse(f.persisted())[0], f.project);
    } finally { f.close(); }
  });
}

test('stale PATCH and persistence failure preserve canonical prose and all workflow contexts atomically', async () => {
  const f = fixture();
  try {
    const before = structuredClone(f.project);
    const disk = f.persisted();
    const body = { expectedRevision: 2, title: 'Chapter six', content: 'Replacement' };
    const stale = await f.request({ ...body, expectedRevision: 1 });
    assert.equal(stale.status, 409);
    assert.deepEqual(f.project, before);
    assert.equal(f.persisted(), disk);
    f.store.touch = () => { throw new Error('synthetic persistence failure'); };
    assert.equal((await f.request(body)).status, 500);
    assert.deepEqual(f.project, before);
    assert.equal(f.persisted(), disk);
  } finally { f.close(); }
});
