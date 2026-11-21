import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
// Undici strips Host overrides: use real node:http to exercise proxy authority headers.
async function wireFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method || 'GET', headers: init.headers as Record<string, string> }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
    }); req.on('error', reject); if (init.body) req.write(init.body); req.end();
  });
}
import { acquireDataLock } from '../../core/local-runtime.js';
import { AuthService } from '../auth/auth.js';
import { realSQLConnectDrivers } from '../../infrastructure/database/sqlconnect-drivers.js';
import { readStorageProfiles, readStorageManifest } from '../../infrastructure/storage/storage-config.js';
import { createInitializationApplication } from './application.js';
import { completeInitialization, initConfig, initToken, isFreshInitDirectory, loadServerInitEnvironment } from './state.js';

const values = { NOVEL_TRUSTED_PUBLIC_ORIGIN: 'https://novel.example', MODEL_SECRETS_KEY: 'm'.repeat(32), PLATFORM_SECRETS_KEY: 'p'.repeat(32), NOVEL_SMS_PROVIDER: 'aliyun', NOVEL_SMS_ALIYUN_ACCESS_KEY_ID: 'fixture-id', NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET: 'fixture-secret', NOVEL_SMS_ALIYUN_SIGN_NAME: 'fixture', NOVEL_SMS_ALIYUN_TEMPLATE_CODE: 'SMS_123' };
const input = () => ({ values: { ...values }, username: 'owner', phone: '+8613800000000', password: 'Strong unrelated phrase 927!' });
function temporary(t: test.TestContext) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-init-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('database defaults to explicit local JSON, with no SQL manifest or profile', t => {
  const dir = temporary(t); completeInitialization(dir, {}, input());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'init-storage.json'), 'utf8')), {
    version: 1, mode: 'local-json', activeBackend: 'local-json', schemaInitialized: false, sqlActivation: 'deferred-offline',
  });
  assert.equal(readStorageProfiles(dir), null); assert.equal(readStorageManifest(dir), null);
});
test('SQL deferred bootstrap saves v3 profiles offline, redacts env password and snapshots env precedence', t => {
  const connections = Object.values(realSQLConnectDrivers).map(driver => t.mock.method(driver, 'connect', async () => { throw new Error('Unexpected database connection'); }));
  const dir = temporary(t);
  const env = { NOVEL_INIT_DB_MODE: 'sql-later', NOVEL_INIT_DB_DRIVER: 'postgresql', NOVEL_INIT_DB_HOST: 'bootstrap.invalid',
    NOVEL_INIT_DB_PORT: '5432', NOVEL_INIT_DB_DATABASE: 'novel', NOVEL_INIT_DB_USER: 'owner', NOVEL_INIT_DB_PASSWORD: 'env-password', NOVEL_INIT_DB_TLS: 'verify' };
  const publicConfig = initConfig(env).database!;
  assert.equal(publicConfig.connection?.hasPassword, true);
  assert.equal('password' in publicConfig.connection!, false);
  assert.equal(JSON.stringify(initConfig(env)).includes('env-password'), false);
  assert.ok(publicConfig.environmentFields.includes('password'));
  completeInitialization(dir, env, { ...input(), database: { mode: 'local-json' } });
  const saved = readStorageProfiles(dir)!;
  assert.equal(saved.profiles[0].connection.password, 'env-password');
  assert.equal(saved.profiles[0].connection.host, 'bootstrap.invalid');
  assert.equal(readStorageManifest(dir), null);
  assert.equal(fs.existsSync(path.join(dir, 'sqlconnect.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'init-storage.json'), 'utf8')).mode, 'sql-later');
  for (const connect of connections) assert.equal(connect.mock.callCount(), 0);
});
test('deferred SQL supports all existing dialects and keeps local auth usable after restart', t => {
  for (const driver of ['mysql', 'postgresql', 'sqlserver', 'mssql']) {
    const dir = temporary(t);
    completeInitialization(dir, {}, { ...input(), database: { mode: 'sql-later', connection: {
      driver, host: 'db.invalid', port: 5432, database: 'novel', user: 'owner', password: 'fixture', tls: 'verify', timeoutMs: 10000,
    } } });
    assert.equal(readStorageProfiles(dir)!.profiles[0].connection.driver, driver === 'mssql' ? 'sqlserver' : driver);
    const restartedEnv = {}; loadServerInitEnvironment(dir, restartedEnv);
    assert.equal(readStorageManifest(dir), null);
    assert.ok(new AuthService({ dataDir: dir, enabled: true, securityProfile: 'server' }).hasSuperadmin());
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'storage-profiles.json')).mode & 0o777, 0o600);
  }
});
test('SQL profile write failure leaves journal and does not enable business storage', t => {
  const dir = temporary(t); const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith('storage-profiles.json')) throw new Error('injected profile failure');
    return rename(from, to);
  });
  assert.throws(() => completeInitialization(dir, { NOVEL_INIT_DB_MODE: 'sql-later', NOVEL_INIT_DB_DRIVER: 'mysql', NOVEL_INIT_DB_HOST: 'db.invalid',
    NOVEL_INIT_DB_PORT: '3306', NOVEL_INIT_DB_DATABASE: 'novel', NOVEL_INIT_DB_USER: 'owner' }, input()), /injected profile failure/);
  assert.ok(fs.existsSync(path.join(dir, '.init-journal.json')));
  assert.equal(readStorageManifest(dir), null); assert.equal(fs.existsSync(path.join(dir, 'auth-enabled.json')), false);
  assert.throws(() => loadServerInitEnvironment(dir, {}), /INIT_RECOVERY_REQUIRED/);
});
test('SQL partial environment is public-prefilled and strict invalid input never writes', t => {
  const partial = initConfig({ NOVEL_INIT_DB_HOST: 'db.invalid', NOVEL_INIT_DB_PASSWORD: 'private' }).database!;
  assert.equal(partial.connection?.host, 'db.invalid'); assert.equal(partial.connection?.hasPassword, true);
  for (const database of [ { mode: 'sql-later' }, { mode: 'unknown' }, { mode: 'local-json', connection: {} } ]) {
    const dir = temporary(t); assert.throws(() => completeInitialization(dir, {}, { ...input(), database })); assert.deepEqual(fs.readdirSync(dir), []);
  }
  for (const env of [ { NOVEL_INIT_DB_PORT: '1e3' }, { NOVEL_INIT_DB_MODE: 'sql' }, { NOVEL_INIT_DB_TLS: 'insecure' } ]) {
    const dir = temporary(t); assert.throws(() => completeInitialization(dir, env, input())); assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('regional Init phone validation rejects invalid national numbers before writes and accepts NANP', t => {
  for (const phone of ['+8612800000000', '+12021550123', '+442071838750', '13800000000']) {
    const dir = temporary(t);
    assert.throws(() => completeInitialization(dir, {}, { ...input(), phone }));
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  const dir = temporary(t);
  completeInitialization(dir, {}, { ...input(), phone: '+12025550123' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  assert.equal(saved.account.profiles[0].phone, '+12025550123');
});

test('fresh directory only, lock ownership, generated token private and stable', t => {
  const dir = temporary(t); assert.equal(isFreshInitDirectory(dir), true);
  const release = acquireDataLock(dir); t.after(release);
  assert.throws(() => acquireDataLock(dir));
  const first = initToken(dir, {}); assert.ok(first.token.length >= 32); assert.equal(initToken(dir, {}).token, first.token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.init-token')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}'); assert.equal(isFreshInitDirectory(dir), false);
});
test('successful bootstrap persists existing auth format and environment precedence on restart', t => {
  const dir = temporary(t); const release = acquireDataLock(dir); t.after(release);
  completeInitialization(dir, { MODEL_SECRETS_KEY: 'e'.repeat(32) }, input()); assert.equal(isFreshInitDirectory(dir), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'server-init.json'), 'utf8')).values.MODEL_SECRETS_KEY, 'e'.repeat(32));
  assert.throws(() => completeInitialization(dir, {}, input()));
  const env: NodeJS.ProcessEnv = { MODEL_SECRETS_KEY: 'override'.repeat(8), NOVEL_SMS_PROVIDER: '' };
  loadServerInitEnvironment(dir, env); assert.equal(env.MODEL_SECRETS_KEY, 'override'.repeat(8)); assert.equal(env.NOVEL_SMS_PROVIDER, 'aliyun');
  const auth = new AuthService({ dataDir: dir, enabled: true, securityProfile: 'server' }); assert.ok(auth.hasSuperadmin());
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')); assert.equal(saved.sessions.length, 0); assert.equal(saved.account.profiles[0].phoneVerified, true);
  assert.equal(fs.readFileSync(path.join(dir, 'auth.key')).length, 32);
  const config = initConfig(values); assert.equal(config.fields.find(f => f.key === 'MODEL_SECRETS_KEY')?.value, undefined);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'server-init.json')).mode & 0o777, 0o600);
});
test('invalid input is read-only; partial commit journal and malformed persistence fail closed', t => {
  const dir = temporary(t);
  assert.throws(() => completeInitialization(dir, {}, { ...input(), password: 'short' })); assert.deepEqual(fs.readdirSync(dir), []);
  assert.throws(() => completeInitialization(dir, {}, { ...input(), values: { ...values, BAD: 'x' } }));
  assert.throws(() => completeInitialization(dir, {}, { ...input(), phone: '123' }));
  assert.throws(() => completeInitialization(dir, { MODEL_SECRETS_KEY: 'x'.repeat(4097) }, input()));
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.writeFileSync(path.join(dir, '.init-journal.json'), '{}'); assert.throws(() => loadServerInitEnvironment(dir, {}), /INIT_RECOVERY_REQUIRED/); assert.throws(() => isFreshInitDirectory(dir), /INIT_RECOVERY_REQUIRED/);
  fs.unlinkSync(path.join(dir, '.init-journal.json')); fs.writeFileSync(path.join(dir, 'server-init.json'), '{"version":2,"values":{}}'); assert.throws(() => loadServerInitEnvironment(dir, {}), /SERVER_INIT_CONFIG_INVALID/);
});
test('write failure leaves recovery journal and never permits automatic retry', t => {
  const dir = temporary(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith('auth.json')) throw new Error('injected write failure');
    return rename(from, to);
  });
  assert.throws(() => completeInitialization(dir, {}, input()), /injected write failure/);
  assert.ok(fs.existsSync(path.join(dir, '.init-journal.json')));
  assert.equal(fs.existsSync(path.join(dir, 'auth-enabled.json')), false);
  assert.throws(() => loadServerInitEnvironment(dir, {}), /INIT_RECOVERY_REQUIRED/);
  assert.throws(() => completeInitialization(dir, {}, input()), /INIT_RECOVERY_REQUIRED/);
});

test('HTTP isolation: exact origin, token only in header, JSON bounds, no business and one-shot completion', async t => {
  const dir = temporary(t); const release = acquireDataLock(dir); t.after(release);
  const token = 't'.repeat(32); const runtime = createInitializationApplication({ dir, env: { NOVEL_INIT_TOKEN: token }, serveWeb: false });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = 'http://127.0.0.1:' + address.port;
  const request = (route: string, init: RequestInit = {}) => wireFetch(base + route, init);
  assert.deepEqual(await (await request('/api/init/status')).json(), { required: true });
  for (const route of ['/api/auth/session', '/api/projects', '/api/admin', '/uploads/test', '/']) assert.equal((await request(route)).status, 404);
  assert.equal((await request('/api/init/config')).status, 401);
  assert.equal((await request('/api/init/config?token=' + token)).status, 400);
  assert.equal((await request('/api/init/config', { headers: { 'X-Init-Token': token, Origin: 'http://localhost:' + address.port } })).status, 403);
  assert.equal((await request('/api/init/config', { headers: { 'X-Init-Token': token, Origin: 'null' } })).status, 403);
  assert.equal((await request('/api/init/config', { headers: { 'X-Init-Token': token, Host: 'localhost:5173' } })).status, 403);
  assert.equal((await request('/api/init/status', { method: 'HEAD' })).status, 405);
  assert.equal((await request('/api/init/config', { headers: { 'X-Init-Token': token, 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-For': '198.51.100.1' } })).status, 200);
  assert.equal((await request('/api/init/config', { headers: { 'X-Init-Token': token, Host: '192.168.1.2:' + address.port } })).status, 403);
  assert.equal((await request('/api/init/config', { headers: { 'X-Init-Token': token, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const config = await request('/api/init/config', { headers: { 'X-Init-Token': token } }); assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/init/complete', { method: 'POST', headers: { 'X-Init-Token': token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=x' })).status, 415);
  assert.equal((await request('/api/init/complete', { method: 'POST', headers: { 'X-Init-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(70000) }) })).status, 413);
  const submit = () => request('/api/init/complete', { method: 'POST', headers: { 'X-Init-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(input()) });
  const results = await Promise.all([submit(), submit()]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(await (await request('/api/init/status')).json(), { required: false, restartRequired: true });
  assert.equal((await request('/api/init/config', { headers: { 'X-Init-Token': token } })).status, 409);
});
test('status fails closed after an incomplete commit instead of offering retry', async t => {
  const dir = temporary(t);
  const runtime = createInitializationApplication({ dir, env: { NOVEL_INIT_TOKEN: 't'.repeat(32) }, serveWeb: false });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  fs.writeFileSync(path.join(dir, '.init-journal.json'), '{}');
  const response = await wireFetch('http://127.0.0.1:' + address.port + '/api/init/status');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'INIT_RECOVERY_REQUIRED');
});

test('trusted HTTPS origin is exclusive and rate limiting is bounded', async t => {
  const dir = temporary(t); const token = 't'.repeat(32); const runtime = createInitializationApplication({ dir, env: { NOVEL_INIT_TOKEN: token, NOVEL_TRUSTED_PUBLIC_ORIGIN: values.NOVEL_TRUSTED_PUBLIC_ORIGIN } });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = 'http://127.0.0.1:' + address.port;
  assert.equal((await wireFetch(base + '/api/init/status')).status, 403);
  const headers = { Host: 'novel.example', Origin: 'https://novel.example', 'X-Init-Token': token };
  assert.equal((await wireFetch(base + '/api/init/config', { headers })).status, 200);
  assert.equal((await wireFetch(base + '/api/init/config', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  for (let i = 0; i < 20; i++) await wireFetch(base + '/api/init/config', { headers });
  assert.equal((await wireFetch(base + '/api/init/config', { headers })).status, 429);
});
