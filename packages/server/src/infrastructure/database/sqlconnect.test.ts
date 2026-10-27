import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { SQLConnectService, SQLConnectError, createSQLconnectRouter, type SQLConnectDriverMap } from './sqlconnect.js';

const config = { driver: 'mysql', host: 'localhost', port: 3306, database: 'novel_test', user: 'tester', password: 'secret-value', tls: 'verify', timeoutMs: 1000 };
function fixture(t: TestContext, overrides: Partial<SQLConnectDriverMap> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-sqlconnect-'));
  const statements: string[] = [];
  let opens = 0, closes = 0;
  const driver = { async connect() { opens++; return { async execute(sql: string) { statements.push(sql); }, async close() { closes++; } }; } };
  const service = new SQLConnectService({ dataDir: dir, drivers: { mysql: driver, postgresql: driver, sqlserver: driver, ...overrides } });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, dir, statements, opens: () => opens, closes: () => closes };
}

test('offline boot, strict config, alias normalization, password preservation/clear and secure atomic persistence', t => {
  const f = fixture(t);
  assert.equal(f.opens(), 0);
  assert.equal(f.service.status().storage, 'local-json');
  assert.equal(f.service.status().configured, false);
  for (const bad of [{ ...config, extra: true }, { ...config, database: 'db; DROP DATABASE x' }, { ...config, timeoutMs: 999 }, { ...config, tls: 'off', host: 'db.example.com' }])
    assert.throws(() => f.service.saveConfig(bad), SQLConnectError);
  f.service.saveConfig({ ...config, driver: 'mssql' });
  assert.equal(f.service.status().config?.driver, 'sqlserver');
  assert.equal(JSON.stringify(f.service.status()).includes('secret-value'), false);
  const { password: _password, ...without } = config;
  f.service.saveConfig(without);
  const configPath = path.join(f.dir, 'sqlconnect.json');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).password, 'secret-value');
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  f.service.saveConfig({ ...without, password: '' });
  assert.equal(f.service.status().config?.hasPassword, false);
  assert.equal(fs.readdirSync(f.dir).length, 1);
  assert.equal(f.opens(), 0);
});

test('all dialect scripts initialize explicitly, without database creation or database interpolation, and close finally', async t => {
  for (const driver of ['mysql', 'postgresql', 'sqlserver']) {
    const f = fixture(t);
    f.service.saveConfig({ ...config, driver });
    assert.throws(() => f.service.initialize({ confirmDatabase: 'other' }), SQLConnectError);
    assert.throws(() => f.service.initialize({ confirmDatabase: config.database, scriptPath: '/arbitrary' }), SQLConnectError);
    assert.equal(f.opens(), 0);
    await f.service.test();
    assert.deepEqual(f.statements, ['SELECT 1']);
    await f.service.initialize({ confirmDatabase: config.database });
    await f.service.initialize({ confirmDatabase: config.database });
    assert.equal(f.opens(), 3);
    assert.equal(f.closes(), 3);
    const executable = f.statements.join('\n').replace(/--[^\n]*/g, '');
    assert.doesNotMatch(executable, /CREATE\s+DATABASE|\bUSE\s|^\s*GO\s*$/im);
    assert.match(executable, /novel_agent_metadata/);
    assert.match(executable, /novel_agent_projects_owner_idx/);
    assert.match(executable, /novel_agent_chapters_owner_idx/);
    assert.match(executable, /novel_agent_assets_owner_idx/);
    assert.match(executable, /novel_agent_platform_bindings_owner_idx/);
    assert.match(executable, /novel_agent_settings/);
    assert.match(executable, /FOREIGN KEY \(owner_id, project_id\) REFERENCES (?:public\.|dbo\.)?novel_agent_projects\(owner_id, project_id\)/);
    if (driver === 'mysql') assert.match(executable, /DEFAULT CHARSET=utf8mb4/);
  }
});

test('operation and config locks prevent overlapping initialization, and failures never expose credentials', async t => {
  let release!: () => void;
  let closed = 0;
  const f = fixture(t, { mysql: { async connect() { return { async execute() { await new Promise<void>(resolve => { release = resolve; }); throw new Error('secret-value internal SQL connection string'); }, async close() { closed++; } }; } } });
  f.service.saveConfig(config);
  const running = f.service.test();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().busy, true);
  await assert.rejects(f.service.test(), (error: SQLConnectError) => error.code === 'SQLCONNECT_BUSY');
  assert.throws(() => f.service.saveConfig(config), (error: SQLConnectError) => error.code === 'SQLCONNECT_BUSY');
  release();
  await assert.rejects(running, (error: SQLConnectError) => error.code === 'SQLCONNECT_FAILED' && !error.message.includes('secret-value'));
  assert.equal(closed, 1);
  assert.equal(f.service.status().busy, false);
});

test('deadline aborts driver, retains lock until late adapter settles, and late connection is closed', async t => {
  let resolveConnection!: (value: { execute(): Promise<void>; close(): Promise<void> }) => void;
  let signal: AbortSignal | undefined;
  let closed = 0;
  const f = fixture(t, { mysql: { async connect(_config, abortSignal) {
    signal = abortSignal;
    return new Promise(resolve => { resolveConnection = resolve; });
  } } });
  f.service.saveConfig(config);
  await assert.rejects(f.service.test(), (error: SQLConnectError) => error.code === 'SQLCONNECT_TIMEOUT');
  assert.equal(signal?.aborted, true);
  assert.equal(f.service.status().busy, true);
  resolveConnection({ async execute() { assert.fail('must not query late connection'); }, async close() { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(f.service.status().busy, false);
});

test('router gives only redacted status and safe generic failures; no arbitrary SQL endpoint', async t => {
  const f = fixture(t, { mysql: { async connect() { throw new Error('secret-value!'); } } });
  const app = express();
  app.use(express.json());
  app.use('/api/sqlconnect', createSQLconnectRouter(f.service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/sqlconnect`;
  const put = await fetch(`${base}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(put.status, 200);
  assert.doesNotMatch(await put.text(), /secret-value/);
  const status = await fetch(`${base}/status`);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json()).config.hasPassword, true);
  const response = await fetch(`${base}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret-value/);
  assert.equal((await fetch(`${base}/query`, { method: 'POST' })).status, 404);
  const drivers = await (await fetch(`${base}/drivers`)).json();
  assert.equal(drivers.drivers.length, 3);
});

test('malformed persisted config fails closed without opening any connection', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'sqlconnect.json'), '{broken');
  const degraded = new SQLConnectService({ dataDir: f.dir });
  assert.equal(degraded.status().available, false);
  assert.equal(degraded.status().errorCode, 'SQLCONNECT_CONFIG_UNAVAILABLE');
  assert.throws(() => degraded.saveConfig(config), (error: SQLConnectError) => error.code === 'SQLCONNECT_CONFIG_UNAVAILABLE');
  assert.equal(fs.readFileSync(path.join(f.dir, 'sqlconnect.json'), 'utf8'), '{broken');
  assert.equal(f.opens(), 0);
});
