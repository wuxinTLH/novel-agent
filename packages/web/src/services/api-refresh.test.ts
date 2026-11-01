import assert from 'node:assert/strict';
import test from 'node:test';
import { api, ApiError, resetApiSession } from './api';

type Reply = { status?: number; body: unknown };
function mockFetch(reply: (url: string, init: RequestInit) => Reply | Promise<Reply>) {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = await reply(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
      resetApiSession();
    },
  };
}
const session = (authenticated: boolean, refreshAvailable = false) => ({
  enabled: true,
  authenticated,
  refreshAvailable,
  user: authenticated ? { id: 'a' } : null,
  ...(authenticated ? { csrfToken: 'session-token' } : {}),
});

test('anonymous server session refreshes once with a fresh prelogin CSRF nonce', async () => {
  resetApiSession();
  let refreshed = false;
  const { calls, restore } = mockFetch((url, init) => {
    if (url === '/api/auth/session') return { body: session(refreshed, !refreshed) };
    if (url === '/api/auth/csrf') return { body: { csrfToken: 'prelogin-nonce' } };
    if (url === '/api/auth/refresh') {
      assert.equal(new Headers(init.headers).get('x-csrf-token'), 'prelogin-nonce');
      assert.equal(init.credentials, 'same-origin');
      refreshed = true;
      return { body: { ok: true } };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => api<{ authenticated: boolean }>('/auth/session')),
    );
    assert.ok(results.every((value) => value.authenticated));
    assert.equal(calls.filter((call) => call.url === '/api/auth/refresh').length, 1);
    assert.equal(calls.filter((call) => call.url === '/api/auth/csrf').length, 1);
  } finally {
    restore();
  }
});

test('local and plain anonymous sessions never refresh', async () => {
  resetApiSession();
  const { calls, restore } = mockFetch(() => ({ body: { ...session(false), enabled: false } }));
  try {
    assert.equal((await api<{ authenticated: boolean }>('/auth/session')).authenticated, false);
    assert.deepEqual(
      calls.map((call) => call.url),
      ['/api/auth/session'],
    );
  } finally {
    restore();
  }
});

test('401 protected GET refreshes and retries once; writes are never retried', async () => {
  resetApiSession();
  let refreshed = false;
  const oldWindow = globalThis.window;
  const events: string[] = [];
  globalThis.window = { dispatchEvent: (event: Event) => events.push(event.type) } as unknown as Window &
    typeof globalThis;
  const { calls, restore } = mockFetch((url) => {
    if (url === '/api/protected')
      return refreshed ? { body: { ok: true } } : { status: 401, body: { error: 'AUTH_REQUIRED' } };
    if (url === '/api/auth/session') return { body: session(refreshed, !refreshed) };
    if (url === '/api/auth/csrf') return { body: { csrfToken: 'nonce' } };
    if (url === '/api/auth/refresh') {
      refreshed = true;
      return { body: { ok: true } };
    }
    if (url === '/api/platforms/session') return { body: { csrfToken: 'platform-nonce' } };
    if (url === '/api/write') return { status: 401, body: { error: 'AUTH_REQUIRED' } };
    throw new Error(`Unexpected request: ${url}`);
  });
  try {
    assert.deepEqual(await api('/protected'), { ok: true });
    assert.equal(calls.filter((call) => call.url === '/api/protected').length, 2);
    assert.deepEqual(events, []);
    await assert.rejects(
      api('/write', { method: 'POST', body: '{}' }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    assert.equal(calls.filter((call) => call.url === '/api/write').length, 1);
    assert.deepEqual(events, ['novel-auth-expired']);
  } finally {
    restore();
    globalThis.window = oldWindow;
  }
});

test('failed refresh leaves session anonymous and does not retry protected GET', async () => {
  resetApiSession();
  const oldWindow = globalThis.window;
  const events: string[] = [];
  globalThis.window = { dispatchEvent: (event: Event) => events.push(event.type) } as unknown as Window &
    typeof globalThis;
  const { calls, restore } = mockFetch((url) => {
    if (url === '/api/auth/session') return { body: session(false, true) };
    if (url === '/api/auth/csrf') return { body: { csrfToken: 'nonce' } };
    if (url === '/api/auth/refresh') return { status: 401, body: { error: 'AUTH_REFRESH_EXPIRED' } };
    if (url === '/api/protected') return { status: 401, body: { error: 'AUTH_REQUIRED' } };
    throw new Error(`Unexpected request: ${url}`);
  });
  try {
    assert.equal((await api<{ authenticated: boolean }>('/auth/session')).authenticated, false);
    await assert.rejects(
      api('/protected'),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    assert.equal(calls.filter((call) => call.url === '/api/protected').length, 1);
    assert.deepEqual(events, ['novel-auth-expired']);
  } finally {
    restore();
    globalThis.window = oldWindow;
  }
});

test('stale anonymous response cannot initiate a second refresh', async () => {
  resetApiSession();
  let releaseStale!: (value: Reply) => void;
  let sessionReads = 0;
  let refreshed = false;
  const { calls, restore } = mockFetch((url) => {
    if (url === '/api/auth/session') {
      sessionReads++;
      if (sessionReads === 1)
        return new Promise<Reply>((resolve) => {
          releaseStale = resolve;
        });
      return { body: session(refreshed, !refreshed) };
    }
    if (url === '/api/auth/csrf') return { body: { csrfToken: 'nonce' } };
    if (url === '/api/auth/refresh') {
      refreshed = true;
      return { body: { ok: true } };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  try {
    const stale = api<{ authenticated: boolean }>('/auth/session');
    assert.equal((await api<{ authenticated: boolean }>('/auth/session')).authenticated, true);
    releaseStale({ body: session(false, true) });
    assert.equal((await stale).authenticated, true);
    assert.equal(calls.filter((call) => call.url === '/api/auth/refresh').length, 1);
  } finally {
    restore();
  }
});
