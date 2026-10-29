import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamProgressStore } from './stream-progress.js';
const run = { scopeId: 'tenant-a', projectId: 'p', runId: 'r' };
test('progress is isolated by tenant, project, run and step; snapshots are detached', () => {
  const store = createStreamProgressStore();
  store.begin({ ...run, stepId: 's' }).append('temporary');
  for (const key of [{ ...run, scopeId: 'tenant-b' }, { ...run, projectId: 'q' }, { ...run, runId: 'old' }]) assert.deepEqual(store.snapshot(key).nodes, []);
  const snapshot = store.snapshot(run); snapshot.nodes[0].text = 'modified';
  assert.equal(store.snapshot(run).nodes[0].text, 'temporary');
});
test('text stays bounded, reports truncation, and never starts with a split surrogate', () => {
  const store = createStreamProgressStore({ maxTextChars: 4 });
  const handle = store.begin({ ...run, stepId: 's' }); handle.append('abc'); handle.append('😀中文');
  const node = store.snapshot(run).nodes[0];
  assert.ok(node.text.length <= 4); assert.equal(node.truncated, true);
  assert.ok(!/^[\uDC00-\uDFFF]/.test(node.text));
});
test('clear and abort prevent stale handles reviving entries or clearing replacement attempts', () => {
  const store = createStreamProgressStore(); const controller = new AbortController();
  const old = store.begin({ ...run, stepId: 's' }, controller.signal); old.append('old');
  const next = store.begin({ ...run, stepId: 's' }); next.append('next'); old.clear(); old.append('late');
  assert.equal(store.snapshot(run).nodes[0].text, 'next');
  store.clearRun(run); next.append('late'); assert.equal(store.snapshot(run).nodes.length, 0);
  const handle = store.begin({ ...run, stepId: 's' }, controller.signal); handle.append('draft'); controller.abort(); handle.append('late');
  assert.equal(store.snapshot(run).nodes.length, 0);
  store.begin({ ...run, stepId: 's' }, controller.signal).append('late'); assert.equal(store.snapshot(run).nodes.length, 0);
});
test('node/global caps and lazy expiry bound orphan memory without timers', () => {
  let now = 100; const store = createStreamProgressStore({ maxNodesPerRun: 2, maxEntries: 3, ttlMs: 10, now: () => now });
  for (const stepId of ['a', 'b', 'c']) { store.begin({ ...run, stepId }).append(stepId); now++; }
  assert.deepEqual(store.snapshot(run).nodes.map(v => v.stepId), ['c', 'b']);
  const other = { ...run, runId: 'other' }; store.begin({ ...other, stepId: 'a' }).append('other'); now++;
  store.begin({ ...other, stepId: 'b' }).append('other');
  assert.equal(store.snapshot(run).nodes.length, 1);
  now += 11; assert.deepEqual(store.snapshot(run).nodes, []); assert.deepEqual(store.snapshot(other).nodes, []);
  assert.deepEqual(createStreamProgressStore().snapshot(run).nodes, []);
});
