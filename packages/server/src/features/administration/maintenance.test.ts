import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  backupFull,
  restoreFull,
  validateBackup,
  migrateAllProfiles,
  GLOBAL_AUTH_OWNER,
  type MaintenanceBackend,
  type MaintenanceSnapshot,
} from './maintenance.js';
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-maintenance-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir);
  return { base, dataDir };
}
function backend(
  ids = ['main'],
): MaintenanceBackend & { rows: Map<string, MaintenanceSnapshot>; imports: string[] } {
  const rows = new Map<string, MaintenanceSnapshot>(
    ids.map((id) => [id, { version: 3 as const, owners: [] }]),
  );
  const imports: string[] = [];
  return {
    profileIds: ids,
    rows,
    imports,
    async exportSnapshot(id) {
      return structuredClone(rows.get(id)!);
    },
    async assertEmpty(id) {
      assert.equal(rows.get(id)!.owners.length, 0, 'not empty');
    },
    async importSnapshot(id, snapshot) {
      assert.equal(rows.get(id)!.owners.length, 0);
      imports.push(id);
      rows.set(id, structuredClone(snapshot));
    },
  };
}
function auth(dataDir: string) {
  fs.writeFileSync(path.join(dataDir, 'auth.key'), Buffer.alloc(32, 1));
  fs.writeFileSync(
    path.join(dataDir, 'auth.json'),
    JSON.stringify({
      version: 1,
      users: [owner, other].map((id, i) => ({
        id,
        username: i ? 'second' : 'admin',
        role: i ? 'user' : 'superadmin',
        disabled: !!i,
        createdAt: new Date().toISOString(),
        passwordHash: 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(128),
      })),
      sessions: [],
      turnstile: { enabled: false, siteKey: '', action: 'login', hostname: '', encryptedSecret: '' },
    }),
  );
}
test('full directory binary and empty directory round trip excludes transient/history files', async (t) => {
  const { base, dataDir } = fixture(t);
  fs.mkdirSync(path.join(dataDir, 'users'));
  fs.mkdirSync(path.join(dataDir, 'users', 'empty'));
  fs.mkdirSync(path.join(dataDir, 'uploads'));
  fs.writeFileSync(path.join(dataDir, 'uploads', 'binary'), Buffer.from([0, 255, 12, 128]));
  fs.mkdirSync(path.join(dataDir, 'admin-backups'));
  fs.writeFileSync(path.join(dataDir, 'ignored.tmp'), 'ignore');
  const destination = path.join(base, 'backup');
  await backupFull({ dataDir, destination, runtimeStopped: true });
  const manifest = validateBackup(destination).manifest;
  assert.ok(manifest.entries.some((e) => e.path === 'users/empty' && e.type === 'directory'));
  assert.ok(!manifest.entries.some((e) => e.path.startsWith('admin-backups') || e.path.endsWith('.tmp')));
  const target = path.join(base, 'restored');
  await restoreFull({ dataDir: target, backupDir: destination, runtimeStopped: true });
  assert.deepEqual(fs.readFileSync(path.join(target, 'uploads', 'binary')), Buffer.from([0, 255, 12, 128]));
  assert.ok(fs.statSync(path.join(target, 'users', 'empty')).isDirectory());
  assert.ok(!fs.existsSync(path.join(target, '.instance.lock')));
});
test('tampering rejects before SQL import; all owners and arbitrary document keys survive', async (t) => {
  const { base, dataDir } = fixture(t),
    source = backend();
  source.rows.set('main', {
    version: 3,
    owners: [
      {
        ownerId: other,
        revision: 8,
        documents: [{ key: 'future.json', content: '{}', revision: 4 }],
        receipts: [{ sourceHash: 'receipt', documentCount: 1 }],
      },
    ],
  });
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '[]');
  const destination = path.join(base, 'backup');
  await backupFull({ dataDir, destination, runtimeStopped: true, backend: source });
  const target = backend();
  await restoreFull({
    dataDir: path.join(base, 'restored'),
    backupDir: destination,
    runtimeStopped: true,
    backend: target,
    activateStaged(stage) {
      fs.writeFileSync(
        path.join(stage, 'storage-profiles.json'),
        JSON.stringify({
          version: 3,
          defaultProfileId: target.profileIds[0],
          profiles: target.profileIds.map((id) => ({
            id,
            connection: {
              driver: 'postgresql',
              host: 'localhost',
              port: 5432,
              user: 'test',
              database: 'novel',
              tls: 'verify',
              timeoutMs: 1000,
            },
          })),
          ownerProfiles: [],
        }),
      );
    },
  });
  assert.deepEqual(target.rows, source.rows);
  fs.writeFileSync(path.join(destination, 'files', 'projects.json'), '{}');
  await assert.rejects(
    restoreFull({
      dataDir: path.join(base, 'bad'),
      backupDir: destination,
      runtimeStopped: true,
      backend: backend(),
    }),
    /MAINTENANCE_CHECKSUM_MISMATCH/,
  );
});
test('hardlinks refused and backup output cannot nest inside source', async (t) => {
  const { base, dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, 'one'), 'x');
  fs.linkSync(path.join(dataDir, 'one'), path.join(dataDir, 'two'));
  await assert.rejects(
    backupFull({ dataDir, destination: path.join(base, 'backup'), runtimeStopped: true }),
    /MAINTENANCE_UNSAFE_FILE/,
  );
  await assert.rejects(
    backupFull({ dataDir, destination: path.join(dataDir, 'nested'), runtimeStopped: true }),
    /MAINTENANCE_PATH_OVERLAP/,
  );
});
test('replace retains entire previous directory; fresh target required without acknowledgment', async (t) => {
  const { base, dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, 'new'), 'new');
  const destination = path.join(base, 'backup');
  await backupFull({ dataDir, destination, runtimeStopped: true });
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'old'), 'old');
  await assert.rejects(
    restoreFull({ dataDir: target, backupDir: destination, runtimeStopped: true }),
    /MAINTENANCE_REPLACE_ACK_REQUIRED/,
  );
  const result = await restoreFull({
    dataDir: target,
    backupDir: destination,
    runtimeStopped: true,
    replace: true,
  });
  assert.equal(fs.readFileSync(path.join(result.rollbackDir, 'old'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(target, 'new'), 'utf8'), 'new');
});
test('multi-profile failure keeps durable receipt journal and refuses blind retry', async (t) => {
  const { base, dataDir } = fixture(t),
    source = backend(['a', 'b']);
  for (const id of source.profileIds)
    source.rows.set(id, {
      version: 3,
      owners: [
        {
          ownerId: id === 'a' ? owner : other,
          revision: 1,
          documents: [{ key: 'x', content: '{}', revision: 1 }],
          receipts: [],
        },
      ],
    });
  const destination = path.join(base, 'backup');
  await backupFull({ dataDir, destination, runtimeStopped: true, backend: source });
  const target = backend(['a', 'b']);
  const original = target.importSnapshot;
  target.importSnapshot = async (id, snapshot) => {
    if (id === 'b') throw new Error('COMMIT_UNCERTAIN');
    return original(id, snapshot);
  };
  const restoreDir = path.join(base, 'restored');
  await assert.rejects(
    restoreFull({
      dataDir: restoreDir,
      backupDir: destination,
      runtimeStopped: true,
      backend: target,
      activateStaged(stage) {
        fs.writeFileSync(
          path.join(stage, 'storage-profiles.json'),
          JSON.stringify({
            version: 3,
            defaultProfileId: target.profileIds[0],
            profiles: target.profileIds.map((id) => ({
              id,
              connection: {
                driver: 'postgresql',
                host: 'localhost',
                port: 5432,
                user: 'test',
                database: 'novel',
                tls: 'verify',
                timeoutMs: 1000,
              },
            })),
            ownerProfiles: [{ ownerId: other, profileId: 'b' }],
          }),
        );
      },
    }),
    /COMMIT_UNCERTAIN/,
  );
  const journal = JSON.parse(fs.readFileSync(path.join(restoreDir, '.maintenance-journal.json'), 'utf8'));
  assert.deepEqual(journal.importedProfiles, ['a']);
  assert.equal(journal.phase, 'sql-importing:b');
});
test('existing disabled tenant data migrates by UUID hash and global auth is preserved', async (t) => {
  const { dataDir } = fixture(t);
  auth(dataDir);
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '[]');
  const relative = 'users/' + createHash('sha256').update(other).digest('hex');
  fs.mkdirSync(path.join(dataDir, relative), { recursive: true });
  fs.writeFileSync(path.join(dataDir, relative, 'models.json'), '[]');
  const target = backend();
  let activated = false;
  const result = await migrateAllProfiles({
    dataDir,
    runtimeStopped: true,
    backend: target,
    legacyOwnerId: owner,
    profileForOwner: () => 'main',
    activate(plan) {
      activated = true;
      assert.equal(plan.owners.length, 2);
    },
  });
  assert.ok(activated);
  assert.equal(result.owners.find((o) => o.ownerId === other)?.relativeDir, relative);
  const owners = target.rows.get('main')!.owners;
  assert.ok(owners.find((o) => o.ownerId === other)?.documents.some((d) => d.key === 'models.json'));
  assert.ok(
    owners.find((o) => o.ownerId === GLOBAL_AUTH_OWNER)?.documents.some((d) => d.key === 'auth.json'),
  );
  assert.ok(!fs.existsSync(path.join(dataDir, 'business-storage.json')));
});
test('auth-off root migration never generates authentication or a key', async (t) => {
  const { dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '[]');
  const target = backend();
  await migrateAllProfiles({
    dataDir,
    runtimeStopped: true,
    backend: target,
    legacyOwnerId: owner,
    profileForOwner: () => 'main',
    activate() {},
  });
  assert.equal(fs.existsSync(path.join(dataDir, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'auth.key')), false);
  assert.equal(target.rows.get('main')!.owners.length, 1);
  assert.equal(target.rows.get('main')!.owners[0].ownerId, owner);
});
test('restoration revokes persistent login sessions while preserving original backup', async (t) => {
  const { base, dataDir } = fixture(t);
  auth(dataDir);
  const original = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
  original.sessions = [
    { userId: owner, tokenHash: 'c'.repeat(64), csrfToken: 'd'.repeat(64), expiresAt: Date.now() + 100000 },
  ];
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify(original));
  const destination = path.join(base, 'backup');
  await backupFull({ dataDir, destination, runtimeStopped: true });
  const target = path.join(base, 'target');
  await restoreFull({ dataDir: target, backupDir: destination, runtimeStopped: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'auth.json'), 'utf8')).sessions.length, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, 'files', 'auth.json'), 'utf8')).sessions.length,
    1,
  );
});
test('migration safety backup precedes any target initialization and captures local source only', async (t) => {
  const { base, dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '[]');
  const target = backend(),
    original = target.assertEmpty,
    destination = path.join(base, 'safety');
  target.assertEmpty = async (id) => {
    assert.equal(validateBackup(destination).manifest.complete, true);
    return original(id);
  };
  await migrateAllProfiles({
    dataDir,
    runtimeStopped: true,
    backend: target,
    legacyOwnerId: owner,
    profileForOwner: () => 'main',
    backupDestination: destination,
    activate() {},
  });
  assert.equal(validateBackup(destination).manifest.sql.length, 0);
});
test('project verification accepts relational formatting normalization without changing source hash', async (t) => {
  const { base, dataDir } = fixture(t),
    target = backend();
  const original = '[\n ]\n';
  fs.writeFileSync(path.join(dataDir, 'projects.json'), original);
  const importer = target.importSnapshot;
  target.importSnapshot = async (id, snapshot) => {
    const normalized = structuredClone(snapshot);
    for (const row of normalized.owners)
      for (const doc of row.documents)
        if (doc.key === 'projects.json') doc.content = JSON.stringify(JSON.parse(doc.content));
    await importer(id, normalized);
  };
  await migrateAllProfiles({
    dataDir,
    runtimeStopped: true,
    backend: target,
    legacyOwnerId: owner,
    profileForOwner: () => 'main',
    backupDestination: path.join(base, 'backup'),
    activate() {},
  });
  assert.equal(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'), original);
  assert.equal(target.rows.get('main')!.owners[0].documents[0].content, '[]');
});
test('restore rejects changed owner routing before any SQL import', async (t) => {
  const { base, dataDir } = fixture(t),
    source = backend(['a', 'b']);
  source.rows.set('a', {
    version: 3,
    owners: [{ ownerId: GLOBAL_AUTH_OWNER, revision: 0, documents: [], receipts: [] }],
  });
  const destination = path.join(base, 'backup');
  await backupFull({ dataDir, destination, runtimeStopped: true, backend: source });
  const target = backend(['a', 'b']);
  await assert.rejects(
    restoreFull({
      dataDir: path.join(base, 'target'),
      backupDir: destination,
      runtimeStopped: true,
      backend: target,
      activateStaged(stage) {
        fs.writeFileSync(
          path.join(stage, 'storage-profiles.json'),
          JSON.stringify({
            version: 3,
            defaultProfileId: 'b',
            profiles: ['a', 'b'].map((id) => ({
              id,
              connection: {
                driver: 'postgresql',
                host: 'localhost',
                port: 5432,
                user: 'test',
                database: 'novel',
                tls: 'verify',
                timeoutMs: 1000,
              },
            })),
            ownerProfiles: [],
          }),
        );
      },
    }),
    /MAINTENANCE_OWNER_ROUTING_MISMATCH/,
  );
  assert.equal(target.imports.length, 0);
});
test('orphan tenant rejected before any SQL writes', async (t) => {
  const { dataDir } = fixture(t);
  auth(dataDir);
  fs.mkdirSync(path.join(dataDir, 'users', 'unknown'), { recursive: true });
  const target = backend();
  await assert.rejects(
    migrateAllProfiles({
      dataDir,
      runtimeStopped: true,
      backend: target,
      legacyOwnerId: owner,
      profileForOwner: () => 'main',
      activate() {
        assert.fail();
      },
    }),
    /MAINTENANCE_UNOWNED_DIRECTORY/,
  );
  assert.equal(target.imports.length, 0);
});
