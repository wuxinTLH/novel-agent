import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthStatus } from '../../../../../shared/auth';
import { createSessionRevalidator } from './session-revalidation';

function session(id: string | null = 'a'): AuthStatus {
  return {
    enabled: true, authenticated: id !== null,
    user: id ? { id, username: id, role: 'writer', disabled: false, createdAt: '' } : null,
    csrfToken: 'token',
    turnstile: { enabled: false, siteKey: '', action: '', hostname: '' },
  };
}
function setup(read: (signal: AbortSignal) => Promise<AuthStatus>) {
  const calls = { initial: 0, changed: 0, errors: 0 };
  const validator = createSessionRevalidator({
    read, initial: () => calls.initial++, changed: () => calls.changed++,
    error: () => calls.errors++, checking: () => {},
  });
  return { calls, validator };
}
test('unchanged identity/token rotation preserves UI; alias identity switch triggers once', async () => {
  let next = session();
  const { validator, calls } = setup(async () => next);
  await validator.check();
  next = { ...session(), csrfToken: 'rotated' };
  await validator.check();
  assert.deepEqual(calls, { initial: 1, changed: 0, errors: 0 });
  next = session('b');
  await validator.check();
  await validator.check();
  assert.deepEqual(calls, { initial: 1, changed: 1, errors: 0 });
});
test('logout, auth-mode change and changed authorization invalidate the mounted identity', async () => {
  for (const next of [session(null), { ...session(), enabled: false },
    { ...session(), user: { ...session().user!, role: 'superadmin' as const } }]) {
    let current = session();
    const { validator, calls } = setup(async () => current);
    await validator.check();
    current = next;
    await validator.check();
    assert.equal(calls.changed, 1);
  }
});
test('late checks and disposed/unmounted responses cannot install stale identity', async () => {
  const requests: { signal: AbortSignal; resolve: (value: AuthStatus) => void }[] = [];
  const { validator, calls } = setup((signal) => new Promise((resolve) => requests.push({ signal, resolve })));
  const first = validator.check();
  const second = validator.check();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(session('b'));
  await second;
  requests[0].resolve(session('a'));
  await first;
  assert.deepEqual(calls, { initial: 1, changed: 0, errors: 0 });
  const third = validator.check();
  validator.dispose();
  requests[2].resolve(session(null));
  await third;
  assert.equal(requests[2].signal.aborted, true);
  assert.deepEqual(calls, { initial: 1, changed: 0, errors: 0 });
});
test('network failure never installs anonymous/auth-disabled state or reloads drafts', async () => {
  let fail = false;
  const { validator, calls } = setup(async () => {
    if (fail) throw new Error('offline');
    return session();
  });
  await validator.check();
  fail = true;
  await validator.check();
  assert.deepEqual(calls, { initial: 1, changed: 0, errors: 1 });
});
