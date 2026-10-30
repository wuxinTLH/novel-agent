import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import http from 'node:http';
async function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode === 200, headers: { get: name => res.headers[name] }, json: async () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Request timeout')));
  });
}
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Production artifacts and disposable data only. Host/Origin simulation is NOT TLS acceptance.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-modes-smoke-'));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
let child;
async function stop() {
  if (child && child.exitCode === null) {
    const done = once(child, 'exit');
    child.kill();
    await done;
  }
  child = undefined;
}
async function start(CoreModel, data) {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...environment, CoreModel, DATA_DIR: data, PORT: String(port), SERVE_WEB: 'false', NODE_ENV: 'production' };
  if (CoreModel === 'server') Object.assign(env, {
    NOVEL_TRUSTED_PUBLIC_ORIGIN: 'https://novel.example',
    MODEL_SECRETS_KEY: 'smoke-only-model-key-0123456789abcdef',
    PLATFORM_SECRETS_KEY: 'smoke-only-platform-key-0123456789abcdef',
  });
  let output = '';
  child = spawn(process.execPath, [path.join(temporary, 'build/packages/server/src/index.js')], { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let failure;
  child.on('error', error => { failure = error; });
  const base = `http://127.0.0.1:${port}`;
  const headers = CoreModel === 'server' ? { Host: 'novel.example', Origin: 'https://novel.example' } : {};
  for (let attempt = 0; attempt < 150; attempt++) {
    if (failure) throw failure;
    assert.equal(child.exitCode, null, `Mode startup failed: ${output}`);
    try {
      const response = await request(`${base}/api/auth/session`, headers);
      if (response.ok) {
        assert.equal((await response.json()).enabled, CoreModel === 'server');
        assert.match(output, new RegExp(CoreModel === 'local' ? '127\\.0\\.0\\.1' : '0\\.0\\.0\\.0'));
        return { base, headers };
      }
    } catch {}
    await delay(100);
  }
  throw Error(`Startup timeout: ${output}`);
}
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'] }));
  fs.cpSync(path.join(root, 'build'), path.join(temporary, 'build'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const local = await start('local', path.join(temporary, 'local-data'));
  const status = await fetch(`${local.base}/api/services/user`);
  assert.equal((await status.json()).coreModel, 'local');
  await stop();
  console.log('PASS local production startup, loopback binding and safe mode metadata');
  const data = path.join(temporary, 'server-data');
  const { runAdmin, parseAdminArguments } = await import(pathToFileURL(path.join(temporary, 'build/packages/server/src/features/administration/admin.js')).href);
  const args = (command, ...rest) => parseAdminArguments([command, '--data-dir', data, '--confirm', ...rest]);
  await runAdmin(args('bootstrap-admin', '--username', 'smokeadmin'), { CoreModel: 'server', NOVEL_BOOTSTRAP_PASSWORD: 'Orbit!Quartz-Amber-9716' });
  await runAdmin(args('enable-auth', '--no-legacy'), { CoreModel: 'server' });
  const server = await start('server', data);
  const denied = await request(`${server.base}/api/projects`, server.headers);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('cache-control'), /no-store/);
  await stop();
  const audit = fs.readFileSync(path.join(data, 'security-audit/security-audit.jsonl'), 'utf8');
  assert.match(audit, /request.accepted/);
  assert.equal(audit.includes('Orbit!'), false);
  assert.equal(audit.includes('novel.example'), false);
  console.log('PASS server production startup, authenticated boundary and mandatory projected audit');
  console.log('NOTE: no real HTTPS proxy, container or external service was exercised');
} finally {
  await stop();
  fs.rmSync(temporary, { recursive: true, force: true });
}
