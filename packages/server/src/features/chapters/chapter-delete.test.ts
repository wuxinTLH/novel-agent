import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import type { Project } from '../../../../../shared/types.js';
import type { ServiceContext } from '../../core/context.js';
import { installHttpFallbacks, installHttpPolicy } from '../../core/http.js';
import { Store } from '../projects/store.js';
import { createProject } from '../projects/defaults.js';
import { projectsService } from '../projects/projects.js';
import { chaptersService } from './chapters.js';
import { addManualChapter } from './manual-chapters.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chapter-delete-'));
  const store = new Store(dir);
  const project = store.projects[0];
  project.chapters = [];
  for (const number of [1, 4, 9])
    addManualChapter(project, {
      number,
      title: `Chapter ${number}`,
      content: 'Text',
      requestId: randomUUID(),
    });
  project.steps[0].status = 'done';
  project.steps[0].output = 'Prior output';
  store.touch(project);
  let guardCalls = 0;
  let busy = false;
  const context = {
    dir,
    store,
    platformRuntime: {
      csrfToken: 'test-csrf',
      assertProjectIdle(id: string) {
        assert.equal(id, project.id);
        guardCalls++;
        if (busy) throw Object.assign(new Error('busy'), { status: 409, code: 'PLATFORM_BUSY' });
      },
    },
  } as unknown as ServiceContext;
  const app = express();
  installHttpPolicy(app, context, 3001);
  projectsService.register(app, context);
  chaptersService.register(app, context);
  installHttpFallbacks(app, dir, { serveWeb: false });
  // Exercise the actual Express stack without opening a port or making a network request.
  async function request(body: unknown, options: { projectId?: string; csrf?: string; host?: string } = {}) {
    const req = new http.IncomingMessage(new Socket());
    req.method = 'POST';
    req.url = `/api/projects/${options.projectId ?? project.id}/chapters/delete`;
    const text = JSON.stringify(body);
    req.headers = {
      host: options.host ?? '127.0.0.1:3001',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
      'x-platform-csrf': options.csrf ?? 'test-csrf',
    };
    const res = new http.ServerResponse(req);
    const result = new Promise<{ status: number; body: Project & { code?: string } }>((resolve, reject) => {
      res.end = ((chunk: string) => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(String(chunk)) });
        } catch (error) {
          reject(error);
        }
        return res;
      }) as typeof res.end;
    });
    app(req, res);
    req.push(text);
    req.push(null);
    return result;
  }
  const selection = () =>
    project.chapters.slice(0, 2).map(({ id, revision }) => ({ id, expectedRevision: revision }));
  const persisted = () => fs.readFileSync(path.join(dir, 'projects.json'), 'utf8');
  return {
    project,
    store,
    request,
    selection,
    persisted,
    guardCalls: () => guardCalls,
    setBusy: () => {
      busy = true;
    },
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('batch delete persists once, retains numbering/watermark and unrelated project/publication data', async () => {
  const f = fixture();
  try {
    const foreign = createProject('foreign');
    f.store.projects.push(foreign);
    const beforeForeign = structuredClone(foreign);
    const survivor = structuredClone(f.project.chapters[2]);
    const candidate = { number: 12 } as NonNullable<Project['candidates']>[number];
    f.project.candidates = [candidate];
    f.project.workflow!.publication = { enabled: true, linkId: 'existing-link', action: 'save_draft' };
    const publication = structuredClone(f.project.workflow!.publication);
    let saves = 0;
    const touch = f.store.touch.bind(f.store);
    f.store.touch = (project) => {
      saves++;
      touch(project);
    };
    const result = await f.request({ chapters: f.selection(), workflowId: f.project.activeWorkflowId });
    assert.equal(result.status, 200);
    assert.equal(saves, 1);
    assert.equal(f.guardCalls(), 1);
    assert.deepEqual(result.body.chapters, [survivor]);
    assert.equal(result.body.chapterNumberHighWatermark, 12);
    assert.deepEqual(f.project.candidates, [candidate]);
    assert.deepEqual(f.project.workflow!.publication, publication);
    assert.deepEqual(foreign, beforeForeign);
    assert.ok(
      f.project.steps.every(
        (step) => step.status === 'idle' && step.output === '' && !step.generationContext,
      ),
    );
    assert.deepEqual(JSON.parse(f.persisted())[0], f.project);
    // Deleting the last canonical chapter must not release reserved numbers.
    assert.equal(
      (await f.request({ chapters: [{ id: survivor.id, expectedRevision: survivor.revision }] })).status,
      200,
    );
    assert.equal(f.project.chapterNumberHighWatermark, 12);
    assert.deepEqual(f.project.chapters, []);
  } finally {
    f.close();
  }
});

test('missing, stale, foreign and repeated deletion conflict atomically before persistence', async () => {
  const f = fixture();
  try {
    const foreign = createProject('foreign');
    const foreignChapter = addManualChapter(foreign, {
      number: 1,
      title: 'Other',
      content: 'Text',
      requestId: randomUUID(),
    }).chapter;
    f.store.projects.push(foreign);
    f.store.save();
    const before = structuredClone(f.store.projects);
    const disk = f.persisted();
    f.store.touch = () => {
      assert.fail('invalid selection must not persist');
    };
    for (const invalid of [
      { id: f.project.chapters[1].id, expectedRevision: 99 },
      { id: 'missing', expectedRevision: 1 },
      { id: foreignChapter.id, expectedRevision: 1 },
    ]) {
      const result = await f.request({ chapters: [f.selection()[0], invalid] });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'REVISION_CONFLICT');
      assert.deepEqual(f.store.projects, before);
      assert.equal(f.persisted(), disk);
    }
  } finally {
    f.close();
  }
});

test('batch schema rejects empty, oversized, duplicate, malformed and unknown fields without mutation', async () => {
  const f = fixture();
  try {
    const valid = f.selection()[0];
    const before = structuredClone(f.project);
    const disk = f.persisted();
    for (const body of [
      {},
      { chapters: [] },
      { chapters: [valid, valid] },
      { chapters: Array.from({ length: 501 }, (_, id) => ({ id: String(id), expectedRevision: 1 })) },
      ...[0, -1, 1.5, '1', null, undefined].map((expectedRevision) => ({
        chapters: [{ ...valid, expectedRevision }],
      })),
      { chapters: [{ ...valid, id: '' }] },
      { chapters: [{ ...valid, extra: true }] },
      { chapters: [valid], workflowId: '' },
      { chapters: [valid], extra: true },
    ]) {
      const result = await f.request(body);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'INVALID_INPUT');
      assert.deepEqual(f.project, before);
      assert.equal(f.persisted(), disk);
    }
  } finally {
    f.close();
  }
});

test('batch delete preserves workflow, run, platform, project lookup and HTTP security guards', async () => {
  const f = fixture();
  try {
    const body = { chapters: f.selection() };
    const before = structuredClone(f.project);
    const disk = f.persisted();
    assert.equal(
      (await f.request({ ...body, workflowId: 'foreign-workflow' })).body.code,
      'WORKFLOW_CONFLICT',
    );
    assert.equal((await f.request(body, { projectId: 'foreign-project' })).status, 404);
    assert.equal((await f.request(body, { csrf: '' })).body.code, 'PLATFORM_CSRF_REQUIRED');
    assert.equal((await f.request(body, { host: 'evil.example:3001' })).body.code, 'LOCAL_ORIGIN_REJECTED');
    f.project.run = { id: 'active-run', status: 'running' } as Project['run'];
    assert.equal((await f.request(body)).body.code, 'RUN_CONFLICT');
    delete f.project.run;
    f.setBusy();
    assert.equal((await f.request(body)).body.code, 'PLATFORM_BUSY');
    assert.deepEqual(f.project, before);
    assert.equal(f.persisted(), disk);
  } finally {
    f.close();
  }
});

test('failed persistence rolls back all deleted chapters, watermark and invalidated workflow output', async () => {
  const f = fixture();
  try {
    delete f.project.chapterNumberHighWatermark;
    const before = structuredClone(f.project);
    const disk = f.persisted();
    f.store.touch = (draft) => {
      draft.updatedAt = 'not committed';
      throw new Error('simulated disk failure');
    };
    const result = await f.request({ chapters: f.selection() });
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'INTERNAL_ERROR');
    assert.deepEqual(f.project, before);
    assert.equal(f.persisted(), disk);
  } finally {
    f.close();
  }
});

test('batch accepts 500 unique chapters and keeps a higher historic watermark', async () => {
  const f = fixture();
  try {
    const template = f.project.chapters[0];
    f.project.chapters = Array.from({ length: 500 }, (_, index) => ({
      ...template,
      id: `chapter-${index}`,
      number: index + 1,
    }));
    f.project.chapterNumberHighWatermark = 700;
    const chapters = f.project.chapters.map(({ id, revision }) => ({ id, expectedRevision: revision }));
    assert.equal((await f.request({ chapters })).status, 200);
    assert.deepEqual(f.project.chapters, []);
    assert.equal(f.project.chapterNumberHighWatermark, 700);
    assert.equal((await f.request({ chapters })).status, 409);
  } finally {
    f.close();
  }
});
