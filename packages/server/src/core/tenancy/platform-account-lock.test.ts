import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker, MessageChannel } from 'node:worker_threads';
import { PlatformAccountLockCoordinator, createWorkerPlatformAccountLockClient } from './platform-account-lock.js';

const scope = { providerId: 'tomato', accountId: 'private-verified-author' };
test('independent clients exclude same verified account and unknown identity, without TTL or reentrant owners', async () => {
  const coordinator = new PlatformAccountLockCoordinator();
  const a = coordinator.localClient(), b = coordinator.localClient();
  const release = await a.acquire(scope);
  await assert.rejects(b.acquire(scope), { code: 'PLATFORM_BUSY' });
  await assert.rejects(a.acquire(scope), { code: 'PLATFORM_BUSY' });
  await assert.rejects(b.acquire({ providerId: 'tomato' }), { code: 'PLATFORM_BUSY' });
  const other = await b.acquire({ ...scope, accountId: 'different' });
  await other(); await release();
  const login = await a.acquire({ providerId: 'tomato' });
  await assert.rejects(b.acquire({ ...scope, accountId: 'different' }), { code: 'PLATFORM_BUSY' });
  const independent = await b.acquire({ ...scope, providerId: 'other' });
  await independent(); await login();
  await (await b.acquire(scope))();
});

test('missing coordinator and closed channel fail closed; messages contain no raw identity', async () => {
  const coordinator = new PlatformAccountLockCoordinator();
  const channel = new MessageChannel();
  const credentials = coordinator.credentials();
  const client = createWorkerPlatformAccountLockClient(channel.port1, credentials, 20);
  const seen: unknown[] = [];
  channel.port2.on('message', message => seen.push(message));
  try {
    await assert.rejects(client.acquire(scope), { code: 'PLATFORM_LOCK_UNAVAILABLE' });
    assert.equal(JSON.stringify(seen).includes(scope.accountId), false);
    channel.port2.close();
    await once(channel.port1, 'close');
    await assert.rejects(client.acquire(scope), { code: 'PLATFORM_LOCK_UNAVAILABLE' });
  } finally { channel.port1.close(); channel.port2.close(); }
});

test('real worker capability ownership, forged releases, and worker termination cleanup', async () => {
  const coordinator = new PlatformAccountLockCoordinator();
  const url = new URL('./platform-account-lock.ts', import.meta.url).href;
  const source = `
    const {parentPort,workerData}=require('node:worker_threads');
    import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.url,workerData.url)).then(({createWorkerPlatformAccountLockClient})=>{
      const client=createWorkerPlatformAccountLockClient(parentPort,workerData.credentials);
      let release, leaseId;
      parentPort.on('message', message=> { if(message.type==='platform-account-lock-v1' && message.leaseId) leaseId=message.leaseId; });
      parentPort.on('message',async message=>{
        if(message.command==='acquire') {
          try { release=await client.acquire(message.scope); parentPort.postMessage({event:'acquired',leaseId}); }
          catch(e){ parentPort.postMessage({event:'rejected',code:e.code}); }
        }
        if(message.command==='release') { await release?.(); parentPort.postMessage({event:'released'}); }
        if(message.command==='forge') {parentPort.postMessage(message.request); parentPort.postMessage({event:'forged'});}
      });
      parentPort.postMessage({event:'ready'});
    });`;
  function spawn() {
    const credentials = coordinator.credentials();
    const worker = new Worker(source, { eval: true, workerData: { url, credentials } });
    coordinator.bindWorker(worker, credentials);
    return { worker, credentials };
  }
  const a = spawn(), b = spawn();
  const event = (worker: Worker) => new Promise<Record<string, string>>(resolve => {
    const listener = (value: Record<string, string>) => { if (value.event) { worker.off('message', listener); resolve(value); } };
    worker.on('message', listener);
  });
  const command = (worker: Worker, body: object) => { const result = event(worker); worker.postMessage(body); return result; };
  try {
    await Promise.all([event(a.worker), event(b.worker)]);
    const granted = await command(a.worker, { command: 'acquire', scope });
    assert.equal(granted.event, 'acquired');
    assert.ok(granted.leaseId);
    const leaseId = granted.leaseId;
    assert.equal((await command(b.worker, { command: 'acquire', scope })).code, 'PLATFORM_BUSY');
    // A worker's release with an arbitrary/other lease cannot release another worker's ownership.
    await command(b.worker, { command: 'forge', request: { type: 'platform-account-lock-v1', capability: b.credentials.capability, requestId: 'forged', action: 'release', leaseId: leaseId ?? 'not-owned' } });
    assert.equal((await command(b.worker, { command: 'acquire', scope })).code, 'PLATFORM_BUSY');
    // Channel close/error or a close request is not sufficient; actual exit is authoritative.
    await a.worker.terminate();
    assert.equal((await command(b.worker, { command: 'acquire', scope })).event, 'acquired');
    await command(b.worker, { command: 'release' });
    await (await coordinator.localClient().acquire(scope))();
  } finally { await Promise.all([a.worker.terminate(), b.worker.terminate()]); }
});
