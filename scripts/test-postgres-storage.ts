import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { PostgresStorage, PostgresStorageError } from '../packages/server/src/infrastructure/storage/postgres-storage.js';

// Explicitly invoked live acceptance probe. Never reads credential files or prints
// connection details, source documents, database errors, or environment values.
// All generated rows remain in novel_test under unique test-prefixed owners.
const v1Tables = [
  'novel_agent_metadata',
  'novel_agent_users',
  'novel_agent_projects',
  'novel_agent_chapters',
  'novel_agent_assets',
  'novel_agent_settings',
  'novel_agent_platform_bindings',
] as const;
const hasCode = (code: string) => (error: unknown) =>
  error instanceof PostgresStorageError && error.code === code;

let storage: PostgresStorage | undefined;
let pool: Pool | undefined;
let failed = false;
try {
  if (process.env.PGDATABASE !== 'novel_test') throw new Error('TEST_DATABASE_GUARD');
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD'] as const) {
    if (!process.env[name]) throw new Error('TEST_ENV_MISSING');
  }
  const port = Number(process.env.PGPORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TEST_ENV_INVALID');
  const config: PoolConfig = {
    host: process.env.PGHOST,
    port,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: 'novel_test',
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    max: 2,
  };
  storage = new PostgresStorage(config);
  pool = new Pool(config);
  // Preflight is read-only and reports only fixed permission labels, never server errors.
  // Migration scripts use public explicitly; database CONNECT alone is insufficient.
  const permissions = await pool.query(
    "SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage, has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create",
  );
  if (!permissions.rows[0]?.schema_usage || !permissions.rows[0]?.schema_create) {
    console.error('POSTGRES_SCHEMA_PERMISSION_REQUIRED: public schema USAGE and CREATE are required.');
    throw new Error('TEST_SCHEMA_PERMISSION_REQUIRED');
  }
  // Table identifiers below come only from the static allowlist, never the environment.
  const before = new Map<string, string>();
  for (const table of v1Tables) {
    const exists = await pool.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
    if (exists.rows[0].table_name) {
      const result = await pool.query(`SELECT COUNT(*)::text AS count FROM public.${table}`);
      before.set(table, result.rows[0].count as string);
    }
  }
  for (let run = 0; run < 2; run++) {
    await storage.migrate();
    // Counts are checked BEFORE this probe creates any owners/documents.
    for (const [table, count] of before) {
      const result = await pool.query(`SELECT COUNT(*)::text AS count FROM public.${table}`);
      assert.equal(result.rows[0].count, count, 'Existing v1 row count changed during migration.');
    }
  }
  const schema = await pool.query(
    'SELECT metadata_value FROM public.novel_agent_metadata WHERE metadata_key = $1',
    ['schema_version'],
  );
  assert.equal(schema.rows[0]?.metadata_value, '2');
  const ledger = await pool.query(
    'SELECT version FROM public.novel_agent_schema_migrations ORDER BY version',
  );
  assert.deepEqual(
    ledger.rows.map((row) => row.version),
    [1, 2],
  );
  console.log('PASS migration twice, v2 metadata/ledger, preexisting v1 row counts preserved');

  const runId = randomUUID();
  const owner = `test-pg-${runId}`;
  const other = `test-pg-other-${runId}`;
  const importer = `test-pg-import-${runId}`;
  assert.equal(await storage.readDocument(owner, 'acceptance'), null);
  assert.equal(await storage.writeDocument(owner, 'acceptance', 'first', 0), 1);
  assert.equal(await storage.writeDocument(owner, 'acceptance', 'second', 1), 2);
  assert.deepEqual(await storage.readDocument(owner, 'acceptance'), { revision: 2, content: 'second' });
  assert.equal(await storage.readOwnerRevision(owner), 2);
  assert.equal(await storage.readDocument(other, 'acceptance'), null);
  assert.equal(await storage.writeDocument(other, 'acceptance', 'isolated', 0), 1);
  assert.deepEqual(await storage.readDocument(owner, 'acceptance'), { revision: 2, content: 'second' });
  assert.deepEqual(await storage.readDocument(other, 'acceptance'), { revision: 1, content: 'isolated' });
  console.log('PASS committed CAS create/update/read and cross-owner isolation');

  await assert.rejects(storage.writeDocument(owner, 'acceptance', 'stale', 1), hasCode('REVISION_CONFLICT'));
  await assert.rejects(
    storage.writeDocument(owner, 'acceptance', 'duplicate', 0),
    hasCode('REVISION_CONFLICT'),
  );
  assert.deepEqual(await storage.readDocument(owner, 'acceptance'), { revision: 2, content: 'second' });
  assert.equal(await storage.readOwnerRevision(owner), 2);
  // Two actual independent connections compete for the same expected revision.
  const races = await Promise.allSettled([
    storage.writeDocument(owner, 'acceptance', 'race-a', 2),
    storage.writeDocument(owner, 'acceptance', 'race-b', 2),
  ]);
  assert.equal(races.filter((result) => result.status === 'fulfilled' && result.value === 3).length, 1);
  const rejected = races.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].status === 'rejected' && hasCode('REVISION_CONFLICT')(rejected[0].reason));
  assert.equal((await storage.readDocument(owner, 'acceptance'))?.revision, 3);
  assert.equal(await storage.readOwnerRevision(owner), 3);
  console.log('PASS stale/create conflicts, concurrent CAS winner, rollback revision preservation');

  const documents = [
    { key: 'test-store', content: '{"test":true}' },
    { key: 'test-settings', content: '{}' },
  ];
  const hash = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
  assert.deepEqual(await storage.importDocuments(importer, hash, documents), { imported: true, count: 2 });
  assert.deepEqual(await storage.importDocuments(importer, hash, documents), { imported: false, count: 2 });
  assert.deepEqual(await storage.readDocument(importer, documents[0].key), {
    revision: 1,
    content: documents[0].content,
  });
  assert.equal(await storage.readOwnerRevision(importer), 1);
  const rejectedHash = createHash('sha256').update(`${hash}:rejected`).digest('hex');
  await assert.rejects(
    storage.importDocuments(importer, rejectedHash, [{ key: 'must-not-appear', content: 'rejected' }]),
    hasCode('IMPORT_TARGET_NOT_EMPTY'),
  );
  assert.equal(await storage.readDocument(importer, 'must-not-appear'), null);
  assert.equal(await storage.readOwnerRevision(importer), 1);
  const receipt = await pool.query(
    'SELECT COUNT(*)::text AS count FROM public.novel_agent_document_imports WHERE owner_id = $1 AND source_hash = $2',
    [importer, rejectedHash],
  );
  assert.equal(receipt.rows[0].count, '0');
  console.log('PASS atomic import, owner/hash idempotency and nonempty import rollback');

  // Force a failure AFTER document INSERT without destructive SQL or schema changes:
  // the repository must reject an unsafe owner revision and roll back that insert.
  const rollbackOwner = `test-pg-rollback-${runId}`;
  await storage.writeDocument(rollbackOwner, 'baseline', 'retained', 0);
  await pool.query('UPDATE public.novel_agent_owner_state SET revision = $2 WHERE owner_id = $1', [
    rollbackOwner,
    Number.MAX_SAFE_INTEGER,
  ]);
  await assert.rejects(
    storage.writeDocument(rollbackOwner, 'must-rollback', 'not-committed', 0),
    hasCode('REVISION_OVERFLOW'),
  );
  assert.equal(await storage.readDocument(rollbackOwner, 'must-rollback'), null);
  assert.equal(await storage.readOwnerRevision(rollbackOwner), Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await storage.readDocument(rollbackOwner, 'baseline'), {
    revision: 1,
    content: 'retained',
  });
  console.log('PASS failure after document INSERT rolls back actual transaction');
  console.log(
    `PASS live PostgreSQL acceptance; retained test owners: ${owner}, ${other}, ${importer}, ${rollbackOwner}`,
  );
} catch {
  failed = true;
  // Deliberately do not print the thrown object; PG errors can contain credentials or SQL data.
  console.error('FAIL PostgreSQL acceptance check (diagnostics suppressed to protect credentials).');
} finally {
  try {
    await storage?.close();
  } catch {
    failed = true;
  }
  try {
    await pool?.end();
  } catch {
    failed = true;
  }
}
if (failed) process.exitCode = 1;
