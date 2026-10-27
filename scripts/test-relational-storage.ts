import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { sqlConnectConfigSchema } from '../shared/sqlconnect.js';
import { RelationalStorage, RelationalStorageError } from '../server/models/relational-storage.js';

// Explicit live PostgreSQL acceptance only. Never reads credential files or prints
// connection details, source documents, environment values, or database errors.
// Requires PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD. TLS verification is mandatory
// for remote hosts; PGSSLMODE=disable is accepted only for schema-approved loopback.
// All generated rows remain under unique test-v3-* owners. No cleanup/destructive SQL.
const protectedTables = [
  'novel_agent_metadata',
  'novel_agent_users',
  'novel_agent_projects',
  'novel_agent_chapters',
  'novel_agent_assets',
  'novel_agent_settings',
  'novel_agent_platform_bindings',
  'novel_agent_owner_state',
  'novel_agent_documents',
  'novel_agent_document_imports',
  'novel_agent_schema_migrations',
  'novel_agent_v3_repository',
  'novel_agent_v3_owners',
  'novel_agent_v3_documents',
  'novel_agent_v3_receipts',
  'novel_agent_v3_projects',
  'novel_agent_v3_chapters',
  'novel_agent_v3_assets',
  'novel_agent_v3_workflows',
] as const;
const hasCode = (code: string) => (error: unknown) =>
  error instanceof RelationalStorageError && error.code === code;
let storage: RelationalStorage | undefined;
let pool: Pool | undefined;
let failed = false;
try {
  if (process.env.PGDATABASE !== 'novel_test') throw new Error('TEST_DATABASE_GUARD');
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD'] as const)
    if (!process.env[name]) throw new Error('TEST_ENV_MISSING');
  if (process.env.PGSSLMODE && !['verify-full', 'disable'].includes(process.env.PGSSLMODE))
    throw new Error('TEST_TLS_MODE_INVALID');
  const config = sqlConnectConfigSchema.parse({
    driver: 'postgresql',
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    tls: process.env.PGSSLMODE === 'disable' ? 'off' : 'verify',
    timeoutMs: 30000,
  });
  storage = new RelationalStorage(config);
  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.tls === 'verify' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: config.timeoutMs,
    statement_timeout: config.timeoutMs,
    max: 2,
  });
  const permissions = await pool.query(
    "SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usage, has_schema_privilege(current_user, 'public', 'CREATE') AS create",
  );
  assert.ok(permissions.rows[0]?.usage && permissions.rows[0]?.create);
  const before = new Map<(typeof protectedTables)[number], string>();
  for (const table of protectedTables) {
    const exists = await pool.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    if (exists.rows[0]?.name)
      before.set(
        table,
        (await pool.query(`SELECT COUNT(*)::text AS count FROM public.${table}`)).rows[0].count as string,
      );
  }
  for (let iteration = 0; iteration < 2; iteration++) {
    await storage.migrate();
    for (const [table, count] of before)
      assert.equal(
        (await pool.query(`SELECT COUNT(*)::text AS count FROM public.${table}`)).rows[0].count,
        count,
      );
  }
  console.log('PASS v3 migration idempotency and preexisting table counts preserved');
  const run = randomUUID();
  const owner = `test-v3-${run}`,
    other = `test-v3-other-${run}`,
    importer = `test-v3-import-${run}`;
  const project = {
    id: 'project',
    title: 'Unicode 中文 😀',
    future: { unknown: true },
    chapters: [
      { id: 'chapter', title: 'Chapter', content: 'Actual prose', revision: 7, future: ['preserved'] },
    ],
    assets: [{ id: 'asset', name: 'Map', custom: true }],
    workflows: [{ id: 'workflow', name: 'Graph', steps: [], custom: { nested: 1 } }],
  };
  assert.equal(await storage.readDocument(owner, 'projects.json'), null);
  assert.equal(await storage.writeDocument(owner, 'projects.json', JSON.stringify([project]), 0), 1);
  assert.deepEqual(JSON.parse((await storage.readDocument(owner, 'projects.json'))!.content), [project]);
  const manifest = await pool.query(
    'SELECT content FROM public.novel_agent_v3_documents WHERE owner_id = $1 AND document_key = $2',
    [owner, 'projects.json'],
  );
  assert.ok(!String(manifest.rows[0].content).includes('Actual prose'));
  const chapter = await pool.query(
    'SELECT body FROM public.novel_agent_v3_chapters WHERE owner_id = $1 AND project_id = $2 AND entity_id = $3',
    [owner, 'project', 'chapter'],
  );
  assert.deepEqual(JSON.parse(chapter.rows[0].body as string), project.chapters[0]);
  const unchanged = await pool.query(
    'SELECT xmin::text AS version FROM public.novel_agent_v3_chapters WHERE owner_id = $1 AND project_id = $2 AND entity_id = $3',
    [owner, 'project', 'chapter'],
  );
  project.title = 'Metadata-only update';
  assert.equal(await storage.writeDocument(owner, 'projects.json', JSON.stringify([project]), 1), 2);
  const after = await pool.query(
    'SELECT xmin::text AS version FROM public.novel_agent_v3_chapters WHERE owner_id = $1 AND project_id = $2 AND entity_id = $3',
    [owner, 'project', 'chapter'],
  );
  assert.equal(after.rows[0].version, unchanged.rows[0].version);
  await assert.rejects(storage.writeDocument(owner, 'projects.json', '[]', 1), hasCode('REVISION_CONFLICT'));
  console.log('PASS normalized entity persistence, unknown fields, Unicode and incremental chapter hash');
  await storage.writeDocument(other, 'auth.json', '{"isolated":true}', 0);
  assert.equal(await storage.readDocument(owner, 'auth.json'), null);
  const races = await Promise.allSettled([
    storage.writeDocument(owner, 'race', 'first', 0),
    storage.writeDocument(owner, 'race', 'second', 0),
  ]);
  assert.equal(races.filter((result) => result.status === 'fulfilled' && result.value === 1).length, 1);
  assert.equal(
    races.filter((result) => result.status === 'rejected' && hasCode('REVISION_CONFLICT')(result.reason))
      .length,
    1,
  );
  console.log('PASS independent connection CAS contention and owner isolation');
  const documents = [
    { key: 'models.json', content: '{"unknown":[1,2]}' },
    { key: 'auth.json', content: '{"global":true}' },
  ];
  const sourceHash = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
  assert.deepEqual(await storage.importDocuments(importer, sourceHash, documents), {
    imported: true,
    count: 2,
  });
  assert.deepEqual(await storage.importDocuments(importer, sourceHash, documents), {
    imported: false,
    count: 2,
  });
  await assert.rejects(storage.importDocuments(importer, 'f'.repeat(64), []), hasCode('IMPORT_CONFLICT'));
  const snapshot = await storage.exportSnapshot();
  const exportedOwner = snapshot.owners.find((value) => value.ownerId === owner)!;
  assert.equal(exportedOwner.revision, 3);
  const exportedProjects = exportedOwner.documents.find((value) => value.key === 'projects.json')!;
  assert.equal(exportedProjects.revision, 2);
  assert.deepEqual(JSON.parse(exportedProjects.content), [project]);
  const exportedImport = snapshot.owners.find((value) => value.ownerId === importer)!;
  assert.equal(exportedImport.revision, 1);
  assert.deepEqual(exportedImport.receipts, [{ sourceHash, documentCount: 2 }]);
  assert.equal(
    snapshot.owners.find((value) => value.ownerId === other)?.documents[0].content,
    '{"isolated":true}',
  );
  // Never importSnapshot into a shared/nonempty database; mock suite covers empty-target
  // import, preserved revisions/receipts, conflict rejection, and transaction rollback.
  console.log(
    'PASS consistent snapshot includes reconstructed projects, all documents, revisions and receipts',
  );
  console.log('PASS live PostgreSQL v3 acceptance; generated test rows retained');
} catch {
  failed = true;
  console.error('FAIL relational acceptance check (diagnostics suppressed to protect credentials).');
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
