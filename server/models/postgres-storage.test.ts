import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { PoolClient } from 'pg';
import { PostgresStorage, PostgresStorageError, type PostgresStoragePool } from './postgres-storage.js';

type Row = Record<string, unknown>;
interface State {
  documents: Record<string, { revision: number; content: string }>;
  imports: Record<string, number>;
  owners: Record<string, number>;
}
function fixture() {
  let state: State = { documents: {}, imports: {}, owners: {} };
  let pending: State | undefined;
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let released = 0,
    ended = 0;
  let metadata: string | null = '1',
    ledger: number | null = null;
  let failMatch: string | undefined;
  let commitGate: Promise<void> | undefined;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (failMatch && sql.includes(failMatch))
        throw new Error('private database credentials and query text');
      let rows: Row[] = [];
      const owner = String(values?.[0]),
        key = `${owner}:${String(values?.[1])}`;
      if (sql === 'BEGIN') pending = structuredClone(state);
      else if (sql === 'ROLLBACK') pending = undefined;
      else if (sql === 'COMMIT') {
        await commitGate;
        state = pending!;
        pending = undefined;
      } else if (sql.includes('to_regclass'))
        rows = [
          {
            metadata: metadata === null ? null : 'novel_agent_metadata',
            ledger: ledger === null ? null : 'novel_agent_schema_migrations',
          },
        ];
      else if (sql.startsWith('SELECT metadata_value')) rows = [{ metadata_value: metadata }];
      else if (sql.startsWith('SELECT MAX(version)')) rows = [{ version: ledger }];
      else if (sql.startsWith('INSERT INTO public.novel_agent_owner_state')) pending!.owners[owner] ??= 0;
      else if (sql.startsWith('UPDATE public.novel_agent_owner_state')) {
        pending!.owners[owner]++;
        rows = [{ revision: String(pending!.owners[owner]) }];
      } else if (sql.startsWith('SELECT revision FROM public.novel_agent_owner_state'))
        rows = owner in pending!.owners ? [{ revision: String(pending!.owners[owner]) }] : [];
      else if (sql.startsWith('SELECT revision, content'))
        rows = pending!.documents[key] ? [pending!.documents[key]] : [];
      else if (sql.startsWith('SELECT document_count'))
        rows = key in pending!.imports ? [{ document_count: pending!.imports[key] }] : [];
      else if (sql.startsWith('SELECT 1 FROM public.novel_agent_documents'))
        rows = Object.keys(pending!.documents).some((k) => k.startsWith(`${owner}:`)) ? [{ exists: 1 }] : [];
      else if (sql.startsWith('INSERT INTO public.novel_agent_documents')) {
        if (!pending!.documents[key]) {
          pending!.documents[key] = { revision: 1, content: String(values?.[2]) };
          rows = [{ revision: '1' }];
        }
      } else if (sql.startsWith('UPDATE public.novel_agent_documents')) {
        const document = pending!.documents[key];
        if (document && document.revision === values?.[3]) {
          document.revision++;
          document.content = String(values?.[2]);
          rows = [{ revision: String(document.revision) }];
        }
      } else if (sql.startsWith('INSERT INTO public.novel_agent_document_imports'))
        pending!.imports[key] = Number(values?.[2]);
      return { rows, rowCount: rows.length };
    },
    release() {
      released++;
    },
  };
  const pool: PostgresStoragePool = {
    async connect() {
      return client as unknown as PoolClient;
    },
    async end() {
      ended++;
    },
  };
  const storage = new PostgresStorage({ host: 'unused.invalid' }, pool);
  return {
    storage,
    calls,
    state: () => state,
    released: () => released,
    ended: () => ended,
    version(value: string | null, migration: number | null = null) {
      metadata = value;
      ledger = migration;
    },
    fail(match: string) {
      failMatch = match;
    },
    gate(value: Promise<void>) {
      commitGate = value;
    },
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof PostgresStorageError && error.code === expected;

test('migration is transactionally locked, additive, and runs v1 before v2', async () => {
  const f = fixture();
  await f.storage.migrate();
  assert.equal(f.calls[0].sql, 'BEGIN');
  assert.match(f.calls[1].sql, /pg_advisory_xact_lock\(\$1\)/);
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  const scripts = f.calls.filter((call) => call.sql.startsWith('--'));
  assert.equal(scripts.length, 2);
  assert.match(scripts[0].sql, /novel_agent_projects/);
  assert.match(scripts[1].sql, /novel_agent_documents/);
  assert.doesNotMatch(
    scripts.map((call) => call.sql.replace(/--[^\n]*/g, '')).join('\n'),
    /\b(?:DROP|DELETE|TRUNCATE)\b/i,
  );
  assert.equal(f.released(), 1);
});

test('future or corrupt schema versions fail closed before initialization; future ledger also rejected', async () => {
  for (const [version, ledger] of [
    ['3', null],
    ['invalid', null],
    ['2', 3],
  ] as const) {
    const f = fixture();
    f.version(version, ledger);
    await assert.rejects(f.storage.migrate(), code('UNSUPPORTED_SCHEMA_VERSION'));
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(
      f.calls.some((call) => call.sql.startsWith('--')),
      false,
    );
    assert.equal(f.released(), 1);
  }
});

test('fresh database and existing v2 both migrate idempotently', async () => {
  for (const version of [null, '2']) {
    const f = fixture();
    f.version(version, version === '2' ? 2 : null);
    await f.storage.migrate();
    await f.storage.migrate();
    assert.equal(f.calls.filter((call) => call.sql === 'COMMIT').length, 2);
  }
});

test('migration DDL failure rolls back and sanitizes errors', async () => {
  const f = fixture();
  f.fail('CREATE TABLE IF NOT EXISTS public.novel_agent_schema_migrations');
  await assert.rejects(
    f.storage.migrate(),
    (error) => code('STORAGE_FAILED')(error) && !String(error).includes('credentials'),
  );
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(
    f.calls.some((call) => call.sql === 'COMMIT'),
    false,
  );
});

test('CAS creates and updates tenant-isolated documents, with durable owner revisions', async () => {
  const f = fixture();
  assert.equal(await f.storage.readDocument('alice', 'book'), null);
  assert.equal(await f.storage.readOwnerRevision('alice'), 0);
  assert.equal(await f.storage.writeDocument('alice', 'book', 'one', 0), 1);
  assert.equal(await f.storage.writeDocument('alice', 'book', 'two', 1), 2);
  assert.equal(await f.storage.writeDocument('bob', 'book', 'other', 0), 1);
  assert.deepEqual(await f.storage.readDocument('alice', 'book'), { revision: 2, content: 'two' });
  assert.deepEqual(await f.storage.readDocument('bob', 'book'), { revision: 1, content: 'other' });
  assert.equal(await f.storage.readOwnerRevision('alice'), 2);
  await assert.rejects(f.storage.writeDocument('alice', 'book', 'overwrite', 0), code('REVISION_CONFLICT'));
  await assert.rejects(f.storage.writeDocument('alice', 'book', 'stale', 1), code('REVISION_CONFLICT'));
  await assert.rejects(f.storage.writeDocument('alice', 'missing', 'bad', 1), code('REVISION_CONFLICT'));
  assert.deepEqual(await f.storage.readDocument('alice', 'book'), { revision: 2, content: 'two' });
  assert.equal(await f.storage.readOwnerRevision('alice'), 2);
  const userInsert = f.calls.find((call) => call.sql.startsWith('INSERT INTO public.novel_agent_users'));
  assert.deepEqual(userInsert?.values, ['alice', 'alice']);
  assert.ok(f.calls.some((call) => call.sql.endsWith('FOR UPDATE')));
});

test('input is parameterized and never used as SQL syntax', async () => {
  const f = fixture();
  const owner = "owner'; SELECT secret; --",
    key = "key'; SELECT secret; --",
    value = "content'; DROP TABLE x; --";
  await f.storage.writeDocument(owner, key, value, 0);
  assert.equal(
    f.calls.some((call) => call.sql.includes(owner) || call.sql.includes(key) || call.sql.includes(value)),
    false,
  );
  assert.ok(f.calls.some((call) => call.values?.includes(value)));
});

test('write does not acknowledge before actual COMMIT and reports uncertain commit', async () => {
  const f = fixture();
  let release!: () => void;
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let acknowledged = false;
  const writing = f.storage.writeDocument('alice', 'book', 'one', 0).then((value) => {
    acknowledged = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false);
  assert.deepEqual(f.state().documents, {});
  release();
  assert.equal(await writing, 1);
  assert.equal(f.state().documents['alice:book'].content, 'one');
  const failed = fixture();
  failed.fail('COMMIT');
  await assert.rejects(failed.storage.writeDocument('alice', 'book', 'one', 0), code('COMMIT_UNCERTAIN'));
  assert.equal(failed.released(), 1);
});

test('imports are owner/hash idempotent, reject nonempty target, and preserve original document', async () => {
  const f = fixture();
  const documents = [
    { key: 'store', content: '{"projects":[]}' },
    { key: 'secret', content: '{}' },
  ];
  assert.deepEqual(await f.storage.importDocuments('alice', 'hash-a', documents), {
    imported: true,
    count: 2,
  });
  assert.equal(await f.storage.readOwnerRevision('alice'), 1);
  assert.deepEqual(
    await f.storage.importDocuments('alice', 'hash-a', [{ key: 'store', content: 'changed' }]),
    { imported: false, count: 2 },
  );
  assert.equal((await f.storage.readDocument('alice', 'store'))?.content, documents[0].content);
  await assert.rejects(
    f.storage.importDocuments('alice', 'hash-b', documents),
    code('IMPORT_TARGET_NOT_EMPTY'),
  );
  assert.deepEqual(await f.storage.importDocuments('bob', 'hash-a', documents), { imported: true, count: 2 });
  assert.equal(await f.storage.readOwnerRevision('alice'), 1);
});

test('import failure is atomic including owner row, import receipt, and revision', async () => {
  const f = fixture();
  f.fail('INSERT INTO public.novel_agent_document_imports');
  await assert.rejects(
    f.storage.importDocuments('alice', 'hash', [{ key: 'store', content: '{}' }]),
    code('STORAGE_FAILED'),
  );
  assert.deepEqual(f.state(), { documents: {}, imports: {}, owners: {} });
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
});

test('owner revision overflow rolls back the document mutation', async () => {
  const f = fixture();
  f.state().owners.alice = Number.MAX_SAFE_INTEGER;
  await assert.rejects(f.storage.writeDocument('alice', 'book', 'one', 0), code('REVISION_OVERFLOW'));
  assert.deepEqual(f.state().documents, {});
  assert.equal(f.state().owners.alice, Number.MAX_SAFE_INTEGER);
});

test('invalid input rejects before opening transactions; close ends pool', async () => {
  const f = fixture();
  await assert.rejects(f.storage.writeDocument('', 'key', '', 0), code('INVALID_INPUT'));
  await assert.rejects(f.storage.writeDocument('alice', 'key', '', -1), code('INVALID_INPUT'));
  await assert.rejects(f.storage.writeDocument('alice', 'key', '\0', 0), code('INVALID_INPUT'));
  await assert.rejects(f.storage.importDocuments('alice', 'hash', []), code('INVALID_INPUT'));
  await assert.rejects(
    f.storage.importDocuments('alice', 'hash', [
      { key: 'x', content: '' },
      { key: 'x', content: '' },
    ]),
    code('INVALID_INPUT'),
  );
  assert.equal(f.calls.length, 0);
  await f.storage.close();
  assert.equal(f.ended(), 1);
});

test('v2 migration contains owner-scoped keys and FKs without destructive SQL', () => {
  const sql = fs.readFileSync(new URL('./sql/migrate_postgresql_v2.sql', import.meta.url), 'utf8');
  assert.match(sql, /PRIMARY KEY \(owner_id, document_key\)/);
  assert.match(sql, /PRIMARY KEY \(owner_id, source_hash\)/);
  assert.match(sql, /REFERENCES public\.novel_agent_users\(user_id\)/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /\b(?:DROP|DELETE|TRUNCATE)\b/i);
});
