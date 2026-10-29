import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorkflowSchedule, runWorkflowSchedule } from './workflow-scheduler.js';
const nodes = ['start', 'a', 'b', 'join', 'end'].map(id => ({ id }));
const edges = [{ source: 'start', target: 'a' }, { source: 'start', target: 'b' }, { source: 'a', target: 'join' }, { source: 'b', target: 'join' }, { source: 'join', target: 'end' }];
test('stable ready waves respect all predecessors and concurrency bounds', () => {
  assert.deepEqual(planWorkflowSchedule(nodes, edges, 2).waves, [['start'], ['a', 'b'], ['join'], ['end']]);
  assert.deepEqual(planWorkflowSchedule(nodes, edges, 1).waves, [['start'], ['a'], ['b'], ['join'], ['end']]);
  assert.throws(() => planWorkflowSchedule(nodes, [...edges, { source: 'end', target: 'start' }]));
  assert.throws(() => planWorkflowSchedule(nodes, edges, 0));
  assert.throws(() => planWorkflowSchedule([{ id: 'a' }, { id: 'a' }], []));
});
test('runner admits siblings concurrently, joins only after completion and clones dependency results', async () => {
  let active = 0, peak = 0;
  const executed: string[] = [];
  const states = await runWorkflowSchedule(nodes, edges, { concurrency: 2, execute: async (id, deps) => {
    executed.push(id); active++; peak = Math.max(peak, active);
    if (id === 'join') assert.deepEqual(Object.keys(deps), ['a', 'b']);
    await Promise.resolve(); active--;
    return { value: id };
  } });
  assert.equal(peak, 2); assert.equal(states.end.status, 'done');
  assert.ok(executed.indexOf('join') > executed.indexOf('b'));
});
test('explicit branches propagate skip, any join merges selected branch; labels never select branches', async () => {
  const branched = [{ source: 'start', target: 'a', when: 'yes' }, { source: 'start', target: 'b', when: 'no' }, ...edges.slice(2)];
  const states = await runWorkflowSchedule(nodes.map(n => n.id === 'join' ? { ...n, join: 'any' as const } : n), branched, { execute: async id => ({ value: id, ...(id === 'start' ? { branch: 'yes' } : {}) }) });
  assert.equal(states.a.status, 'done'); assert.equal(states.b.status, 'skipped'); assert.equal(states.end.status, 'done');
  const strict = await runWorkflowSchedule(nodes, branched, { execute: async id => ({ branch: id === 'start' ? 'yes' : undefined }) });
  assert.equal(strict.join.status, 'skipped'); assert.equal(strict.end.status, 'skipped');
});
test('failure blocks descendants, independent work continues; disabled ancestors skip descendants', async () => {
  const states = await runWorkflowSchedule(nodes, edges, { concurrency: 2, execute: async id => { if (id === 'a') throw new Error('private provider error'); return {}; } });
  assert.equal(states.a.status, 'failed'); assert.equal(states.b.status, 'done'); assert.equal(states.join.status, 'blocked'); assert.equal(states.end.status, 'blocked');
  assert.ok(!JSON.stringify(states).includes('private provider error'));
  const disabled = await runWorkflowSchedule(nodes.map(n => ({ ...n, enabled: n.id !== 'start' })), edges, { execute: async () => assert.fail('disabled subtree must not execute') });
  assert.equal(disabled.end.status, 'skipped');
});
test('abort stops admissions and marks cooperative in-flight work cancelled', async () => {
  const controller = new AbortController(); const executed: string[] = [];
  const states = await runWorkflowSchedule(nodes, edges, { signal: controller.signal, concurrency: 2, execute: async id => { executed.push(id); controller.abort(); return {}; } });
  assert.deepEqual(executed, ['start']);
  assert.ok(Object.values(states).every(state => state.status === 'cancelled'));
  const preAborted = await runWorkflowSchedule(nodes, edges, { signal: controller.signal, execute: async () => assert.fail('no admission after cancellation') });
  assert.ok(Object.values(preAborted).every(state => state.status === 'cancelled'));
});
