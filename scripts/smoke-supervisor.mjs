import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { supervise } from '../build/packages/server/src/core/supervisor.js';

// Never discover the developer's root .env or use their DATA_DIR.
const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-guardian-smoke-'));
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({
    name: 'novel-agent', type: 'module', workspaces: ['packages/web', 'packages/server'],
  }));
  for (const dir of ['build', 'dist']) {
    fs.cpSync(path.join(root, dir), path.join(temporary, dir), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  Object.assign(env, {
    PORT: String(port), DATA_DIR: data, NODE_ENV: 'production',
    MODEL_API_KEY: '', MODEL_SECRETS_KEY: '', PLATFORM_SECRETS_KEY: '',
  });
  const signals = new EventEmitter();
  const events = [];
  let health;
  let verification;
  const code = await supervise({
    entry: path.join(temporary, 'build/packages/server/src/index.js'), cwd: temporary, env, signals,
    onEvent(event) {
      events.push(event.type);
      if (event.type === 'ready') {
        verification = (async () => {
          try {
            const response = await fetch('http://127.0.0.1:' + port + '/api/health');
            assert.equal(response.ok, true);
            health = await response.json();
          } finally { signals.emit('SIGTERM'); }
        })();
      }
    },
  });
  await verification;
  assert.equal(code, 0);
  assert.ok(health);
  assert.deepEqual(events, ['starting', 'ready', 'stopped']);
  assert.equal(fs.existsSync(path.join(data, '.instance.lock')), false);
  console.log('PASS isolated real production core readiness, HTTP health, graceful IPC stop, lock release; no restart');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
