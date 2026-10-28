import test from 'node:test';
import assert from 'node:assert/strict';
import { RelationalStorage, type RelationalAdapter, type RelationalDialect } from './relational-storage.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Deliberately no implicit transaction serialization. This tests admission/SQL shape,
// not database isolation, transaction correctness, or real database performance.
function controlled(dialect: RelationalDialect) {
  const transactions: Array<{
    finish: ReturnType<typeof deferred>;
    commit: ReturnType<typeof deferred>;
    sql: string[];
  }> = [];
  let failure: 'begin' | 'query' | 'commit' | undefined;
  const adapter: RelationalAdapter = {
    dialect,
    async close() {},
    async begin() {
      if (failure === 'begin') {
        failure = undefined;
        throw new Error('begin');
      }
      const entry = { finish: deferred(), commit: deferred(), sql: [] as string[] };
      transactions.push(entry);
      return {
        async query(sql) {
          entry.sql.push(sql);
          if (failure === 'query') {
            failure = undefined;
            throw new Error('query');
          }
          if (sql.startsWith('SELECT revision FROM')) return [{ revision: 0 }];
          return [];
        },
        async commit() {
          entry.commit.resolve();
          await entry.finish.promise;
          if (failure === 'commit') {
            failure = undefined;
            throw new Error('commit');
          }
        },
        async rollback() {},
        release() {},
      };
    },
  };
  return {
    storage: new RelationalStorage(
      {
        driver: dialect,
        host: 'localhost',
        port: 1234,
        database: 'test',
        user: 'test',
        tls: 'off',
        timeoutMs: 1000,
      },
      adapter,
    ),
    transactions,
    fail(kind: typeof failure) {
      failure = kind;
    },
  };
}
for (const dialect of ['postgresql', 'mysql', 'sqlserver'] as const) {
  test(`${dialect}: owner queue shares barrier, snapshot waits through commit and blocks later work`, async () => {
    const f = controlled(dialect);
    const a = f.storage.writeDocument('a', 'one', 'x', 0);
    const a2 = f.storage.writeDocument('a', 'two', 'x', 0);
    const b = f.storage.writeDocument('b', 'one', 'x', 0);
    await tick();
    assert.equal(f.transactions.length, 2, 'same owner must wait before opening a connection');
    const snapshot = f.storage.exportSnapshot();
    const c = f.storage.writeDocument('c', 'one', 'x', 0);
    await tick();
    assert.equal(f.transactions.length, 2);
    f.transactions[0].finish.resolve();
    await a;
    await tick();
    assert.equal(f.transactions.length, 3, 'queued same-owner work before barrier may run');
    f.transactions[1].finish.resolve();
    f.transactions[2].finish.resolve();
    await Promise.all([a2, b]);
    await tick();
    assert.equal(f.transactions.length, 4, 'snapshot starts only after all prior commits');
    assert.ok(
      f.transactions[3].sql.some((sql) => sql.includes('repository') && /FOR UPDATE|XLOCK/.test(sql)),
    );
    f.transactions[3].finish.resolve();
    await snapshot;
    await tick();
    assert.equal(f.transactions.length, 5);
    f.transactions[4].finish.resolve();
    await c;
    const shared =
      dialect === 'postgresql' ? 'FOR SHARE' : dialect === 'mysql' ? 'LOCK IN SHARE MODE' : 'WITH (HOLDLOCK)';
    assert.ok(f.transactions[0].sql.some((sql) => sql.includes('repository') && sql.includes(shared)));
  });
  test(`${dialect}: document import and projected reads share the owner queue`, async () => {
    const f = controlled(dialect);
    const importer = f.storage.importDocuments('a', 'a'.repeat(64), []);
    const projected = f.storage.readDocument('a', 'projects.json');
    const other = f.storage.readDocument('b', 'plain');
    await tick();
    assert.equal(f.transactions.length, 2);
    f.transactions[0].finish.resolve();
    await importer;
    await tick();
    assert.equal(f.transactions.length, 3);
    f.transactions[1].finish.resolve();
    f.transactions[2].finish.resolve();
    await Promise.all([projected, other]);
  });
  test(`${dialect}: failed exclusive operation admits queued owners`, async () => {
    const f = controlled(dialect);
    f.fail('query');
    const snapshot = assert.rejects(f.storage.exportSnapshot(), { code: 'STORAGE_FAILED' });
    const writer = f.storage.writeDocument('a', 'x', 'x', 0);
    await snapshot;
    await tick();
    assert.equal(f.transactions.length, 2);
    f.transactions[1].finish.resolve();
    await writer;
  });
  test(`${dialect}: import and migration use exclusive admission`, async () => {
    const f = controlled(dialect);
    const restore = f.storage.importSnapshot({ version: 3, owners: [] });
    const migrate = f.storage.migrate();
    const read = f.storage.readDocument('a', 'x');
    await tick();
    assert.equal(f.transactions.length, 1);
    f.transactions[0].finish.resolve();
    await restore;
    await tick();
    assert.equal(f.transactions.length, 2);
    f.transactions[1].finish.resolve();
    await migrate;
    await tick();
    assert.equal(f.transactions.length, 3);
    f.transactions[2].finish.resolve();
    assert.equal(await read, null);
  });
  for (const phase of ['begin', 'query', 'commit'] as const) {
    test(`${dialect}: ${phase} failure releases owner and exclusive queue`, async () => {
      const f = controlled(dialect);
      f.fail(phase);
      const failed = assert.rejects(f.storage.writeDocument('a', 'x', 'x', 0), {
        code: phase === 'commit' ? 'COMMIT_UNCERTAIN' : 'STORAGE_FAILED',
      });
      await tick();
      f.transactions[0]?.finish.resolve();
      await failed;
      const again = f.storage.writeDocument('a', 'x', 'x', 0);
      await tick();
      f.transactions.at(-1)!.finish.resolve();
      await again;
      const snapshot = f.storage.exportSnapshot();
      await tick();
      f.transactions.at(-1)!.finish.resolve();
      await snapshot;
    });
  }
}
