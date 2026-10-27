import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseMaintenanceArguments, runMaintenance } from './maintenance-cli.js';
import { backupFull } from './maintenance.js';

const owner = '11111111-1111-4111-8111-111111111111';
test('maintenance parses explicit offline commands and resolves paths', () => {
  const backup = parseMaintenanceArguments([
    'backup',
    '--destination',
    'private-backup',
    '--data-dir',
    'local-data',
    '--confirm',
  ]);
  assert.equal(backup.command, 'backup');
  assert.equal(backup.destination, path.resolve('private-backup'));
  assert.equal(backup.dataDir, path.resolve('local-data'));
  const restore = parseMaintenanceArguments([
    'restore',
    '--source',
    'backup',
    '--database-config',
    'target-profiles.json',
    '--replace',
    '--confirm',
  ]);
  assert.equal(restore.databaseConfig, path.resolve('target-profiles.json'));
  assert.equal(restore.replace, true);
  const migration = parseMaintenanceArguments([
    'migrate-all',
    '--owner',
    owner,
    '--destination',
    'migration-backup',
    '--confirm',
  ]);
  assert.equal(migration.owner, owner);
  assert.equal(migration.destination, path.resolve('migration-backup'));
});

test('confirmation, required owner and strict option applicability fail closed', () => {
  const cases = [
    ['backup', '--destination', 'backup'],
    ['backup', '--confirm'],
    ['restore', '--confirm'],
    ['migrate-all', '--confirm'],
    ['migrate-all', '--owner', owner, '--confirm'],
    ['migrate-all', '--destination', 'backup', '--confirm'],
    ['migrate-all', '--owner', 'invalid', '--destination', 'backup', '--confirm'],
    [
      'migrate-all',
      '--owner',
      '00000000-0000-4000-8000-000000000001',
      '--destination',
      'backup',
      '--confirm',
    ],
    ['backup', '--destination', 'backup', '--replace', '--confirm'],
    ['backup', '--destination', 'backup', '--database-config', 'config', '--confirm'],
    ['restore', '--source', 'backup', '--owner', owner, '--confirm'],
    ['restore', '--source', 'backup', '--source', 'other', '--confirm'],
    ['backup', '--destination', '--confirm'],
    ['backup', '--destination', 'backup', '--confirm', '--confirm'],
    ['backup', '--destination', 'backup', '--unknown', '--confirm'],
    ['enable-auth', '--confirm'],
  ];
  for (const args of cases) assert.throws(() => parseMaintenanceArguments(args), /^Error: MAINTENANCE_/);
});

test('legacy SQL backup is explicitly unsupported, never silently local-only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-maintenance-cli-'));
  try {
    fs.writeFileSync(
      path.join(root, 'business-storage.json'),
      JSON.stringify({ backend: 'postgresql', version: 1, ownerId: owner, migrationHash: 'a'.repeat(64) }),
    );
    await assert.rejects(
      runMaintenance(
        parseMaintenanceArguments([
          'backup',
          '--data-dir',
          root,
          '--destination',
          root + '-backup',
          '--confirm',
        ]),
      ),
      /MAINTENANCE_LEGACY_SQL_BACKUP_UNSUPPORTED/,
    );
    assert.equal(fs.existsSync(root + '-backup'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local complete backup and restore preserve bytes and do not enable auth', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-maintenance-cli-local-'));
  const root = path.join(base, 'source'),
    archive = path.join(base, 'archive'),
    restored = path.join(base, 'restored');
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, 'uploads'));
    const bytes = Buffer.from([0, 255, 42, 128, 3]);
    fs.writeFileSync(path.join(root, 'uploads', 'binary.bin'), bytes);
    fs.writeFileSync(
      path.join(root, 'auth-enabled.json'),
      JSON.stringify({ enabled: false, legacyOwnerId: null }),
    );
    await runMaintenance(
      parseMaintenanceArguments(['backup', '--data-dir', root, '--destination', archive, '--confirm']),
    );
    await runMaintenance(
      parseMaintenanceArguments(['restore', '--data-dir', restored, '--source', archive, '--confirm']),
    );
    assert.deepEqual(fs.readFileSync(path.join(restored, 'uploads', 'binary.bin')), bytes);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(restored, 'auth-enabled.json'), 'utf8')).enabled,
      false,
    );
    assert.equal(fs.existsSync(path.join(restored, '.instance.lock')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('SQL archive restoration requires explicit target config before any archive connection can open', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-maintenance-cli-sql-'));
  try {
    const root = path.join(base, 'source'),
      archive = path.join(base, 'archive');
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, 'business-storage.json'),
      JSON.stringify({ backend: 'relational', version: 3, ownerId: owner, migrationHash: 'a'.repeat(64) }),
    );
    fs.writeFileSync(path.join(root, 'storage-profiles.json'), 'never read connection data from here');
    await backupFull({
      dataDir: root,
      destination: archive,
      runtimeStopped: true,
      backend: {
        profileIds: ['source-profile'],
        exportSnapshot: async () => ({ version: 3, owners: [] }),
        assertEmpty: async () => {},
        importSnapshot: async () => {},
      },
    });
    await assert.rejects(
      runMaintenance(
        parseMaintenanceArguments([
          'restore',
          '--data-dir',
          path.join(base, 'target'),
          '--source',
          archive,
          '--confirm',
        ]),
      ),
      /MAINTENANCE_EXPLICIT_TARGET_CONFIG_REQUIRED/,
    );
    assert.equal(fs.existsSync(path.join(base, 'target')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('database config cannot be attached to a local-only backup restore', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-maintenance-cli-config-'));
  try {
    const root = path.join(base, 'source'),
      archive = path.join(base, 'archive');
    fs.mkdirSync(root);
    await runMaintenance(
      parseMaintenanceArguments(['backup', '--data-dir', root, '--destination', archive, '--confirm']),
    );
    await assert.rejects(
      runMaintenance(
        parseMaintenanceArguments([
          'restore',
          '--data-dir',
          path.join(base, 'target'),
          '--source',
          archive,
          '--database-config',
          path.join(base, 'must-not-read.json'),
          '--confirm',
        ]),
      ),
      /MAINTENANCE_EXPLICIT_TARGET_CONFIG_REQUIRED/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
