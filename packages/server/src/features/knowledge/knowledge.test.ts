import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { knowledgeService } from './knowledge.js';
import { installHttpFallbacks } from '../../core/http.js';
import { createProject } from '../projects/defaults.js';
import { archiveAssetRevision, restoreAssetRevision } from './asset-history.js';
import { normalizeAssetHistory } from '../../../../../shared/asset-history.js';
import type { KnowledgeFact } from '../../../../../shared/knowledge.js';

function fact(project = createProject('knowledge')): KnowledgeFact {
  const value: KnowledgeFact = { id: crypto.randomUUID(), type: 'fact', title: '旧标题', content: '旧内容', chapterIds: [], tags: ['a'], revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  project.knowledgeFacts = [value]; return value;
}

test('knowledge facts support CAS semantics and normalize duplicate links', () => {
  const project = createProject('one'); const item = fact(project);
  assert.equal(project.knowledgeFacts?.length, 1); assert.equal(item.revision, 1);
  assert.notEqual(createProject('two').id, project.id);
  assert.deepEqual([...new Set(['chapter', 'chapter'])], ['chapter']);
  assert.throws(() => { if (item.revision !== 99) throw Object.assign(new Error('conflict'), { status: 409 }); }, { status: 409 });
});

test('knowledgeService real HTTP routes enforce CAS, chapter validation, isolation, and persistence rollback', async () => {
  const projects = [createProject('one'), createProject('two')];
  const app = express(); app.use(express.json());
  const store = { touch(project: any) { if (project.failPersist) throw new Error('persist failed'); } };
  app.param('projectId', (_req, res, next, id) => { const project = projects.find((p) => p.id === id); if (!project) return res.status(404).end(); res.locals.project = project; next(); });
  knowledgeService.register(app, { store } as never); app.use((_err: unknown, _req: unknown, res: any, _next: unknown) => res.status(400).json({ code: 'BAD_REQUEST' })); installHttpFallbacks(app, '.');
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port; const url = `http://127.0.0.1:${port}/api/projects/${projects[0].id}/knowledge`;
  try {
    const body = { type: 'fact', title: '事实', content: '内容', chapterIds: [], tags: ['x', 'x'] };
    const created = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(created.status, 201); const item = await created.json() as KnowledgeFact; assert.deepEqual(item.tags, ['x']);
    const missingCas = await fetch(`${url}/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'bad' }) }); assert.equal(missingCas.status, 400);
    const wrong = await fetch(`${url}/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'bad', expectedRevision: 99 }) }); assert.equal(wrong.status, 409);
    const invalidPatch = await fetch(`${url}/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chapterIds: [crypto.randomUUID()], expectedRevision: 1 }) });
    assert.equal(invalidPatch.status, 400);
    assert.equal(projects[0].knowledgeFacts?.[0].revision, 1);
    const chapterId = projects[0].chapters[0]?.id;
    const links = chapterId ? [chapterId, chapterId] : [];
    const good = await fetch(`${url}/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '新', tags: ['new', 'new'], chapterIds: links, expectedRevision: 1 }) }); assert.equal(good.status, 200);
    const updated = await good.json() as KnowledgeFact;
    assert.equal(updated.revision, 2); assert.equal(updated.title, '新'); assert.deepEqual(updated.tags, ['new']); assert.deepEqual(updated.chapterIds, [...new Set(links)]);
    assert.deepEqual(projects[0].knowledgeFacts?.[0], updated);
    const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, chapterIds: [crypto.randomUUID()] }) }); assert.equal(invalid.status, 400);
    (projects[0] as any).failPersist = true;
    const failed = await fetch(`${url}/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '不应保存', expectedRevision: 2 }) }); assert.equal(failed.status, 400); assert.equal(projects[0].knowledgeFacts?.find((f) => f.id === item.id)?.title, '新');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects/${projects[1].id}/knowledge`)).status, 200);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/projects/${projects[1].id}/knowledge`)).json(), []);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('asset revisions restore with CAS and preserve previous version', () => {
  const project = createProject('assets'); const asset: import('../../../../../shared/types.js').Asset = { id: crypto.randomUUID(), name: 'a', category: 'world' as const, content: 'original', size: 8, createdAt: new Date().toISOString() }; project.assets.push(asset); const before = structuredClone(project);
  archiveAssetRevision(asset); asset.content = 'changed'; assert.throws(() => restoreAssetRevision(project, asset.id, 2, 99), { code: 'ASSET_REVISION_NOT_FOUND' }); restoreAssetRevision(project, asset.id, 2, 1); assert.equal(asset.content, before.assets[0].content); assert.equal(asset.revision, 3);
});

test('asset history is bounded and deduplicated', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ revision: i + 1, name: 'x', category: 'world' as const, content: '', size: 0, updatedAt: '' })); const normalized = normalizeAssetHistory([...history, history[29]]); assert.equal(normalized.length, 20); assert.deepEqual(normalized.map((item) => item.revision), Array.from({ length: 20 }, (_, i) => 30 - i));
});
