import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../projects/store.js';
import { PlatformRuntime } from './platform-runtime.js';
import type { DraftBrowserAdapter, VerifiedDraft, FanqieChapter } from './platforms-types.js';

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-overwrite-'));
  const drafts = new Map<string, VerifiedDraft>();
  const volumes = [{ id: 'v1', name: '第一卷' }];
  const writes: string[] = [];
  let extra: FanqieChapter[] = [];
  const browser: DraftBrowserAdapter = {
    readiness: 'ready', reason: 'offline',
    async startLogin() {}, loginOpen: () => true,
    async completeLogin() { return { account: { accountId: 'author', accountName: '作者' }, state: { cookies: [], origins: [] } }; },
    async closeLogin() {}, async verifyAccount() { return { accountId: 'author', accountName: '作者' }; },
    async listWorks() { return [{ id: 'work', providerId: 'tomato', title: '作品', description: '', genre: '', revision: '1', chapterCount: 0, updatedAt: '' }]; },
    async listVolumes() { return structuredClone(volumes); },
    async listChapters(_id, _state, _work, volumeId) { return [...drafts.values()].map<FanqieChapter>(d => ({ id: d.id, title: d.title, volumeId: d.volumeId, status: d.publishStatus!, kind: 'draft' as const })).concat(extra).filter(d => !volumeId || d.volumeId === volumeId); },
    async createDraft(_id, _state, accountId, workId, snapshot, identified, volumeId) {
      const id = `created-${writes.length}`;
      writes.push(id);
      drafts.set(id, { id, accountId, workId, title: snapshot.title, content: snapshot.content, paragraphs: [...snapshot.paragraphs], volumeId, publishStatus: 0 });
      identified(id); return { draftId: id };
    },
    async overwriteDraft(_id, _state, accountId, workId, draftId, snapshot, volumeId) {
      writes.push(draftId);
      const actual = { id: draftId, accountId, workId, title: snapshot.title.replace(/^第1章/, '第 1 章'), content: snapshot.content, paragraphs: [...snapshot.paragraphs], volumeId, publishStatus: 0 };
      drafts.set(draftId, actual); return actual;
    },
    async readDraft(_id, _state, _work, id) { const value = drafts.get(id); if (!value) throw new Error('missing pinned draft'); return structuredClone(value); },
    async findDrafts() { return [...drafts.values()]; }, async deleteDraft() {}, async closeConnection() {}, async close() {},
  };
  const store = new Store(dir);
  const runtime = new PlatformRuntime(store, { browser });
  t.after(async () => { await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const project = store.projects[0];
  project.chapters = [{ id: 'c1', number: 1, revision: 1, title: '第1章 标题', content: '完整正文。'.repeat(500), mode: 'demo', updatedAt: '' }];
  const login = await runtime.startLogin(project.id);
  const connection = await runtime.completeLogin(project.id, login.id);
  runtime.platforms.putLink({ id: 'link', projectId: project.id, connectionId: connection.id, providerId: 'tomato', accountId: connection.accountId, remoteWorkId: 'work', title: '作品', revision: '1', lastSyncedAt: '' });
  const prepare = (volumeId?: string) => runtime.preparePublication(project.id, 'link', project.chapters.map(c => c.id), 'save_draft', undefined, volumeId);
  const seed = (id = 'existing', title = '第 1 章 标题', volumeId = 'v1') => { drafts.set(id, { id, accountId: 'author', workId: 'work', title, content: 'old', paragraphs: ['old'], volumeId, publishStatus: 0 }); };
  const start = async (batch: Awaited<ReturnType<typeof prepare>>) => { runtime.publications.approve(batch.id, batch.preview.hash); runtime.publications.start(batch.id, { approvalHash: batch.preview.hash, requestId: randomUUID() }); await runtime.waitForIdle(); return runtime.publications.get(batch.id); };
  return { runtime, project, connection, drafts, volumes, writes, seed, prepare, start, setExtra: (value: FanqieChapter[]) => { extra = value; } };
}

test('sole volume is automatically pinned; preview never creates or overwrites', async t => {
  const f = await fixture(t);
  const batch = await f.prepare();
  assert.equal(batch.preview.remotePlan?.[0].mode, 'create');
  assert.equal(batch.preview.remotePlan?.[0].volumeId, 'v1');
  assert.deepEqual(f.writes, []);
  assert.equal((await f.start(batch)).state, 'completed');
  assert.equal(f.drafts.size, 1);
});

test('same chapter overwrite pins baseline and exact ID, accepts canonical title, and supports next revision', async t => {
  const f = await fixture(t); f.seed();
  const first = await f.prepare();
  assert.equal(first.preview.remotePlan?.[0].mode, 'overwrite');
  assert.deepEqual(f.writes, []);
  const completed = await f.start(first);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.items[0].remoteFingerprint?.length, 64);
  assert.deepEqual(f.writes, ['existing']);
  f.project.chapters[0].content += '\n新修订'; f.project.chapters[0].revision++;
  const next = await f.prepare();
  assert.equal(next.preview.remotePlan?.[0].predecessor?.operationId, completed.items[0].id);
  assert.equal((await f.start(next)).state, 'completed');
  assert.equal(f.drafts.size, 1);
});

test('external remote changes stop before durable mutation or overwrite', async t => {
  const f = await fixture(t); f.seed();
  const batch = await f.prepare();
  f.drafts.get('existing')!.content = 'external change';
  const result = await f.start(batch);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].mutationStarted, false);
  assert.deepEqual(f.writes, []);
});

test('multiple volumes require selection and ambiguous same-chapter drafts block', async t => {
  const f = await fixture(t);
  f.volumes.push({ id: 'v2', name: '第二卷' });
  await assert.rejects(f.prepare(), { code: 'PUBLICATION_VOLUME_REQUIRED' });
  f.seed('one'); f.seed('two');
  await assert.rejects(f.prepare('v1'), { code: 'PUBLICATION_REMOTE_CONFLICT' });
  assert.deepEqual(f.writes, []);
});

test('published same chapter explicitly blocks instead of creating another draft', async t => {
  const f = await fixture(t);
  f.setExtra([{ id: 'published', title: '第1章 标题', volumeId: 'v1', kind: 'chapter', status: 4 }]);
  await assert.rejects(f.prepare(), { code: 'PUBLICATION_REMOTE_NOT_DRAFT' });
  assert.deepEqual(f.writes, []);
});

test('renamed same chapter overwrites instead of creating a duplicate', async t => {
  const f = await fixture(t); f.seed('existing', '第1章 旧标题');
  const batch = await f.prepare();
  assert.equal(batch.preview.remotePlan?.[0].mode, 'overwrite');
  assert.equal((await f.start(batch)).state, 'completed');
  assert.deepEqual(f.writes, ['existing']);
});

test('completed first overwrite does not invalidate its old baseline before next chapter', async t => {
  const f = await fixture(t); f.seed();
  f.project.chapters.push({ ...f.project.chapters[0], id: 'c2', number: 2, title: '第2章 次章' });
  const batch = await f.prepare();
  assert.equal((await f.start(batch)).state, 'completed');
  assert.equal(f.writes.length, 2);
});

test('unknown legacy failure without remote ID remains unknown even with empty catalog', async t => {
  for (const variant of ['empty-strict', 'nonempty-strict', 'empty-general'] as const) {
    await t.test(variant, async t => {
      const f = await fixture(t);
      const chapter = f.project.chapters[0];
      const strict = variant !== 'empty-general';
      f.runtime.platforms.putDraftOperation({
        id: 'legacy', projectId: f.project.id, connectionId: f.connection.id, providerId: 'tomato', accountId: 'author', remoteWorkId: 'work',
        chapterId: chapter.id, chapterNumber: 1, revision: 1, contentHash: 'a'.repeat(64), title: chapter.title,
        state: 'unknown', mutationStarted: true, createdAt: '', updatedAt: '', businessKey: 'old', preparationId: 'old', requestKeys: [],
        errorCode: 'PLATFORM_DOM_VERIFICATION_REQUIRED', error: strict ? '标准章节标题必须为与章节序号一致的“第N章 标题”；不支持的格式不会写入编辑器。' : 'other unknown failure',
        snapshot: { chapterId: chapter.id, number: 1, revision: 1, title: chapter.title, content: chapter.content, paragraphs: [chapter.content], contentHash: 'a'.repeat(64) },
      });
      if (variant === 'nonempty-strict') f.seed('blank', '空白草稿');
      await assert.rejects(f.prepare(), { code: 'PLATFORM_OPERATION_UNKNOWN' });
      assert.equal(f.runtime.platforms.draftOperation(f.project.id, 'legacy')?.state, 'unknown');
      assert.deepEqual(f.writes, []);
    });
  }
});

test('known exact ID is never rediscovered by title after deletion', async t => {
  const f = await fixture(t); f.seed();
  const first = await f.prepare(); assert.equal((await f.start(first)).state, 'completed');
  f.drafts.delete('existing'); f.seed('different');
  f.project.chapters[0].revision++;
  await assert.rejects(f.prepare(), { code: 'PUBLICATION_REMOTE_CHANGED' });
  assert.deepEqual(f.writes, ['existing']);
});
