import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Store } from '../projects/store.js';
import { PlatformRuntime } from './platform-runtime.js';
import { createPlatformRouter } from './platform-routes.js';
import { type BrowserSessionState, type DraftBrowserAdapter, type VerifiedDraft } from './platforms-types.js';
import type { DraftSnapshot, PlatformWork } from '../../../../../shared/platforms.js';
import type { PublicationBatch } from '../../../../../shared/publication.js';

/** Entirely offline: no Chromium, real session, platform requests, or remote writes. */
class PublicationFixtureBrowser implements DraftBrowserAdapter {
  readonly readiness = 'ready' as const;
  readonly reason = 'Offline publication regression fixture only';
  readonly accountId = 'publication-fixture-author';
  readonly accountName = 'Offline author';
  logins = new Set<string>();
  drafts = new Map<string, VerifiedDraft>();
  created: DraftSnapshot[] = [];
  reviewed: { draftId: string; snapshot: DraftSnapshot; useAi: 1 | 2 | undefined }[] = [];
  reads: string[] = [];
  failAfterSave = false;
  failAfterReview = false;
  reviewReceiptProven = false;
  async verifyReviewReceipt() { return this.reviewReceiptProven; }
  corruptReadback?: (draft: VerifiedDraft) => void;
  beforeCreate?: () => void;
  works: PlatformWork[] = [
    {
      id: 'publication-fixture-work',
      providerId: 'tomato',
      title: 'Offline work',
      description: '',
      genre: '',
      revision: '1',
      chapterCount: 0,
      updatedAt: '',
    },
  ];
  async startLogin(id: string) {
    this.logins.add(id);
  }
  loginOpen(id: string) {
    return this.logins.has(id);
  }
  async completeLogin(_id: string) {
    return {
      account: { accountId: this.accountId, accountName: this.accountName },
      state: { cookies: [], origins: [] },
    };
  }
  async closeLogin(id: string) {
    this.logins.delete(id);
  }
  async verifyAccount(_id: string, _state: BrowserSessionState) {
    return { accountId: this.accountId, accountName: this.accountName };
  }
  async listWorks(_id: string, _state: BrowserSessionState) {
    return structuredClone(this.works);
  }
  async createDraft(
    _id: string,
    _state: BrowserSessionState,
    accountId: string,
    workId: string,
    snapshot: DraftSnapshot,
    identified: (id: string) => void,
  ) {
    this.beforeCreate?.();
    this.created.push(structuredClone(snapshot));
    const id = `offline-draft-${this.created.length}`;
    this.drafts.set(id, {
      id,
      accountId,
      workId,
      title: snapshot.title,
      content: snapshot.content,
      paragraphs: [...snapshot.paragraphs],
      publishStatus: 0,
    });
    if (this.failAfterSave) throw new Error('PRIVATE_OFFLINE_BROWSER_ERROR');
    identified(id);
    return { draftId: id };
  }
  async readDraft(_id: string, _state: BrowserSessionState, _workId: string, draftId: string) {
    this.reads.push(draftId);
    const draft = structuredClone(this.drafts.get(draftId)!);
    this.corruptReadback?.(draft);
    return draft;
  }
  async findDrafts(
    _id: string,
    _state: BrowserSessionState,
    _accountId: string,
    _workId: string,
    _snapshot: DraftSnapshot,
  ) {
    return structuredClone([...this.drafts.values()]);
  }
  async deleteDraft(_id: string, _state: BrowserSessionState, _workId: string, draftId: string) {
    this.drafts.delete(draftId);
  }
  async submitReview(
    _id: string,
    _state: BrowserSessionState,
    _accountId: string,
    _workId: string,
    draftId: string,
    snapshot: DraftSnapshot,
    useAi?: 1 | 2,
  ) {
    assert.equal(this.reads.at(-1), draftId, 'review must follow exact-draft readback');
    this.reviewed.push({ draftId, snapshot: structuredClone(snapshot), useAi });
    if (this.failAfterReview) throw new Error('offline review receipt interrupted');
  }
  async closeConnection(_id: string) {}
  async close() {
    this.logins.clear();
  }
}

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-publication-runtime-test-'));
  const browser = new PublicationFixtureBrowser();
  const store = new Store(dir);
  const runtime = new PlatformRuntime(store, { browser });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const project = store.projects[0];
  project.chapters = [2, 1].map((number) => ({
    id: `publication-chapter-${number}`,
    number,
    revision: 1,
    title: `第${number}章 原样标题`,
    content: `  原样第一段 ${number}\r\n\r\n${'完整正文，不能只保留摘要。'.repeat(200)}\r\n末段。  `,
    mode: 'demo' as const,
    updatedAt: new Date().toISOString(),
  }));
  const login = await runtime.startLogin(project.id);
  const connection = await runtime.completeLogin(project.id, login.id);
  const link = {
    id: 'publication-fixture-link',
    projectId: project.id,
    connectionId: connection.id,
    providerId: 'tomato' as const,
    accountId: connection.accountId,
    remoteWorkId: browser.works[0].id,
    title: browser.works[0].title,
    revision: '1',
    lastSyncedAt: '',
  };
  runtime.platforms.putLink(link);
  const prepare = (action: 'save_draft' | 'submit_review' = 'save_draft', useAi?: 1 | 2) =>
    runtime.preparePublication(
      project.id,
      link.id,
      project.chapters.map((c) => c.id),
      action,
      useAi,
    );
  const start = (batch: PublicationBatch, requestId = randomUUID()) => {
    runtime.publications.approve(batch.id, batch.preview.hash);
    return runtime.publications.start(batch.id, { approvalHash: batch.preview.hash, requestId });
  };
  return { dir, browser, store, runtime, project, connection, link, prepare, start };
}
const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;

async function routerFixture(t: TestContext) {
  const f = await fixture(t);
  const app = express();
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const previousPort = process.env.PORT;
  process.env.PORT = String(port);
  app.use('/api', createPlatformRouter(f.store, f.runtime));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  });
  const root = `http://127.0.0.1:${port}/api/projects/${f.project.id}/platform-publication-batches`;
  const request = (suffix = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(root + suffix, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Platform-CSRF': f.runtime.csrfToken,
        'Idempotency-Key': randomUUID(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const input = { linkId: f.link.id, chapterIds: f.project.chapters.map((c) => c.id), action: 'save_draft' };
  return { ...f, root, request, input };
}

test('publication prepare and approval are read-only; explicit start preserves complete sorted snapshots and durable intent', async (t) => {
  const f = await fixture(t);
  const batch = await f.prepare();
  assert.equal(batch.state, 'preview');
  assert.equal(batch.approvalHash, undefined);
  assert.deepEqual(
    batch.preview.chapters.map((c) => c.number),
    [1, 2],
  );
  for (const snapshot of batch.preview.chapters) {
    const local = f.project.chapters.find((c) => c.id === snapshot.chapterId)!;
    assert.equal(snapshot.content, local.content);
    assert.deepEqual(snapshot.paragraphs, local.content.replace(/\r\n?/g, '\n').split('\n'));
  }
  await f.runtime.waitForIdle();
  assert.equal(f.browser.created.length, 0);
  assert.equal(f.browser.reads.length, 0);
  assert.throws(
    () =>
      f.runtime.publications.start(batch.id, { approvalHash: batch.preview.hash, requestId: randomUUID() }),
    hasCode('APPROVAL_MISMATCH'),
  );
  f.runtime.publications.approve(batch.id, batch.preview.hash);
  await f.runtime.waitForIdle();
  assert.equal(f.browser.created.length, 0, 'approval alone must never schedule work');
  f.browser.beforeCreate = () => {
    const persisted = JSON.parse(fs.readFileSync(path.join(f.dir, 'publication-queue.json'), 'utf8'));
    const saved = persisted.batches.find((b: PublicationBatch) => b.id === batch.id);
    assert.equal(saved.approvalHash, batch.preview.hash);
    assert.equal(
      saved.items.find((i: PublicationBatch['items'][number]) => i.state === 'running').mutationStarted,
      true,
    );
  };
  f.runtime.publications.start(batch.id, { approvalHash: batch.preview.hash, requestId: randomUUID() });
  await f.runtime.waitForIdle();
  assert.equal(f.runtime.publications.get(batch.id).state, 'completed');
  assert.deepEqual(f.browser.created, batch.preview.chapters);
  assert.equal(f.browser.reviewed.length, 0);
  assert.ok(f.project.chapters.every((c) => !('publishedAt' in c)));
});

test('publication routes require manual exact approval, an idempotency key and explicit review AI declaration', async (t) => {
  const f = await routerFixture(t);
  for (const body of [
    { ...f.input, action: 'submit_review' },
    { ...f.input, action: 'submit_review', useAi: 0 },
  ]) {
    assert.ok((await f.request('/prepare', 'POST', body)).status >= 400);
  }
  const response = await f.request('/prepare', 'POST', f.input);
  assert.equal(response.status, 201);
  const batch: PublicationBatch = await response.json();
  for (const body of [
    { approvalHash: batch.preview.hash, approved: false },
    { approvalHash: batch.preview.hash },
    { approvalHash: '0'.repeat(64), approved: true },
    { approvalHash: batch.preview.hash, approved: true, useAi: 1 },
  ])
    assert.ok((await f.request(`/${batch.id}/start`, 'POST', body)).status >= 400);
  const approval = { approvalHash: batch.preview.hash, approved: true };
  assert.equal(
    (await f.request(`/${batch.id}/start`, 'POST', approval, { 'Idempotency-Key': '' })).status,
    400,
  );
  assert.equal(f.browser.created.length, 0);
  const headers = { 'Idempotency-Key': 'offline-start-request' };
  assert.equal((await f.request(`/${batch.id}/start`, 'POST', approval, headers)).status, 202);
  await f.runtime.waitForIdle();
  assert.equal((await f.request(`/${batch.id}/start`, 'POST', approval, headers)).status, 202);
  assert.equal(f.browser.created.length, 2);
  const list: PublicationBatch[] = await (await f.request()).json();
  assert.equal(list.find((b) => b.id === batch.id)?.state, 'completed');
});

test('publication startup rejects stale complete content and target fields before editor entry', async (t) => {
  for (const change of [
    'content',
    'title',
    'revision',
    'number',
    'workTitle',
    'workRevision',
    'account',
    'work',
    'connection',
  ] as const) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const batch = await f.prepare();
      switch (change) {
        case 'content':
          f.project.chapters[0].content += '\n只改正文、不改版本';
          break;
        case 'title':
          f.project.chapters[0].title += ' changed';
          break;
        case 'revision':
          f.project.chapters[0].revision++;
          break;
        case 'number':
          f.project.chapters[0].number = 3;
          break;
        case 'workTitle':
          f.browser.works[0].title += ' changed';
          break;
        case 'workRevision':
          f.browser.works[0].revision = '2';
          break;
        case 'account':
        case 'connection': {
          const other = {
            ...f.runtime.connection(f.project.id, f.connection.id),
            id: 'another-connection',
            ...(change === 'account' ? { accountId: 'another-author' } : {}),
          };
          f.runtime.platforms.putConnection(other);
          f.runtime.platforms.putLink({ ...f.link, connectionId: other.id, accountId: other.accountId });
          break;
        }
        case 'work':
          f.runtime.platforms.putLink({ ...f.link, remoteWorkId: 'another-work' });
          break;
      }
      f.start(batch);
      await f.runtime.waitForIdle();
      assert.equal(f.runtime.publications.get(batch.id).state, 'failed');
      assert.equal(f.browser.created.length, 0);
      assert.equal(f.browser.reviewed.length, 0);
      assert.ok(f.runtime.publications.get(batch.id).items.every((i) => !i.mutationStarted));
    });
  }
});

test('saved draft to review reuses exact remote IDs and forwards each explicitly approved AI value', async (t) => {
  for (const useAi of [1, 2] as const) {
    await t.test(`useAi=${useAi}`, async (t) => {
      const f = await fixture(t);
      const draft = await f.prepare();
      f.start(draft);
      await f.runtime.waitForIdle();
      const saved = f.runtime.publications.get(draft.id);
      const review = await f.prepare('submit_review', useAi);
      assert.equal(f.browser.reviewed.length, 0);
      assert.equal(review.preview.useAi, useAi);
      f.start(review);
      await f.runtime.waitForIdle();
      const submitted = f.runtime.publications.get(review.id);
      assert.equal(submitted.state, 'completed');
      assert.ok(submitted.items.every((i) => i.state === 'submitted'));
      assert.deepEqual(
        submitted.items.map((i) => i.remoteDraftId),
        saved.items.map((i) => i.remoteDraftId),
      );
      assert.equal(f.browser.created.length, 2, 'review must not create another draft');
      assert.deepEqual(
        f.browser.reviewed.map((r) => r.useAi),
        [useAi, useAi],
      );
      assert.deepEqual(
        f.browser.reviewed.map((r) => r.snapshot),
        review.preview.chapters,
      );
      assert.equal(f.browser.reads.length, 4);
      assert.ok(f.project.chapters.every((c) => !('publishedAt' in c)));
    });
  }
});

test('unknown batch outcome blocks start/resume and fresh duplicate approvals without blind resend', async (t) => {
  const f = await fixture(t);
  f.browser.failAfterSave = true;
  const batch = await f.prepare();
  f.start(batch);
  await f.runtime.waitForIdle();
  assert.equal(f.runtime.publications.get(batch.id).state, 'unknown');
  assert.equal(f.browser.created.length, 1);
  assert.equal(f.browser.reviewed.length, 0);
  assert.throws(
    () =>
      f.runtime.publications.start(batch.id, { approvalHash: batch.preview.hash, requestId: randomUUID() }),
    hasCode('INVALID_STATE'),
  );
  const duplicate = await f.prepare();
  assert.throws(
    () => f.runtime.publications.approve(duplicate.id, duplicate.preview.hash),
    hasCode('DUPLICATE_CHAPTER'),
  );
  const legacy = await f.runtime.prepare(f.project.id, f.link.id, batch.preview.chapters[0].chapterId);
  assert.throws(
    () => f.runtime.execute(f.project.id, legacy.id, legacy.snapshot.contentHash, randomUUID()),
    hasCode('PLATFORM_DRAFT_UPDATE_BLOCKED'),
  );
  await assert.rejects(f.runtime.removeProject(f.project.id), hasCode('PUBLICATION_PENDING'));
  assert.equal(f.browser.created.length, 1);
  assert.ok(
    !fs
      .readFileSync(path.join(f.dir, 'publication-queue.json'), 'utf8')
      .includes('PRIVATE_OFFLINE_BROWSER_ERROR'),
  );
});

test('pending publication queues preserve connection, project and HTTP link recovery entries', async (t) => {
  for (const state of ['queued', 'paused', 'unknown'] as const) {
    await t.test(state, async (t) => {
      const f = await routerFixture(t);
      const batch = await f.prepare();
      f.runtime.publications.approve(batch.id, batch.preview.hash);
      if (state === 'paused') f.runtime.publications.pause(batch.id);
      if (state === 'unknown') {
        f.browser.failAfterSave = true;
        f.runtime.publications.start(batch.id, {
          approvalHash: batch.preview.hash,
          requestId: randomUUID(),
        });
        await f.runtime.waitForIdle();
      }
      assert.equal(f.runtime.publications.get(batch.id).state, state);
      await assert.rejects(
        f.runtime.removeConnection(f.project.id, f.connection.id),
        hasCode('PUBLICATION_PENDING'),
      );
      await assert.rejects(f.runtime.removeProject(f.project.id), hasCode('PUBLICATION_PENDING'));
      const response = await fetch(
        f.root.replace(/platform-publication-batches$/, `platform-links/${f.link.id}`),
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'X-Platform-CSRF': f.runtime.csrfToken,
          },
          body: '{}',
        },
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'PUBLICATION_PENDING');
      assert.equal(f.runtime.connection(f.project.id, f.connection.id).id, f.connection.id);
      assert.ok(f.runtime.platforms.links(f.project.id).some((link) => link.id === f.link.id));
      assert.equal(f.store.get(f.project.id)?.id, f.project.id);
      assert.equal(f.browser.created.length, state === 'unknown' ? 1 : 0);
    });
  }
});

test('completed batch drafts also block the legacy single-draft creation entry point', async (t) => {
  const f = await fixture(t);
  const batch = await f.prepare();
  f.start(batch);
  await f.runtime.waitForIdle();
  const chapter = batch.preview.chapters[0];
  const single = await f.runtime.prepare(f.project.id, f.link.id, chapter.chapterId);
  assert.throws(
    () => f.runtime.execute(f.project.id, single.id, single.snapshot.contentHash, randomUUID()),
    hasCode('PLATFORM_DRAFT_UPDATE_BLOCKED'),
  );
  assert.equal(f.browser.created.length, 2);
  assert.equal(f.runtime.platforms.draftOperations(f.project.id).length, 0);
});

test('review readback mismatch stops without invoking submitReview or processing later chapters', async (t) => {
  for (const field of ['content', 'paragraphs', 'accountId', 'workId', 'id'] as const) {
    await t.test(field, async (t) => {
      const f = await fixture(t);
      f.browser.corruptReadback = (draft) => {
        if (field === 'paragraphs') draft.paragraphs = ['different paragraph'];
        else draft[field] += '-changed';
      };
      const batch = await f.prepare('submit_review', 1);
      f.start(batch);
      await f.runtime.waitForIdle();
      assert.equal(f.runtime.publications.get(batch.id).state, 'unknown');
      assert.equal(f.browser.created.length, 1);
      assert.equal(f.browser.reviewed.length, 0);
    });
  }
});

test('server automatic prepare approval is explicit, hashed and durable; review completes without local approval', async (t) => {
  const f = await routerFixture(t);
  const response = await f.request('/prepare', 'POST', { ...f.input, action: 'submit_review', useAi: 1, autoApprove: true });
  assert.equal(response.status, 201);
  const batch: PublicationBatch = await response.json();
  assert.equal(batch.preview.autoApprove, true);
  assert.equal(batch.approvalHash, batch.preview.hash);
  assert.equal(batch.approval?.mode, 'automatic');
  assert.equal(batch.approval?.source, 'prepare');
  await f.runtime.waitForIdle();
  assert.equal(f.runtime.publications.get(batch.id).state, 'completed');
  assert.equal(f.browser.reviewed.length, 2);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.dir, 'publication-queue.json'), 'utf8'));
  assert.equal(persisted.batches[0].approval.hash, batch.preview.hash);
});

test('automatic start of existing preview audits explicit opt-in without rewriting immutable hash', async (t) => {
  const f = await routerFixture(t);
  const batch = await f.prepare();
  assert.equal(batch.preview.autoApprove, false);
  const response = await f.request(`/${batch.id}/start`, 'POST', { approvalHash: batch.preview.hash, autoApprove: true });
  assert.equal(response.status, 202);
  await f.runtime.waitForIdle();
  const result = f.runtime.publications.get(batch.id);
  assert.equal(result.preview.hash, batch.preview.hash);
  assert.equal(result.preview.autoApprove, false);
  assert.equal(result.approval?.mode, 'automatic');
  assert.equal(result.state, 'completed');
});

test('unknown saved batch reconciles only exact known identity and complete body; never performs writes or retries', async (t) => {
  for (const mismatch of ['none', 'content', 'paragraphs', 'accountId', 'workId', 'id', 'status', 'missingId'] as const) {
    await t.test(mismatch, async (t) => {
      const f = await routerFixture(t);
      f.browser.corruptReadback = draft => { draft.content += '-uncertain'; };
      const batch = await f.prepare();
      f.start(batch); await f.runtime.waitForIdle();
      assert.equal(f.runtime.publications.get(batch.id).state, 'unknown');
      f.browser.corruptReadback = undefined;
      const draft = f.browser.drafts.get('offline-draft-1')!;
      if (mismatch === 'paragraphs') draft.paragraphs = ['wrong'];
      else if (mismatch === 'status') draft.publishStatus = 1;
      else if (mismatch === 'missingId') f.browser.drafts.delete(draft.id);
      else if (mismatch !== 'none') draft[mismatch] += '-wrong';
      const response = await f.request(`/${batch.id}/reconcile`, 'POST', {});
      assert.equal(response.status, 200);
      const result: PublicationBatch = await response.json();
      assert.equal(result.items[0].state, mismatch === 'none' ? 'draft_verified' : 'unknown');
      assert.equal(result.state, mismatch === 'none' ? 'paused' : 'unknown');
      assert.equal(f.browser.created.length, 1);
      assert.equal(f.browser.reviewed.length, 0);
      await f.runtime.waitForIdle();
      assert.equal(f.browser.created.length, 1);
    });
  }
});

test('unknown review requires explicit read-only receipt proof, never re-submits', async (t) => {
  for (const proven of [false, true]) await t.test(String(proven), async (t) => {
    const f = await fixture(t); f.browser.failAfterReview = true;
    const batch = await f.prepare('submit_review', 1); f.start(batch); await f.runtime.waitForIdle();
    assert.equal(f.runtime.publications.get(batch.id).state, 'unknown');
    f.browser.reviewReceiptProven = proven;
    const result = await f.runtime.reconcilePublication(f.project.id, batch.id);
    assert.equal(result.items[0].state, proven ? 'submitted' : 'unknown');
    assert.equal(f.browser.reviewed.length, 1);
    assert.equal(f.browser.created.length, 1);
  });
});

test('unknown without persisted remote identity is never searched, deleted or retried', async (t) => {
  const f = await routerFixture(t);
  f.browser.failAfterSave = true;
  const batch = await f.prepare(); f.start(batch); await f.runtime.waitForIdle();
  const response = await f.request(`/${batch.id}/reconcile`, 'POST', {});
  assert.equal(response.status, 200);
  const result: PublicationBatch = await response.json();
  assert.equal(result.items[0].remoteDraftId, undefined);
  assert.equal(result.items[0].state, 'unknown');
  assert.equal(f.browser.reads.length, 0);
  assert.equal(f.browser.created.length, 1);
});

test('reconciliation route enforces CSRF, project scope and running-project lock', async (t) => {
  const f = await routerFixture(t); f.browser.failAfterSave = true;
  const batch = await f.prepare(); f.start(batch); await f.runtime.waitForIdle();
  assert.equal((await f.request(`/${batch.id}/reconcile`, 'POST', {}, { 'X-Platform-CSRF': '' })).status, 403);
  assert.equal((await f.request(`/${batch.id}/reconcile`, 'POST', { remoteDraftId: 'injected' })).status, 400);
  const other = { ...structuredClone(f.project), id: randomUUID(), name: 'Other project' };
  f.store.projects.push(other);
  const wrongScope = await fetch(f.root.replace(f.project.id, other.id) + `/${batch.id}/reconcile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': f.runtime.csrfToken }, body: '{}',
  });
  assert.equal(wrongScope.status, 404);
  const oldRun = f.project.run;
  f.project.run = { ...oldRun, status: 'running' } as NonNullable<typeof f.project.run>;
  assert.equal((await f.request(`/${batch.id}/reconcile`, 'POST', {})).status, 409);
  f.project.run = oldRun;
  assert.equal(f.browser.created.length, 1);
});

test('publication routes inherit localhost, origin, fetch-site and CSRF guards', async (t) => {
  const f = await routerFixture(t);
  const hostileHeaders: Record<string, string>[] = [
    { 'X-Platform-CSRF': '' },
    { Origin: 'https://evil.test' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const headers of hostileHeaders) {
    assert.equal((await f.request('/prepare', 'POST', f.input, headers)).status, 403);
  }
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(f.root, { headers: { Host: 'evil.test' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(hostileHost, 403);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), []);
  assert.equal(f.browser.created.length, 0);
});
