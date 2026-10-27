import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RelationalStorage,
  createProfileStorage,
  type RelationalAdapter,
  type RelationalDialect,
} from './relational-storage.js';
import { profileForOwner, storageConfigSchema, type StorageSnapshot } from '../../shared/storage.js';
import type { SQLConnectConfig } from '../../shared/sqlconnect.js';

type Row = Record<string, unknown>;
const config = (driver: RelationalDialect): SQLConnectConfig => ({
  driver,
  host: 'localhost',
  port: 1234,
  database: 'test',
  user: 'test',
  tls: 'verify',
  timeoutMs: 1000,
});
function fixture(dialect: RelationalDialect) {
  let state: Record<string, Row[]> = {};
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let failMatch = '',
    commitFail = false,
    closed = false,
    commits = 0,
    rollbacks = 0;
  let gate: Promise<void> | undefined;
  let tail = Promise.resolve();
  const adapter: RelationalAdapter = {
    dialect,
    async close() {
      closed = true;
    },
    async begin() {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      let pending = structuredClone(state);
      return {
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (failMatch && sql.includes(failMatch)) throw new Error('secret credentials');
          if (sql.startsWith('DECLARE')) return [];
          const table = sql.match(/novel_agent_v3_\w+/)?.[0];
          if (!table || sql.startsWith('CREATE') || sql.includes('CREATE TABLE')) {
            if (table) pending[table] ??= [];
            return [];
          }
          const rows = (pending[table] ??= []);
          const keyColumns = table.endsWith('repository')
            ? ['repository_id']
            : table.endsWith('owners')
              ? ['owner_id']
              : table.endsWith('documents')
                ? ['owner_id', 'document_key']
                : table.endsWith('receipts')
                  ? ['owner_id', 'source_hash']
                  : ['owner_id', 'project_id', 'entity_id'];
          if (sql.startsWith('INSERT') || sql.startsWith('IF NOT EXISTS')) {
            const columns = sql.match(/INSERT INTO [\w.]+ \(([^)]+)\)/)![1].split(', ');
            const insertValues = sql.startsWith('IF') ? values.slice(keyColumns.length) : values;
            const row = Object.fromEntries(columns.map((column, index) => [column, insertValues[index]]));
            if (!rows.some((existing) => keyColumns.every((key) => existing[key] === row[key])))
              rows.push(row);
            else if (!sql.includes('CONFLICT') && !sql.includes('DUPLICATE') && !sql.startsWith('IF'))
              throw new Error('duplicate');
            return [];
          }
          const where = sql.match(/WHERE (.*?)(?: ORDER BY| FOR UPDATE|$)/)?.[1];
          const conditions = where ? [...where.matchAll(/(\w+) = \?/g)].map((match) => match[1]) : [];
          if (sql.startsWith('SELECT'))
            return rows
              .filter((row) => conditions.every((key, index) => row[key] === values[index]))
              .map((row) => ({ ...row }));
          if (sql.startsWith('UPDATE')) {
            const columns = [...sql.match(/SET (.*?) WHERE/)![1].matchAll(/(\w+) = \?/g)].map(
              (match) => match[1],
            );
            for (const row of rows)
              if (conditions.every((key, index) => row[key] === values[columns.length + index]))
                columns.forEach((column, index) => {
                  row[column] = values[index];
                });
            return [];
          }
          if (sql.startsWith('DELETE'))
            pending[table] = rows.filter(
              (row) => !conditions.every((key, index) => row[key] === values[index]),
            );
          return [];
        },
        async commit() {
          await gate;
          if (commitFail) throw new Error('secret commit failure');
          state = pending;
          commits++;
        },
        async rollback() {
          rollbacks++;
          pending = {};
        },
        release() {
          unlock();
        },
      };
    },
  };
  return {
    storage: new RelationalStorage(config(dialect), adapter),
    adapter,
    calls,
    state: () => state,
    failure(match: string) {
      failMatch = match;
    },
    commitFailure() {
      commitFail = true;
    },
    hold(promise: Promise<void> | undefined) {
      gate = promise;
    },
    counts: () => ({ closed, commits, rollbacks }),
  };
}
const projectDocument = (
  title = 'One',
  chapters = [{ id: 'chapter', title: 'Chapter', number: 1, content: 'Prose' }],
) =>
  JSON.stringify([
    {
      id: 'project',
      title,
      chapters,
      assets: [{ id: 'asset', name: 'Map' }],
      workflows: [{ id: 'flow', name: 'Story' }],
    },
  ]);
for (const dialect of ['postgresql', 'mysql', 'sqlserver'] as const) {
  test(`${dialect}: isolated additive migration, CAS, all-document persistence and tenant isolation`, async () => {
    const f = fixture(dialect);
    await f.storage.migrate();
    assert.equal(Object.keys(f.state()).length, 8);
    const ddl = f.calls.filter((call) => call.sql.includes('CREATE TABLE'));
    assert.equal(ddl.length, 8);
    if (dialect === 'mysql')
      assert.ok(ddl.every((call) => call.sql.includes('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin')));
    if (dialect === 'sqlserver')
      assert.ok(
        ddl.every((call) => call.sql.includes('NVARCHAR(') && call.sql.includes('Latin1_General_100_BIN2')),
      );
    assert.equal(await f.storage.writeDocument('global-auth', 'auth.json', '{"secret":true}', 0), 1);
    assert.equal(await f.storage.writeDocument('other', 'auth.json', '{}', 0), 1);
    assert.equal(await f.storage.writeDocument('global-auth', 'auth.json', 'new', 1), 2);
    await assert.rejects(f.storage.writeDocument('global-auth', 'auth.json', 'stale', 1), {
      code: 'REVISION_CONFLICT',
    });
    assert.deepEqual(await f.storage.readDocument('global-auth', 'auth.json'), {
      revision: 2,
      content: 'new',
    });
    assert.deepEqual(await f.storage.readDocument('other', 'auth.json'), { revision: 1, content: '{}' });
    assert.equal(await f.storage.readDocument('missing', 'x'), null);
    assert.ok(
      f.calls.some((call) => call.sql.includes(dialect === 'sqlserver' ? 'UPDLOCK, HOLDLOCK' : 'FOR UPDATE')),
    );
    assert.ok(f.calls.every((call) => !call.sql.includes('global-auth') && !call.sql.includes('secret')));
    await f.storage.close();
    assert.equal(f.counts().closed, true);
  });
  test(`${dialect}: incremental owner-scoped projections and transactional rollback`, async () => {
    const f = fixture(dialect);
    await f.storage.migrate();
    await f.storage.writeDocument('a', 'projects.json', projectDocument(), 0);
    await f.storage.writeDocument('b', 'projects.json', projectDocument(), 0);
    assert.equal(
      f.state().novel_agent_v3_documents[0].content,
      '[{"id":"project","collections":{"chapters":["chapter"],"assets":["asset"],"workflows":["flow"]}}]',
    );
    assert.deepEqual(
      JSON.parse((await f.storage.readDocument('a', 'projects.json'))!.content),
      JSON.parse(projectDocument()),
    );
    assert.ok(!String(f.state().novel_agent_v3_projects[0].body).includes('Prose'));
    const start = f.calls.length;
    await f.storage.writeDocument('a', 'projects.json', projectDocument(), 1);
    assert.equal(
      f.calls
        .slice(start)
        .filter((call) =>
          /^(INSERT INTO|UPDATE|DELETE FROM).*v3_(projects|chapters|assets|workflows)/.test(call.sql),
        ).length,
      0,
    );
    await f.storage.writeDocument('a', 'projects.json', projectDocument('Changed', []), 2);
    assert.equal(f.state().novel_agent_v3_chapters.length, 1);
    assert.equal(f.state().novel_agent_v3_chapters[0].owner_id, 'b');
    assert.ok(
      f.calls
        .filter((call) => call.sql.startsWith('DELETE'))
        .every((call) => call.sql.includes('owner_id = ? AND project_id = ? AND entity_id = ?')),
    );
    const before = structuredClone(f.state());
    f.failure(
      'INSERT INTO ' +
        (dialect === 'postgresql' ? 'public.' : dialect === 'sqlserver' ? 'dbo.' : '') +
        'novel_agent_v3_chapters',
    );
    await assert.rejects(f.storage.writeDocument('a', 'projects.json', projectDocument(), 3), {
      code: 'STORAGE_FAILED',
    });
    assert.deepEqual(f.state(), before);
  });
  test(`${dialect}: imports idempotent; full snapshot keeps arbitrary owners/revisions/receipts`, async () => {
    const f = fixture(dialect);
    await f.storage.migrate();
    const hash = 'a'.repeat(64);
    assert.deepEqual(
      await f.storage.importDocuments('global/auth', hash, [{ key: 'auth.json', content: 'auth' }]),
      { imported: true, count: 1 },
    );
    assert.deepEqual(
      await f.storage.importDocuments('global/auth', hash, [{ key: 'auth.json', content: 'auth' }]),
      { imported: false, count: 1 },
    );
    await assert.rejects(f.storage.importDocuments('global/auth', 'b'.repeat(64), []), {
      code: 'IMPORT_CONFLICT',
    });
    await f.storage.writeDocument('tenant', 'projects.json', projectDocument(), 0);
    await f.storage.writeDocument('tenant', 'projects.json', projectDocument('New'), 1);
    const snapshot = await f.storage.exportSnapshot();
    const destination = fixture(dialect);
    await destination.storage.migrate();
    await destination.storage.importSnapshot(snapshot);
    assert.deepEqual(await destination.storage.exportSnapshot(), snapshot);
    await assert.rejects(destination.storage.importSnapshot(snapshot), { code: 'SNAPSHOT_CONFLICT' });
    assert.deepEqual(await destination.storage.exportSnapshot(), snapshot);
    const failingDestination = fixture(dialect);
    await failingDestination.storage.migrate();
    failingDestination.failure(
      'INSERT INTO ' +
        (dialect === 'postgresql' ? 'public.' : dialect === 'sqlserver' ? 'dbo.' : '') +
        'novel_agent_v3_receipts',
    );
    await assert.rejects(failingDestination.storage.importSnapshot(snapshot), { code: 'STORAGE_FAILED' });
    assert.deepEqual(await failingDestination.storage.exportSnapshot(), { version: 3, owners: [] });
    const duplicate = structuredClone(snapshot);
    duplicate.owners.push(duplicate.owners[0]);
    await assert.rejects(destination.storage.importSnapshot(duplicate), { code: 'INVALID_INPUT' });
  });
  test(`${dialect}: missing repository gate rejects writes and snapshots`, async () => {
    const f = fixture(dialect);
    await f.storage.migrate();
    f.state().novel_agent_v3_repository.length = 0;
    await assert.rejects(f.storage.writeDocument('owner', 'x', 'content', 0), { code: 'SCHEMA_NOT_READY' });
    await assert.rejects(f.storage.exportSnapshot(), { code: 'SCHEMA_NOT_READY' });
    await assert.rejects(f.storage.importSnapshot({ version: 3, owners: [] }), { code: 'SCHEMA_NOT_READY' });
    assert.equal(f.state().novel_agent_v3_documents.length, 0);
  });
  test(`${dialect}: concurrent same revision only commits once`, async () => {
    const f = fixture(dialect);
    await f.storage.migrate();
    const results = await Promise.allSettled([
      f.storage.writeDocument('owner', 'x', 'first', 0),
      f.storage.writeDocument('owner', 'x', 'second', 0),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(
      results.filter((result) => result.status === 'rejected' && result.reason.code === 'REVISION_CONFLICT')
        .length,
      1,
    );
  });
  test(`${dialect}: write awaits commit, unknown commit outcome and sanitized errors`, async () => {
    const f = fixture(dialect);
    await f.storage.migrate();
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let done = false;
    const pending = f.storage.writeDocument('owner', 'x', 'x', 0).then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false);
    assert.equal(f.state().novel_agent_v3_documents.length, 0);
    release();
    await pending;
    assert.equal(done, true);
    f.hold(undefined);
    f.commitFailure();
    await assert.rejects(
      f.storage.writeDocument('owner', 'x', 'y', 1),
      (error) =>
        error instanceof Error &&
        !error.message.includes('secret') &&
        'code' in error &&
        error.code === 'COMMIT_UNCERTAIN',
    );
  });
}
test('entity reconstruction preserves unknown metadata, optional collection presence and order', async () => {
  const f = fixture('mysql');
  await f.storage.migrate();
  const content = JSON.stringify([
    {
      id: 'p2',
      custom: { nested: [1, 2] },
      chapters: [
        { id: 'z', future: true },
        { id: 'a', content: 'next' },
      ],
      workflow: { legacy: true },
      steps: [{ id: 'step' }],
    },
    { id: 'p1', assets: [], workflows: [] },
  ]);
  await f.storage.writeDocument('arbitrary/global-owner', 'projects.json', content, 0);
  assert.deepEqual(
    JSON.parse((await f.storage.readDocument('arbitrary/global-owner', 'projects.json'))!.content),
    JSON.parse(content),
  );
  const snapshot = await f.storage.exportSnapshot();
  assert.deepEqual(JSON.parse(snapshot.owners[0].documents[0].content), JSON.parse(content));
});
test('typed profiles preserve SQL TLS validation and explicit tenant selection', () => {
  const parsed = storageConfigSchema.parse({
    version: 3,
    defaultProfileId: 'pg',
    profiles: [
      { id: 'pg', connection: config('postgresql') },
      { id: 'my', connection: config('mysql') },
    ],
    ownerProfiles: [{ ownerId: 'tenant', profileId: 'my' }],
  });
  assert.equal(profileForOwner(parsed, 'tenant').id, 'my');
  assert.equal(profileForOwner(parsed, 'global-auth').id, 'pg');
  assert.throws(() => storageConfigSchema.parse({ ...parsed, defaultProfileId: 'absent' }));
  assert.throws(() =>
    storageConfigSchema.parse({ ...parsed, profiles: [...parsed.profiles, parsed.profiles[0]] }),
  );
  assert.throws(() => new RelationalStorage({ ...config('mysql'), host: 'remote.example', tls: 'off' }));
  assert.throws(() => createProfileStorage(parsed, 'absent'), { code: 'UNKNOWN_PROFILE' });
  assert.throws(() => new RelationalStorage(config('mysql'), fixture('postgresql').adapter), {
    code: 'DRIVER_MISMATCH',
  });
});
test('invalid projects, duplicates, revisions and snapshot input rejected without durable changes', async () => {
  const f = fixture('postgresql');
  await f.storage.migrate();
  await assert.rejects(f.storage.writeDocument('owner', 'projects.json', 'invalid', 0), {
    code: 'INVALID_PROJECTS',
  });
  await assert.rejects(f.storage.writeDocument('owner', 'projects.json', '[{"id":"p"},{"id":"p"}]', 0), {
    code: 'INVALID_PROJECTS',
  });
  await assert.rejects(f.storage.writeDocument('owner', 'x', 'x', -1), { code: 'INVALID_INPUT' });
  await assert.rejects(f.storage.writeDocument('owner', 'x', 'x', Number.MAX_SAFE_INTEGER), {
    code: 'REVISION_OVERFLOW',
  });
  await assert.rejects(
    f.storage.importDocuments('owner', 'a'.repeat(64), [
      { key: 'x', content: 'a' },
      { key: 'x', content: 'b' },
    ]),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(f.storage.importSnapshot({ version: 2, owners: [] } as unknown as StorageSnapshot), {
    code: 'INVALID_INPUT',
  });
  assert.equal(f.state().novel_agent_v3_documents.length, 0);
});
