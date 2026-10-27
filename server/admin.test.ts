import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminMain, parseAdminArguments, runAdmin } from './admin.js';
import { acquireDataLock } from './local-runtime.js';
import { PostgresStorage } from './models/postgres-storage.js';

const owner = '11111111-1111-4111-8111-111111111111';
function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'novel-admin-'));
}
function options(command: string, dir: string, ...args: string[]) {
  return parseAdminArguments([command, '--data-dir', dir, '--confirm', ...args]);
}

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
});
