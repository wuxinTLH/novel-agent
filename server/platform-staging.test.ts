import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { Store } from './store.js';
import { PlatformRuntime } from './platform-runtime.js';
import { PlatformStore } from './platform-store.js';
import { createPlatformRouter } from './platform-routes.js';
import { PublicationQueue } from './publication-queue.js';
import type { BrowserSessionState, DraftBrowserAdapter, VerifiedDraft } from './platforms-types.js';
import type { DraftSnapshot, PlatformWork } from '../shared/platforms.js';
import type { PublicationTarget } from '../shared/publication.js';

// A deliberately offline adapter: clearing local staging must never touch a remote browser.
class NoRemoteBrowser implements DraftBrowserAdapter {
  readonly readiness = 'ready' as const;
  readonly reason = 'offline staging fixture';
  writes = 0;
  async startLogin() { this.writes++; throw new Error('Unexpected remote login'); }
  loginOpen() { return false; }
  async completeLogin(): Promise<{ account: { accountId: string; accountName: string }; state: BrowserSessionState }> {
    this.writes++; throw new Error('Unexpected remote login');
  }
  async closeLogin() { this.writes++; throw new Error('Unexpected remote login'); }
  async verifyAccount(): Promise<{ accountId: string; accountName: string }> { this.writes++; throw new Error('Unexpected remote verification'); }
  async listWorks(): Promise<PlatformWork[]> { this.writes++; throw new Error('Unexpected remote read'); }
  async createDraft(): Promise<{ draftId: string }> { this.writes++; throw new Error('Unexpected remote write'); }
  async readDraft(): Promise<VerifiedDraft> { this.writes++; throw new Error('Unexpected remote read'); }
  async findDrafts(): Promise<VerifiedDraft[]> { this.writes++; throw new Error('Unexpected remote read'); }
  async deleteDraft() { this.writes++; throw new Error('Unexpected remote delete'); }
  async closeConnection() { this.writes++; throw new Error('Unexpected remote close'); }
  async close() {}
}

const snapshot: DraftSnapshot = {
  chapterId: 'chapter', number: 1, revision: 1, title: 'Chapter', content: 'offline fixture',
  paragraphs: ['offline fixture'], contentHash: 'a'.repeat(64),
};
const offlineQueue = (dir: string) => new PublicationQueue(path.join(dir, 'publication-queue.json'), {
  validate: async () => {}, execute: async () => { throw new Error('Unexpected remote write'); },
});
const target = (projectId: string): PublicationTarget => ({
  projectId, connectionId: `connection-${projectId}`, providerId: 'tomato', accountId: 'offline-account',
  accountName: 'Fixture', linkId: `link-${projectId}`, remoteWorkId: 'offline-work',
  workTitle: 'Offline fixture', workRevision: '1',
});

test('staging clear HTTP requires CSRF and both acknowledgements, scopes records, backs up both stores without remote writes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-staging-http-'));
  const priorPort = process.env.PORT;
  const store = new Store(dir);
  const project = store.projects[0].id;
  const otherProject = { ...structuredClone(store.projects[0]), id: 'other-project' };
  store.projects.push(otherProject);
  store.save();
  const browser = new NoRemoteBrowser();
  const platform = new PlatformStore(dir);
  const queue = offlineQueue(dir);
  const seed = async (id: string) => {
    platform.putOperation(`key-${id}`, { projectId: id, hash: id, state: 'unknown' });
    platform.putPreparation({ id: `preparation-${id}`, projectId: id, connectionId: `connection-${id}`,
      providerId: 'tomato', accountId: 'offline-account', accountName: 'Fixture', linkId: `link-${id}`,
      remoteWorkId: 'offline-work', workTitle: 'Offline fixture', snapshot, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(), warning: 'offline' });
    return queue.preview({ target: target(id), action: 'save_draft', chapters: [snapshot] });
  };
  const targetBatch = await seed(project);
  const otherBatch = await seed(otherProject.id);
  const runtime = new PlatformRuntime(store, { browser });
  const server = express();
  server.use(express.json());
  const listener = server.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  process.env.PORT = String(port);
  server.use('/api', createPlatformRouter(store, runtime));
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await runtime.close();
    if (priorPort === undefined) delete process.env.PORT;
    else process.env.PORT = priorPort;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = (id: string, body: unknown, csrf = runtime.csrfToken) => fetch(
    `http://127.0.0.1:${port}/api/projects/${id}/platform-staging/clear`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': csrf }, body: JSON.stringify(body) },
  );
  const platformFile = path.join(dir, 'platform-connections.json');
  const queueFile = path.join(dir, 'publication-queue.json');
  const platformBefore = fs.readFileSync(platformFile, 'utf8');
  const queueBefore = fs.readFileSync(queueFile, 'utf8');
  for (const [body, csrf, expectedStatus, expectedCode] of [
    [{ confirmed: true, acknowledgeDuplicateRisk: true }, '', 403, 'PLATFORM_CSRF_REQUIRED'],
    [{ confirmed: true }, runtime.csrfToken, 400, 'PLATFORM_VALIDATION_ERROR'],
    [{ acknowledgeDuplicateRisk: true }, runtime.csrfToken, 400, 'PLATFORM_VALIDATION_ERROR'],
    [{ confirmed: false, acknowledgeDuplicateRisk: true }, runtime.csrfToken, 400, 'PLATFORM_VALIDATION_ERROR'],
    [{ confirmed: true, acknowledgeDuplicateRisk: false }, runtime.csrfToken, 400, 'PLATFORM_VALIDATION_ERROR'],
  ] as const) {
    const response = await request(project, body, csrf);
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).code, expectedCode);
    assert.equal(fs.readFileSync(platformFile, 'utf8'), platformBefore);
    assert.equal(fs.readFileSync(queueFile, 'utf8'), queueBefore);
  }
  const response = await request(project, { confirmed: true, acknowledgeDuplicateRisk: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cleared: true });
  assert.equal(runtime.platforms.operation(`key-${project}`), undefined);
  assert.equal(runtime.platforms.preparation(project, `preparation-${project}`), undefined);
  assert.equal(runtime.publications.list(project).length, 0);
  assert.equal(runtime.platforms.operation(`key-${otherProject.id}`)?.state, 'unknown');
  assert.ok(runtime.platforms.preparation(otherProject.id, `preparation-${otherProject.id}`));
  assert.equal(runtime.publications.get(otherBatch.id).id, otherBatch.id);
  assert.equal(browser.writes, 0);
  assert.ok(JSON.parse(fs.readFileSync(queueFile, 'utf8')).batches.every((batch: { id: string }) => batch.id !== targetBatch.id));
  const backups = fs.readdirSync(dir);
  for (const file of [platformFile, queueFile]) {
    const prefix = path.basename(file) + '.staging-';
    const backup = backups.find(name => name.startsWith(prefix) && name.endsWith('.bak'));
    assert.ok(backup, `missing staging backup for ${prefix}`);
    assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), file === platformFile ? platformBefore : queueBefore);
  }
  const reopened = new PlatformRuntime(new Store(dir), { browser: new NoRemoteBrowser() });
  try {
    assert.equal(reopened.platforms.operation(`key-${project}`), undefined);
    assert.equal(reopened.platforms.operation(`key-${otherProject.id}`)?.state, 'unknown');
    assert.equal(reopened.publications.list(project).length, 0);
    assert.equal(reopened.publications.get(otherBatch.id).id, otherBatch.id);
  } finally { await reopened.close(); }
});

test('staging clear HTTP refuses active target draft operation without touching either store or remote browser', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-staging-active-'));
  const priorPort = process.env.PORT;
  const store = new Store(dir);
  const project = store.projects[0].id;
  const browser = new NoRemoteBrowser();
  const platform = new PlatformStore(dir);
  platform.putOperation('active-fixture', { projectId: project, hash: 'fixture', state: 'unknown' });
  const queue = offlineQueue(dir);
  const batch = await queue.preview({ target: target(project), action: 'save_draft', chapters: [snapshot] });
  const platformFile = path.join(dir, 'platform-connections.json');
  const queueFile = path.join(dir, 'publication-queue.json');
  const runtime = new PlatformRuntime(store, { browser });
  const app = express();
  app.use(express.json());
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  process.env.PORT = String(port);
  app.use('/api', createPlatformRouter(store, runtime));
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await runtime.close();
    if (priorPort === undefined) delete process.env.PORT;
    else process.env.PORT = priorPort;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  runtime.platforms.putDraftOperation({ id: 'queued-draft', projectId: project, connectionId: 'offline-connection',
    providerId: 'tomato', accountId: 'offline-account', remoteWorkId: 'offline-work', chapterId: snapshot.chapterId,
    chapterNumber: snapshot.number, revision: snapshot.revision, contentHash: snapshot.contentHash,
    title: snapshot.title, state: 'queued', mutationStarted: false, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), snapshot, businessKey: 'offline-business',
    preparationId: 'offline-preparation', requestKeys: [] });
  const before = [fs.readFileSync(platformFile, 'utf8'), fs.readFileSync(queueFile, 'utf8')];
  const response = await fetch(`http://127.0.0.1:${port}/api/projects/${project}/platform-staging/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': runtime.csrfToken },
    body: JSON.stringify({ confirmed: true, acknowledgeDuplicateRisk: true }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PLATFORM_BUSY');
  assert.deepEqual([fs.readFileSync(platformFile, 'utf8'), fs.readFileSync(queueFile, 'utf8')], before);
  assert.equal(runtime.publications.get(batch.id).state, 'preview');
  assert.equal(browser.writes, 0);
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('.staging-')).length, 0);
});
