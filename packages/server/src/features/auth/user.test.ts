import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Request } from 'express';
import { UserService } from './user.js';
const request = {} as Request;
test('User is dormant by default and ignores untrusted tenant headers in local mode', async () => {
  const service = new UserService('./data');
  assert.equal(service.status().enabled, false);
  assert.deepEqual(await service.resolve({ headers: { 'x-user-id': 'another-user' } } as unknown as Request), service.localScope());
  assert.equal(service.localScope().dataDir, path.resolve('./data'));
});
test('verified identities get non-overlapping filesystem-safe roots for every store', async () => {
  const scopeA = await new UserService('./data', async () => ({ id: '../a' })).resolve(request);
  const scopeB = await new UserService('./data', async () => ({ id: '../b' })).resolve(request);
  assert.notEqual(scopeA.dataDir, scopeB.dataDir);
  assert.equal(path.dirname(scopeA.dataDir), path.resolve('./data/users'));
  assert.match(path.basename(scopeA.dataDir), /^[a-f0-9]{64}$/);
  assert.equal((await new UserService('./data', async () => ({ id: '../a' })).resolve(request)).dataDir, scopeA.dataDir);
  assert.throws(() => new UserService('./data', async () => ({ id: 'a' })).localScope(), /USER_SCOPE_REQUIRED/);
});
test('enabled User service fails closed without a valid verified identity', async () => {
  await assert.rejects(new UserService('./data', async () => null).resolve(request), /USER_AUTHENTICATION_REQUIRED/);
  await assert.rejects(new UserService('./data', async () => ({ id: '' })).resolve(request), /USER_IDENTITY_INVALID/);
});
