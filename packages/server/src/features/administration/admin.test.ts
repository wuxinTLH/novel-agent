import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminMain, parseAdminArguments, runAdmin } from './admin.js';
import { acquireDataLock } from '../../core/local-runtime.js';
import { PostgresStorage } from '../../infrastructure/storage/postgres-storage.js';
import { PostgresBridge } from '../../infrastructure/storage/postgres-bridge.js';

const owner = '11111111-1111-4111-8111-111111111111';
function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'novel-admin-'));
}
function options(command: string, dir: string, ...args: string[]) {
  return parseAdminArguments([command, '--data-dir', dir, '--confirm', ...args]);
}

test('server CLI bootstrap applies the server credential policy and validates CoreModel', async () => {
  const dir = temporary();
  try {
    const command = options('bootstrap-admin', dir, '--username', 'rootadmin', '--phone', '+14155550123');
    await assert.rejects(runAdmin(command, { CoreModel: 'SERVER' }), /CORE_MODEL_INVALID/);
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    await assert.rejects(runAdmin(command, { CoreModel: 'server', NOVEL_BOOTSTRAP_PASSWORD: 'abcdefghijklmn' }));
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    const result = await runAdmin(command, { CoreModel: 'server', NOVEL_BOOTSTRAP_PASSWORD: 'Amber!Orbit-Quartz-9716' });
    assert.ok(result.ownerId);
    const document = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    assert.deepEqual(document.account.profiles.filter((profile: { userId: string }) => profile.userId === result.ownerId).map((profile: { phone: string; phoneVerified: boolean }) => [profile.phone, profile.phoneVerified]), [['+14155550123', true]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('admin arguments require explicit confirmation and ownership; reject argv passwords', () => {
  assert.throws(() => parseAdminArguments(['bootstrap-admin', '--username', 'admin']), /CONFIRM_REQUIRED/);
  assert.throws(
    () =>
      parseAdminArguments(['bootstrap-admin', '--username', 'admin', '--confirm', '--password', 'secret']),
    /ARGUMENT_INVALID/,
  );
  assert.throws(() => parseAdminArguments(['enable-auth', '--confirm']), /EXPLICIT_LEGACY_CHOICE/);
  assert.throws(() => parseAdminArguments(['disable-auth', '--confirm']), /PUBLIC_ACCESS_ACK/);
  assert.throws(() => parseAdminArguments(['assign-legacy', '--confirm']), /OWNER_REQUIRED/);
  assert.throws(
    () => parseAdminArguments(['migrate-sql', '--owner', '../escape', '--confirm']),
    /OWNER_INVALID/,
  );
  assert.throws(
    () => parseAdminArguments(['migrate-sql', '--owner', owner, '--owner', owner, '--confirm']),
    /DUPLICATE/,
  );
});

test('bootstrap, assignment and auth changes preserve originals and private backups', async () => {
  const dir = temporary();
  try {
    const legacy = JSON.stringify({ projects: [] });
    fs.writeFileSync(path.join(dir, 'projects.json'), legacy);
    const password = 'very-private-password-123';
    const bootstrap = await runAdmin(options('bootstrap-admin', dir, '--username', 'rootadmin'), {
      NOVEL_BOOTSTRAP_PASSWORD: password,
    });
    assert.ok(bootstrap.ownerId);
    assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8').includes(password), false);
    await assert.rejects(
      runAdmin(options('bootstrap-admin', dir, '--username', 'second'), {
        NOVEL_BOOTSTRAP_PASSWORD: password,
      }),
      /AUTH_ALREADY_BOOTSTRAPPED/,
    );
    await assert.rejects(runAdmin(options('enable-auth', dir, '--no-legacy')), /LEGACY_DATA_REQUIRES_OWNER/);
    await assert.rejects(runAdmin(options('assign-legacy', dir, '--owner', owner)), /OWNER_USER_NOT_FOUND/);
    const assignment = await runAdmin(options('assign-legacy', dir, '--owner', bootstrap.ownerId!));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auth-enabled.json'), 'utf8')), {
      enabled: false,
      legacyOwnerId: bootstrap.ownerId,
    });
    assert.equal(fs.readFileSync(path.join(assignment.backup, 'projects.json'), 'utf8'), legacy);
    await runAdmin(options('enable-auth', dir, '--owner', bootstrap.ownerId!));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auth-enabled.json'), 'utf8')), {
      enabled: true,
      legacyOwnerId: bootstrap.ownerId,
    });
    await runAdmin(options('disable-auth', dir, '--allow-public-access'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auth-enabled.json'), 'utf8')), {
      enabled: false,
      legacyOwnerId: bootstrap.ownerId,
    });
    assert.equal(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'), legacy);
    assert.equal(fs.existsSync(path.join(dir, '.instance.lock')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server phone flags validate before writes; local bootstrap remains unchanged', async () => {
  const dir = temporary();
  try {
    assert.throws(() => options('bootstrap-admin', dir, '--username', 'admin', '--phone', '4155550123'), /ADMIN_PHONE_INVALID/);
    assert.throws(() => options('set-phone', dir, '--username', 'admin'), /ADMIN_PHONE_REQUIRED/);
    assert.throws(() => options('set-phone', dir, '--phone', '+14155550123'), /ADMIN_USERNAME_INVALID/);
    assert.throws(() => options('set-phone', dir, '--username', 'admin', '--phone', '+0123456789'), /ADMIN_PHONE_INVALID/);
    assert.throws(() => options('set-phone', dir, '--username', 'admin', '--phone', '+14155550123', '--phone', '+14155550123'), /ADMIN_DUPLICATE_ARGUMENT/);
    assert.throws(() => options('disable-auth', dir, '--allow-public-access', '--phone', '+14155550123'), /ADMIN_PHONE_NOT_APPLICABLE/);
    assert.throws(() => options('set-phone', dir, '--username', 'admin', '--phone=+14155550123'), /ADMIN_ARGUMENT_INVALID/);
    await assert.rejects(runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), { CoreModel: 'server', NOVEL_BOOTSTRAP_PASSWORD: 'Amber!Orbit-Quartz-9716' }), /ADMIN_PHONE_REQUIRED/);
    await assert.rejects(runAdmin(options('bootstrap-admin', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'local', NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123' }), /ADMIN_PHONE_SERVER_ONLY/);
    await assert.rejects(runAdmin(options('set-phone', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'local' }), /ADMIN_SERVER_ONLY/);
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    const result = await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), { NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123' });
    assert.ok(result.ownerId);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('offline set-phone provisions verified phone and never returns it', async () => {
  const dir = temporary();
  try {
    const boot = await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), { NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123' });
    const lock = acquireDataLock(dir);
    try {
      await assert.rejects(runAdmin(options('set-phone', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'server' }), /数据目录已锁定/);
    } finally { lock(); }
    await assert.rejects(runAdmin(options('set-phone', dir, '--username', 'unknown', '--phone', '+14155550123'), { CoreModel: 'server' }), /ADMIN_PHONE_USER_NOT_FOUND/);
    const changed = await runAdmin(options('set-phone', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'server' });
    assert.equal(JSON.stringify(changed).includes('+14155550123'), false);
    assert.equal(changed.ownerId, undefined);
    const document = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    assert.ok(document.account.profiles.some((profile: { userId: string; phone: string; phoneVerified: boolean }) => profile.userId === boot.ownerId && profile.phone === '+14155550123' && profile.phoneVerified));
    const manifest = JSON.parse(fs.readFileSync(path.join(changed.backup, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.command, 'set-phone');
    assert.equal(manifest.files.some((file: { name: string }) => file.name === 'auth.json'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('set-phone updates SQL-backed auth after verified snapshot', async (t) => {
  const dir = temporary();
  try {
    const boot = await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), { NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123' });
    let authContent = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'sqlconnect.json'), JSON.stringify({ driver: 'postgresql', host: 'localhost', port: 5432, database: 'novel', user: 'admin' }));
    fs.writeFileSync(path.join(dir, 'business-storage.json'), JSON.stringify({ backend: 'postgresql', ownerId: boot.ownerId, migrationHash: 'a'.repeat(64), version: 1 }));
    t.mock.method(PostgresStorage.prototype, 'readDocument', async (_ownerId: string, key: string) => key === 'auth.json' ? { revision: 1, content: authContent } : null);
    t.mock.method(PostgresStorage.prototype, 'close', async () => {});
    t.mock.method(PostgresBridge.prototype, 'read', (key: string) => key === 'auth.json' ? authContent : null);
    const write = t.mock.method(PostgresBridge.prototype, 'write', (key: string, content: string) => {
      assert.equal(key, 'auth.json');
      authContent = content;
    });
    const changed = await runAdmin(options('set-phone', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'server' });
    assert.equal(write.mock.callCount(), 1);
    assert.ok(JSON.parse(authContent).account.profiles.some((profile: { phone: string; phoneVerified: boolean }) => profile.phone === '+14155550123' && profile.phoneVerified));
    const snapshot = JSON.parse(fs.readFileSync(path.join(changed.backup, 'postgres-snapshot.json'), 'utf8'));
    assert.equal(snapshot.snapshots.find((entry: { key: string }) => entry.key === 'auth.json').document.content.includes('+14155550123'), false);
    assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8').includes('+14155550123'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('atomic server bootstrap and set-phone do not write on storage failure', async (t) => {
  const dir = temporary();
  const originalRename = fs.renameSync;
  const write = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]) === path.join(dir, 'auth.json')) throw new Error('private phone write failure');
    return originalRename(...args);
  });
  try {
    await assert.rejects(runAdmin(options('bootstrap-admin', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'server', NOVEL_BOOTSTRAP_PASSWORD: 'Amber!Orbit-Quartz-9716' }), /AUTH_STORAGE_UNAVAILABLE/);
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    write.mock.restore();
    await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), { NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123' });
    const before = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === path.join(dir, 'auth.json')) throw new Error('private phone write failure');
      return originalRename(...args);
    });
    await assert.rejects(runAdmin(options('set-phone', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'server' }), /AUTH_STORAGE_UNAVAILABLE/);
    assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('set-phone revokes existing sessions and refresh families', async () => {
  const dir = temporary();
  try {
    const boot = await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), { NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123' });
    const file = path.join(dir, 'auth.json');
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    document.sessions.push({ tokenHash: 'a'.repeat(64), userId: boot.ownerId, csrfToken: 'b'.repeat(64), expiresAt: Date.now() + 10000 });
    document.refreshFamilies = [{ id: 'c'.repeat(32), userId: boot.ownerId, tokenHash: 'd'.repeat(64), sessionHash: 'a'.repeat(64), issuedAt: Date.now(), lastActiveAt: Date.now(), expiresAt: Date.now() + 10000 }];
    fs.writeFileSync(file, JSON.stringify(document));
    await runAdmin(options('set-phone', dir, '--username', 'admin', '--phone', '+14155550123'), { CoreModel: 'server' });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.sessions.length, 0);
    assert.equal(after.refreshFamilies.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('administration rejects running server and malformed JSON', async () => {
  const dir = temporary();
  try {
    const release = acquireDataLock(dir);
    try {
      await assert.rejects(runAdmin(options('disable-auth', dir, '--allow-public-access')), /数据目录已锁定/);
    } finally {
      release();
    }
    fs.writeFileSync(path.join(dir, 'projects.json'), '{broken');
    await assert.rejects(
      runAdmin(options('disable-auth', dir, '--allow-public-access')),
      /LEGACY_JSON_INVALID/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'auth-enabled.json')), false);
    fs.writeFileSync(path.join(dir, 'projects.json'), '{}');
    fs.writeFileSync(path.join(dir, 'auth-enabled.json'), '{"enabled":true}');
    await assert.rejects(
      runAdmin(options('disable-auth', dir, '--allow-public-access')),
      /AUTH_CONFIG_INVALID/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration imports and verifies before activating; mocked storage never contacts network', async (t) => {
  const dir = temporary();
  const rows = new Map<string, { revision: number; content: string }>();
  const key = (ownerId: string, name: string) => `${ownerId}/${name}`;
  t.mock.method(PostgresStorage.prototype, 'migrate', async () => {});
  t.mock.method(PostgresStorage.prototype, 'close', async () => {});
  t.mock.method(
    PostgresStorage.prototype,
    'readDocument',
    async (ownerId: string, name: string) => rows.get(key(ownerId, name)) ?? null,
  );
  t.mock.method(
    PostgresStorage.prototype,
    'writeDocument',
    async (ownerId: string, name: string, content: string) => {
      rows.set(key(ownerId, name), { revision: 1, content });
      return 1;
    },
  );
  t.mock.method(
    PostgresStorage.prototype,
    'importDocuments',
    async (ownerId: string, _hash: string, documents: { key: string; content: string }[]) => {
      assert.equal(fs.existsSync(path.join(dir, 'business-storage.json')), false);
      for (const document of documents)
        rows.set(key(ownerId, document.key), { revision: 1, content: document.content });
      return { imported: true, count: documents.length };
    },
  );
  try {
    const bootstrap = await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), {
      NOVEL_BOOTSTRAP_PASSWORD: 'never-print-me-123',
    });
    fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
    fs.writeFileSync(
      path.join(dir, 'sqlconnect.json'),
      JSON.stringify({
        driver: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'novel',
        user: 'admin',
      }),
    );
    await runAdmin(options('migrate-sql', dir, '--owner', bootstrap.ownerId!));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'business-storage.json'), 'utf8'));
    assert.equal(manifest.ownerId, bootstrap.ownerId);
    assert.match(manifest.migrationHash, /^[a-f0-9]{64}$/);
    assert.equal(
      rows.get(key('00000000-0000-4000-8000-000000000001', 'auth.json'))?.content,
      fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'),
    );
    assert.equal(fs.existsSync(path.join(dir, 'projects.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration rejects structurally invalid legacy docs before any database call', async (t) => {
  const dir = temporary();
  const migrate = t.mock.method(PostgresStorage.prototype, 'migrate', async () => {
    throw new Error('UNEXPECTED_DATABASE_CALL');
  });
  try {
    fs.writeFileSync(path.join(dir, 'projects.json'), '{}');
    await assert.rejects(
      runAdmin(options('migrate-sql', dir, '--owner', owner)),
      /ADMIN_LEGACY_DOCUMENT_INVALID/,
    );
    assert.equal(migrate.mock.callCount(), 0);
    assert.equal(fs.existsSync(path.join(dir, 'business-storage.json')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'), '{}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-legacy authenticated migration requires owner assignment before database writes', async (t) => {
  const dir = temporary();
  const migrate = t.mock.method(PostgresStorage.prototype, 'migrate', async () => {
    throw new Error('UNEXPECTED_DATABASE_CALL');
  });
  try {
    const bootstrap = await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), {
      NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123',
    });
    await runAdmin(options('enable-auth', dir, '--no-legacy'));
    const before = fs.readFileSync(path.join(dir, 'auth-enabled.json'), 'utf8');
    await assert.rejects(
      runAdmin(options('migrate-sql', dir, '--owner', bootstrap.ownerId!)),
      /ADMIN_SQL_AUTH_OWNER_ASSIGNMENT_REQUIRED/,
    );
    assert.equal(migrate.mock.callCount(), 0);
    assert.equal(fs.existsSync(path.join(dir, 'business-storage.json')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'auth-enabled.json'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-legacy cannot orphan uploads or unknown secret files', async () => {
  const dir = temporary();
  try {
    await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), {
      NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123',
    });
    fs.mkdirSync(path.join(dir, 'uploads'));
    await assert.rejects(
      runAdmin(options('enable-auth', dir, '--no-legacy')),
      /ADMIN_LEGACY_DATA_REQUIRES_OWNER/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'auth-enabled.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration readback failure does not activate PostgreSQL', async (t) => {
  const dir = temporary();
  t.mock.method(PostgresStorage.prototype, 'migrate', async () => {});
  t.mock.method(PostgresStorage.prototype, 'close', async () => {});
  t.mock.method(PostgresStorage.prototype, 'importDocuments', async () => ({ imported: true, count: 1 }));
  t.mock.method(PostgresStorage.prototype, 'readDocument', async () => null);
  try {
    const bootstrap = await runAdmin(options('bootstrap-admin', dir, '--username', 'admin'), {
      NOVEL_BOOTSTRAP_PASSWORD: 'private-fixture-123',
    });
    fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
    fs.writeFileSync(
      path.join(dir, 'sqlconnect.json'),
      JSON.stringify({
        driver: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'novel',
        user: 'admin',
      }),
    );
    await assert.rejects(
      runAdmin(options('migrate-sql', dir, '--owner', bootstrap.ownerId!)),
      /ADMIN_IMPORT_VERIFICATION_FAILED/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'business-storage.json')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'), '[]');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI errors never echo password or untrusted arguments', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (value: string) => errors.push(value));
  const exit = await adminMain([
    'bootstrap-admin',
    '--confirm',
    '--username',
    'admin',
    '--password',
    'do-not-echo',
  ]);
  assert.equal(exit, 1);
  assert.deepEqual(errors, ['ADMIN_ARGUMENT_INVALID']);
  const phone = 'private-invalid-phone';
  const phoneExit = await adminMain(['set-phone', '--username', 'admin', '--phone', phone, '--confirm']);
  assert.equal(phoneExit, 1);
  assert.deepEqual(errors, ['ADMIN_ARGUMENT_INVALID', 'ADMIN_PHONE_INVALID']);
  assert.equal(errors.join(' ').includes(phone), false);
});
