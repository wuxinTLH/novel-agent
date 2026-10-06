import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Store } from './store.js';
import { SecretStore } from './secrets.js';
import { PlatformStore } from './platform-store.js';
import { PlatformRuntime } from './platform-runtime.js';
import { createPlatformRouter } from './platform-routes.js';
import { allowedFanqieNavigation, FanqieBrowser } from './fanqie-browser.js';
import {
  PlatformError,
  type BrowserSessionState,
  type DraftBrowserAdapter,
  type VerifiedDraft,
} from './platforms-types.js';
import type { DraftSnapshot, PlatformWork } from '../shared/platforms.js';

/** Offline fixture only. Never launches Chromium, reads an account, or contacts a platform. */
class FixtureBrowser implements DraftBrowserAdapter {
  readonly readiness = 'ready' as const;
  readonly reason = 'OFFLINE TEST ONLY: injected fixture, not live verification';
  accountId = 'fixture-account';
  accountName = 'Offline fixture author';
  expired = false;
  badReadback = false;
  failAfterSave = false;
  failBeforeWrite = false;
  delay?: Promise<void>;
  created = 0;
  reads = 0;
  starts = 0;
  logins = new Set<string>();
  drafts = new Map<string, VerifiedDraft>();
  beforeCreate?: () => void;
  works: PlatformWork[] = [
    {
      id: 'fixture-work',
      providerId: 'tomato',
      title: 'Fixture work',
      description: '',
      genre: '',
      revision: '1',
      chapterCount: 0,
      updatedAt: '',
    },
  ];
  async startLogin(id: string) {
    this.starts++;
    this.logins.add(id);
  }
  loginOpen(id: string) {
    return this.logins.has(id);
  }
  async completeLogin(_id: string) {
    return {
      account: { accountId: this.accountId, accountName: this.accountName },
      state: { cookies: [{ name: 'fixture', value: 'TEST_COOKIE_NEVER_LOG' }], origins: [] },
    };
  }
  async closeLogin(id: string) {
    this.logins.delete(id);
  }
  async verifyAccount(_id: string, _state: BrowserSessionState) {
    if (this.expired) throw new PlatformError(401, 'PLATFORM_REAUTH_REQUIRED', '测试会话过期。');
    return { accountId: this.accountId, accountName: this.accountName };
  }
  async listWorks(_id: string, _state: BrowserSessionState) {
    if (this.failBeforeWrite) throw new PlatformError(502, 'PLATFORM_DOM_MISMATCH', '测试作品页不匹配。');
    return structuredClone(this.works);
  }
  async createDraft(
    _connectionId: string,
    _state: BrowserSessionState,
    accountId: string,
    workId: string,
    snapshot: DraftSnapshot,
    onIdentified: (id: string) => void,
  ) {
    this.beforeCreate?.();
    if (this.delay) await this.delay;
    const id = `fixture-draft-${++this.created}`;
    this.drafts.set(id, {
      id,
      workId,
      accountId,
      title: snapshot.title,
      content: snapshot.content,
      paragraphs: snapshot.paragraphs,
    });
    if (this.failAfterSave) throw new Error('PRIVATE_FAKE_URL_TOKEN must not leak');
    onIdentified(id);
    return { draftId: id };
  }
  async readDraft(_connectionId: string, _state: BrowserSessionState, _workId: string, draftId: string) {
    this.reads++;
    const draft = structuredClone(this.drafts.get(draftId)!);
    if (this.badReadback) draft.paragraphs = ['changed paragraph'];
    return draft;
  }
  async findDrafts(
    _connectionId: string,
    _state: BrowserSessionState,
    _accountId: string,
    _workId: string,
    _snapshot: DraftSnapshot,
  ) {
    return structuredClone([...this.drafts.values()]);
  }
  async closeConnection(_id: string) {}
  async close() {
    this.logins.clear();
  }
}
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novel-platform-test-'));
const restoreEnv = (key: string, previous: string | undefined) => {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
};
const expectCode = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;
async function connectedFixture(dir: string, browser = new FixtureBrowser()) {
  const store = new Store(dir),
    runtime = new PlatformRuntime(store, { browser });
  const project = store.projects[0];
  project.chapters.push({
    id: 'fixture-chapter',
    number: 1,
    revision: 1,
    title: '第一章 原样标题',
    content: '第一段\n\n第二段。',
    mode: 'demo',
    updatedAt: new Date().toISOString(),
  });
  const login = await runtime.startLogin(project.id);
  const connection = await runtime.completeLogin(project.id, login.id);
  const link = {
    id: 'fixture-link',
    projectId: project.id,
    connectionId: connection.id,
    providerId: 'tomato' as const,
    accountId: connection.accountId,
    remoteWorkId: 'fixture-work',
    title: 'Fixture work',
    revision: '1',
    lastSyncedAt: '',
  };
  runtime.platforms.putLink(link);
  return { store, project, runtime, connection, link, browser };
}

test('encrypted browser credentials survive restart, wrong key preserves bytes, missing key is memory only', () => {
  const dir = temporary(),
    previous = process.env.PLATFORM_SECRETS_KEY;
  try {
    process.env.PLATFORM_SECRETS_KEY = 'offline-test-key';
    const secrets = new SecretStore(dir);
    secrets.set('credential', JSON.stringify({ cookies: [{ value: 'PRIVATE_TEST_TOKEN' }], origins: [] }));
    const file = path.join(dir, 'platform-secrets.enc'),
      original = fs.readFileSync(file, 'utf8');
    assert.ok(!original.includes('PRIVATE_TEST_TOKEN'));
    assert.ok(new SecretStore(dir).get('credential')?.includes('PRIVATE_TEST_TOKEN'));
    process.env.PLATFORM_SECRETS_KEY = 'wrong-key';
    assert.throws(() => new SecretStore(dir), /无法解密/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    delete process.env.PLATFORM_SECRETS_KEY;
    new SecretStore(dir).set('temporary', 'TEMP_TOKEN');
    assert.equal(new SecretStore(dir).get('temporary'), undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    restoreEnv('PLATFORM_SECRETS_KEY', previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v1 tomato impersonation is quarantined with original archives; pending generic operations stay unknown', () => {
  const dir = temporary();
  try {
    const connection = (id: string, providerId: string) => ({
      id,
      projectId: 'p',
      providerId,
      accountName: 'old',
      credentialRef: `${id}-secret`,
      createdAt: '',
    });
    const work = (id: string, providerId: string) => ({
      id,
      providerId,
      title: 'old',
      description: '',
      genre: '',
      revision: '1',
      chapterCount: 0,
      updatedAt: '',
    });
    const old = {
      version: 1,
      connections: [connection('fake-tomato', 'tomato'), connection('mock', 'mock')],
      links: [
        {
          id: 'old-link',
          projectId: 'p',
          providerId: 'tomato',
          connectionId: 'fake-tomato',
          remoteWorkId: 'fake-id',
          title: 'old',
          revision: '1',
          lastSyncedAt: '',
        },
      ],
      mockWorks: { 'fake-tomato': [work('fake-id', 'tomato')], mock: [work('mock-id', 'mock')] },
      chapters: { 'fake-id': [{ id: 'fake-chapter', content: 'legacy body', publishedAt: 'never real' }] },
      operations: { old: { hash: 'old', state: 'pending' } },
    };
    const file = path.join(dir, 'platform-connections.json'),
      source = JSON.stringify(old);
    fs.writeFileSync(file, source);
    const store = new PlatformStore(dir);
    assert.equal(store.legacyArchived, true);
    assert.equal(store.connections('p').length, 1);
    assert.equal(store.connection('p', 'fake-tomato'), undefined);
    assert.deepEqual(store.links('p'), []);
    assert.deepEqual(store.works('fake-tomato'), []);
    assert.equal(store.operation('old'), undefined);
    assert.equal(fs.readFileSync(file + '.v1.bak', 'utf8'), source);
    assert.ok(fs.readFileSync(file, 'utf8').includes('legacy body'));
    const migrated = fs.readFileSync(file, 'utf8');
    new PlatformStore(dir);
    assert.equal(fs.readFileSync(file, 'utf8'), migrated);
    store.putOperation('pending', { hash: 'x', state: 'pending' });
    assert.equal(new PlatformStore(dir).operation('pending')?.state, 'unknown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production browser is lazy and honestly gated; navigation does not accept arbitrary hosts', async () => {
  const browser = new FanqieBrowser();
  assert.equal(browser.readiness, 'ready');
  assert.equal(browser.loginOpen('never-started'), false);
  assert.ok(allowedFanqieNavigation('https://fanqienovel.com/main/writer/'));
  for (const url of [
    'http://fanqienovel.com/',
    'https://fanqienovel.com.evil.test/',
    'https://user:pass@fanqienovel.com/',
    'https://fanqienovel.com:444/',
    'https://localhost/',
    'file:///tmp/a',
  ])
    assert.equal(allowedFanqieNavigation(url), false);
  await assert.rejects(
    browser.verifyAccount('a', { cookies: [], origins: [] }),
    expectCode('PLATFORM_DOM_VERIFICATION_REQUIRED'),
  );
  await browser.close();
});

test('approved single snapshot writes durable intent, reopens exact draft, deduplicates across request keys', async () => {
  const dir = temporary(),
    oldKey = process.env.PLATFORM_SECRETS_KEY;
  delete process.env.PLATFORM_SECRETS_KEY;
  const fixture = await connectedFixture(dir);
  try {
    const { runtime, project, browser, link } = fixture;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    assert.equal(browser.created, 0);
    browser.beforeCreate = () => {
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'platform-connections.json'), 'utf8'));
      assert.equal(persisted.draftOperations[0].mutationStarted, true);
      assert.equal(persisted.draftOperations[0].snapshot.content, preview.snapshot.content);
    };
    const result = runtime.execute(project.id, preview.id, preview.snapshot.contentHash, 'same-request-key');
    assert.equal(result.state, 'queued');
    assert.equal(
      runtime.execute(project.id, preview.id, preview.snapshot.contentHash, 'same-request-key').id,
      result.id,
    );
    await runtime.waitForIdle();
    assert.equal(browser.created, 1);
    assert.equal(browser.reads, 1);
    assert.equal(runtime.platforms.draftOperation(project.id, result.id)?.state, 'verified');
    assert.equal(runtime.platforms.receipts(project.id).length, 1);
    const again = runtime.execute(
      project.id,
      preview.id,
      preview.snapshot.contentHash,
      'different-request-key',
    );
    assert.equal(again.id, result.id);
    assert.equal(browser.created, 1);
    assert.equal('publishedAt' in project.chapters[0], false);
    const body = fs.readFileSync(path.join(dir, 'platform-connections.json'), 'utf8');
    assert.ok(!body.includes('TEST_COOKIE_NEVER_LOG'));
    project.chapters[0].revision++;
    project.chapters[0].content += '\n变化';
    await assert.rejects(
      runtime.prepare(project.id, link.id, 'fixture-chapter'),
      expectCode('PLATFORM_DRAFT_UPDATE_BLOCKED'),
    );
  } finally {
    await fixture.runtime.close();
    restoreEnv('PLATFORM_SECRETS_KEY', oldKey);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timeout after remote save becomes unknown, never blind resend, read-only reconciliation verifies', async () => {
  const dir = temporary(),
    fixture = await connectedFixture(dir);
  try {
    const { runtime, project, browser, link } = fixture;
    browser.failAfterSave = true;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    const op = runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID());
    await runtime.waitForIdle();
    const unknown = runtime.platforms.draftOperation(project.id, op.id)!;
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.remoteDraftId, undefined);
    assert.ok(!unknown.error?.includes('PRIVATE_FAKE_URL_TOKEN'));
    assert.equal(
      runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID()).state,
      'unknown',
    );
    assert.equal(browser.created, 1);
    await assert.rejects(runtime.removeProject(project.id), expectCode('PLATFORM_OPERATION_UNKNOWN'));
    assert.equal((await runtime.reconcile(project.id, op.id)).state, 'verified');
    assert.equal(browser.created, 1);
    assert.equal(browser.reads, 1);
  } finally {
    await fixture.runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readback paragraph mismatch remains unknown and does not produce a receipt', async () => {
  const dir = temporary(),
    fixture = await connectedFixture(dir);
  try {
    const { runtime, project, browser, link } = fixture;
    browser.badReadback = true;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    const op = runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID());
    await runtime.waitForIdle();
    assert.equal(runtime.platforms.draftOperation(project.id, op.id)?.state, 'unknown');
    assert.equal(runtime.platforms.receipts(project.id).length, 0);
    await assert.rejects(
      runtime.reconcile(project.id, op.id),
      expectCode('PLATFORM_DRAFT_VERIFICATION_FAILED'),
    );
    assert.equal(browser.created, 1);
  } finally {
    await fixture.runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('requirements, modified preview and identity mismatch fail before mutation; missing credentials allow reauth', async () => {
  const dir = temporary(),
    oldKey = process.env.PLATFORM_SECRETS_KEY;
  delete process.env.PLATFORM_SECRETS_KEY;
  const fixture = await connectedFixture(dir);
  try {
    const { runtime, project, browser, link, connection } = fixture;
    project.requirements = { instructions: '', requiredText: ['必须原文'], forbiddenText: [] };
    await assert.rejects(
      runtime.prepare(project.id, link.id, 'fixture-chapter'),
      expectCode('CHAPTER_REQUIREMENTS_FAILED'),
    );
    project.requirements = { instructions: '', requiredText: [], forbiddenText: [] };
    let preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    project.chapters[0].revision++;
    assert.throws(
      () => runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID()),
      expectCode('PLATFORM_PREVIEW_CHANGED'),
    );
    preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    project.requirements.requiredText = ['新要求'];
    assert.throws(
      () => runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID()),
      expectCode('CHAPTER_REQUIREMENTS_FAILED'),
    );
    project.requirements.requiredText = [];
    browser.accountId = 'other-account';
    await assert.rejects(
      runtime.prepare(project.id, link.id, 'fixture-chapter'),
      expectCode('PLATFORM_ACCOUNT_MISMATCH'),
    );
    assert.equal(
      runtime.publicConnection(runtime.connection(project.id, connection.id)).status,
      'needs_reauth',
    );
    assert.equal(browser.created, 0);
    browser.accountId = 'fixture-account';
    const login = await runtime.startLogin(project.id, connection.id);
    const restored = await runtime.completeLogin(project.id, login.id);
    assert.equal(restored.id, connection.id);
    assert.equal(restored.status, 'connected');
    runtime.secrets.delete(runtime.connection(project.id, connection.id).credentialRef);
    assert.equal(
      runtime.publicConnection(runtime.connection(project.id, connection.id)).hasCredential,
      false,
    );
    const missing = await runtime.startLogin(project.id, connection.id);
    assert.equal((await runtime.completeLogin(project.id, missing.id)).status, 'connected');
  } finally {
    await fixture.runtime.close();
    restoreEnv('PLATFORM_SECRETS_KEY', oldKey);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saved credentials recover; durable interrupted tasks become unknown without automatic browser activity', async () => {
  const dir = temporary(),
    previous = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = 'offline-persistent-state';
  const fixture = await connectedFixture(dir);
  let restarted: PlatformRuntime | undefined;
  try {
    const { runtime, project, browser, link, store, connection } = fixture;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    browser.failAfterSave = true;
    const op = runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID());
    await runtime.waitForIdle();
    const record = runtime.platforms.draftOperation(project.id, op.id)!;
    runtime.platforms.putDraftOperation({ ...record, state: 'running' });
    await runtime.close();
    const restartedBrowser = new FixtureBrowser();
    restartedBrowser.drafts = browser.drafts;
    restarted = new PlatformRuntime(store, { browser: restartedBrowser });
    assert.equal(restartedBrowser.starts, 0);
    assert.equal(restartedBrowser.created, 0);
    assert.equal(restartedBrowser.reads, 0);
    assert.equal(
      restarted.publicConnection(restarted.connection(project.id, connection.id)).hasCredential,
      true,
    );
    assert.equal(restarted.platforms.draftOperation(project.id, op.id)?.state, 'unknown');
    assert.equal((await restarted.reconcile(project.id, op.id)).state, 'verified');
    assert.equal(restartedBrowser.created, 0);
  } finally {
    await restarted?.close();
    await fixture.runtime.close();
    restoreEnv('PLATFORM_SECRETS_KEY', previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project and shared-account locks prevent concurrent mutation without losing a task', async () => {
  const dir = temporary(),
    fixture = await connectedFixture(dir);
  let unblock!: () => void;
  fixture.browser.delay = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  try {
    const { runtime, project, browser, link, connection } = fixture;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID());
    assert.throws(() => runtime.assertProjectIdle(project.id), expectCode('PLATFORM_BUSY'));
    await assert.rejects(
      runtime.withLock(project.id, runtime.connection(project.id, connection.id), async () => {}),
      expectCode('PLATFORM_BUSY'),
    );
    const second = structuredClone(project);
    second.id = 'other-project';
    fixture.store.projects.push(second);
    const otherRecord = {
      ...runtime.connection(project.id, connection.id),
      id: 'other-connection',
      projectId: second.id,
    };
    runtime.platforms.putConnection(otherRecord);
    await assert.rejects(
      runtime.withLock(second.id, otherRecord, async () => {}),
      expectCode('PLATFORM_BUSY'),
    );
    unblock();
    await runtime.waitForIdle();
    assert.equal(runtime.isProjectBusy(project.id), false);
    assert.equal(browser.created, 1);
  } finally {
    unblock();
    await fixture.runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session expiry and read-only DOM failure block writes; only a fresh preview can retry a known prewrite failure', async () => {
  const dir = temporary(),
    fixture = await connectedFixture(dir);
  try {
    const { runtime, project, browser, link, connection } = fixture;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    browser.expired = true;
    const failed = runtime.execute(
      project.id,
      preview.id,
      preview.snapshot.contentHash,
      'expired-session-request',
    );
    await runtime.waitForIdle();
    assert.equal(runtime.platforms.draftOperation(project.id, failed.id)?.state, 'failed');
    assert.equal(runtime.platforms.draftOperation(project.id, failed.id)?.mutationStarted, false);
    assert.equal(browser.created, 0);
    assert.equal(
      runtime.execute(project.id, preview.id, preview.snapshot.contentHash, 'expired-session-request').id,
      failed.id,
    );
    browser.expired = false;
    const login = await runtime.startLogin(project.id, connection.id);
    await runtime.completeLogin(project.id, login.id);
    browser.failBeforeWrite = true;
    await assert.rejects(
      runtime.prepare(project.id, link.id, 'fixture-chapter'),
      expectCode('PLATFORM_DOM_MISMATCH'),
    );
    browser.failBeforeWrite = false;
    const fresh = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    const retried = runtime.execute(project.id, fresh.id, fresh.snapshot.contentHash, randomUUID());
    assert.notEqual(retried.id, failed.id);
    await runtime.waitForIdle();
    assert.equal(runtime.platforms.draftOperation(project.id, retried.id)?.state, 'verified');
    assert.equal(browser.created, 1);
  } finally {
    await fixture.runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous reconciliation never creates a draft or marks a receipt verified', async () => {
  const dir = temporary(),
    fixture = await connectedFixture(dir);
  try {
    const { runtime, project, browser, link } = fixture;
    browser.failAfterSave = true;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    const op = runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID());
    await runtime.waitForIdle();
    const saved = structuredClone([...browser.drafts.values()][0]);
    browser.drafts.clear();
    await assert.rejects(runtime.reconcile(project.id, op.id), expectCode('PLATFORM_OPERATION_UNKNOWN'));
    browser.drafts.set(saved.id, saved);
    browser.drafts.set('fixture-duplicate', { ...saved, id: 'fixture-duplicate' });
    await assert.rejects(runtime.reconcile(project.id, op.id), expectCode('PLATFORM_OPERATION_UNKNOWN'));
    assert.equal(browser.created, 1);
    assert.equal(runtime.platforms.receipts(project.id).length, 0);
  } finally {
    await fixture.runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('durable intent disk failure prevents editor entry and releases task locks', async () => {
  const dir = temporary(),
    fixture = await connectedFixture(dir);
  try {
    const { runtime, project, browser, link } = fixture;
    const preview = await runtime.prepare(project.id, link.id, 'fixture-chapter');
    const persist = runtime.platforms.putDraftOperation.bind(runtime.platforms);
    runtime.platforms.putDraftOperation = () => {
      throw new Error('offline disk failure');
    };
    assert.throws(
      () => runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID()),
      /offline disk failure/,
    );
    assert.equal(runtime.isProjectBusy(project.id), false);
    assert.equal(browser.created, 0);
    runtime.platforms.putDraftOperation = persist;
    const operation = runtime.execute(project.id, preview.id, preview.snapshot.contentHash, randomUUID());
    await runtime.waitForIdle();
    assert.equal(runtime.platforms.draftOperation(project.id, operation.id)?.state, 'verified');
  } finally {
    await fixture.runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed platform store is not rewritten and shared local session remains available in degraded mode', async () => {
  const dir = temporary(),
    oldPort = process.env.PORT;
  const store = new Store(dir);
  const file = path.join(dir, 'platform-connections.json');
  fs.writeFileSync(file, '{malformed preserve me');
  const runtime = new PlatformRuntime(store);
  const app = express();
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  process.env.PORT = String(port);
  app.use('/api', createPlatformRouter(store, runtime));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/platforms/session`);
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.available, false);
    assert.equal(session.csrfToken, runtime.csrfToken);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/projects/${store.projects[0].id}/platform-connections`))
        .status,
      503,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), '{malformed preserve me');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
    restoreEnv('PORT', oldPort);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('platform HTTP guards, mock isolation, disabled publication, strict single draft approval and local status', async () => {
  const dir = temporary(),
    oldPort = process.env.PORT;
  const fixture = await connectedFixture(dir),
    { runtime, project, browser, link } = fixture;
  const app = express();
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  process.env.PORT = String(port);
  app.use('/api', createPlatformRouter(fixture.store, runtime));
  const root = `http://127.0.0.1:${port}/api`,
    base = `/projects/${project.id}`;
  const request = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(root + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Platform-CSRF': runtime.csrfToken,
        'Idempotency-Key': randomUUID(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await request('/platforms/session', 'GET', undefined, { Origin: 'http://evil.test' })).status,
      403,
    );
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(
        root + '/platforms/session',
        { headers: { Host: 'evil.test' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal(
      (await request(`${base}/platform-publications`, 'POST', {}, { 'X-Platform-CSRF': '' })).status,
      403,
    );
    assert.equal((await request(`${base}/platform-publications`, 'POST', {})).status, 410);
    assert.equal(
      (await request(`${base}/platform-connections/tomato/token`, 'POST', { token: 'fake' })).status,
      501,
    );
    assert.equal(
      (
        await request(`${base}/platform-works`, 'POST', {
          connectionId: fixture.connection.id,
          title: 'fake',
        })
      ).status,
      501,
    );
    const providers = await (await request('/platforms/providers')).json();
    assert.ok(
      providers.every(
        (item: { capabilities: { publishChapter: boolean } }) => !item.capabilities.publishChapter,
      ),
    );
    const connectResponse = await request(`${base}/platform-connections/mock/token`, 'POST', {
      token: 'PRIVATE_MOCK_TEST_TOKEN',
    });
    assert.equal(connectResponse.status, 201);
    const mock = await connectResponse.json();
    assert.equal(mock.credentialRef, undefined);
    assert.equal(mock.hasCredential, true);
    const workResponse = await request(`${base}/platform-works`, 'POST', {
      connectionId: mock.id,
      title: 'Mock only',
    });
    assert.equal(workResponse.status, 201);
    const work = await workResponse.json();
    assert.equal(work.providerId, 'mock');
    assert.equal(
      (await request(`${base}/platform-links`, 'POST', { connectionId: mock.id, remoteWorkId: work.id }))
        .status,
      201,
    );
    const previewResponse = await request(`${base}/platform-drafts/prepare`, 'POST', {
      linkId: link.id,
      chapterId: 'fixture-chapter',
    });
    assert.equal(previewResponse.status, 201);
    const preview = await previewResponse.json();
    assert.equal(
      (
        await request(`${base}/platform-drafts/execute`, 'POST', {
          preparationId: preview.id,
          contentHash: preview.snapshot.contentHash,
          approved: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `${base}/platform-drafts/execute`,
          'POST',
          { preparationId: preview.id, contentHash: preview.snapshot.contentHash, approved: true },
          { 'Idempotency-Key': '' },
        )
      ).status,
      400,
    );
    const execute = await request(`${base}/platform-drafts/execute`, 'POST', {
      preparationId: preview.id,
      contentHash: preview.snapshot.contentHash,
      approved: true,
    });
    assert.equal(execute.status, 202);
    await runtime.waitForIdle();
    const operations = await (await request(`${base}/platform-operations`)).json();
    assert.equal(operations[0].state, 'verified');
    assert.equal(operations[0].snapshot, undefined);
    assert.equal((await (await request(`${base}/platform-draft-receipts`)).json()).length, 1);
    assert.equal(browser.created, 1);
    assert.ok(
      !fs
        .readFileSync(path.join(dir, 'platform-connections.json'), 'utf8')
        .includes('PRIVATE_MOCK_TEST_TOKEN'),
    );
    project.run = { id: 'run', status: 'running', mode: 'demo', startedAt: '' };
    assert.equal(
      (
        await request(`${base}/platform-drafts/prepare`, 'POST', {
          linkId: link.id,
          chapterId: 'fixture-chapter',
        })
      ).status,
      409,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
    restoreEnv('PORT', oldPort);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
