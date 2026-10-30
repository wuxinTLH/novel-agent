import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readCoreModel, coreModelBindHost, assertCoreModelGateway, assertCoreModelOrigin } from './core-model.js';
import { readLocalGatewayConfig } from './local-gateway.js';
import { appRoot } from './local-runtime.js';

test('CoreModel accepts only exact local/server values and defaults to local', () => {
  assert.equal(readCoreModel({}), 'local');
  assert.equal(readCoreModel({ CoreModel: 'local' }), 'local');
  assert.equal(readCoreModel({ CoreModel: 'server' }), 'server');
  // Differently cased variable names do not opt in to network exposure.
  assert.equal(readCoreModel({ CORE_MODEL: 'server', COREMODEL: 'server', coremodel: 'server' }), 'local');
  for (const CoreModel of ['', 'LOCAL', 'Server', ' server', 'server ', 'remote', 'standard', 'hardened'])
    assert.throws(() => readCoreModel({ CoreModel }), /CORE_MODEL_INVALID/);
  assert.equal(coreModelBindHost('local'), '127.0.0.1');
  assert.equal(coreModelBindHost('server'), '0.0.0.0');
});

test('local mode accepts only loopback trusted origins, while server supports remote HTTPS', () => {
  assert.doesNotThrow(() => assertCoreModelOrigin('local'));
  for (const trustedOrigin of ['https://localhost', 'https://127.0.0.1:3443', 'https://[::1]'])
    assert.doesNotThrow(() => assertCoreModelOrigin('local', trustedOrigin));
  for (const trustedOrigin of ['https://novel.example', 'https://192.168.1.2', 'https://localhost.evil'])
    assert.throws(() => assertCoreModelOrigin('local', trustedOrigin), /LOCAL_PUBLIC_ORIGIN_FORBIDDEN/);
  assert.doesNotThrow(() => assertCoreModelOrigin('server', 'https://novel.example'));
});

test('local mode rejects nonloopback gateway host configuration without changing the gateway', () => {
  const env = { GATEWAY_ENABLED: 'true', GATEWAY_PORTS: '3102' };
  const config = readLocalGatewayConfig(env, 3001);
  assert.doesNotThrow(() => assertCoreModelGateway('local', config, env));
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    assert.doesNotThrow(() => assertCoreModelGateway('local', { ...config, host }, {}));
    assert.doesNotThrow(() => assertCoreModelGateway('local', config, { GATEWAY_HOST: host }));
  }
  for (const host of ['', '0.0.0.0', '::', '192.168.1.2', 'example.com', '127.1', '127.0.0.1.evil']) {
    assert.throws(() => assertCoreModelGateway('local', { ...config, host }, {}), /LOCAL_GATEWAY_LOOPBACK_REQUIRED/);
    assert.throws(() => assertCoreModelGateway('local', config, { GATEWAY_HOST: host }), /LOCAL_GATEWAY_LOOPBACK_REQUIRED/);
  }
});

test('invalid mode and server prerequisites fail before creating a data directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-core-model-preflight-'));
  try {
    const cases = [
      { CoreModel: 'SERVER', error: 'CORE_MODEL_INVALID' },
      { CoreModel: 'server', SECURITY_PROFILE: 'standard', error: 'SERVER_SECURITY_PROFILE_CONFLICT' },
      { CoreModel: 'server', SECURITY_AUDIT: 'false', error: 'SERVER_SECURITY_AUDIT_CONFLICT' },
      { CoreModel: 'server', error: 'HARDENED_AUTH_REQUIRED' },
      { CoreModel: 'local', GATEWAY_HOST: '0.0.0.0', error: 'LOCAL_GATEWAY_LOOPBACK_REQUIRED' },
      { CoreModel: 'local', NOVEL_TRUSTED_PUBLIC_ORIGIN: 'https://novel.example', error: 'LOCAL_PUBLIC_ORIGIN_FORBIDDEN' },
    ];
    for (const [index, scenario] of cases.entries()) {
      const dir = path.join(root, String(index));
      const { error, ...overrides } = scenario;
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of ['CoreModel', 'SECURITY_PROFILE', 'SECURITY_AUDIT', 'GATEWAY_ENABLED', 'GATEWAY_HOST', 'NOVEL_TRUSTED_PUBLIC_ORIGIN']) delete env[key];
      Object.assign(env, { PORT: '3001', DATA_DIR: dir, GATEWAY_ENABLED: 'false', NOVEL_TRUSTED_PUBLIC_ORIGIN: '', SECURITY_PROFILE: undefined, SECURITY_AUDIT: undefined }, overrides);
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], {
        cwd: appRoot, env, encoding: 'utf8', timeout: 30_000,
      });
      assert.ifError(child.error);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, new RegExp(error));
      assert.equal(fs.existsSync(dir), false, `${error} must not create the data directory`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
