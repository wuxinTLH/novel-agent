import test from 'node:test';
import assert from 'node:assert/strict';
import { PooledStorageBridge } from './pooled-storage-bridge.js';
import type { SQLConnectConfig } from '../../shared/sqlconnect.js';

const config: SQLConnectConfig = {
  driver: 'postgresql',
  host: 'localhost',
  port: 5432,
  user: 'private-user',
  password: 'never-log-me',
  database: 'test',
  tls: 'off',
  timeoutMs: 1000,
};
function fixture(mode = 'normal', responseBytes = 4096, timeoutMs = 2000) {
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    const header = new Int32Array(workerData.shared, 0, 2);
    const bytes = new Uint8Array(workerData.shared, 8);
    const records = new Map(); let writes = 0;
    const respond = (value) => {
      const encoded = new TextEncoder().encode(JSON.stringify(value));
      bytes.set(encoded); Atomics.store(header, 1, encoded.length);
      Atomics.store(header, 0, 1); Atomics.notify(header, 0);
    };
    respond({ok:true});
    parentPort.on('message', async ({operation, payload}) => {
      if (operation === 'close') { parentPort.close(); return; }
      if (${JSON.stringify(mode)} === 'timeout') return;
      if (${JSON.stringify(mode)} === 'invalid') { Atomics.store(header,1,-1); Atomics.store(header,0,1); Atomics.notify(header,0); return; }
      if (${JSON.stringify(mode)} === 'fail') { respond({ok:false,code:'COMMIT_UNCERTAIN'}); return; }
      if (${JSON.stringify(mode)} === 'secret') { respond({ok:false,code:'password=never-log-me'}); return; }
      if (operation === 'read') { respond({ok:true,result:records.get(payload.key) ?? null}); return; }
      if (operation === 'write') {
        const prior = records.get(payload.key);
        if ((prior?.revision ?? 0) !== payload.revision) { respond({ok:false,code:'REVISION_CONFLICT'}); return; }
        await new Promise(resolve => setTimeout(resolve, 30));
        writes++; const revision = (prior?.revision ?? 0) + 1;
        records.set(payload.key, {revision,content:payload.content});
        respond({ok:true,result:revision}); return;
      }
      if (operation === 'stats') { respond({ok:true,result:{writes,ownerId:workerData.ownerId}}); return; }
      if (operation === 'malformed') { bytes.set(new TextEncoder().encode('not-json')); Atomics.store(header,1,8); Atomics.store(header,0,1); Atomics.notify(header,0); return; }
      respond({ok:true,result:payload});
    });`;
  return new PooledStorageBridge(config, 'owner-a', {
    workerUrl: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    responseBytes,
    timeoutMs,
  });
}

test('persistent bridge retains one worker state and returns only after committed write', async () => {
  const bridge = fixture();
  try {
    assert.equal(bridge.read('projects.json'), null);
    const start = Date.now();
    bridge.write('projects.json', 'first');
    assert.ok(Date.now() - start >= 20);
    assert.equal(bridge.read('projects.json'), 'first');
    bridge.write('projects.json', 'second');
    assert.equal(bridge.read('projects.json'), 'second');
    assert.deepEqual(bridge.request('stats'), { writes: 2, ownerId: 'owner-a' });
  } finally {
    await bridge.close();
  }
  assert.throws(() => bridge.read('projects.json'), { code: 'STORAGE_RECONCILIATION_REQUIRED' });
  await bridge.close();
});

test('real TypeScript database worker boots without network and closes its persistent pool', async () => {
  const bridge = new PooledStorageBridge(config, 'owner-worker-bootstrap', { timeoutMs: 5000 });
  bridge.assertHealthy();
  await bridge.close();
});

test('first write hydrates expected revision before the commit', async () => {
  const bridge = fixture();
  try {
    bridge.write('new.json', 'value');
    assert.equal(bridge.read('new.json'), 'value');
  } finally {
    await bridge.close();
  }
});

test('uncertain COMMIT poisons bridge and cannot retry', async () => {
  const bridge = fixture('fail');
  try {
    assert.throws(() => bridge.read('projects.json'), { code: 'COMMIT_UNCERTAIN' });
    assert.throws(() => bridge.request('write'), { code: 'STORAGE_RECONCILIATION_REQUIRED' });
  } finally {
    await bridge.close();
  }
});

test('lost acknowledgment times out and poisons bridge', async () => {
  const bridge = fixture('timeout', 4096, 500);
  try {
    assert.throws(() => bridge.request('write'), { code: 'DATABASE_WORKER_TIMEOUT' });
    assert.throws(() => bridge.read('projects.json'), { code: 'STORAGE_RECONCILIATION_REQUIRED' });
  } finally {
    await bridge.close();
  }
});

test('invalid shared slot and malformed JSON fail closed', async () => {
  for (const mode of ['invalid', 'normal']) {
    const bridge = fixture(mode);
    try {
      assert.throws(() => bridge.request('malformed'), { code: 'DATABASE_WORKER_INVALID_RESPONSE' });
      assert.throws(() => bridge.assertHealthy(), { code: 'STORAGE_RECONCILIATION_REQUIRED' });
    } finally {
      await bridge.close();
    }
  }
});

test('driver error details are not exposed and allocation is bounded', async () => {
  const bridge = fixture('secret');
  try {
    assert.throws(
      () => bridge.request('read'),
      (error) => {
        assert.equal((error as { code: string }).code, 'DATABASE_WORKER_FAILED');
        assert.ok(!String(error).includes('never-log-me'));
        return true;
      },
    );
  } finally {
    await bridge.close();
  }
  assert.throws(() => fixture('normal', 64), /INVALID_DATABASE_WORKER_LIMITS/);
  assert.throws(() => fixture('normal', 65 * 1024 * 1024), /INVALID_DATABASE_WORKER_LIMITS/);
});
