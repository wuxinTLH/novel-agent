import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { createApplication } from './application.js';
import { createServiceContext, type FeatureService } from './context.js';
import { createProjectOperations } from './project-operations.js';
import { coreServices, registerServices } from './registry.js';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-services-'));
  const context = createServiceContext(dir);
  context.modelProvider.settings.mode = 'demo';
  let optionalCalls = 0;
  const optional: FeatureService = {
    id: 'test-extension',
    register(app) {
      app.post('/api/test-extension', (_req, res) => {
        optionalCalls++;
        res.json({ ok: true });
      });
    },
  };
  const app = createApplication(context, { port: 3001, appRoot: dir, services: [optional] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  async function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: url,
            method,
            headers: {
              host: '127.0.0.1:3001',
              'content-type': 'application/json',
              'X-Platform-CSRF': context.platformRuntime.csrfToken,
              ...headers,
            },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              text += chunk;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }),
            );
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      },
    );
  }
  return {
    context,
    request,
    optionalCalls: () => optionalCalls,
    async close() {
      for (const controller of context.runner.controllers.values()) controller.abort();
      await context.platformRuntime.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('service registry is explicit, preserves guard order, and rejects duplicate IDs before registration', () => {
  assert.deepEqual(
    coreServices.map((service) => service.id),
    ['platform', 'model-settings', 'projects', 'workflow', 'assets', 'generation', 'chapters'],
  );
  let calls = 0;
  const service: FeatureService = {
    id: 'duplicate',
    register() {
      calls++;
    },
  };
  assert.throws(
    () => registerServices(express(), {} as never, [service, service]),
    /Duplicate backend service/,
  );
  assert.equal(calls, 0);
});

test('optional services share origin and CSRF guards and precede API fallbacks', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request('POST', '/api/test-extension', {}, { host: 'evil.example:3001' })).body.code,
      'LOCAL_ORIGIN_REJECTED',
    );
    assert.equal(
      (await f.request('POST', '/api/test-extension', {}, { 'X-Platform-CSRF': '' })).body.code,
      'PLATFORM_CSRF_REQUIRED',
    );
    assert.equal(f.optionalCalls(), 0);
    const accepted = await f.request('POST', '/api/test-extension', {});
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers['cache-control'], 'no-store');
    assert.equal(f.optionalCalls(), 1);
    assert.equal((await f.request('GET', '/api/not-found')).body.code, 'NOT_FOUND');
  } finally {
    await f.close();
  }
});

test('extracted projects/assets/graph/chapters use the same project and persist local mutations', async () => {
  const f = await fixture();
  try {
    const created = await f.request('POST', '/api/projects', { title: 'Service test' });
    assert.equal(created.status, 201);
    const base = `/api/projects/${created.body.id}`;
    assert.equal((await f.request('GET', base)).body.title, 'Service test');
    assert.equal(
      (
        await f.request('POST', `${base}/assets`, {
          name: 'Setting',
          category: 'world',
          content: 'World detail',
        })
      ).status,
      201,
    );
    assert.equal(f.context.store.get(created.body.id)!.assets.length, 1);
    const conflict = await f.request('PATCH', base, { expectedGraphRevision: 999, title: 'Rejected' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'GRAPH_CONFLICT');
    assert.equal(f.context.store.get(created.body.id)!.title, 'Service test');
    assert.equal((await f.request('PATCH', base, { title: 'Updated' })).status, 200);
    assert.equal(
      (
        await f.request('PATCH', `${base}/chapters/missing`, {
          expectedRevision: 1,
          title: 'Chapter',
          content: 'Text',
        })
      ).body.code,
      'CHAPTER_NOT_FOUND',
    );
    const persisted = JSON.parse(fs.readFileSync(path.join(f.context.dir, 'projects.json'), 'utf8'));
    assert.equal(persisted.find((p: { id: string }) => p.id === created.body.id).title, 'Updated');
  } finally {
    await f.close();
  }
});

test('project guard keeps run/cancel exceptions and platform busy protection', async () => {
  const f = await fixture();
  try {
    const project = f.context.store.projects[0];
    project.run = { id: 'running-test', status: 'running' } as typeof project.run;
    const base = `/api/projects/${project.id}`;
    assert.equal((await f.request('POST', `${base}/assets`, {})).body.code, 'RUN_CONFLICT');
    assert.equal((await f.request('POST', `${base}/run`, { invalid: true })).body.code, 'INVALID_INPUT');
    assert.equal((await f.request('POST', `${base}/cancel`)).status, 200);
    delete project.run;
    f.context.platformRuntime.assertProjectIdle = () => {
      throw Object.assign(new Error('busy'), { status: 409, code: 'PLATFORM_BUSY' });
    };
    assert.equal((await f.request('PATCH', base, { title: 'blocked' })).body.code, 'PLATFORM_BUSY');
    assert.equal((await f.request('POST', `${base}/cancel`)).status, 200);
  } finally {
    await f.close();
  }
});

test('project mutation helper rolls back the in-memory graph when persistence fails', async () => {
  const f = await fixture();
  try {
    const project = f.context.store.projects[0];
    const before = structuredClone(project);
    f.context.store.touch = () => {
      throw new Error('disk unavailable');
    };
    assert.throws(
      () =>
        createProjectOperations(f.context.store).mutateProject(project, (draft) => {
          draft.title = 'not committed';
          draft.assets = [];
        }),
      /disk unavailable/,
    );
    assert.deepEqual(project, before);
  } finally {
    await f.close();
  }
});
