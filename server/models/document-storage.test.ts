import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindDocumentStorage, readDocumentFile, writeDocumentFile } from './document-storage.js';
import { Store } from '../store.js';
import { createModelProvider } from './model-provider.js';
import { PostgresBridge } from './postgres-bridge.js';

test('bound business documents never fall back to legacy JSON; all writes honor durability failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-documents-'));
  const documents = new Map<string, string>();
  let rejectWrites = false;
  fs.writeFileSync(path.join(dir, 'projects.json'), 'invalid legacy input must never be read');
  const unbind = bindDocumentStorage(dir, {
    read(key) {
      return documents.get(key) ?? null;
    },
    write(key, value) {
      if (rejectWrites) throw new Error('COMMIT_UNCERTAIN');
      documents.set(key, value);
    },
  });
  try {
    const store = new Store(dir);
    assert.equal(store.projects.length, 1);
    assert.ok(documents.has('projects.json'));
    assert.equal(
      fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'),
      'invalid legacy input must never be read',
    );
    const models = createModelProvider(dir, false);
    models.saveModels();
    assert.ok(documents.has('models.json'));
    assert.equal(fs.existsSync(path.join(dir, 'models.json')), false);
    assert.equal(readDocumentFile(path.join(dir, 'absent.json')), null);
    assert.throws(() => bindDocumentStorage(dir, { read: () => null, write() {} }), /ALREADY_BOUND/);
    rejectWrites = true;
    assert.throws(() => store.save(), /COMMIT_UNCERTAIN/);
    assert.throws(() => models.saveModels(), /COMMIT_UNCERTAIN/);
    assert.throws(() => writeDocumentFile(path.join(dir, 'other.json'), '{}'), /COMMIT_UNCERTAIN/);
  } finally {
    unbind();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL bridge fails closed before spawning after uncertain persistence', () => {
  const bridge = Object.create(PostgresBridge.prototype) as PostgresBridge;
  Object.assign(bridge, { failed: true, revisions: new Map() });
  assert.throws(() => bridge.assertHealthy(), { code: 'STORAGE_RECONCILIATION_REQUIRED' });
  assert.throws(() => bridge.read('projects.json'), { code: 'STORAGE_RECONCILIATION_REQUIRED' });
  assert.throws(() => bridge.write('projects.json', '[]'), { code: 'STORAGE_RECONCILIATION_REQUIRED' });
});
