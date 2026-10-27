import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../projects/store.js';
import { PlatformRuntime } from './platform-runtime.js';
import { FanqieBrowser } from './fanqie-browser.js';
import { PlatformError, type BrowserSessionState, type DraftBrowserAdapter } from './platforms-types.js';

// Offline only: fake cookies, temporary encrypted storage, no browser launch or network.
const snapshot = (value: string): BrowserSessionState => ({
  cookies: [{ name: 'offline-session', value }],
  origins: [{ origin: 'https://fanqienovel.com', localStorage: [{ name: 'offline', value }] }],
});
function fixtureBrowser() {
  let state = snapshot('initial');
  let captured: BrowserSessionState | undefined;
  let accountId = 'offline-author';
  const closed: string[] = [];
  const logins = new Set<string>();
  const browser: DraftBrowserAdapter = {
    readiness: 'ready',
    reason: 'Offline session fixture',
    async startLogin(id) {
      logins.add(id);
    },
    loginOpen: (id) => logins.has(id),
    async completeLogin() {
      return { account: { accountId, accountName: 'Offline author' }, state };
    },
    async closeLogin(id) {
      logins.delete(id);
    },
    async verifyAccount(_id, input) {
      captured = input;
      return { accountId, accountName: 'Offline author' };
    },
    async sessionState() {
      return state;
    },
    async listWorks() {
      state = snapshot('after-works');
      return [];
    },
    async createDraft() {
      throw new Error('not used');
    },
    async readDraft() {
      throw new Error('not used');
    },
    async findDrafts() {
      return [];
    },
    async deleteDraft() {},
    async closeConnection(id) {
      closed.push(id);
    },
    async close() {},
  };
  return {
    browser,
    closed,
    rotate: (value: string) => {
      state = snapshot(value);
    },
    switchAccount: () => {
      accountId = 'different-author';
    },
    captured: () => captured,
  };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-session-regression-'));
  const fixture = fixtureBrowser();
  const runtime = new PlatformRuntime(new Store(dir), { browser: fixture.browser });
  const projectId = runtime.store.projects[0].id;
  const login = await runtime.startLogin(projectId);
  const connection = await runtime.completeLogin(projectId, login.id);
  const record = runtime.connection(projectId, connection.id);
  return { dir, fixture, runtime, projectId, record };
}

test('browser-managed cookie and localStorage rotation persists encrypted across restart', async () => {
  const previousKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = 'offline-session-test-key';
  const f = await setup();
  let restarted: PlatformRuntime | undefined;
  try {
    f.fixture.rotate('rotated-cookie');
    await f.runtime.testConnection(f.record);
    assert.deepEqual(
      JSON.parse(f.runtime.secrets.get(f.record.credentialRef)!).state,
      snapshot('rotated-cookie'),
    );
    await f.runtime.listWorks(f.record);
    assert.deepEqual(
      JSON.parse(f.runtime.secrets.get(f.record.credentialRef)!).state,
      snapshot('after-works'),
    );
    const disk = fs.readFileSync(path.join(f.dir, 'platform-secrets.enc'), 'utf8');
    assert.ok(!disk.includes('after-works'));
    await f.runtime.close();
    restarted = new PlatformRuntime(new Store(f.dir), { browser: f.fixture.browser });
    await restarted.testConnection(restarted.connection(f.projectId, f.record.id));
    assert.deepEqual(f.fixture.captured(), snapshot('after-works'));
  } finally {
    await restarted?.close();
    await f.runtime.close();
    if (previousKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = previousKey;
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('account mismatch never persists replacement cookies and requires reauthentication', async () => {
  const f = await setup();
  try {
    const original = f.runtime.secrets.get(f.record.credentialRef);
    f.fixture.rotate('wrong-account-cookie');
    f.fixture.switchAccount();
    await assert.rejects(
      f.runtime.testConnection(f.record),
      (error: unknown) => error instanceof PlatformError && error.code === 'PLATFORM_ACCOUNT_MISMATCH',
    );
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, true);
    assert.ok(f.fixture.closed.includes(f.record.id));
    await f.runtime.persistBrowserSession(f.record);
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
  } finally {
    await f.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('same-account relogin closes stale connection context and old operations cannot overwrite it', async () => {
  const f = await setup();
  try {
    await f.runtime.testConnection(f.record);
    f.fixture.rotate('relogin-cookie');
    const login = await f.runtime.startLogin(f.projectId, f.record.id);
    await f.runtime.completeLogin(f.projectId, login.id);
    const current = f.runtime.connection(f.projectId, f.record.id);
    assert.ok(f.fixture.closed.includes(f.record.id));
    assert.notEqual(current.credentialRef, f.record.credentialRef);
    assert.equal(f.runtime.secrets.has(f.record.credentialRef), false);
    f.fixture.rotate('stale-operation-cookie');
    await f.runtime.persistBrowserSession(f.record);
    assert.deepEqual(
      JSON.parse(f.runtime.secrets.get(current.credentialRef)!).state,
      snapshot('relogin-cookie'),
    );
  } finally {
    await f.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('snapshot failure preserves prior credential instead of replacing it', async () => {
  const f = await setup();
  try {
    const original = f.runtime.secrets.get(f.record.credentialRef);
    f.fixture.browser.sessionState = async () => {
      throw new Error('offline capture failed');
    };
    await assert.rejects(f.runtime.testConnection(f.record), /offline capture failed/);
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, false);
  } finally {
    await f.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('idle verified contexts do not block manual relogin, but another login does', async () => {
  const { chromium } = await import('playwright');
  const originalLaunch = chromium.launch;
  let launches = 0;
  chromium.launch = async () => {
    launches++;
    throw new Error('offline launch stub');
  };
  const browser = new FanqieBrowser();
  const sessions = (browser as unknown as { sessions: Map<string, { pages?: Set<unknown> }> }).sessions;
  try {
    sessions.set('idle-connection', {});
    await assert.rejects(
      browser.startLogin('offline-login'),
      (error: unknown) => error instanceof PlatformError && error.code === 'PLATFORM_BROWSER_UNAVAILABLE',
    );
    assert.equal(launches, 1, 'idle contexts must reach the stubbed launcher, not report login busy');
    sessions.set('existing-login', { pages: new Set() });
    await assert.rejects(
      browser.startLogin('another-login'),
      (error: unknown) => error instanceof PlatformError && error.code === 'PLATFORM_LOGIN_BUSY',
    );
    assert.equal(launches, 1);
  } finally {
    sessions.clear();
    chromium.launch = originalLaunch;
    await browser.close();
  }
});

test('real adapter snapshot on unknown connection does not open a browser', async () => {
  const browser = new FanqieBrowser();
  assert.equal(await browser.sessionState('offline-absent'), undefined);
  await browser.close();
});
