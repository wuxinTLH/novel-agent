import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicationQueue, PublicationQueueError, publicationPreviewHash, type PublicationQueueHooks } from './publication-queue.js';
import type { DraftSnapshot } from '../../../../../shared/platforms.js';
import type { PublicationTarget } from '../../../../../shared/publication.js';

test('explicit staging clear backs up history and rejects active batches', async t => {
  const { queue, file } = fixture(t);
  const batch = await queue.preview({ target, action: 'save_draft', chapters: [chapter()] });
  queue.clearStaging('another-project');
  assert.equal(queue.list(target.projectId).length, 1);
  queue.clearStaging(target.projectId);
  assert.equal(queue.list(target.projectId).length, 0);
  assert.ok(fs.readdirSync(path.dirname(file)).some(name => name.includes('.staging-')));
  const next = await approved(queue);
  assert.throws(() => queue.clearStaging(target.projectId), errorCode('INVALID_STATE'));
  assert.equal(queue.get(next.id).state, 'queued');
});

test('automatic policy is hash-bound and restart-safe approval provenance is persisted', async t => {
  const { queue, file, hooks } = fixture(t);
  const batch = await queue.preview({ target, action: 'save_draft', chapters: [chapter()], autoApprove: true });
  const { hash, ...payload } = batch.preview;
  assert.notEqual(publicationPreviewHash({ ...payload, autoApprove: false }), hash);
  queue.approve(batch.id, hash, { mode: 'automatic', source: 'prepare' });
  const reopened = new PublicationQueue(file, hooks);
  assert.equal(reopened.get(batch.id).approval?.mode, 'automatic');
  assert.equal(reopened.get(batch.id).state, 'paused');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.batches[0].preview.autoApprove = false;
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => new PublicationQueue(file, hooks), errorCode('SNAPSHOT_CHANGED'));
});

test('read-only recovery rejects replacement ID and action mismatch, preserving unknown without reexecution', async t => {
  for (const outcome of ['exact', 'replacement', 'wrongAction', 'unproven'] as const) {
    let writes = 0;
    const { queue } = fixture(t, {
      execute: async (_p, _i, context) => { writes++; context.beforeMutation(); context.identified('known-id'); throw new Error('uncertain'); },
      reconcile: async () => outcome === 'unproven' ? undefined : {
        state: outcome === 'wrongAction' ? 'submitted' : 'draft_verified',
        remoteDraftId: outcome === 'replacement' ? 'other-id' : 'known-id', remoteFingerprint: 'proof',
      },
    });
    const batch = await approved(queue);
    queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'start' }); await queue.waitForIdle();
    const result = await queue.reconcile(batch.id);
    assert.equal(result.state, outcome === 'exact' ? 'completed' : 'unknown');
    assert.equal(writes, 1);
    assert.equal(result.items[0].reconciliation?.outcome, outcome === 'exact' ? 'draft_verified' : 'unproven');
  }
});

test('manual remote ID is only persisted after read-only proof and never reexecutes', async t => {
  for (const proven of [false, true]) {
    let writes = 0;
    const { queue } = fixture(t, {
      execute: async (_p, _i, context) => { writes++; context.beforeMutation(); throw new Error('lost ID'); },
      reconcile: async (_p, item) => {
        assert.equal(item.remoteDraftId, 'candidate-id');
        return proven ? { state: 'draft_verified', remoteDraftId: 'candidate-id', remoteFingerprint: 'proof' } : undefined;
      },
    });
    const batch = await approved(queue);
    queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'start' });
    await queue.waitForIdle();
    const result = await queue.reconcile(batch.id, { [batch.items[0].id]: 'candidate-id' });
    assert.equal(result.state, proven ? 'completed' : 'unknown');
    assert.equal(result.items[0].remoteDraftId, proven ? 'candidate-id' : undefined);
    assert.equal(writes, 1);
  }
});

const target: PublicationTarget = { projectId: 'project-a', connectionId: 'connection-a', providerId: 'tomato', accountId: 'account-a', accountName: 'Author', linkId: 'link-a', remoteWorkId: 'work-a', workTitle: 'Work', workRevision: '1' };
function chapter(number = 1): DraftSnapshot { return { chapterId: `chapter-${number}`, number, revision: 1, title: `Chapter ${number}`, content: 'Full immutable text', paragraphs: ['Full immutable text'], contentHash: `hash-${number}` }; }
function fixture(t: { after(fn: () => void): void }, hooks?: Partial<PublicationQueueHooks>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'queue.json');
  const defaults: PublicationQueueHooks = { validate: async () => {}, execute: async (_p, _i, c) => { c.beforeMutation(); c.identified('remote-id'); return { state: 'draft_verified' }; } };
  const queue = new PublicationQueue(file, { ...defaults, ...hooks });
  return { queue, file, hooks: { ...defaults, ...hooks } };
}
async function approved(queue: PublicationQueue, chapters = [chapter()]) {
  const batch = await queue.preview({ target, action: 'save_draft', chapters });
  return queue.approve(batch.id, batch.preview.hash);
}
function errorCode(code: string) { return (e: unknown) => e instanceof PublicationQueueError && e.code === code; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test('full immutable previews, exact hash approval, max 50, no implicit execution, no credentials', async t => {
  let writes = 0;
  const { queue, file } = fixture(t, { execute: async () => { writes++; return { state: 'draft_verified' }; } });
  const chapters = [chapter()];
  const batch = await queue.preview({ target: { ...target, token: 'SECRET' } as PublicationTarget, action: 'save_draft', chapters });
  chapters[0].content = 'changed';
  assert.equal(batch.preview.chapters[0].content, 'Full immutable text');
  assert.throws(() => { batch.preview.chapters[0].title = 'changed'; }, TypeError);
  assert.throws(() => queue.approve(batch.id, 'wrong'), errorCode('APPROVAL_MISMATCH'));
  assert.equal(queue.approve(batch.id, batch.preview.hash).state, 'queued');
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(file, 'utf8').includes('SECRET'), false);
  await assert.rejects(queue.preview({ target, action: 'save_draft', chapters: Array.from({ length: 51 }, (_, i) => chapter(i + 1)) }), errorCode('INVALID_PREVIEW'));
  await assert.rejects(queue.preview({ target, action: 'save_draft', chapters: [chapter(), chapter()] }), errorCode('DUPLICATE_CHAPTER'));
});

test('explicit start is idempotent and sequential, lock spans entire batch, mutation persists before execute', async t => {
  const order: string[] = [];
  let active = 0;
  const f = fixture(t, {
    acquire: async () => { order.push('lock'); return () => { order.push('unlock'); }; },
    execute: async (_p, item, c) => {
      active++; assert.equal(active, 1); order.push(item.snapshot.chapterId);
      c.beforeMutation();
      const persisted = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      assert.equal(persisted.batches[0].items.find((i: { id: string }) => i.id === item.id).mutationStarted, true);
      c.identified(`remote-${item.id}`); active--; return { state: 'draft_verified' };
    },
  });
  const batch = await approved(f.queue, [chapter(), chapter(2)]);
  const input = { approvalHash: batch.preview.hash, requestId: 'start-1' };
  f.queue.start(batch.id, input); f.queue.start(batch.id, input);
  f.queue.start(batch.id, { ...input, requestId: 'different-active-request' });
  await f.queue.waitForIdle();
  assert.deepEqual(order, ['lock', 'unlock', 'lock', 'chapter-1', 'chapter-2', 'unlock']);
  assert.equal(f.queue.get(batch.id).state, 'completed');
  f.queue.start(batch.id, input);
  assert.deepEqual(order, ['lock', 'unlock', 'lock', 'chapter-1', 'chapter-2', 'unlock']);
});

test('pause finishes in-flight item, starts no next chapter, fresh explicit request resumes', async t => {
  const entered = deferred(); const finish = deferred(); let calls = 0;
  const { queue } = fixture(t, { execute: async (_p, _i, c) => { calls++; c.beforeMutation(); entered.resolve(); await finish.promise; return { state: 'draft_verified' }; } });
  const batch = await approved(queue, [chapter(), chapter(2)]);
  queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'first' });
  await entered.promise;
  assert.equal(queue.pause(batch.id).state, 'running');
  finish.resolve(); await queue.waitForIdle();
  assert.equal(calls, 1); assert.equal(queue.get(batch.id).state, 'paused');
  queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'second' });
  await queue.waitForIdle(); assert.equal(calls, 2); assert.equal(queue.get(batch.id).state, 'completed');
});

test('snapshot validation rejects changed chapters before any mutation and stops remaining items', async t => {
  let changed = false; let calls = 0;
  const { queue } = fixture(t, { validate: async () => { if (changed) throw new Error('snapshot changed'); }, execute: async () => { calls++; return { state: 'draft_verified' }; } });
  const batch = await approved(queue, [chapter(), chapter(2)]); changed = true;
  queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'start' });
  await queue.waitForIdle(); assert.equal(calls, 0); assert.equal(queue.get(batch.id).state, 'failed');
});

test('pre-mutation failure is failed; post-mutation failure unknown; neither retries or leaks hook secrets', async t => {
  for (const mutate of [false, true]) {
    let calls = 0;
    const { queue, file } = fixture(t, { execute: async (_p, _i, c) => { calls++; if (mutate) c.beforeMutation(); throw new Error('TOKEN_SECRET'); } });
    const batch = await approved(queue, [chapter(), chapter(2)]);
    queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'start' }); await queue.waitForIdle();
    assert.equal(queue.get(batch.id).state, mutate ? 'unknown' : 'failed'); assert.equal(calls, 1);
    assert.throws(() => queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'retry' }), errorCode('INVALID_STATE'));
    assert.equal(fs.readFileSync(file, 'utf8').includes('TOKEN_SECRET'), false);
  }
});

test('dedup and conflicting versions cross project boundaries at approval, including completed items', async t => {
  const { queue } = fixture(t); const first = await approved(queue);
  queue.start(first.id, { approvalHash: first.preview.hash, requestId: 'start' }); await queue.waitForIdle();
  for (const revision of [1, 2]) {
    const batch = await queue.preview({ target: { ...target, projectId: 'another-project', connectionId: 'another-connection' }, action: 'save_draft', chapters: [{ ...chapter(), revision }] });
    assert.throws(() => queue.approve(batch.id, batch.preview.hash), errorCode(revision === 1 ? 'DUPLICATE_CHAPTER' : 'CONFLICTING_VERSION'));
  }
});

test('restart queued pauses, restart mutation intent is unknown, safe in-flight is paused; never auto resumes', async t => {
  const { queue, file, hooks } = fixture(t); const batch = await approved(queue);
  const reopened = new PublicationQueue(file, hooks);
  assert.equal(reopened.get(batch.id).state, 'paused');
  for (const mutationStarted of [false, true]) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.batches[0].state = 'running'; data.batches[0].items[0].state = 'running'; data.batches[0].items[0].mutationStarted = mutationStarted;
    fs.writeFileSync(file, JSON.stringify(data));
    const restarted = new PublicationQueue(file, hooks);
    assert.equal(restarted.get(batch.id).state, mutationStarted ? 'unknown' : 'paused');
    assert.equal(restarted.get(batch.id).items[0].state, mutationStarted ? 'unknown' : 'queued');
  }
});

test('atomic persistence failure rolls back approvals and prevents mutation', async t => {
  const { queue, file, hooks } = fixture(t); const preview = await queue.preview({ target, action: 'save_draft', chapters: [chapter()] });
  const original = fs.readFileSync(file, 'utf8');
  const broken = new PublicationQueue(file, hooks, { persist: () => { throw new Error('disk full'); } });
  assert.throws(() => broken.approve(preview.id, preview.preview.hash), /disk full/);
  assert.equal(broken.get(preview.id).state, 'preview'); assert.equal(fs.readFileSync(file, 'utf8'), original);
  const batch = queue.approve(preview.id, preview.preview.hash);
  let fail = false; let touched = 0;
  const runner = new PublicationQueue(file, { validate: async () => {}, execute: async (_p, _i, c) => { fail = true; c.beforeMutation(); touched++; return { state: 'draft_verified' }; } }, { persist: (destination, contents) => { if (fail) throw new Error('disk full'); fs.writeFileSync(destination, contents); } });
  runner.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'run' }); await runner.waitForIdle();
  assert.equal(touched, 0); assert.equal(runner.get(batch.id).items[0].mutationStarted, false);
});

test('submit_review records submitted, never infers published, and rejects wrong outcome', async t => {
  for (const state of ['submitted', 'draft_verified'] as const) {
    const { queue } = fixture(t, { execute: async (_p, _i, c) => { c.beforeMutation(); return { state }; } });
    const batch = await queue.preview({ target, action: 'submit_review', useAi: 1, chapters: [chapter()] }); queue.approve(batch.id, batch.preview.hash);
    queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'review' }); await queue.waitForIdle();
    assert.equal(queue.get(batch.id).state, state === 'submitted' ? 'completed' : 'unknown');
    assert.equal(JSON.stringify(queue.get(batch.id)).includes('published'), false);
  }
});

test('completed exact draft can be submitted only with identical remote identity', async t => {
  for (const wrong of [false, true]) {
    const { queue } = fixture(t, { execute: async (preview, _item, c) => {
      c.beforeMutation(); c.identified(preview.action === 'submit_review' && wrong ? 'wrong-id' : 'exact-id');
      return { state: preview.action === 'submit_review' ? 'submitted' : 'draft_verified' };
    } });
    const saved = await approved(queue);
    queue.start(saved.id, { approvalHash: saved.preview.hash, requestId: 'save' }); await queue.waitForIdle();
    const review = await queue.preview({ target, action: 'submit_review', useAi: 1, chapters: [chapter()] });
    assert.equal(queue.findVerifiedDraft(review.preview, chapter())?.remoteDraftId, 'exact-id');
    queue.approve(review.id, review.preview.hash);
    queue.start(review.id, { approvalHash: review.preview.hash, requestId: 'submit' }); await queue.waitForIdle();
    assert.equal(queue.get(review.id).state, wrong ? 'unknown' : 'completed');
  }
});

test('approval expires after ten minutes and modified execution snapshots fail loading', async t => {
  const { file, hooks } = fixture(t);
  let now = '2026-01-01T00:00:00.000Z';
  const queue = new PublicationQueue(file, hooks, { now: () => now });
  const batch = await queue.preview({ target, action: 'save_draft', chapters: [chapter()] });
  now = '2026-01-01T00:10:00.000Z';
  assert.throws(() => queue.approve(batch.id, batch.preview.hash), errorCode('PREVIEW_EXPIRED'));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.batches[0].items[0].snapshot.title = 'tampered execution'; fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => new PublicationQueue(file, hooks), errorCode('SNAPSHOT_CHANGED'));
});

test('review requires explicit hash-bound AI declaration', async t => {
  const { queue } = fixture(t);
  await assert.rejects(queue.preview({ target, action: 'submit_review', chapters: [chapter()] }), errorCode('INVALID_PREVIEW'));
  const batch = await queue.preview({ target, action: 'submit_review', useAi: 1, chapters: [chapter()] });
  const { hash, ...payload } = batch.preview;
  assert.notEqual(publicationPreviewHash({ ...payload, useAi: 2 }), hash);
});

test('remote plans permit sequential verified revisions without rewriting historical previews', async t => {
  const { queue, file, hooks } = fixture(t, { execute: async (_preview, item, context) => {
    context.beforeMutation(); context.identified('exact-remote');
    return { state: 'draft_verified', remoteDraftId: 'exact-remote', remoteFingerprint: `fingerprint-${item.snapshot.revision}` };
  } });
  let previous;
  for (const revision of [1, 2, 3]) {
    const snapshot = { ...chapter(), revision, content: `revision ${revision}`, paragraphs: [`revision ${revision}`], contentHash: `hash-${revision}` };
    const remotePlan = previous ? [{ chapterId: snapshot.chapterId, volumeId: 'volume', volumeName: 'Volume',
      mode: 'overwrite' as const, remoteDraftId: 'exact-remote', expectedRemoteFingerprint: previous.items[0].remoteFingerprint!,
      predecessor: { source: 'publication' as const, operationId: previous.items[0].id } }] :
      [{ chapterId: snapshot.chapterId, volumeId: 'volume', volumeName: 'Volume', mode: 'create' as const }];
    const batch = await queue.preview({ target, action: 'save_draft', chapters: [snapshot], remotePlan });
    queue.approve(batch.id, batch.preview.hash);
    queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: `revision-${revision}` });
    await queue.waitForIdle();
    previous = queue.get(batch.id);
    assert.equal(previous.state, 'completed');
    assert.equal(previous.items[0].remoteDraftId, 'exact-remote');
  }
  const oldHash = queue.list()[0].preview.hash;
  const reopened = new PublicationQueue(file, hooks);
  assert.equal(reopened.list()[0].preview.hash, oldHash);
  assert.equal(reopened.list()[0].preview.chapters[0].revision, 1);
});

test('remote target baseline, head, duplicate remote identities and unknown revisions remain guarded', async t => {
  const { queue } = fixture(t, { execute: async (_p, _i, c) => {
    c.beforeMutation(); c.identified('remote'); return { state: 'draft_verified', remoteDraftId: 'remote', remoteFingerprint: 'baseline' };
  } });
  const first = await queue.preview({ target, action: 'save_draft', chapters: [chapter()],
    remotePlan: [{ chapterId: chapter().chapterId, volumeId: 'v', volumeName: 'V', mode: 'create' }] });
  queue.approve(first.id, first.preview.hash); queue.start(first.id, { approvalHash: first.preview.hash, requestId: 'first' }); await queue.waitForIdle();
  const saved = queue.get(first.id);
  const plan = { chapterId: chapter().chapterId, volumeId: 'v', volumeName: 'V', mode: 'overwrite' as const, remoteDraftId: 'remote',
    expectedRemoteFingerprint: 'baseline', predecessor: { source: 'publication' as const, operationId: saved.items[0].id } };
  for (const invalid of [{ ...plan, expectedRemoteFingerprint: 'external-edit' }, { ...plan, predecessor: { ...plan.predecessor, operationId: 'old-head' } },
    { ...plan, chapterId: 'other-local' }]) {
    const candidate = await queue.preview({ target, action: 'save_draft', chapters: [{ ...chapter(), revision: 2, chapterId: invalid.chapterId }], remotePlan: [invalid] });
    assert.throws(() => queue.approve(candidate.id, candidate.preview.hash), errorCode('CONFLICTING_VERSION'));
  }
  const candidate = await queue.preview({ target, action: 'save_draft', chapters: [{ ...chapter(), revision: 2 }], remotePlan: [plan] });
  queue.approve(candidate.id, candidate.preview.hash);
  const contender = await queue.preview({ target, action: 'save_draft', chapters: [{ ...chapter(), revision: 3 }], remotePlan: [plan] });
  assert.throws(() => queue.approve(contender.id, contender.preview.hash), errorCode('CONFLICTING_VERSION'));
});

test('unknown mutation blocks new remote overwrite and legacy preview hash remains unchanged', async t => {
  const { queue, file, hooks } = fixture(t, { execute: async (_p, _i, context) => {
    context.beforeMutation(); context.identified('remote'); throw new Error('uncertain remote save');
  } });
  const legacy = await queue.preview({ target, action: 'save_draft', chapters: [chapter()] });
  const legacyHash = legacy.preview.hash;
  assert.equal('remotePlan' in legacy.preview, false);
  queue.approve(legacy.id, legacyHash); queue.start(legacy.id, { approvalHash: legacyHash, requestId: 'unknown' }); await queue.waitForIdle();
  assert.equal(queue.get(legacy.id).state, 'unknown');
  const candidate = await queue.preview({ target, action: 'save_draft', chapters: [{ ...chapter(), revision: 2 }],
    remotePlan: [{ chapterId: chapter().chapterId, volumeId: 'v', volumeName: 'V', mode: 'overwrite', remoteDraftId: 'remote', expectedRemoteFingerprint: 'readback' }] });
  assert.throws(() => queue.approve(candidate.id, candidate.preview.hash), errorCode('CONFLICTING_VERSION'));
  const reopened = new PublicationQueue(file, hooks);
  assert.equal(reopened.get(legacy.id).preview.hash, legacyHash);
  assert.equal('remotePlan' in reopened.get(legacy.id).preview, false);
});

test('new remote plans cannot return a replacement remote identity', async t => {
  const { queue } = fixture(t, { execute: async (_p, _i, context) => {
    context.beforeMutation(); return { state: 'draft_verified', remoteDraftId: 'replacement', remoteFingerprint: 'post' };
  } });
  const batch = await queue.preview({ target, action: 'save_draft', chapters: [chapter()],
    remotePlan: [{ chapterId: chapter().chapterId, volumeId: 'v', volumeName: 'V', mode: 'overwrite', remoteDraftId: 'approved', expectedRemoteFingerprint: 'baseline' }] });
  queue.approve(batch.id, batch.preview.hash); queue.start(batch.id, { approvalHash: batch.preview.hash, requestId: 'wrong-target' }); await queue.waitForIdle();
  assert.equal(queue.get(batch.id).state, 'unknown');
  assert.equal(queue.get(batch.id).items[0].remoteDraftId, undefined);
});

test('tampered immutable preview is rejected on reopen', async t => {
  const { queue, file, hooks } = fixture(t); await approved(queue);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.batches[0].preview.chapters[0].content = 'tampered'; fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => new PublicationQueue(file, hooks), errorCode('SNAPSHOT_CHANGED'));
});
