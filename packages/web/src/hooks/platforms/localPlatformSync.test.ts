import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocalPlatformSync } from './localPlatformSync';

function clock() {
  let run: (() => void) | undefined;
  let delay = 0;
  return {
    schedule: (next: () => void, ms: number) => { run = next; delay = ms; return 1 as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => { run = undefined; },
    tick: async () => { const next = run; run = undefined; next?.(); await new Promise<void>((resolve) => setImmediate(resolve)); },
    get delay() { return delay; },
  };
}

test('idle page continues reading local records and switches to active cadence', async () => {
  const time = clock();
  let active = false;
  let reads = 0;
  const sync = startLocalPlatformSync({ ...time, active: () => active, paused: () => false,
    read: async (_signal, isCurrent) => { assert.equal(isCurrent(), true); reads++; },
  });
  assert.equal(time.delay, 1000);
  await time.tick();
  assert.equal(reads, 1);
  assert.equal(time.delay, 5000);
  active = true;
  await time.tick();
  assert.equal(reads, 2);
  assert.equal(time.delay, 1500);
  sync.stop();
  await time.tick();
  assert.equal(reads, 2);
});

test('focus requests coalesce and snapshots overlapping mutations cannot commit', async () => {
  const time = clock();
  let finish: (() => void) | undefined;
  let current: (() => boolean) | undefined;
  let reads = 0;
  let paused = false;
  const sync = startLocalPlatformSync({ ...time, active: () => false, paused: () => paused,
    read: async (_signal, isCurrent) => {
      reads++;
      current = isCurrent;
      await new Promise<void>((resolve) => { finish = resolve; });
    },
  });
  sync.refresh();
  sync.refresh();
  assert.equal(reads, 1);
  assert.equal(current?.(), true);
  paused = true;
  sync.invalidate();
  assert.equal(current?.(), false);
  paused = false;
  assert.equal(current?.(), false, 'snapshot stays invalid after mutation has completed');
  finish?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(time.delay, 0);
  await time.tick();
  assert.equal(reads, 2);
  sync.stop();
  assert.equal(current?.(), false);
  finish?.();
});

test('hidden/pending pages skip reads; background failures retry without action error callbacks', async () => {
  const time = clock();
  let paused = true;
  let reads = 0;
  const sync = startLocalPlatformSync({ ...time, active: () => false, paused: () => paused,
    read: async () => { reads++; throw new Error('local snapshot temporarily unavailable'); },
  });
  await time.tick();
  assert.equal(reads, 0);
  paused = false;
  await time.tick();
  assert.equal(reads, 1);
  assert.equal(time.delay, 5000);
  await time.tick();
  assert.equal(reads, 2);
  sync.stop();
});
