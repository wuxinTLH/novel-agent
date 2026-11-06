import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../projects/store.js';
import { PlatformRuntime } from './platform-runtime.js';
import { FanqieBrowser } from './fanqie-browser.js';
import { PlatformAccountLockError } from '../../core/tenancy/platform-account-lock.js';
import { PlatformError, type BrowserSessionState, type DraftBrowserAdapter } from './platforms-types.js';

test('unavailable coordinator prevents login browser entry and verified-account read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-lock-unavailable-'));
  const fixture = fixtureBrowser();
  let acquired = 0;
  const runtime = new PlatformRuntime(new Store(dir), { browser: fixture.browser, accountLocks: {
    acquire: async () => { acquired++; throw new PlatformAccountLockError('PLATFORM_LOCK_UNAVAILABLE'); },
  } });
  try {
    const projectId = runtime.store.projects[0].id;
    await assert.rejects(runtime.startLogin(projectId), { code: 'PLATFORM_LOCK_UNAVAILABLE' });
    assert.equal(acquired, 1);
    assert.equal(runtime.browser.loginOpen('any-id'), false);
    await assert.rejects(runtime.withLock(projectId, { providerId: 'tomato', accountId: 'verified-author' } as never, async () => {
      assert.fail('external work must not begin without a lease');
    }), { code: 'PLATFORM_LOCK_UNAVAILABLE' });
  } finally { await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

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

// Opt in only these tests to resident behavior; legacy fixtures still exercise close-on-login.
function residentFixtureBrowser() {
  const fixture = fixtureBrowser();
  const residents = new Set<string>();
  const closedLogins: string[] = [];
  const retained: Array<{ loginId: string; connectionId: string }> = [];
  let refreshCount = 0;
  let closeCount = 0;
  const originalCloseLogin = fixture.browser.closeLogin.bind(fixture.browser);
  const originalCloseConnection = fixture.browser.closeConnection.bind(fixture.browser);
  fixture.browser.retainLogin = async (loginId, connectionId) => {
    assert.equal(fixture.browser.loginOpen(loginId), true);
    // Transfer ownership without invoking the closeLogin operation under test.
    await originalCloseLogin(loginId);
    residents.add(connectionId);
    retained.push({ loginId, connectionId });
  };
  fixture.browser.refreshSession = async connectionId => {
    refreshCount++;
    if (!residents.has(connectionId))
      throw new PlatformError(410, 'PLATFORM_LOGIN_CLOSED', 'Offline resident window is closed');
    return (await fixture.browser.completeLogin(connectionId)).account;
  };
  fixture.browser.closeLogin = async loginId => {
    closedLogins.push(loginId);
    await originalCloseLogin(loginId);
  };
  fixture.browser.closeConnection = async connectionId => {
    residents.delete(connectionId);
    await originalCloseConnection(connectionId);
  };
  fixture.browser.close = async () => {
    closeCount++;
    residents.clear();
  };
  return { ...fixture, residents, closedLogins, retained,
    refreshCount: () => refreshCount, closeCount: () => closeCount };
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setupResident() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-resident-session-'));
  const fixture = residentFixtureBrowser();
  const runtime = new PlatformRuntime(new Store(dir), { browser: fixture.browser });
  try {
    const projectId = runtime.store.projects[0].id;
    const login = await runtime.startLogin(projectId);
    const connection = await runtime.completeLogin(projectId, login.id);
    return { dir, fixture, runtime, projectId, login, record: runtime.connection(projectId, connection.id) };
  } catch (error) {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test('completeLogin transfers the verified login to a resident without closing it', async () => {
  const f = await setupResident();
  try {
    assert.deepEqual(f.fixture.retained, [{ loginId: f.login.id, connectionId: f.record.id }]);
    assert.deepEqual(f.fixture.closedLogins, []);
    assert.equal(f.fixture.browser.loginOpen(f.login.id), false);
    assert.equal(f.fixture.residents.has(f.record.id), true);
    assert.equal(f.fixture.refreshCount(), 0);
    assert.equal(f.runtime.login(f.projectId, f.login.id).status, 'completed');
  } finally {
    await f.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('resident refresh persists rotated browser cookies and localStorage only as encrypted state', async () => {
  const previousKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = 'offline-resident-session-test-key';
  let f: Awaited<ReturnType<typeof setupResident>> | undefined;
  try {
    f = await setupResident();
    f.fixture.rotate('resident-rotated-cookie');
    await f.runtime.refreshResidentSession(f.projectId, f.record.id);
    assert.equal(f.fixture.refreshCount(), 1);
    assert.deepEqual(JSON.parse(f.runtime.secrets.get(f.record.credentialRef)!).state,
      snapshot('resident-rotated-cookie'));
    const disk = fs.readFileSync(path.join(f.dir, 'platform-secrets.enc'), 'utf8');
    assert.equal(disk.includes('resident-rotated-cookie'), false);
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, false);
    assert.equal(f.fixture.residents.has(f.record.id), true);
  } finally {
    await f?.runtime.close();
    if (f) fs.rmSync(f.dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = previousKey;
  }
});

test('resident identity mismatch preserves the prior state, marks reauthentication and closes the window', async () => {
  const f = await setupResident();
  try {
    const original = f.runtime.secrets.get(f.record.credentialRef);
    f.fixture.rotate('resident-wrong-account-cookie');
    f.fixture.switchAccount();
    await assert.rejects(f.runtime.refreshResidentSession(f.projectId, f.record.id),
      { code: 'PLATFORM_ACCOUNT_MISMATCH' });
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, true);
    assert.deepEqual(f.fixture.closed, [f.record.id]);
    assert.equal(f.fixture.residents.has(f.record.id), false);
    await f.runtime.refreshResidentSession(f.projectId, f.record.id);
    assert.equal(f.fixture.refreshCount(), 1, 'invalid identities must not enter refresh again');
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
  } finally {
    await f.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a closed resident is not reopened and requires reauthentication without replacing saved state', async () => {
  const f = await setupResident();
  try {
    const original = f.runtime.secrets.get(f.record.credentialRef);
    f.fixture.residents.delete(f.record.id);
    await assert.rejects(f.runtime.refreshResidentSession(f.projectId, f.record.id),
      { code: 'PLATFORM_LOGIN_CLOSED' });
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, true);
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
    assert.equal(f.fixture.residents.size, 0);
    assert.equal(f.fixture.retained.length, 1);
  } finally {
    await f.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('resident refresh cannot enter the browser while a cross-runtime account lease is held', async () => {
  const f = await setupResident(), other = await setup();
  const entered = deferredSignal();
  const blocked = deferredSignal();
  const work = other.runtime.withLock(other.projectId, other.record, async () => {
    entered.resolve();
    await blocked.promise;
  });
  try {
    await entered.promise;
    await assert.rejects(f.runtime.refreshResidentSession(f.projectId, f.record.id), { code: 'PLATFORM_BUSY' });
    assert.equal(f.fixture.refreshCount(), 0);
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, false);
    blocked.resolve();
    await work;
    await f.runtime.refreshResidentSession(f.projectId, f.record.id);
    assert.equal(f.fixture.refreshCount(), 1);
  } finally {
    blocked.resolve();
    await work;
    await f.runtime.close();
    await other.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
    fs.rmSync(other.dir, { recursive: true, force: true });
  }
});

test('shutdown waits for in-flight resident refresh before closing its browser', async () => {
  const f = await setupResident();
  const entered = deferredSignal();
  const blocked = deferredSignal();
  const originalRefresh = f.fixture.browser.refreshSession!;
  f.fixture.browser.refreshSession = async (id, state) => {
    entered.resolve();
    await blocked.promise;
    return originalRefresh(id, state);
  };
  const refresh = f.runtime.refreshResidentSession(f.projectId, f.record.id);
  let shutdown: Promise<void> | undefined;
  let shutdownComplete = false;
  try {
    await entered.promise;
    shutdown = f.runtime.close().then(() => { shutdownComplete = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(shutdownComplete, false);
    assert.equal(f.fixture.closeCount(), 0);
    assert.equal(f.fixture.residents.has(f.record.id), true);
    blocked.resolve();
    await refresh;
    await shutdown;
    assert.equal(f.fixture.refreshCount(), 1);
    assert.equal(f.fixture.closeCount(), 1);
    assert.equal(f.fixture.residents.size, 0);
  } finally {
    blocked.resolve();
    await refresh;
    await shutdown;
    if (!shutdown) await f.runtime.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('an open manual login survives more than fifteen minutes and can still become resident', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-manual-login-lifetime-'));
  const fixture = residentFixtureBrowser();
  const runtime = new PlatformRuntime(new Store(dir), { browser: fixture.browser });
  try {
    const projectId = runtime.store.projects[0].id;
    const login = await runtime.startLogin(projectId);
    t.mock.timers.tick(16 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runtime.login(projectId, login.id).status, 'waiting');
    assert.equal(fixture.browser.loginOpen(login.id), true);
    assert.deepEqual(fixture.closedLogins, []);
    const connection = await runtime.completeLogin(projectId, login.id);
    assert.equal(fixture.residents.has(connection.id), true);
    assert.equal(fixture.refreshCount(), 0);
  } finally {
    await runtime.close();
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manual window watcher releases its lease on close and shutdown cancels the watcher', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-login-window-watcher-'));
  const fixture = residentFixtureBrowser();
  let releases = 0;
  const runtime = new PlatformRuntime(new Store(dir), { browser: fixture.browser,
    accountLocks: { acquire: async () => () => { releases++; } } });
  try {
    const projectId = runtime.store.projects[0].id;
    const login = await runtime.startLogin(projectId);
    await fixture.browser.closeLogin(login.id);
    t.mock.timers.tick(4_999);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(releases, 0);
    t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(releases, 1, 'window observation must release the provider lease without a login request');
    assert.equal(runtime.login(projectId, login.id).status, 'closed');
    await runtime.startLogin(projectId);
    await runtime.close();
    assert.equal(releases, 2);
    const closeCalls = fixture.closedLogins.length;
    t.mock.timers.tick(60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(releases, 2);
    assert.equal(fixture.closedLogins.length, closeCalls);
  } finally {
    await runtime.close();
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduled resident refresh skips a busy account and retries on the next interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setupResident();
  const entered = deferredSignal(), blocked = deferredSignal();
  const work = f.runtime.withLock(f.projectId, f.record, async () => {
    entered.resolve();
    await blocked.promise;
  });
  try {
    await entered.promise;
    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.fixture.refreshCount(), 0);
    assert.equal(f.fixture.residents.has(f.record.id), true);
    blocked.resolve();
    await work;
    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.fixture.refreshCount(), 1);
  } finally {
    blocked.resolve();
    await work;
    await f.runtime.close();
    t.mock.timers.reset();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('transient resident refresh failure preserves state and browser for the next scheduled attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setupResident();
  const originalRefresh = f.fixture.browser.refreshSession!;
  let attempts = 0;
  f.fixture.browser.refreshSession = async (id, state) => {
    if (++attempts === 1) throw new PlatformError(502, 'PLATFORM_REQUEST_FAILED', 'Offline transient failure');
    return originalRefresh(id, state);
  };
  try {
    const original = f.runtime.secrets.get(f.record.credentialRef);
    f.fixture.rotate('resident-after-transient');
    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, false);
    assert.equal(f.fixture.residents.has(f.record.id), true);
    assert.deepEqual(f.fixture.closed, []);
    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.deepEqual(JSON.parse(f.runtime.secrets.get(f.record.credentialRef)!).state,
      snapshot('resident-after-transient'));
  } finally {
    await f.runtime.close();
    t.mock.timers.reset();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('closed-window verification invalidates a resident and cancels its refresh timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setupResident();
  f.fixture.browser.verifyAccount = async () => {
    throw new PlatformError(410, 'PLATFORM_LOGIN_CLOSED', 'Offline resident window is closed');
  };
  try {
    const original = f.runtime.secrets.get(f.record.credentialRef);
    await assert.rejects(f.runtime.testConnection(f.record), { code: 'PLATFORM_LOGIN_CLOSED' });
    assert.equal(f.runtime.connection(f.projectId, f.record.id).needsReauth, true);
    assert.equal(f.runtime.secrets.get(f.record.credentialRef), original);
    assert.deepEqual(f.fixture.closed, [f.record.id]);
    t.mock.timers.tick(10 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.fixture.refreshCount(), 0);
  } finally {
    await f.runtime.close();
    t.mock.timers.reset();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('resident refresh runs every five minutes and shutdown cancels the next scheduled refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setupResident();
  try {
    t.mock.timers.tick(5 * 60_000 - 1);
    assert.equal(f.fixture.refreshCount(), 0);
    t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.fixture.refreshCount(), 1);
    t.mock.timers.tick(5 * 60_000 - 1);
    assert.equal(f.fixture.refreshCount(), 1);
    t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.fixture.refreshCount(), 2);
    await f.runtime.close();
    t.mock.timers.tick(10 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.fixture.refreshCount(), 2);
  } finally {
    await f.runtime.close();
    t.mock.timers.reset();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('separate runtimes exclude verified same-account work and hold unknown login through browser close', async () => {
  const a = await setup(), b = await setup();
  let finish!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const work = a.runtime.withLock(a.projectId, a.record, async () => { entered(); await blocked; });
  try {
    await ready;
    await assert.rejects(b.runtime.listWorks(b.record), { code: 'PLATFORM_BUSY' });
    await assert.rejects(b.runtime.startLogin(b.projectId), { code: 'PLATFORM_BUSY' });
    finish(); await work;
    const login = await a.runtime.startLogin(a.projectId);
    await assert.rejects(b.runtime.listWorks(b.record), { code: 'PLATFORM_BUSY' });
    let closed!: () => void;
    const closeBlocked = new Promise<void>(resolve => { closed = resolve; });
    const original = a.runtime.browser.closeLogin;
    a.runtime.browser.closeLogin = async id => { await closeBlocked; await original(id); };
    const cancel = a.runtime.cancelLogin(a.projectId, login.id);
    await assert.rejects(b.runtime.listWorks(b.record), { code: 'PLATFORM_BUSY' });
    closed(); await cancel;
    await b.runtime.listWorks(b.record);
  } finally {
    finish(); await work;
    await a.runtime.close(); await b.runtime.close();
    fs.rmSync(a.dir, { recursive: true, force: true }); fs.rmSync(b.dir, { recursive: true, force: true });
  }
});

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

test('repeat manual login reuses pending window and passes explicit connection for relogin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-login-reuse-'));
  const fixture = fixtureBrowser();
  const starts: { id: string; connectionId?: string }[] = [];
  const original = fixture.browser.startLogin.bind(fixture.browser);
  fixture.browser.startLogin = async (id, connectionId) => { starts.push({ id, connectionId }); await original(id); };
  const runtime = new PlatformRuntime(new Store(dir), { browser: fixture.browser });
  try {
    const projectId = runtime.store.projects[0].id;
    const first = await runtime.startLogin(projectId);
    assert.equal((await runtime.startLogin(projectId)).id, first.id);
    assert.equal(starts.length, 1, 'no second browser for repeated pending login');
    const connection = await runtime.completeLogin(projectId, first.id);
    const relogin = await runtime.startLogin(projectId, connection.id);
    assert.equal(starts.at(-1)?.connectionId, connection.id);
    assert.equal((await runtime.startLogin(projectId, connection.id)).id, relogin.id);
    assert.equal(starts.length, 2);
  } finally { await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real adapter snapshot on unknown connection does not open a browser', async () => {
  const browser = new FanqieBrowser();
  assert.equal(await browser.sessionState('offline-absent'), undefined);
  await browser.close();
});
