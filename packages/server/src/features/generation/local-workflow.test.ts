import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUPER_NOVEL_STAGES, isLocalWorkflowStep } from '../../../../../shared/workflow-templates.js';
import type { StepGenerationContext } from '../../../../../shared/types.js';
import { createProject, createSuperNovelWorkflowGraph, normalizeWorkflow } from '../projects/defaults.js';
import { validateGraph } from '../workflow/workflow-graph.js';
import { editableStepSchema } from '../workflow/workflow-support.js';
import { Store } from '../projects/store.js';
import { buildContext, generate, Runner, type RuntimeSettings } from './engine.js';
import { settingsForStep, prepareRun } from './generation.js';
import { executeLocalWorkflowStep } from './local-workflow.js';

const unavailable: RuntimeSettings = { mode: 'live', apiKey: '', hasKey: false, model: '', baseUrl: '' };
function fixture() {
  const p = createProject('增强模板');
  const graph = createSuperNovelWorkflowGraph();
  p.steps = graph.steps; p.workflow = graph.workflow; p.activeWorkflowId = graph.id; p.workflows = [graph];
  const context: StepGenerationContext = { runId: 'run', workflowId: graph.id, number: 3, mode: 'create',
    requirements: { instructions: '雾海', requiredText: [], forbiddenText: [] }, graphRevision: 0 };
  return { p, context, imported: p.steps[1], retrieved: p.steps[2] };
}

test('super template is optional, executable, explicit writer/audit, and normalization preserves saved work', () => {
  const { p } = fixture();
  assert.deepEqual(p.steps.slice(1, -1).map(({ id, kind }) => ({ id, kind })), [...SUPER_NOVEL_STAGES]);
  assert.equal(p.steps.filter(isLocalWorkflowStep).length, 2);
  assert.equal(p.steps.filter(s => !isLocalWorkflowStep(s) && s.kind !== 'start' && s.kind !== 'end').length, 6);
  assert.equal(p.workflow!.auditNodeId, 'review'); assert.equal(p.workflow!.outputWriterNodeId, 'draft');
  assert.equal(p.workflow!.autoPublish, false); assert.equal(p.workflow!.autoGenerate, false);
  assert.equal(p.workflow!.maxParallelNodes, 1); validateGraph(p, true);
  assert.deepEqual(prepareRun(p).orderedStepIds, p.steps.map(s => s.id));
  p.steps[1].prompt = '作者原任务'; const before = structuredClone(p.steps); normalizeWorkflow(p);
  assert.deepEqual(p.steps, before);
  assert.deepEqual(createProject('默认').steps.map(s => s.kind), ['start', 'plan', 'writer', 'audit', 'end']);
  for (const step of p.steps.filter(isLocalWorkflowStep)) {
    const { status: _status, output: _output, ...editable } = step;
    assert.doesNotThrow(() => editableStepSchema.parse(editable));
  }
});

test('world import is selected, bounded read-only text and never follows URLs', () => {
  const { p, context, imported } = fixture();
  p.assets = [
    { id: 'a', name: '已确认世界', category: 'world', content: 'SELECTED_WORLD', size: 1, createdAt: '' },
    { id: 'b', name: '未选择世界', category: 'world', content: 'EXCLUDED_WORLD', size: 1, createdAt: '' },
    { id: 'c', name: '人物', category: 'characters', content: 'NOT_WORLD', size: 1, createdAt: '' },
  ];
  imported.assetIds = ['a']; const before = structuredClone(p.assets);
  const output = executeLocalWorkflowStep(p, imported, context);
  assert.match(output, /SELECTED_WORLD/); assert.doesNotMatch(output, /EXCLUDED_WORLD|NOT_WORLD/);
  assert.deepEqual(p.assets, before);
  imported.assetIds = []; assert.match(executeLocalWorkflowStep(p, imported, context), /未选中/);
  imported.assetIds = ['missing']; assert.match(executeLocalWorkflowStep(p, imported, context), /未选中/);
  delete imported.assetIds; p.assets[0].content = '大'.repeat(30000);
  const bounded = executeLocalWorkflowStep(p, imported, context);
  assert.ok(bounded.length < 17000); assert.match(bounded, /截断/); assert.match(bounded, /未包含/);
});

test('retrieval uses only prior canonical prose and exposes missing predecessor/source/budget', () => {
  const { p, context, retrieved } = fixture();
  p.chapters = [1, 3, 4].map(number => ({ id: 'c' + number, number, revision: 1, title: '章' + number,
    content: number === 1 ? '雾海 PRIOR_CANONICAL' : '雾海 FUTURE_OR_TARGET', mode: 'demo', updatedAt: '' }));
  p.knowledgeFacts = [
    { id: 'fact1', type: 'fact', title: '先前事实', content: 'PRIOR_FACT', chapterIds: ['c1'], tags: [], revision: 1, createdAt: '', updatedAt: '' },
    { id: 'fact2', type: 'fact', title: '未来事实', content: 'FUTURE_FACT', chapterIds: ['c4'], tags: [], revision: 1, createdAt: '', updatedAt: '' },
    { id: 'fact3', type: 'fact', title: '悬空事实', content: 'MISSING_FACT', chapterIds: ['missing'], tags: [], revision: 1, createdAt: '', updatedAt: '' },
  ];
  retrieved.prompt = '雾海'; retrieved.assetIds = [];
  p.steps.find(s => s.id === 'draft')!.output = 'CANDIDATE_OUTPUT';
  const output = executeLocalWorkflowStep(p, retrieved, context);
  assert.match(output, /PRIOR_CANONICAL/); assert.match(output, /PRIOR_FACT/);
  assert.doesNotMatch(output, /FUTURE_OR_TARGET|CANDIDATE_OUTPUT|FUTURE_FACT|MISSING_FACT/);
  assert.match(output, /直接前章缺失/); assert.match(output, /字符偏移/); assert.match(output, /预算/);
  retrieved.output = output; retrieved.status = 'done'; retrieved.generationContext = context;
  assert.match(buildContext(p, 'plan', context), /PRIOR_CANONICAL/);
  assert.doesNotMatch(buildContext(p, 'plan', { ...context, runId: 'other' }), /本地上下文检索/);
  p.chapters = []; assert.match(executeLocalWorkflowStep(p, retrieved, context), /没有目标章之前/);
  assert.match(executeLocalWorkflowStep(p, retrieved, context), /无关键词匹配/);
  retrieved.prompt = '词'.repeat(13000);
  assert.match(executeLocalWorkflowStep(p, retrieved, context), /检索词因 12000 字符预算截断/);
});

test('local stages bypass provider/model admission, support cancellation and persist through Runner', async () => {
  const { p, context, imported, retrieved } = fixture();
  for (const step of [imported, retrieved]) {
    step.modelId = 'deleted-profile';
    assert.equal(settingsForStep(step, unavailable), unavailable);
    assert.match(await generate(p, step.id, unavailable, '', new AbortController().signal, context), /未调用模型/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(generate(p, step.id, unavailable, '', aborted.signal, context), { name: 'AbortError' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-local-workflow-'));
  try {
    const store = new Store(dir); const saved = store.projects[0];
    Object.assign(saved, { steps: p.steps, workflow: p.workflow, activeWorkflowId: p.activeWorkflowId, workflows: p.workflows });
    // A standalone local step is admitted even with no usable model; downstream model stages remain protected.
    assert.doesNotThrow(() => prepareRun(saved, { stepId: imported.id }, unavailable));
    assert.throws(() => prepareRun(saved, {}, unavailable), { code: 'MODEL_UNAVAILABLE' });
    await new Runner(store).run(saved, unavailable, { stepId: imported.id });
    assert.equal(saved.run!.status, 'done'); assert.equal(imported.status, 'done');
    assert.equal(saved.modelUsage?.length || 0, 0);
    assert.match(new Store(dir).get(saved.id)!.steps[1].output, /本地世界观导入/);
    assert.equal(saved.candidates?.length || 0, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
