import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureTenantDirectory } from './tenant-directory.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-tenant-directory-'));
  return {
    root,
    shared: path.join(root, 'users'),
    dir: path.join(root, 'users', 'owner'),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('concurrent shared ancestor creation accepts EEXIST only after inspecting the winning directory', () => {
  const f = fixture();
  try {
    const inspected: string[] = [];
    let races = 0;
    ensureTenantDirectory(f.root, f.dir, {
      existsSync: fs.existsSync,
      mkdirSync(cursor, options) {
        if (cursor === f.shared) {
          fs.mkdirSync(cursor, options); // Another worker wins after our exists check.
          races++;
        }
        return fs.mkdirSync(cursor, options); // Real EEXIST from the losing worker.
      },
      lstatSync(cursor) {
        inspected.push(cursor);
        return fs.lstatSync(cursor);
      },
    });
    assert.equal(races, 1);
    assert.deepEqual(inspected, [f.root, f.shared, f.dir]);
    assert.ok(fs.lstatSync(f.dir).isDirectory());
  } finally {
    f.close();
  }
});

test('racing EEXIST does not admit a symlink or non-directory and never creates its child', () => {
  for (const kind of ['symlink', 'file'] as const) {
    const f = fixture();
    try {
      const created: string[] = [];
      let inspectedWinner = false;
      assert.throws(
        () =>
          ensureTenantDirectory(f.root, f.dir, {
            existsSync(cursor) {
              return cursor === f.root;
            },
            mkdirSync(cursor) {
              created.push(cursor);
              throw Object.assign(new Error('competing creation'), { code: 'EEXIST' });
            },
            lstatSync(cursor) {
              if (cursor === f.shared) {
                inspectedWinner = true;
                return { isDirectory: () => kind === 'symlink', isSymbolicLink: () => kind === 'symlink' };
              }
              return fs.lstatSync(cursor);
            },
          }),
        /UNSAFE_TENANT_DIRECTORY/,
      );
      assert.equal(inspectedWinner, true);
      assert.deepEqual(created, [f.shared]);
      assert.equal(fs.existsSync(f.dir), false);
    } finally {
      f.close();
    }
  }
});

test('existing filesystem symlink ancestors remain rejected without writing through them', () => {
  const f = fixture();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-tenant-outside-'));
  try {
    fs.symlinkSync(target, f.shared, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ensureTenantDirectory(f.root, f.dir), /UNSAFE_TENANT_DIRECTORY/);
    assert.equal(fs.existsSync(path.join(target, 'owner')), false);
  } finally {
    f.close();
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('non-EEXIST mkdir failures and out-of-root targets fail closed', () => {
  const f = fixture();
  try {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    assert.throws(
      () =>
        ensureTenantDirectory(f.root, f.dir, {
          existsSync: fs.existsSync,
          mkdirSync() {
            throw denied;
          },
          lstatSync: fs.lstatSync,
        }),
      (error) => error === denied,
    );
    assert.throws(
      () => ensureTenantDirectory(f.root, path.join(f.root, '..', 'outside')),
      /UNSAFE_TENANT_DIRECTORY/,
    );
    assert.equal(fs.existsSync(f.shared), false);
  } finally {
    f.close();
  }
});
