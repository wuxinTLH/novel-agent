import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireDataLock, findAppRoot, appRoot } from './local-runtime.js';
import { fileURLToPath } from 'node:url';

test('application root stays at the workspace across source, build, and nested package manifests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-workspace-root-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'novel-agent' }));
    assert.throws(() => findAppRoot(dir), /APPLICATION_ROOT_NOT_FOUND/);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'novel-agent', workspaces: ['packages/*'] }));
    for (const relative of ['packages/server/src/core', 'build/packages/server/src/core']) {
      const nested = path.join(dir, relative);
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'space.syjx.agent.novel.server' }));
      assert.equal(findAppRoot(nested), dir);
    }
    assert.equal(appRoot, findAppRoot(path.dirname(fileURLToPath(import.meta.url))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'novel-instance-lock-'));
}

function leaveExitedOwnerLock(dir: string) {
  const moduleUrl = new URL('./local-runtime.ts', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { acquireDataLock } from ${JSON.stringify(moduleUrl)}; acquireDataLock(${JSON.stringify(dir)});`,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  return fs.readFileSync(path.join(dir, '.instance.lock'), 'utf8');
}

test('data lock rejects a live owner and release permits restart', () => {
  const dir = temporaryDirectory();
  try {
    const file = path.join(dir, '.instance.lock');
    const release = acquireDataLock(dir);
    const original = fs.readFileSync(file, 'utf8');
    assert.throws(() => acquireDataLock(dir), /数据目录已锁定/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    release();
    release();
    assert.equal(fs.existsSync(file), false);
    const releaseAgain = acquireDataLock(dir);
    assert.notEqual(fs.readFileSync(file, 'utf8'), original);
    releaseAgain();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup recovers an exited backend lock without changing project data', () => {
  const dir = temporaryDirectory();
  try {
    const manuscript = path.join(dir, 'projects.json');
    fs.writeFileSync(manuscript, 'unchanged manuscript fixture');
    const previous = leaveExitedOwnerLock(dir);
    const release = acquireDataLock(dir);
    const owner = JSON.parse(fs.readFileSync(path.join(dir, '.instance.lock'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, JSON.parse(previous).token);
    assert.equal(fs.readFileSync(manuscript, 'utf8'), 'unchanged manuscript fixture');
    assert.equal(fs.existsSync(path.join(dir, '.instance.lock.recovery')), false);
    assert.throws(() => acquireDataLock(dir), /数据目录已锁定/);
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-reboot locks recover even when their PID has been reused, but fresh files remain protected', () => {
  const dir = temporaryDirectory();
  try {
    const file = path.join(dir, '.instance.lock');
    const old = new Date(Date.now() - (os.uptime() + 3600) * 1000);
    const raw = JSON.stringify({ pid: process.pid, token: 'previous-boot', startedAt: old.toISOString() });
    fs.writeFileSync(file, raw);
    assert.throws(() => acquireDataLock(dir), /数据目录已锁定/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    fs.utimesSync(file, old, old);
    const release = acquireDataLock(dir);
    assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'previous-boot');
    assert.throws(() => acquireDataLock(dir), /数据目录已锁定/);
    release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed, incomplete, and invalid-owner locks fail closed without modification', () => {
  const dir = temporaryDirectory();
  try {
    const file = path.join(dir, '.instance.lock');
    for (const raw of [
      '',
      '{',
      'null',
      '{}',
      '{"pid":0,"token":"x"}',
      '{"pid":-1,"token":"x"}',
      '{"pid":"123","token":"x"}',
      '{"pid":2147483647}',
    ]) {
      fs.writeFileSync(file, raw);
      assert.throws(() => acquireDataLock(dir), /数据目录已锁定/);
      assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release never removes a replacement owner and concurrent recovery stays exclusive', () => {
  const dir = temporaryDirectory();
  try {
    const file = path.join(dir, '.instance.lock');
    const release = acquireDataLock(dir);
    const replacement = JSON.stringify({ pid: process.pid, token: 'different-owner' });
    fs.writeFileSync(file, replacement);
    release();
    assert.equal(fs.readFileSync(file, 'utf8'), replacement);
    fs.unlinkSync(file);
    const previous = leaveExitedOwnerLock(dir);
    const recovery = path.join(dir, '.instance.lock.recovery');
    fs.writeFileSync(recovery, JSON.stringify({ pid: process.pid }));
    assert.throws(() => acquireDataLock(dir), /数据目录锁正在恢复/);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
    fs.unlinkSync(recovery);
    acquireDataLock(dir)();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
