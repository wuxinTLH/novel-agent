import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_PRESETS } from '../../../../../shared/node-presets.js';
import { SYSTEM_END_NODE_ID, SYSTEM_START_NODE_ID } from '../../../../../shared/types.js';
import { buildContext } from '../generation/engine.js';
import { prepareRun } from '../generation/generation.js';
import { validateGraph } from '../workflow/workflow-graph.js';
import { createProject, createSteps, createWorkflowGraph, normalizeWorkflow, starterProject } from './defaults.js';

const chapterIds = [SYSTEM_START_NODE_ID, 'plan', 'draft', 'review', SYSTEM_END_NODE_ID];

test('new chapter templates run three paid stages with an explicit audit, without auto-publishing', () => {
  for (const graph of [createWorkflowGraph('章模板', true), (() => {
    const project = createProject('新书');
    return { steps: project.steps, workflow: project.workflow! };
  })()]) {
    assert.deepEqual(graph.steps.map((step) => step.id), chapterIds);
    assert.deepEqual(graph.workflow.edges.map(({ source, target }) => [source, target]), [
      [SYSTEM_START_NODE_ID, 'plan'],
      ['plan', 'draft'],
      ['draft', 'review'],
      ['review', SYSTEM_END_NODE_ID],
    ]);
    assert.deepEqual(graph.steps.slice(1, -1).map((step) => step.kind), ['plan', 'writer', 'audit']);
    assert.ok(graph.steps.slice(1, -1).every((step) => step.enabled && !step.reusePreviousOutput));
    assert.equal(graph.workflow.auditNodeId, 'review');
    assert.equal(graph.workflow.autoPublish, false);
    assert.equal(graph.workflow.autoGenerate, false);
    assert.ok((graph.workflow.maxParallelNodes ?? 1) <= 1, 'linear graph must not promise parallel work');
    validateGraph(graph, true);
  }
  const project = createProject('首章');
  assert.deepEqual(prepareRun(project).orderedStepIds, chapterIds);
});

test('chapter planning still receives supplied lore and plot plus earlier prose', () => {
  const project = starterProject();
  project.chapters = [{
    id: 'first', number: 1, revision: 1, title: '第一章', content: '前章实际正文', mode: 'demo', updatedAt: '',
  }];
  const context = buildContext(project, 'plan', {
    runId: 'chapter-2', workflowId: project.activeWorkflowId!, number: 2, mode: 'create',
    requirements: { instructions: '', requiredText: [], forbiddenText: [] },
    graphRevision: project.workflow!.graphRevision || 0,
  });
  assert.match(context, /雾海 · 世界观/);
  assert.match(context, /故事主线/);
  assert.match(context, /前章实际正文/);
  assert.match(context, /当前目标章节：第 2 章/);
});

test('legacy and customized graphs remain intact on normalization; optional world and outline remain available', () => {
  const optional = createSteps();
  assert.deepEqual(optional.map((step) => step.id), ['lore', 'outline', 'plan', 'draft', 'review']);
  assert.deepEqual(optional.map((step) => step.kind), ['world', 'outline', 'plan', 'writer', 'audit']);
  assert.equal(optional[0].prompt, NODE_PRESETS.world.prompt);
  assert.equal(optional[1].prompt, NODE_PRESETS.outline.prompt);

  const project = createProject('自定义');
  const old = optional.map((step) => ({
    ...step,
    kind: (['lore', 'outline', 'plan'].includes(step.id) ? 'agent' : step.kind) as typeof step.kind,
    prompt: `作者提示词：${step.id}`,
    output: `作者已存结果：${step.id}`,
    status: 'done' as const,
  }));
  project.steps = [project.steps[0], ...old, project.steps.at(-1)!];
  project.workflow!.edges = [
    { id: 'start-lore', source: SYSTEM_START_NODE_ID, target: 'lore' },
    { id: 'lore-outline', source: 'lore', target: 'outline' },
    { id: 'outline-plan', source: 'outline', target: 'plan' },
    { id: 'plan-draft', source: 'plan', target: 'draft' },
    { id: 'draft-review', source: 'draft', target: 'review' },
    { id: 'review-end', source: 'review', target: SYSTEM_END_NODE_ID },
  ];
  project.workflow!.maxParallelNodes = 2;
  const before = project.steps.slice(1, -1).map(({ id, kind, prompt, output, status }) => ({ id, kind, prompt, output, status }));
  const edges = structuredClone(project.workflow!.edges);
  normalizeWorkflow(project);
  assert.deepEqual(project.steps.slice(1, -1).map(({ id, kind, prompt, output, status }) => ({ id, kind, prompt, output, status })), before);
  assert.deepEqual(project.workflow!.edges, edges);
  assert.equal(project.workflow!.maxParallelNodes, 2);
  assert.equal(project.workflow!.autoPublish, false);
  validateGraph(project, true);
});
