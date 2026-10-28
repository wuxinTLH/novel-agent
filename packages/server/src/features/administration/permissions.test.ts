import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthService } from '../auth/auth.js';
import type { OnlineMaintenanceManager } from './online-maintenance.js';
import { createAdministrationRouter } from './administration.js';

test('management endpoint permission matrix denies operations high-risk requests before execution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-role-policy-'));
  let calls = 0;
  const auth = {
    enabled: true,
    session: (req: express.Request) => ({ user: { role: req.get('x-test-role') } }),
    requireCsrf: (req: express.Request) => req.get('x-test-csrf') === 'valid',
    managementConfigured: () => true,
    router: express.Router(),
  } as unknown as AuthService;
  const manager = {
    capabilities: () => ({ backupAvailable: true }),
    list: () => [],
    create: (body: unknown) => {
      calls++;
      return body;
    },
    get: () => ({ id: 'test' }),
    cancel: () => {
      calls++;
      return {};
    },
  } as unknown as OnlineMaintenanceManager;
  const app = express();
  app.use('/api/admin', createAdministrationRouter({ dir, auth, onlineMaintenance: manager }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = (role: string, route: string, method = 'GET', body?: unknown, csrf = 'valid') =>
    fetch(`http://127.0.0.1:${address.port}/api/admin${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-role': role, 'x-test-csrf': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    for (const role of ['writer', 'user', 'garbage'])
      assert.equal((await request(role, '/status')).status, 403);
    for (const role of ['superadmin', 'admin', 'operations']) {
      assert.equal((await request(role, '/session')).status, 200);
      assert.equal((await request(role, '/status')).status, 200);
      assert.equal((await request(role, '/storage')).status, 200);
    }
    for (const route of ['/users', '/turnstile', '/account/config', '/maintenance'])
      assert.equal((await request('operations', route)).status, 403);
    assert.equal((await request('operations', '/storage', 'PUT', {})).status, 403);
    assert.equal(
      (await request('operations', '/online-maintenance/tasks', 'POST', { kind: 'restore-plan' })).status,
      403,
    );
    assert.equal((await request('operations', '/online-maintenance/tasks/test/cancel', 'POST')).status, 403);
    assert.equal(calls, 0);
    assert.equal(
      (await request('operations', '/online-maintenance/tasks', 'POST', { kind: 'backup' }, 'invalid'))
        .status,
      403,
    );
    for (const kind of ['backup', 'validate'])
      assert.equal((await request('operations', '/online-maintenance/tasks', 'POST', { kind })).status, 202);
    assert.equal(
      (await request('operations', '/online-maintenance/backups/test/validate', 'POST')).status,
      202,
    );
    assert.equal((await request('operations', '/online-maintenance/tasks/test')).status, 200);
    assert.equal(calls, 3);
    assert.equal((await request('admin', '/turnstile', 'PUT', {})).status, 403);
    assert.equal((await request('operations', '/unregistered')).status, 403);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
