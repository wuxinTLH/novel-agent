import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  RelationalStorage,
  createRelationalAdapter,
  type RelationalAdapter,
} from '../packages/server/src/infrastructure/storage/relational-storage.js';
import type { SQLConnectConfig } from '../shared/sqlconnect.js';

// Optional v3 PostgreSQL acceptance. Never loads credential files or logs values/errors.
// PGDATABASE is only the administrative connection; all storage migration/data work
// occurs in two newly CREATED random databases. No writes to an existing user DB.
// Requires CREATEDB. Explicit invocation: STORAGE_LIVE_ALLOW_CREATE_DATABASE=1 npx tsx scripts/test-relational-storage-live.ts
const required = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const;
const absent = required.filter((name) => !process.env[name]);
if (process.env.STORAGE_LIVE_ALLOW_CREATE_DATABASE !== '1' || absent.length) {
  console.log(
    `SKIP optional live v3 PostgreSQL acceptance: explicit create-database opt-in and named environment required; missing names: ${absent.join(', ') || 'none'}.`,
  );
} else {
  let admin: Pool | undefined;
  const stores: RelationalStorage[] = [];
  const created: string[] = [];
  let stage = 'configuration';
  try {
    const port = Number(process.env.PGPORT);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const tls = process.env.STORAGE_LIVE_TLS === 'off' ? 'off' : 'verify';
    const config: SQLConnectConfig = {
      driver: 'postgresql',
      host: process.env.PGHOST!,
      port,
      user: process.env.PGUSER!,
      password: process.env.PGPASSWORD!,
      database: process.env.PGDATABASE!,
      tls,
      timeoutMs: 10000,
    };
    admin = new Pool({
      host: config.host,
      port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: tls === 'verify' ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    const createStore = async (holdFirstCommit = false) => {
      // Strictly generated identifier, never interpolated from the environment.
      const name = `novel_v3_accept_${randomUUID().replaceAll('-', '')}`;
      await admin!.query(`CREATE DATABASE "${name}"`);
      created.push(name);
      const adapter = createRelationalAdapter({ ...config, database: name });
      let hold: { entered: () => void; wait: Promise<void> } | undefined;
      const wrapped: RelationalAdapter = {
        dialect: adapter.dialect,
        close: () => adapter.close(),
        async begin() {
          const tx = await adapter.begin();
          return {
            ...tx,
            async commit() {
              const current = hold;
              hold = undefined;
              if (current) {
                current.entered();
                await current.wait;
              }
              await tx.commit();
            },
          };
        },
      };
      const storage = new RelationalStorage(
        { ...config, database: name },
        holdFirstCommit ? wrapped : adapter,
      );
      stores.push(storage);
      return {
        storage,
        hold(entered: () => void, wait: Promise<void>) {
          hold = { entered, wait };
        },
      };
    };
    stage = 'isolated database creation and migration';
    const source = await createStore(true);
    const target = await createStore();
    await source.storage.migrate();
    await source.storage.migrate();
    await target.storage.migrate();
    console.log('PASS v3 additive migration twice in newly created isolated database');
    stage = 'roundtrip, import and concurrent CAS';
    const projects = JSON.stringify([
      { id: 'p', title: 'UTF-8 测试', chapters: [{ id: 'c', content: 'prose' }], assets: [], workflows: [] },
    ]);
    await source.storage.importDocuments('owner-a', 'a'.repeat(64), [
      { key: 'projects.json', content: projects },
      { key: 'settings', content: '{}' },
    ]);
    assert.deepEqual(await source.storage.importDocuments('owner-a', 'a'.repeat(64), []), {
      imported: false,
      count: 2,
    });
    assert.deepEqual(
      JSON.parse((await source.storage.readDocument('owner-a', 'projects.json'))!.content),
      JSON.parse(projects),
    );
    const race = await Promise.allSettled([
      source.storage.writeDocument('owner-a', 'settings', 'one', 1),
      source.storage.writeDocument('owner-a', 'settings', 'two', 1),
    ]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(race.some((r) => r.status === 'rejected' && r.reason.code === 'REVISION_CONFLICT'));
    console.log('PASS v3 Unicode projection roundtrip, receipt idempotency, concurrent CAS');
    stage = 'independent owner concurrency and snapshot barrier';
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    source.hold(entered, blocked);
    const writer = source.storage.writeDocument('owner-a', 'held', 'committed', 0);
    await Promise.race([
      ready,
      writer.then(() => {
        throw new Error('HELD_COMMIT_NOT_REACHED');
      }),
    ]);
    try {
      // This must complete while owner-a's actual transaction is held pre-commit.
      const independent = source.storage.writeDocument('owner-b', 'independent', 'parallel', 0);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          independent,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('INDEPENDENT_OWNER_BLOCKED')), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        // Keep any timeout-losing rejection handled; closing the pool drains this work.
        void independent.catch(() => {});
      }
      let exported = false;
      const snapshot = source.storage.exportSnapshot().then((value) => {
        exported = true;
        return value;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(exported, false);
      release();
      await writer;
      const captured = await snapshot;
      assert.ok(
        captured.owners.find((o) => o.ownerId === 'owner-a')!.documents.some((d) => d.key === 'held'),
      );
      stage = 'snapshot restore';
      await target.storage.importSnapshot(captured);
      assert.deepEqual(await target.storage.exportSnapshot(), captured);
      await assert.rejects(target.storage.importSnapshot(captured), { code: 'SNAPSHOT_CONFLICT' });
      console.log(
        'PASS independent owner progresses during held commit, snapshot waits, empty-target restore and conflict',
      );
    } finally {
      release();
      await writer;
    }
    console.log('PASS live v3 PostgreSQL acceptance (not a performance benchmark)');
  } catch {
    process.exitCode = 1;
    console.error(`FAIL live v3 acceptance at fixed stage: ${stage}; details suppressed.`);
  } finally {
    for (const storage of stores)
      try {
        await storage.close();
      } catch {
        process.exitCode = 1;
      }
    // Drop ONLY databases successfully created by this invocation; no FORCE or session termination.
    for (const name of created.reverse())
      try {
        await admin!.query(`DROP DATABASE "${name}"`);
      } catch {
        process.exitCode = 1;
        console.error('FAIL isolated test database cleanup; generated acceptance database retained.');
      }
    await admin?.end();
  }
}
