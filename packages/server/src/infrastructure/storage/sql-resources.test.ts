import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlResourceDirectory } from './sql-resources.js';

test('default SQL resources resolve beside the module, independently of cwd', () => {
  assert.equal(sqlResourceDirectory(), fileURLToPath(new URL('./sql/', import.meta.url)));
});

test('explicit deployment root resolves source resources and compiled-only deployments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-sql-resources-'));
  try {
    const source = path.join(root, 'packages/server/src/infrastructure/storage/sql');
    const compiled = path.join(root, 'build/packages/server/src/infrastructure/storage/sql');
    fs.mkdirSync(compiled, { recursive: true });
    assert.equal(sqlResourceDirectory(root), compiled);
    fs.mkdirSync(source, { recursive: true });
    assert.equal(sqlResourceDirectory(root), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
