import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_VIEW_KEY, readNodeView, saveNodeView } from './nodeViewPreference.js';

test('node view preference survives new reads for every supported view', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readNodeView(storage), 'grid');
  for (const view of ['list', 'menu', 'grid'] as const) {
    saveNodeView(view, storage);
    assert.equal(readNodeView(storage), view);
    assert.equal(values.size, 1);
  }
  values.set(NODE_VIEW_KEY, 'invalid');
  assert.equal(readNodeView(storage), 'grid');
});

test('node view persistence tolerates denied browser storage', () => {
  const storage = { getItem(): string { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readNodeView(storage), 'grid');
  assert.doesNotThrow(() => saveNodeView('menu', storage));
});
