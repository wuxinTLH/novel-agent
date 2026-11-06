import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, Response, RequestHandler } from 'express';
import { ZodError } from 'zod';
import sharp from 'sharp';
import { projectsService } from './projects.js';
import { assetsService } from '../assets/assets.js';
import { Store, migrateProjects } from './store.js';
import { createProject } from './defaults.js';
import type { ServiceContext } from '../../core/context.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-stages-'));
  const store = new Store(dir);
  store.projects = [createProject('stages'), createProject('other')];
  store.save();
  const routes = new Map<string, RequestHandler[]>();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete', 'use', 'param'].map((method) => [method,
    (url: string, ...handlers: RequestHandler[]) => { routes.set(`${method} ${url}`, handlers); },
  ])) as unknown as Express;
  const context = { dir, store, platformRuntime: { assertProjectIdle() {} } } as unknown as ServiceContext;
  projectsService.register(app, context);
  assetsService.register(app, context);
  async function call(method: string, route: string, body: unknown = {}, params: Record<string, string> = {}, files?: unknown[]) {
    const project = store.projects[0];
    let status = 200;
    let output: unknown;
    const req = { body, params, files, method: method.toUpperCase(), path: route.replace('/api/projects/:projectId', '') } as Request;
    const res = { locals: { project, uploadLease: { signal: new AbortController().signal, release() {} } },
      status(code: number) { status = code; return this; }, json(value: unknown) { output = value; return this; },
    } as unknown as Response;
    let admitted = false;
    routes.get('use /api/projects/:projectId')![0](req, res, () => { admitted = true; });
    if (admitted) {
      try { await routes.get(`${method} ${route}`)!.at(-1)!(req, res, () => {}); }
      catch (error) { if (error instanceof ZodError) status = 400; else throw error; }
    }
    return { status, output, project };
  }
  return { dir, store, call, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
const stages = '/api/projects/:projectId/world-stages';
const assets = '/api/projects/:projectId/assets';

test('stage CRUD trims names, enforces duplicates/limits, project isolation and running guards', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call('post', stages, { name: '  第一阶段  ' })).status, 201);
    const p = f.store.projects[0];
    const stageId = p.worldStages![0].id;
    assert.equal(p.worldStages![0].name, '第一阶段');
    assert.equal((await f.call('post', stages, { name: '第一阶段 ' })).status, 409);
    for (const name of ['', '  ', 'x'.repeat(81)]) assert.equal((await f.call('post', stages, { name })).status, 400);
    assert.equal((await f.call('patch', stages + '/:stageId', { name: ' 改名 ' }, { stageId })).status, 200);
    assert.equal(p.worldStages![0].name, '改名');
    assert.equal((await f.call('patch', stages + '/:stageId', { name: '不存在' }, { stageId: 'foreign' })).status, 404);
    p.worldStages!.push({ id: 'second', name: '第二阶段' });
    assert.equal((await f.call('patch', stages + '/:stageId', { name: ' 第二阶段 ' }, { stageId })).status, 409);
    p.worldStages = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: String(i) }));
    assert.equal((await f.call('post', stages, { name: '第51阶段' })).status, 400);
    p.run = { status: 'running' } as NonNullable<typeof p.run>;
    assert.equal((await f.call('post', stages, { name: 'blocked' })).status, 409);
    delete p.run;
    assert.equal((await f.call('delete', stages + '/:stageId', {}, { stageId: '0' })).status, 200);
    assert.equal((await f.call('delete', stages + '/:stageId', {}, { stageId: '0' })).status, 404);
    assert.equal(f.store.projects[1].worldStages, undefined);
  } finally { f.cleanup(); }
});

test('asset create/upload/move/ungroup keep CAS and reject invalid category or foreign project stages', async () => {
  const f = fixture();
  try {
    await f.call('post', stages, { name: '阶段' });
    const p = f.store.projects[0];
    const stageId = p.worldStages![0].id;
    f.store.projects[1].worldStages = [{ id: 'foreign', name: '其他作品' }];
    const input = { name: '设定', category: 'world', content: '正文', worldStageId: stageId };
    for (const changes of [{ category: 'characters' }, { worldStageId: 'foreign' }, { worldStageId: 'missing' }])
      assert.equal((await f.call('post', assets, { ...input, ...changes })).status, 400);
    assert.equal((await f.call('post', assets, input)).status, 201);
    const asset = p.assets.at(-1)!;
    const assetId = asset.id;
    assert.equal(asset.worldStageId, stageId);
    assert.equal((await f.call('delete', stages + '/:stageId', {}, { stageId })).status, 409);
    assert.equal((await f.call('patch', assets + '/:assetId', { expectedRevision: 99, worldStageId: null }, { assetId })).status, 409);
    assert.equal((await f.call('patch', assets + '/:assetId', { expectedRevision: 1, category: 'plot' }, { assetId })).status, 400);
    assert.equal((await f.call('patch', assets + '/:assetId', { expectedRevision: 1, worldStageId: 'foreign' }, { assetId })).status, 400);
    assert.equal((await f.call('patch', assets + '/:assetId', { expectedRevision: 1, worldStageId: null, category: 'plot' }, { assetId })).status, 200);
    assert.equal(p.assets.at(-1)!.worldStageId, undefined);
    assert.equal(p.assets.at(-1)!.revision, 2);
    assert.equal((await f.call('patch', assets + '/:assetId', { worldStageId: stageId }, { assetId })).status, 400);
    const upload = { originalname: 'test.txt', buffer: Buffer.from('uploaded text'), size: 13, mimetype: 'text/plain' };
    assert.equal((await f.call('post', assets + '/upload', { category: 'world', worldStageId: stageId }, {}, [upload])).status, 201);
    assert.equal(p.assets.at(-1)!.worldStageId, stageId);
    assert.equal((await f.call('post', assets + '/upload', { category: 'characters', worldStageId: stageId }, {}, [upload])).status, 400);
    await f.call('patch', assets + '/:assetId', { expectedRevision: 1, worldStageId: null }, { assetId: p.assets.at(-1)!.id });
    const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    assert.equal((await f.call('post', assets + '/upload', { category: 'world', worldStageId: stageId }, {}, [{ originalname: 'image.png', buffer }])).status, 201);
    const image = p.assets.at(-1)!;
    assert.equal(image.worldStageId, stageId);
    assert.ok(image.url?.endsWith('.png'));
    assert.ok(fs.existsSync(path.join(f.dir, image.url!)));
    assert.equal((await f.call('patch', assets + '/:assetId', { expectedRevision: 1, worldStageId: null }, { assetId: image.id })).status, 200);
    await f.call('post', stages, { name: '第二阶段' });
    const secondId = p.worldStages!.at(-1)!.id;
    assert.equal((await f.call('patch', assets + '/:assetId', { expectedRevision: 2, worldStageId: secondId }, { assetId: image.id })).status, 200);
    assert.equal(p.assets.at(-1)!.worldStageId, secondId);
    assert.equal(p.assets.at(-1)!.revision, 3);
    assert.equal((await f.call('delete', stages + '/:stageId', {}, { stageId })).status, 200);
  } finally { f.cleanup(); }
});

test('stored stages survive normalization and fresh Store; malformed assignments fail without changing source', async () => {
  const f = fixture();
  try {
    await f.call('post', stages, { name: '起始阶段' });
    const p = f.store.projects[0];
    const stageId = p.worldStages![0].id;
    await f.call('post', assets, { name: '设定', category: 'world', content: '正文', worldStageId: stageId });
    const restored = new Store(f.dir);
    assert.deepEqual(restored.projects[0].worldStages, p.worldStages);
    assert.equal(restored.projects[0].assets.at(-1)!.worldStageId, stageId);
    assert.equal(restored.projects[1].worldStages, undefined);
    const invalid = structuredClone(restored.projects);
    invalid[0].assets.at(-1)!.worldStageId = 'missing';
    const before = JSON.stringify(invalid);
    assert.throws(() => migrateProjects(invalid), /阶段无效/);
    assert.equal(JSON.stringify(invalid), before);
    invalid[0].assets.at(-1)!.worldStageId = stageId;
    invalid[0].worldStages!.push({ id: 'duplicate-name', name: ' 起始阶段 ' });
    assert.throws(() => migrateProjects(invalid));
    invalid[0].worldStages = Array.from({ length: 51 }, (_, i) => ({ id: String(i), name: String(i) }));
    assert.throws(() => migrateProjects(invalid));
  } finally { f.cleanup(); }
});

test('stage and asset reassignment roll back when synchronous persistence fails', async () => {
  const f = fixture();
  try {
    await f.call('post', stages, { name: '阶段' });
    const p = f.store.projects[0];
    const stageId = p.worldStages![0].id;
    await f.call('post', assets, { name: '设定', category: 'world', content: '正文', worldStageId: stageId });
    const before = structuredClone(p);
    f.store.save = () => { throw new Error('disk failure'); };
    await assert.rejects(f.call('patch', stages + '/:stageId', { name: '改名' }, { stageId }), /disk failure/);
    assert.deepEqual(p, before);
    await assert.rejects(f.call('patch', assets + '/:assetId', { expectedRevision: 1, worldStageId: null }, { assetId: p.assets.at(-1)!.id }), /disk failure/);
    assert.deepEqual(p, before);
  } finally { f.cleanup(); }
});
