import { SYSTEM_END_NODE_ID, SYSTEM_START_NODE_ID, type Project, type Step } from '../shared/types.js';

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_GRAPH' });
}

/** Validates without repairing or mutating the graph. Editing permits disconnected nodes. */
export function validateGraph(p: Pick<Project, 'steps' | 'workflow'>, execution = false): void {
  const ids = new Set<string>();
  for (const step of p.steps) {
    if (!step.id || ids.has(step.id)) invalid('工作流包含重复或空节点 ID。');
    ids.add(step.id);
    if (
      (step.kind === 'start' && step.id !== SYSTEM_START_NODE_ID) ||
      (step.kind === 'end' && step.id !== SYSTEM_END_NODE_ID)
    )
      invalid('开始和结束节点由系统固定管理。');
  }
  const start = p.steps.find((step) => step.id === SYSTEM_START_NODE_ID);
  const end = p.steps.find((step) => step.id === SYSTEM_END_NODE_ID);
  if (
    !start ||
    !end ||
    start.kind !== 'start' ||
    end.kind !== 'end' ||
    start.enabled === false ||
    end.enabled === false
  )
    invalid('工作流必须保留启用的系统开始和结束节点。');
  if (p.workflow?.startNodeId !== SYSTEM_START_NODE_ID || p.workflow.endNodeId !== SYSTEM_END_NODE_ID)
    invalid('工作流边界配置不正确。');
  const edges = p.workflow.edges;
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (!edge.id || edgeIds.has(edge.id)) invalid('工作流包含重复或空连线 ID。');
    edgeIds.add(edge.id);
    const pair = JSON.stringify([edge.source, edge.target]);
    if (pairs.has(pair)) invalid('工作流包含重复的节点连线。');
    pairs.add(pair);
    if (!ids.has(edge.source) || !ids.has(edge.target)) invalid('工作流包含指向不存在节点的连线。');
    if (edge.source === SYSTEM_END_NODE_ID || edge.target === SYSTEM_START_NODE_ID)
      invalid('开始节点只能作为入口，结束节点只能作为出口。');
  }
  const indegree = new Map(p.steps.map((step) => [step.id, 0]));
  for (const edge of edges) indegree.set(edge.target, indegree.get(edge.target)! + 1);
  const queue = p.steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  let count = 0;
  while (queue.length) {
    const id = queue.shift()!;
    count++;
    for (const edge of edges.filter((item) => item.source === id)) {
      indegree.set(edge.target, indegree.get(edge.target)! - 1);
      if (indegree.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  if (count !== p.steps.length) invalid('工作流存在循环依赖，请删除环路后重试。');
  if (!execution) return;
  const enabled = new Set(p.steps.filter((step) => step.enabled !== false).map((step) => step.id));
  for (const edge of edges) {
    if (enabled.has(edge.target) && !enabled.has(edge.source))
      invalid(
        `节点「${p.steps.find((step) => step.id === edge.target)!.title}」依赖已禁用节点，请修改连线或启用该节点。`,
      );
  }
  const reachable = walk(p, SYSTEM_START_NODE_ID, false, enabled);
  const toEnd = walk(p, SYSTEM_END_NODE_ID, true, enabled);
  for (const step of p.steps.filter((item) => item.enabled !== false)) {
    if (step.id !== SYSTEM_START_NODE_ID && !reachable.has(step.id))
      invalid(`节点「${step.title}」无法从开始节点到达。`);
    if (step.id !== SYSTEM_END_NODE_ID && !toEnd.has(step.id))
      invalid(`节点「${step.title}」无法到达结束节点。`);
  }
}

function walk(
  p: Pick<Project, 'workflow'>,
  id: string,
  reverse: boolean,
  allowed?: Set<string>,
): Set<string> {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of p.workflow?.edges || []) {
      if ((reverse ? edge.target : edge.source) !== current) continue;
      const next = reverse ? edge.source : edge.target;
      if (next === id || result.has(next) || (allowed && !allowed.has(next))) continue;
      result.add(next);
      queue.push(next);
    }
  }
  return result;
}
export function downstreamIds(p: Pick<Project, 'workflow'>, id: string): Set<string> {
  return walk(p, id, false);
}
export function upstreamIds(p: Pick<Project, 'workflow'>, id: string): Set<string> {
  return walk(p, id, true);
}

/** Stable Kahn ordering: a join runs only after every predecessor, never BFS order. */
export function orderedSteps(p: Pick<Project, 'steps' | 'workflow'>): Step[] {
  validateGraph(p, true);
  const steps = p.steps.filter((step) => step.enabled !== false);
  const remaining = new Set(steps.map((step) => step.id));
  const result: Step[] = [];
  while (remaining.size) {
    const next = steps.find(
      (step) =>
        remaining.has(step.id) &&
        !(p.workflow?.edges || []).some((edge) => edge.target === step.id && remaining.has(edge.source)),
    );
    if (!next) invalid('工作流无法按依赖顺序执行。');
    result.push(next);
    remaining.delete(next.id);
  }
  return result;
}
