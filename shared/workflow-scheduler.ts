/** Pure scheduling primitives. No model/network/persistence side effects. */
export type ScheduleStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'blocked' | 'cancelled';
export interface ScheduleNode { id: string; enabled?: boolean; join?: 'all' | 'any' }
export interface ScheduleEdge { source: string; target: string; /** Explicit branch selected by the source result. Labels are presentation only. */ when?: string }
export interface ScheduleResult<T = unknown> { value?: T; branch?: string }
export interface ScheduleState<T = unknown> { status: ScheduleStatus; result?: ScheduleResult<T>; reason?: string }
export interface WorkflowSchedule { nodes: ScheduleNode[]; edges: ScheduleEdge[]; waves: string[][] }
const terminal = (s: ScheduleStatus) => s !== 'pending' && s !== 'running';
export function planWorkflowSchedule(nodes: readonly ScheduleNode[], edges: readonly ScheduleEdge[], concurrency = 1): WorkflowSchedule {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('并发上限必须为 1–32 的整数。');
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id || ids.has(node.id)) throw new Error('调度图包含重复或空节点 ID。');
    if (node.join !== undefined && node.join !== 'all' && node.join !== 'any') throw new Error('调度节点汇合策略无效。');
    ids.add(node.id);
  }
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error('调度连线引用不存在的节点。');
    const pair = JSON.stringify([edge.source, edge.target]);
    if (pairs.has(pair)) throw new Error('调度图包含重复连线。'); pairs.add(pair);
    if (edge.when !== undefined && !edge.when.trim()) throw new Error('条件分支值不能为空。');
  }
  const remaining = new Set(ids), waves: string[][] = [];
  while (remaining.size) {
    const ready = nodes.filter(node => remaining.has(node.id) && !edges.some(edge => edge.target === node.id && remaining.has(edge.source))).map(node => node.id);
    if (!ready.length) throw new Error('调度图存在循环依赖。');
    // Each wave is a safe barrier; independent siblings may share a bounded wave.
    for (let i = 0; i < ready.length; i += concurrency) waves.push(ready.slice(i, i + concurrency));
    for (const id of ready) remaining.delete(id);
  }
  return { nodes: nodes.map(node => ({ ...node })), edges: edges.map(edge => ({ ...edge })), waves };
}
export function initialScheduleState<T>(plan: WorkflowSchedule): Record<string, ScheduleState<T>> {
  return Object.fromEntries(plan.nodes.map(node => [node.id, { status: node.enabled === false ? 'skipped' : 'pending', ...(node.enabled === false ? { reason: 'disabled' } : {}) } as ScheduleState<T>]));
}
/** Mutates only scheduling states, never graph/output. All predecessors must resolve before a join. */
export function readyScheduleNodes<T>(plan: WorkflowSchedule, states: Record<string, ScheduleState<T>>): string[] {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of plan.nodes) {
      if (states[node.id].status !== 'pending') continue;
      const incoming = plan.edges.filter(edge => edge.target === node.id);
      if (!incoming.length || incoming.some(edge => !terminal(states[edge.source].status))) continue;
      const active = incoming.filter(edge => states[edge.source].status === 'done' && (edge.when === undefined || states[edge.source].result?.branch === edge.when));
      const failure = incoming.some(edge => ['failed', 'blocked', 'cancelled'].includes(states[edge.source].status));
      if (failure) { states[node.id] = { status: 'blocked', reason: 'dependency-failed' }; changed = true; }
      else if (!active.length || (node.join !== 'any' && active.length !== incoming.length)) {
        states[node.id] = { status: 'skipped', reason: 'branch-not-selected' }; changed = true;
      }
    }
  }
  return plan.nodes.filter(node => states[node.id].status === 'pending' && plan.edges.filter(edge => edge.target === node.id).every(edge => terminal(states[edge.source].status))).map(node => node.id);
}
export interface SchedulerOptions<T> {
  concurrency?: number;
  signal?: AbortSignal;
  execute: (nodeId: string, dependencies: Readonly<Record<string, ScheduleResult<T>>>, signal: AbortSignal) => Promise<ScheduleResult<T>>;
  onState?: (nodeId: string, state: Readonly<ScheduleState<T>>) => void;
}
/** Admission is bounded. Cancellation stops new admissions and drains active cooperative tasks.
 * Tasks must respect signal; callbacks must not mutate shared project state concurrently.
 * Failure blocks descendants while independent branches are allowed to complete.
 */
export async function runWorkflowSchedule<T>(nodes: readonly ScheduleNode[], edges: readonly ScheduleEdge[], options: SchedulerOptions<T>): Promise<Record<string, ScheduleState<T>>> {
  const concurrency = options.concurrency ?? 1;
  const plan = planWorkflowSchedule(nodes, edges, concurrency);
  const states = initialScheduleState<T>(plan);
  const signal = options.signal ?? new AbortController().signal;
  const active = new Map<string, Promise<void>>();
  const emit = (id: string) => options.onState?.(id, structuredClone(states[id]));
  while (true) {
    if (signal.aborted) {
      for (const node of plan.nodes) if (states[node.id].status === 'pending') { states[node.id] = { status: 'cancelled', reason: 'cancelled' }; emit(node.id); }
    } else {
      const previous = Object.fromEntries(plan.nodes.map(node => [node.id, states[node.id].status]));
      const ready = readyScheduleNodes(plan, states);
      for (const node of plan.nodes) if (previous[node.id] !== states[node.id].status) emit(node.id);
      for (const id of ready.slice(0, Math.max(0, concurrency - active.size))) {
        if (signal.aborted) break;
        states[id] = { status: 'running' }; emit(id);
        const dependencies = Object.fromEntries(plan.edges.filter(edge => edge.target === id && states[edge.source].status === 'done' && (edge.when === undefined || states[edge.source].result?.branch === edge.when)).map(edge => [edge.source, structuredClone(states[edge.source].result!)]));
        const task = Promise.resolve().then(() => { signal.throwIfAborted(); return options.execute(id, dependencies, signal); }).then(result => {
          states[id] = signal.aborted ? { status: 'cancelled', reason: 'cancelled' } : { status: 'done', result };
        }, () => { states[id] = signal.aborted ? { status: 'cancelled', reason: 'cancelled' } : { status: 'failed', reason: 'execution-failed' }; }).then(() => { active.delete(id); emit(id); });
        active.set(id, task);
      }
    }
    if (!active.size) break;
    await Promise.race(active.values());
  }
  return states;
}
