import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationBatch } from '../../shared/publication';
import { ensureAutoApprovedBatchStarted, publicationApprovalReady, publicationOutcome } from './PublicationPanel';

const fixture = (state: PublicationBatch['state'] = 'preview'): PublicationBatch => {
  const chapters = [1, 2, 3].map((number) => ({ chapterId: `chapter-${number}`, number, revision: 1,
    title: `第${number}章 标题`, content: '完整正文', paragraphs: ['完整正文'], contentHash: 'a'.repeat(64) }));
  return { id: 'batch-1', state, preview: { id: 'preview-1', hash: 'b'.repeat(64), action: 'save_draft',
    target: { projectId: 'project-1', connectionId: 'connection-1', providerId: 'tomato', accountId: 'account-1',
      accountName: '作者', linkId: 'link-1', remoteWorkId: 'work-1', workTitle: '作品', workRevision: '1' },
    chapters, createdAt: '2026-01-01T00:00:00Z' },
    items: chapters.map(snapshot => ({ id: snapshot.chapterId, snapshot, state: 'queued', mutationStarted: false })),
    startRequestIds: [], pauseRequested: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
};

test('manual preparation is explicitly not an upload and starts no queue', async () => {
  const batch = fixture();
  const next = await ensureAutoApprovedBatchStarted(batch, false, async () => { throw new Error('must not start'); });
  assert.equal(next, batch);
  assert.match(publicationOutcome(next), /仅已准备 3 章本地预览，未启动上传、未提交审核/);
  assert.match(publicationOutcome(next), /远端回读核实草稿 0 \/ 3 章/);
});

test('auto-approved preview response starts promised three-chapter batch exactly once', async () => {
  const batch = fixture();
  let calls = 0;
  const next = await ensureAutoApprovedBatchStarted(batch, true, async (prepared) => {
    calls++;
    assert.equal(prepared.preview.hash, batch.preview.hash);
    assert.equal(prepared.items.length, 3);
    return { ...prepared, state: 'running' };
  });
  assert.equal(calls, 1);
  assert.equal(next.state, 'running');
  assert.match(publicationOutcome(next), /正在执行/);
  assert.match(publicationOutcome(next), /均不算上传成功/);
});

test('server-started, paused, unknown and terminal auto responses are never started again', async () => {
  for (const state of ['queued', 'running', 'paused', 'unknown', 'failed', 'completed'] as const) {
    const batch = fixture(state);
    assert.equal(await ensureAutoApprovedBatchStarted(batch, true, async () => { throw new Error('duplicate start'); }), batch);
  }
});

test('failed auto-start propagates without retry or inventing a verified outcome', async () => {
  let calls = 0;
  const batch = fixture();
  await assert.rejects(ensureAutoApprovedBatchStarted(batch, true, async () => {
    calls++;
    throw new Error('start failed');
  }), /start failed/);
  assert.equal(calls, 1);
  assert.equal(batch.state, 'preview');
  assert.ok(batch.items.every(item => item.state === 'queued'));
});

test('manual snapshot must be explicitly approved even when auto toggle changes later', () => {
  const batch = fixture();
  assert.equal(publicationApprovalReady(batch, true, ''), false);
  assert.equal(publicationApprovalReady(batch, false, `${batch.id}:${batch.preview.hash}`), true);
  assert.equal(publicationApprovalReady(batch, false, `${batch.id}:other-hash`), false);
  batch.preview.autoApprove = true;
  assert.equal(publicationApprovalReady(batch, false, `${batch.id}:${batch.preview.hash}`), false);
  assert.equal(publicationApprovalReady(batch, true, ''), true);
});

test('completed means only processing completed; verified and submitted outcomes are counted separately', () => {
  const batch = fixture('completed');
  batch.items[0].state = 'draft_verified';
  batch.items[1].state = 'submitted';
  batch.items[2].state = 'unknown';
  assert.match(publicationOutcome(batch), /队列处理完成（不代表已发布）/);
  assert.match(publicationOutcome(batch), /远端回读核实草稿 1 \/ 3 章；已提交审核 1 \/ 3 章/);
});
