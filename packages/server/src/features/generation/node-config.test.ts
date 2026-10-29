import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { NODE_PRESETS } from '../../../../../shared/node-presets.js';
import { DEFAULT_CHARACTER_TEMPLATE } from '../../../../../shared/types.js';
import { createCharacterWorkflowGraph, createProject, createSteps, createWorldWorkflowGraph, normalizeWorkflow } from '../projects/defaults.js';
import { buildContext, generate, Runner, type RuntimeSettings } from './engine.js';
import { prepareRun } from './generation.js';
import { Store } from '../projects/store.js';

const demo: RuntimeSettings = { mode: 'demo', apiKey: '', hasKey: false, model: '', baseUrl: '' };
function useGraph(p: ReturnType<typeof createProject>, graph: ReturnType<typeof createWorldWorkflowGraph>) {
  p.steps = graph.steps;
  p.workflow = graph.workflow;
  p.activeWorkflowId = graph.id;
  p.workflows = [graph];
}

test('new defaults share task-specific presets without changing saved prompts or templates', () => {
  assert.deepEqual(Object.keys(NODE_PRESETS).sort(), ['world', 'expand', 'outline', 'plan', 'writer', 'audit', 'custom', 'character', 'dialogue', 'scene', 'continuity', 'conflict', 'foreshadow', 'twist', 'climax'].sort());
  const p = createProject('默认值');
  assert.equal(p.steps.find(s => s.id === 'draft')!.prompt, NODE_PRESETS.writer.prompt);
  assert.doesNotMatch(NODE_PRESETS.writer.prompt, /1500|2500/);
  assert.doesNotMatch(DEFAULT_CHARACTER_TEMPLATE, /力量|san值/);
  const draft = p.steps.find(s => s.id === 'draft')!;
  draft.prompt = '作者原有提示词';
  draft.characterTemplate = '作者原有模板';
  normalizeWorkflow(p);
  assert.equal(draft.prompt, '作者原有提示词');
  assert.equal(draft.characterTemplate, '作者原有模板');
});

test('optional plot nodes form executable upstream stages without entering the default graph', async () => {
  const p = createProject('剧情节点');
  const kinds = ['conflict', 'foreshadow', 'twist', 'climax'] as const;
  assert.ok(!p.steps.some((step) => kinds.includes(step.kind as typeof kinds[number])));
  let previous = p.workflow!.startNodeId!;
  p.workflow!.edges = p.workflow!.edges.filter((edge) => edge.target !== 'plan');
  for (const kind of kinds) {
    p.steps.splice(p.steps.findIndex((step) => step.id === 'plan'), 0, {
      id: `plot-${kind}`, kind, ...NODE_PRESETS[kind], status: 'idle', output: '',
      position: { x: 100, y: 100 },
    });
    p.workflow!.edges.push({ id: `to-${kind}`, source: previous, target: `plot-${kind}` });
    previous = `plot-${kind}`;
  }
  p.workflow!.edges.push({ id: 'to-plan', source: previous, target: 'plan' });
  const prepared = prepareRun(p, {}, demo);
  const order = prepared.orderedStepIds;
  for (const kind of kinds) {
    assert.ok(order.indexOf(`plot-${kind}`) < order.indexOf('plan'));
    const step = p.steps.find((item) => item.id === `plot-${kind}`)!;
    assert.match(buildContext(p, step.id), new RegExp(NODE_PRESETS[kind].prompt));
    step.prompt = `作者保留指令-${kind}`;
    normalizeWorkflow(p);
    assert.equal(step.prompt, `作者保留指令-${kind}`);
  }

  for (const kind of kinds) {
    const step = p.steps.find((item) => item.id === `plot-${kind}`)!;
    step.output = `上游剧情-${kind}`;
    step.status = 'done';
    step.reusePreviousOutput = true;
  }
  const planningContext = buildContext(p, 'plan');
  for (const kind of kinds) assert.ok(planningContext.includes(`上游剧情-${kind}`));

  // Live execution uses the same model transport as every ordinary node, not a UI-only kind.
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '可用于后续规划的剧情设计' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const settings: RuntimeSettings = { ...demo, mode: 'live', apiKey: 'test-key', hasKey: true,
      model: 'test-model', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
    for (const kind of kinds) {
      assert.equal(await generate(p, `plot-${kind}`, settings, '', new AbortController().signal), '可用于后续规划的剧情设计');
      assert.ok(seen.at(-1)!.includes(`作者保留指令-${kind}`));
    }
    assert.equal(seen.length, kinds.length);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('setting-only workflows reject unavailable models before admission but reused outputs need no model', () => {
  for (const graph of [createWorldWorkflowGraph(), createCharacterWorkflowGraph()]) {
    const p = createProject('校验');
    useGraph(p, graph);
    const step = p.steps.find(s => s.kind !== 'start' && s.kind !== 'end')!;
    step.modelId = 'missing-model';
    assert.throws(() => prepareRun(p, {}, demo), { code: 'MODEL_UNAVAILABLE' });
    assert.equal(p.run, undefined);
    step.reusePreviousOutput = true;
    step.output = '已确认的设定';
    assert.doesNotThrow(() => prepareRun(p, {}, demo));
  }
});

test('explicitly reused upstream output remains available to standalone downstream context', () => {
  const p = createProject('复用');
  const [lore, outline] = createSteps();
  p.steps.splice(1, 0, lore, outline);
  p.workflow!.edges.push({ id: 'setting-outline', source: lore.id, target: outline.id });
  lore.output = 'REUSED_AUTHOR_APPROVED_SETTING';
  lore.status = 'done';
  lore.reusePreviousOutput = true;
  // No context is required for an explicitly opted-in reusable setting.
  assert.match(buildContext(p, 'outline'), /REUSED_AUTHOR_APPROVED_SETTING/);
  lore.reusePreviousOutput = false;
  assert.doesNotMatch(buildContext(p, 'outline'), /REUSED_AUTHOR_APPROVED_SETTING/);
});

test('character paid calls are serial and cancellation admits no further profiles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-character-serial-'));
  let calls = 0;
  let active = 0;
  let peak = 0;
  let cancel: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    calls++;
    active++;
    peak = Math.max(peak, active);
    const index = calls;
    await delay(20);
    cancel?.();
    active--;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `姓名: 测试人物${index}\n\n正常人物档案` } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const settings: RuntimeSettings = { mode: 'live', apiKey: 'test-key', hasKey: true, model: 'test-model', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
    const store = new Store(dir);
    const p = store.projects[0];
    useGraph(p, createCharacterWorkflowGraph());
    const step = p.steps.find(s => s.kind === 'character')!;
    step.characterCount = 3;
    const runner = new Runner(store);
    await runner.run(p, settings);
    assert.equal(p.run?.status, 'done');
    assert.equal(calls, 3);
    assert.equal(peak, 1, 'at most one paid model request is active');
    const previousOutput = step.output;
    const previousAssets = structuredClone(p.assets);
    cancel = () => runner.controllers.get(p.id)!.abort();
    await runner.run(p, settings);
    assert.equal(p.run?.status, 'cancelled');
    assert.equal(calls, 4, 'cancellation during the first request prevents the remaining two');
    assert.equal(step.output, previousOutput, 'incomplete batch does not replace saved output');
    assert.deepEqual(p.assets, previousAssets);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('character execution honors node count and profile defaults and request overrides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-node-config-'));
  try {
    const store = new Store(dir);
    const p = store.projects[0];
    useGraph(p, createCharacterWorkflowGraph());
    const step = p.steps.find(s => s.kind === 'character')!;
    step.characterCount = 2;
    step.characterName = '节点姓名';
    step.characterGender = '自定义性别';
    step.characterPersonality = '节点性格';
    step.characterExperience = '节点经历';
    await new Runner(store).run(p, demo);
    assert.equal(p.run?.status, 'done');
    assert.equal(p.assets.filter(a => a.category === 'characters' && a.content.includes('节点姓名')).length, 2);
    assert.match(step.output, /自定义性别/);
    assert.match(step.output, /节点性格/);
    assert.match(step.output, /节点经历/);
    const before = p.assets.length;
    await new Runner(store).run(p, demo, { characterCount: 1, characterProfile: { name: '请求覆盖' } });
    assert.equal(p.assets.length, before + 1);
    assert.match(step.output, /姓名: 请求覆盖/);
    assert.doesNotMatch(step.output, /姓名: 节点姓名/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
