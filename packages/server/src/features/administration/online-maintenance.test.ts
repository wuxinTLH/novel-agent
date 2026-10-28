import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { acquireDataLock } from '../../core/local-runtime.js';
import {
  OnlineMaintenanceManager,
  createOnlineMaintenanceRouter,
  type OnlineMaintenanceLease,
} from './online-maintenance.js';
import { validateBackup, type MaintenanceBackend } from './maintenance.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'online-maintenance-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, backups: path.join(root, '.data-managed-backups') };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function barrier() {
  let held = false,
    acquired = 0,
    released = 0;
  return {
    acquire: async (): Promise<OnlineMaintenanceLease> => {
      assert.equal(held, false);
      held = true;
      acquired++;
      return {
        scope: 'all-tenants-and-control-plane',
        assertHeld() {
          assert.equal(held, true);
        },
        release() {
          held = false;
          released++;
        },
      };
    },
    counts: () => ({ held, acquired, released }),
  };
}
async function finish(manager: OnlineMaintenanceManager) {
  // close cancels queued work; observe completion without scheduling another job.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (manager.list().every((job) => !['queued', 'running'].includes(job.state))) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('manager failed to settle');
}
test('serial bounded queue; queued cancellation; live instance lock retained; history excluded', async (t) => {
  const { dataDir, backups } = fixture(t),
    b = barrier();
  const releaseLock = acquireDataLock(dataDir);
  t.after(releaseLock);
  const waiting = deferred(),
    entered = deferred();
  let exports = 0;
  const backend: MaintenanceBackend = {
    profileIds: ['one', 'two'],
    async exportSnapshot() {
      exports++;
      if (exports === 1) {
        entered.resolve();
        await waiting.promise;
      }
      return { version: 3, owners: [] };
    },
    async assertEmpty() {
      assert.fail('not validation');
    },
    async importSnapshot() {
      assert.fail('never online import');
    },
  };
  const manager = new OnlineMaintenanceManager({
    dataDir,
    maxQueued: 1,
    acquireQuiescence: b.acquire,
    backend: async () => backend,
  });
  const first = manager.create({ kind: 'backup', confirmSecrets: true });
  assert.equal(first.state, 'queued');
  await entered.promise;
  const second = manager.create({ kind: 'backup', confirmSecrets: true });
  assert.throws(() => manager.create({ kind: 'backup', confirmSecrets: true }), /MAINTENANCE_QUEUE_FULL/);
  manager.cancel(second.id);
  waiting.resolve();
  await finish(manager);
  assert.equal(manager.get(first.id).state, 'succeeded');
  assert.equal(manager.get(second.id).state, 'cancelled');
  assert.deepEqual(b.counts(), { held: false, acquired: 1, released: 1 });
  assert.equal(exports, 2);
  const backupId = manager.get(first.id).backupId!;
  const manifest = validateBackup(path.join(backups, backupId)).manifest;
  assert.equal(manifest.consistency, 'quiesced-all-tenants-and-control-plane');
  assert.equal(
    manifest.entries.some((entry) => entry.path.includes('.maintenance-')),
    false,
  );
  const plan = manager.create({ kind: 'restore-plan', backupId });
  await finish(manager);
  assert.deepEqual(manager.get(plan.id).result, {
    fileCount: 0,
    profileCount: 2,
    externalKeysRequired: false,
    offlineRequired: true,
    validation: 'integrity-only',
  });
  await manager.close();
});
test('cancellation before backup commit prevents publication and releases barrier', async (t) => {
  const { dataDir, backups } = fixture(t),
    b = barrier(),
    entered = deferred(),
    resume = deferred();
  const manager = new OnlineMaintenanceManager({
    dataDir,
    acquireQuiescence: b.acquire,
    backend: async () => ({
      profileIds: ['all'],
      async exportSnapshot() {
        entered.resolve();
        await resume.promise;
        return { version: 3, owners: [] };
      },
      async assertEmpty() {},
      async importSnapshot() {
        assert.fail('no import');
      },
    }),
  });
  const job = manager.create({ kind: 'backup', confirmSecrets: true });
  await entered.promise;
  manager.cancel(job.id);
  resume.resolve();
  await finish(manager);
  assert.equal(manager.get(job.id).state, 'cancelled');
  assert.equal(manager.get(job.id).backupId, undefined);
  assert.ok(fs.readdirSync(backups).every((name) => name.endsWith('.tmp')));
  assert.equal(b.counts().released, 1);
  await manager.close();
});
test('local-only snapshot yields so cancellation can arrive before publication', async (t) => {
  const { dataDir, backups } = fixture(t),
    b = barrier();
  fs.writeFileSync(path.join(dataDir, 'payload'), 'safe');
  const manager = new OnlineMaintenanceManager({ dataDir, acquireQuiescence: b.acquire });
  const job = manager.create({ kind: 'backup', confirmSecrets: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  manager.cancel(job.id);
  await finish(manager);
  assert.equal(manager.get(job.id).state, 'cancelled');
  assert.ok(fs.readdirSync(backups).every((name) => name.endsWith('.tmp')));
  assert.equal(b.counts().released, 1);
  await manager.close();
});

test('backend pools close before releasing global barrier even on failure', async (t) => {
  const { dataDir } = fixture(t);
  const order: string[] = [];
  const manager = new OnlineMaintenanceManager({
    dataDir,
    acquireQuiescence: async () => ({
      scope: 'all-tenants-and-control-plane',
      assertHeld() {},
      release() {
        order.push('release');
      },
    }),
    backend: async () => ({
      profileIds: ['all'],
      async exportSnapshot() {
        throw new Error('secret');
      },
      async assertEmpty() {},
      async importSnapshot() {},
      async close() {
        order.push('close');
      },
    }),
  });
  manager.create({ kind: 'backup', confirmSecrets: true });
  await finish(manager);
  assert.deepEqual(order, ['close', 'release']);
  await manager.close();
});

test('backup failure releases barrier and redacts raw exception/SQL credentials', async (t) => {
  const { dataDir } = fixture(t),
    b = barrier();
  const manager = new OnlineMaintenanceManager({
    dataDir,
    acquireQuiescence: b.acquire,
    backend: async () => {
      throw new Error('password=secret C:/private/auth.key');
    },
  });
  const job = manager.create({ kind: 'backup', confirmSecrets: true });
  await finish(manager);
  assert.equal(manager.get(job.id).state, 'failed');
  assert.equal(manager.get(job.id).errorCode, 'MAINTENANCE_TASK_FAILED');
  assert.doesNotMatch(JSON.stringify(manager.list()), /password|private|secret/);
  assert.equal(b.counts().released, 1);
  await manager.close();
});
test('barrier acquisition failure does not snapshot; disabled barrier fails closed', async (t) => {
  const { dataDir, backups } = fixture(t);
  const manager = new OnlineMaintenanceManager({
    dataDir,
    acquireQuiescence: async () => {
      throw new Error('close timeout secret');
    },
    backend: async () => {
      assert.fail('must not snapshot');
    },
  });
  const job = manager.create({ kind: 'backup', confirmSecrets: true });
  await finish(manager);
  assert.equal(manager.get(job.id).state, 'failed');
  assert.equal(fs.readdirSync(backups).length, 0);
  await manager.close();
  const disabled = new OnlineMaintenanceManager({ dataDir });
  assert.equal(disabled.capabilities().backupAvailable, false);
  assert.throws(
    () => disabled.create({ kind: 'backup', confirmSecrets: true }),
    /MAINTENANCE_BARRIER_UNAVAILABLE/,
  );
  await disabled.close();
});
test('restart interrupts queued/running records, bounds history and never replays', async (t) => {
  const { dataDir } = fixture(t);
  const manager = new OnlineMaintenanceManager({
    dataDir,
    acquireQuiescence: barrier().acquire,
    maxHistory: 2,
  });
  const first = manager.create({ kind: 'backup', confirmSecrets: true });
  await finish(manager);
  await manager.close();
  const history = path.join(dataDir, '.maintenance-online', 'jobs.json');
  const jobs = JSON.parse(fs.readFileSync(history, 'utf8'));
  jobs[0].state = 'running';
  jobs[0].phase = 'snapshot';
  fs.writeFileSync(history, JSON.stringify(jobs));
  let acquired = false;
  const resumed = new OnlineMaintenanceManager({
    dataDir,
    maxHistory: 2,
    acquireQuiescence: async () => {
      acquired = true;
      return barrier().acquire();
    },
  });
  assert.equal(resumed.get(first.id).state, 'interrupted');
  assert.equal(acquired, false);
  for (let count = 0; count < 4; count++) {
    resumed.create({ kind: 'backup', confirmSecrets: true });
    await finish(resumed);
  }
  assert.equal(resumed.list().length, 2);
  await resumed.close();
});
test('rejects arbitrary paths, unsupported destructive operations, unsafe backup tree and secret input', async (t) => {
  const { dataDir, root, backups } = fixture(t),
    manager = new OnlineMaintenanceManager({ dataDir, acquireQuiescence: barrier().acquire });
  for (const backupId of [
    '../data',
    '/etc',
    'C:\\private',
    '..',
    'a/b',
    '00000000-0000-4000-8000-000000000000/..',
  ])
    assert.throws(() => manager.create({ kind: 'validate', backupId }));
  assert.throws(() => manager.create({ kind: 'restore', backupId: '00000000-0000-4000-8000-000000000000' }));
  assert.throws(() => manager.create({ kind: 'backup', confirmSecrets: true, destination: root }));
  assert.throws(() => manager.create({ kind: 'backup', confirmSecrets: false }));
  const id = '11111111-1111-4111-8111-111111111111';
  fs.symlinkSync(dataDir, path.join(backups, id), 'junction');
  assert.throws(() => manager.create({ kind: 'validate', backupId: id }), /MAINTENANCE_UNSAFE_DIRECTORY/);
  await manager.close();
});
test('symlinked history and managed root are refused', async (t) => {
  const { dataDir, root } = fixture(t);
  fs.mkdirSync(path.join(dataDir, '.maintenance-online'));
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, '[]');
  const link = path.join(dataDir, '.maintenance-online', 'jobs.json');
  fs.symlinkSync(target, link);
  assert.throws(() => new OnlineMaintenanceManager({ dataDir }), /MAINTENANCE_UNSAFE_HISTORY/);
  fs.unlinkSync(link);
  fs.rmdirSync(path.join(root, '.data-managed-backups'));
  fs.symlinkSync(dataDir, path.join(root, '.data-managed-backups'), 'junction');
  assert.throws(() => new OnlineMaintenanceManager({ dataDir }), /MAINTENANCE_UNSAFE_DIRECTORY/);
});
test('bounded backup storage fails without another barrier; close waits cancellation release', async (t) => {
  const { dataDir } = fixture(t),
    b = barrier();
  const manager = new OnlineMaintenanceManager({ dataDir, acquireQuiescence: b.acquire, maxBackups: 1 });
  manager.create({ kind: 'backup', confirmSecrets: true });
  await finish(manager);
  const second = manager.create({ kind: 'backup', confirmSecrets: true });
  await finish(manager);
  assert.equal(manager.get(second.id).errorCode, 'MAINTENANCE_BACKUP_CAPACITY');
  assert.equal(b.counts().acquired, 1);
  await manager.close();
  assert.throws(() => manager.create({ kind: 'backup', confirmSecrets: true }), /MAINTENANCE_CLOSED/);
});
test('close waits for active work and barrier release; release failure is redacted', async (t) => {
  const { dataDir } = fixture(t),
    entered = deferred(),
    resume = deferred(),
    released = deferred();
  let held = false;
  const manager = new OnlineMaintenanceManager({
    dataDir,
    acquireQuiescence: async () => {
      held = true;
      return {
        scope: 'all-tenants-and-control-plane',
        assertHeld() {
          assert.equal(held, true);
        },
        async release() {
          await released.promise;
          held = false;
        },
      };
    },
    backend: async () => {
      entered.resolve();
      await resume.promise;
      return undefined;
    },
  });
  const job = manager.create({ kind: 'backup', confirmSecrets: true });
  await entered.promise;
  let closed = false;
  const closing = manager.close().then(() => {
    closed = true;
  });
  resume.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(held, true);
  released.resolve();
  await closing;
  assert.equal(held, false);
  assert.equal(manager.get(job.id).state, 'cancelled');
  const failing = new OnlineMaintenanceManager({
    dataDir,
    acquireQuiescence: async () => ({
      scope: 'all-tenants-and-control-plane',
      assertHeld() {},
      release() {
        throw new Error('secret release path');
      },
    }),
  });
  const failed = failing.create({ kind: 'backup', confirmSecrets: true });
  await finish(failing);
  assert.equal(failing.get(failed.id).errorCode, 'MAINTENANCE_BARRIER_RELEASE_FAILED');
  assert.equal(failing.get(failed.id).state, 'failed');
  await failing.close();
});

test('router delegates EVERY endpoint to required administrator+CSRF guard', async (t) => {
  const { dataDir } = fixture(t),
    manager = new OnlineMaintenanceManager({ dataDir });
  t.after(() => manager.close());
  const app = express();
  let checked = 0;
  app.use(
    '/admin/online-maintenance',
    createOnlineMaintenanceRouter({
      manager,
      authorize(req, res, next) {
        checked++;
        if (
          req.get('authorization') !== 'admin' ||
          (req.method !== 'GET' && req.get('x-test-csrf') !== 'valid')
        ) {
          res.status(403).json({ code: 'ADMIN_FORBIDDEN' });
          return;
        }
        next();
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/admin/online-maintenance`;
  const id = '11111111-1111-4111-8111-111111111111';
  for (const [method, suffix] of [
    ['GET', ''],
    ['GET', '/tasks/' + id],
    ['POST', '/tasks'],
    ['POST', '/tasks/' + id + '/cancel'],
    ['POST', '/backups/' + id + '/validate'],
  ]) {
    assert.equal((await fetch(url + suffix, { method })).status, 403);
  }
  assert.equal(
    (await fetch(url + '/tasks', { method: 'POST', headers: { authorization: 'admin' } })).status,
    403,
  );
  const response = await fetch(url, { headers: { authorization: 'admin' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(checked, 7);
  assert.throws(
    () => createOnlineMaintenanceRouter({ manager, authorize: undefined as never }),
    /MAINTENANCE_ADMIN_GUARD_REQUIRED/,
  );
});
