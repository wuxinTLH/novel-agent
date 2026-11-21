import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { databaseSubmission, initialDatabaseDraft, parseInitDatabase } from './init-database';
const json = { mode: 'local-json', connection: null, environmentFields: [], schemaInitialized: false, activeBackend: 'local-json' };
test('database defaults explicitly to local JSON and ignores stale SQL draft', () => {
  const config = parseInitDatabase(undefined);
  assert.deepEqual(config, json);
  assert.deepEqual(databaseSubmission(initialDatabaseDraft(config), config), { mode: 'local-json' });
});
test('public configuration preserves partial environment values but never password', () => {
  const config = parseInitDatabase({ ...json, mode: 'sql-later', connection: { host: 'db.invalid', hasPassword: true, password: 'never-echo' }, environmentFields: ['host', 'password'] });
  assert.deepEqual(config.connection, { host: 'db.invalid', hasPassword: true });
  const draft = { ...initialDatabaseDraft(config), mode: 'sql-later', host: 'attacker.invalid', database: 'novel', user: 'fixture', password: 'injected' };
  const submission = databaseSubmission(draft, config);
  assert.equal(submission?.mode, 'sql-later');
  if (submission?.mode !== 'sql-later') throw new Error('expected SQL configuration');
  assert.equal(submission.connection?.host, 'db.invalid');
  assert.equal(submission.connection?.password, undefined);
});
test('SQL draft syntax validation is offline and enforces TLS and numeric limits', () => {
  const draft = { ...initialDatabaseDraft(), mode: 'sql-later', host: 'db.invalid', database: 'novel', user: 'fixture' };
  assert.ok(databaseSubmission(draft));
  for (const patch of [{ host: '' }, { port: '0' }, { port: '1.5' }, { port: '65536' }, { database: 'bad-name' }, { timeoutMs: '999' }, { tls: 'off' }]) assert.equal(databaseSubmission({ ...draft, ...patch }), null);
  assert.ok(databaseSubmission({ ...draft, host: 'localhost', tls: 'off' }));
  const locked = parseInitDatabase({ ...json, environmentFields: ['mode'] });
  assert.deepEqual(databaseSubmission(draft, locked), { mode: 'local-json' });
});
test('unknown DB state fails closed instead of claiming active SQL', () => {
  for (const patch of [{ mode: 'sql' }, { schemaInitialized: true }, { activeBackend: 'sql' }, { environmentFields: ['unknown'] }, { connection: { hasPassword: true, port: -1 } }]) assert.throws(() => parseInitDatabase({ ...json, ...patch }));
});
test('DB controls never connect and gate clears all database draft secrets', () => {
  const component = readFileSync(new URL('./ServerInitDatabaseFields.tsx', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('./ServerInitGate.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /fetch\(|initRequest\(|localStorage|sessionStorage/);
  assert.ok(gate.includes('setDatabase(initialDatabaseDraft())'));
  assert.ok(gate.includes('database: submittedDatabase'));
  assert.ok(component.includes('init-db-mode'));
});
