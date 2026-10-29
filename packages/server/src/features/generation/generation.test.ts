import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyRequirements, requirementsSchema, runRequestSchema } from '../../../../../shared/generation.js';
import {
  SYSTEM_END_NODE_ID,
  SYSTEM_START_NODE_ID,
  type Chapter,
  type Project,
  type Step,
} from '../../../../../shared/types.js';
import { createProject, createSteps, createWorkflowGraph, createWorldWorkflowGraph } from '../projects/defaults.js';
import {
  buildContext,
  parseProtocolResponse,
  Runner,
  type GenerationContext,
  type RuntimeSettings,
} from './engine.js';
import {
  acceptCandidate,
  literalIssues,
  prepareRun,
  resolveRequirements,
  settingsForStep,
} from './generation.js';
import { migrateProjects, Store } from '../projects/store.js';
import { downstreamIds, orderedSteps, validateGraph } from '../workflow/workflow-graph.js';
import { editableWorkflowSchema } from '../workflow/workflow-support.js';

const demoSettings: RuntimeSettings = { mode: 'demo', apiKey: '', hasKey: false, model: '', baseUrl: '' };
function chapter(number: number): Chapter {
  return {
    id: `chapter-${number}`,
    number,
    revision: 1,
    title: `第 ${number} 章`,
    content: `UNIQUE_CHAPTER_${number}`,
    mode: 'demo',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}
function writerOnly(p: Project) {
  p.steps = p.steps.filter((step) => [SYSTEM_START_NODE_ID, 'draft', SYSTEM_END_NODE_ID].includes(step.id));
  p.workflow!.edges = [
    { id: 'start-draft', source: SYSTEM_START_NODE_ID, target: 'draft' },
    { id: 'draft-end', source: 'draft', target: SYSTEM_END_NODE_ID },
  ];
  delete p.workflow!.auditNodeId;
  if (p.workflows?.[0]) p.workflows[0].steps = p.steps;
}
function legacyChapterGraph(p: Project) {
  p.steps = [p.steps.find((step) => step.id === SYSTEM_START_NODE_ID)!, ...createSteps(), p.steps.find((step) => step.id === SYSTEM_END_NODE_ID)!];
  p.workflow!.edges = p.steps.slice(1).map((step, index) => ({ id: `legacy-${index}`, source: p.steps[index].id, target: step.id }));
  p.workflow!.auditNodeId = 'review';
  p.workflows![0].steps = p.steps;
}
async function withStore(fn: (store: Store, p: Project) => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-generation-'));
  try {
    const store = new Store(dir);
    await fn(store, store.projects[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
interface ModelControl {
  response: string;
  finish: string;
  wait: number;
  status: number;
  onRequest?: (index: number) => void;
  active?: number;
  maxActive?: number;
  respond?: (prompt: string) => Promise<{ response: string; status?: number }>;
}
async function withModel(
  fn: (settings: RuntimeSettings, requests: string[], control: ModelControl) => Promise<void>,
) {
  const requests: string[] = [];
  const control: ModelControl = {
    response: '第 5 章 · 本地假模型\n必须原文\n正常故事正文。',
    finish: 'stop',
    wait: 0,
    status: 200,
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const data = JSON.parse(body);
    requests.push(data.messages?.[1]?.content || data.input?.[0]?.content?.[0]?.text || '');
    control.active = (control.active || 0) + 1;
    control.maxActive = Math.max(control.maxActive || 0, control.active);
    control.onRequest?.(requests.length);
    const custom = await control.respond?.(requests[requests.length - 1]);
    if (control.wait) await delay(control.wait);
    control.active -= 1;
    res.writeHead(custom?.status ?? control.status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: control.finish, message: { content: custom?.response ?? control.response } }],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    await fn(
      {
        mode: 'live',
        apiKey: 'local-stub-only',
        hasKey: true,
        model: 'test',
        baseUrl: `http://127.0.0.1:${port}`,
        protocol: 'chat-completions',
      },
      requests,
      control,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('strict requests enforce bounded integer targets, modes, and literal limits', () => {
  for (const value of [
    { target: { kind: 'single', number: 0 } },
    { target: { kind: 'single', number: 1.2 } },
    { target: { kind: 'range', from: 5, to: 3 } },
    { target: { kind: 'range', from: 1, to: 101 } },
    { target: { kind: 'next', count: 101 } },
    { mode: 'regenerate' },
    { mode: 'regenerate', target: { kind: 'next' } },
    { unknown: true },
    { stepId: 'draft', target: { kind: 'range', from: 1, to: 2 } },
  ])
    assert.equal(runRequestSchema.safeParse(value).success, false);
  assert.equal(runRequestSchema.safeParse({ target: { kind: 'range', from: 3, to: 5 } }).success, true);
  assert.equal(requirementsSchema.safeParse({ ...emptyRequirements(), requiredText: [' '] }).success, false);
  assert.equal(
    requirementsSchema.safeParse({ ...emptyRequirements(), instructions: 'a'.repeat(12001) }).success,
    false,
  );
  assert.equal(requirementsSchema.safeParse({ ...emptyRequirements(), extra: '' }).success, false);
  assert.deepEqual(requirementsSchema.parse(emptyRequirements()), emptyRequirements());
});

test('versioned migration preserves identities, archives simulated publication, normalizes every workflow and is idempotent', () => {
  const original = createProject('migration');
  const legacy = structuredClone(original) as Project & { dataVersion?: number };
  delete legacy.dataVersion;
  delete legacy.chapterNumberHighWatermark;
  legacy.chapters = [chapter(1), chapter(2)];
  for (const value of legacy.chapters) {
    delete (value as Partial<Chapter>).number;
    delete (value as Partial<Chapter>).revision;
  }
  (legacy.chapters[0] as Chapter & { publishedAt?: string }).publishedAt = 'old-simulated-date';
  const other = createWorkflowGraph('inactive', true);
  other.workflow.autoPublish = true;
  legacy.workflows!.push(other);
  legacy.workflow!.autoPublish = true;
  legacy.workflows![0].workflow.autoPublish = true;
  const migrated = migrateProjects([legacy])[0];
  assert.deepEqual(
    migrated.chapters.map((item) => item.number),
    [1, 2],
  );
  assert.deepEqual(
    migrated.chapters.map((item) => item.id),
    ['chapter-1', 'chapter-2'],
  );
  assert.equal(migrated.chapters[0].legacyPublishedAt, 'old-simulated-date');
  assert.equal('publishedAt' in migrated.chapters[0], false);
  assert.equal(migrated.chapterNumberHighWatermark, 2);
  assert.ok(migrated.workflows!.every((graph) => graph.workflow.autoPublish === false));
  assert.deepEqual(migrateProjects([migrated]), [migrated]);
  migrated.chapters.pop();
  assert.equal(migrateProjects([migrated])[0].chapterNumberHighWatermark, 2);
  assert.equal(prepareRun(migrated).targets[0].number, 3);
  assert.equal(legacy.chapters[0].number, undefined);
});

test('migration backs up exact source and corrupt input leaves original file intact', async () => {
  await withStore((store, p) => {
    const legacy = structuredClone(p);
    delete legacy.dataVersion;
    legacy.chapters = [chapter(1)];
    delete (legacy.chapters[0] as Partial<Chapter>).number;
    const file = path.join(store.dir, 'projects.json');
    const source = JSON.stringify([legacy]);
    fs.writeFileSync(file, source);
    new Store(store.dir);
    assert.equal(
      fs.readFileSync(path.join(store.dir, 'projects.pre-generation-v2.json.bak'), 'utf8'),
      source,
    );
    const migrated = fs.readFileSync(file, 'utf8');
    new Store(store.dir);
    assert.equal(fs.readFileSync(file, 'utf8'), migrated);
    const corrupted = JSON.stringify([
      { ...legacy, chapters: [chapter(1), { ...chapter(1), id: 'different-id' }] },
    ]);
    fs.writeFileSync(file, corrupted);
    assert.throws(() => new Store(store.dir), /章节号重复/);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupted);
  });
});

test('stale reuse fails closed but switching it off unblocks a fresh full workflow', () => {
  const p = createProject('reuse recovery');
  const step = p.steps.find((item) => item.kind !== 'writer' && item.id !== SYSTEM_START_NODE_ID && item.id !== SYSTEM_END_NODE_ID)!;
  assert.ok(step);
  step.output = '';
  step.reusePreviousOutput = true;
  assert.throws(() => prepareRun(p), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'REUSE_OUTPUT_UNAVAILABLE');
  step.reusePreviousOutput = false;
  assert.ok(prepareRun(p).orderedStepIds.includes(step.id));
});

test('preflight handles single, range, high watermark, conflicts and multiple writers without mutating state', () => {
  const p = createProject('targets');
  p.chapters = [chapter(1), chapter(5)];
  p.chapterNumberHighWatermark = 9;
  const before = JSON.stringify(p);
  assert.deepEqual(
    prepareRun(p, { target: { kind: 'range', from: 2, to: 4 } }).targets.map((target) => target.number),
    [2, 3, 4],
  );
  assert.deepEqual(
    prepareRun(p, { target: { kind: 'next', count: 2 } }).targets.map((target) => target.number),
    [10, 11],
  );
  assert.equal(
    prepareRun(p, { mode: 'regenerate', target: { kind: 'single', number: 5 } }).targets[0].baseRevision,
    1,
  );
  assert.throws(
    () => prepareRun(p, { target: { kind: 'range', from: 3, to: 5 } }),
    (error: unknown) => {
      assert.deepEqual((error as { conflicts: number[] }).conflicts, [5]);
      return true;
    },
  );
  assert.equal(JSON.stringify(p), before);
  p.workflow!.autoGenerate = true;
  p.workflow!.chapterCount = 101;
  assert.throws(() => prepareRun(p), /100/);
  p.workflow!.autoGenerate = false;
  const other = { ...p.steps.find((step) => step.id === 'draft')!, id: 'writer-2' };
  p.steps.splice(p.steps.length - 1, 0, other);
  p.workflow!.edges.push(
    { id: 'writer-2-in', source: 'plan', target: other.id },
    { id: 'writer-2-out', source: other.id, target: 'review' },
  );
  assert.throws(() => prepareRun(p), /多个正文/);
  assert.equal(prepareRun(p, { outputWriterNodeId: 'draft' }).outputWriterNodeId, 'draft');
});

test('graph join uses stable topological order and rejects cycles, dangling edges, disabled dependencies', () => {
  const p = createProject('join');
  legacyChapterGraph(p);
  const clone = p.steps.find((step) => step.id === 'lore')!;
  p.steps = [p.steps[0], ...['a', 'join', 'b', 'c'].map((id) => ({ ...clone, id })), p.steps.at(-1)!];
  const pairs = [
    [SYSTEM_START_NODE_ID, 'a'],
    [SYSTEM_START_NODE_ID, 'b'],
    ['a', 'join'],
    ['b', 'c'],
    ['c', 'join'],
    ['join', SYSTEM_END_NODE_ID],
  ];
  p.workflow!.edges = pairs.map(([source, target], index) => ({ id: String(index), source, target }));
  assert.deepEqual(
    orderedSteps(p).map((step) => step.id),
    [SYSTEM_START_NODE_ID, 'a', 'b', 'c', 'join', SYSTEM_END_NODE_ID],
  );
  assert.deepEqual([...downstreamIds(p, 'b')], ['c', 'join', SYSTEM_END_NODE_ID]);
  p.workflow!.edges.push({ id: 'cycle', source: 'join', target: 'b' });
  assert.throws(() => validateGraph(p), /循环/);
  p.workflow!.edges.pop();
  p.steps.find((step) => step.id === 'c')!.enabled = false;
  assert.throws(() => validateGraph(p, true), /禁用/);
  p.steps.find((step) => step.id === 'c')!.enabled = true;
  p.workflow!.edges.push({ id: 'missing', source: 'missing', target: 'a' });
  assert.throws(() => validateGraph(p), /不存在/);
});

test('context uses prior-only chapters, isolated original and matching upstream snapshot', () => {
  const p = createProject('context');
  legacyChapterGraph(p);
  p.chapters = [6, 1, 4, 2, 5, 3].map(chapter);
  p.requirements = { instructions: 'project requirement', requiredText: ['must'], forbiddenText: ['never'] };
  p.chapterRequirements = {
    '5': { instructions: 'chapter requirement', requiredText: [], forbiddenText: [] },
  };
  const context: GenerationContext = {
    runId: 'run',
    workflowId: p.activeWorkflowId!,
    number: 5,
    mode: 'regenerate',
    chapterId: 'chapter-5',
    baseRevision: 1,
    requirements: resolveRequirements(p, 5),
    graphRevision: 0,
  };
  const upstream = p.steps.find((step) => step.id === 'plan')!;
  upstream.status = 'done';
  upstream.output = 'SCOPED_PLAN';
  upstream.generationContext = structuredClone(context);
  const stale = p.steps.find((step) => step.id === 'lore')!;
  stale.status = 'done';
  stale.output = 'STALE_PRIOR_RUN';
  stale.generationContext = { ...context, runId: 'old' };
  const result = buildContext(p, 'draft', context);
  assert.match(result, /UNIQUE_CHAPTER_2/);
  assert.match(result, /UNIQUE_CHAPTER_3/);
  assert.match(result, /UNIQUE_CHAPTER_4/);
  assert.match(result, /<本章原稿>\nUNIQUE_CHAPTER_5/);
  assert.match(result, /SCOPED_PLAN/);
  assert.match(result, /project requirement/);
  assert.match(result, /chapter requirement/);
  assert.doesNotMatch(result, /UNIQUE_CHAPTER_6|UNIQUE_CHAPTER_1|STALE_PRIOR_RUN/);
});

test('requirements merge and exact literal validation include cross-scope substring conflicts', () => {
  const p = createProject('requirements');
  p.requirements = { instructions: 'project', requiredText: ['exact'], forbiddenText: ['bad'] };
  p.chapterRequirements = { '5': { instructions: 'chapter', requiredText: ['literal'], forbiddenText: [] } };
  assert.deepEqual(resolveRequirements(p, 5), {
    instructions: 'project\n\nchapter',
    requiredText: ['exact', 'literal'],
    forbiddenText: ['bad'],
  });
  assert.deepEqual(literalIssues('exact literal', resolveRequirements(p, 5)), []);
  assert.equal(literalIssues('EXACT bad', resolveRequirements(p, 5)).length, 3);
  p.chapterRequirements['5'].requiredText = ['badness'];
  assert.throws(() => prepareRun(p, { target: { kind: 'single', number: 5 } }), /冲突/);
  p.chapterRequirements['5'] = emptyRequirements();
  assert.deepEqual(resolveRequirements(p, 5), p.requirements);
});

test('provider completion failures never return partial prose', () => {
  assert.throws(
    () =>
      parseProtocolResponse('chat-completions', {
        choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
      }),
    /截断/,
  );
  assert.throws(
    () => parseProtocolResponse('responses', { status: 'incomplete', output_text: 'partial' }),
    /截断/,
  );
  assert.throws(
    () => parseProtocolResponse('responses', { error: { message: 'secret' }, output_text: 'partial' }),
    /生成失败/,
  );
  assert.throws(
    () =>
      parseProtocolResponse('anthropic-messages', {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial' }],
      }),
    /截断/,
  );
  assert.equal(
    parseProtocolResponse('chat-completions', {
      choices: [{ finish_reason: 'stop', message: { content: 'complete' } }],
    }),
    'complete',
  );
});

test('range generates exactly one chapter per target with target-aware requirements, even with two writers', async () => {
  await withModel(async (settings, requests) =>
    withStore(async (store, p) => {
      legacyChapterGraph(p);
      p.requirements = { instructions: 'GLOBAL_INSTRUCTION', requiredText: ['必须原文'], forbiddenText: [] };
      p.chapterRequirements = { '4': { instructions: 'CHAPTER_FOUR', requiredText: [], forbiddenText: [] } };
      const writer = {
        ...p.steps.find((step) => step.id === 'draft')!,
        id: 'intermediate-writer',
        title: '中间正文',
      };
      p.steps.splice(p.steps.length - 2, 0, writer);
      p.workflow!.edges.push(
        { id: 'intermediate-in', source: 'plan', target: writer.id },
        { id: 'intermediate-out', source: writer.id, target: 'review' },
      );
      await new Runner(store).run(p, settings, {
        target: { kind: 'range', from: 3, to: 5 },
        outputWriterNodeId: 'draft',
      });
      assert.equal(p.run!.status, 'done', p.run!.error);
      assert.deepEqual(
        p.chapters.map((item) => item.number),
        [3, 4, 5],
      );
      assert.equal(p.run!.generatedChapterIds!.length, 3);
      assert.equal(
        p.run!.chapters!.every((item) => item.validationStatus === 'passed'),
        true,
      );
      assert.equal(requests.length, 18);
      assert.ok(
        requests.every((request) => request.includes('GLOBAL_INSTRUCTION') && request.includes('必须原文')),
      );
      assert.ok(
        requests.some(
          (request) => request.includes('当前目标章节：第 4 章') && request.includes('CHAPTER_FOUR'),
        ),
      );
      assert.equal(p.chapterNumberHighWatermark, 5);
      const auditRequest = requests.find((request) =>
        request.includes('当前任务：对当前目标章节的最终正文进行审校'),
      );
      assert.match(auditRequest || '', /正文生成 · 最终正文输出（审校以此为准）/);
    }),
  );
});

test('regeneration creates candidate, adoption is explicit/version checked and preserves prior content', async () => {
  await withModel(async (settings) =>
    withStore(async (store, p) => {
      writerOnly(p);
      p.chapters = [chapter(5)];
      const original = structuredClone(p.chapters[0]);
      await new Runner(store).run(p, settings, { mode: 'regenerate', target: { kind: 'single', number: 5 } });
      assert.equal(p.run!.status, 'done');
      assert.deepEqual(p.chapters[0], original);
      const candidate = p.candidates![0];
      assert.equal(candidate.baseRevision, 1);
      assert.throws(() => acceptCandidate(p, candidate.id, 2), /版本已变化/);
      assert.deepEqual(p.chapters[0], original);
      p.chapters[0].revision = 2;
      assert.throws(() => acceptCandidate(p, candidate.id), /版本已变化/);
      p.chapters[0].revision = 1;
      const adopted = acceptCandidate(p, candidate.id, 1);
      assert.equal(adopted.id, original.id);
      assert.equal(adopted.revision, 2);
      assert.equal(adopted.revisions![0].content, original.content);
      assert.equal(p.candidates!.length, 0);
      assert.match(adopted.content, /本地假模型/);
    }),
  );
});

test('automatic mode adopts a regeneration batch without author decisions and persists revisions', async () => {
  await withModel(async (settings) => withStore(async (store, p) => {
    writerOnly(p);
    p.workflow!.automationMode = 'automatic';
    p.chapters = [chapter(5), chapter(6)];
    await new Runner(store).run(p, settings, { mode: 'regenerate', target: { kind: 'range', from: 5, to: 6 } });
    assert.equal(p.run!.status, 'done');
    assert.deepEqual(p.run!.chapters!.map((item) => item.status), ['done', 'done']);
    assert.equal(p.candidates!.length, 0);
    assert.equal(p.run!.generatedChapterIds!.length, 2);
    assert.ok(p.chapters.every((item) => item.revision === 2));
    assert.equal(p.chapters[0].revisions![0].content, 'UNIQUE_CHAPTER_5');
    const reloaded = new Store(store.dir).projects.find((item) => item.id === p.id)!;
    assert.equal(reloaded.workflow!.automationMode, 'automatic');
    assert.equal(reloaded.chapters[0].revision, 2);
  }));
});

test('automatic batch stops on literal failure or stale revision and keeps original prose', async () => {
  await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    writerOnly(p);
    p.workflow!.automationMode = 'automatic';
    p.chapters = [chapter(5), chapter(6)];
    p.requirements = { instructions: '', requiredText: ['missing phrase'], forbiddenText: [] };
    await new Runner(store).run(p, settings, { mode: 'regenerate', target: { kind: 'range', from: 5, to: 6 } });
    assert.equal(p.run!.errorCode, 'LITERAL_VALIDATION_FAILED');
    assert.equal(requests.length, 1);
    assert.equal(p.run!.chapters![1].status, 'cancelled');
    assert.equal(p.chapters[0].content, 'UNIQUE_CHAPTER_5');
    assert.equal(p.candidates![0].recoveryStatus, 'ready');
    p.requirements = emptyRequirements();
    control.onRequest = () => { p.chapters[0].revision = 2; };
    await new Runner(store).run(p, settings, { mode: 'regenerate', target: { kind: 'single', number: 5 } });
    assert.equal(p.run!.errorCode, 'REVISION_CONFLICT');
    assert.equal(p.chapters[0].content, 'UNIQUE_CHAPTER_5');
    assert.equal(p.candidates!.length, 2);
  }));
});

test('automatic regeneration never adopts when a downstream review request fails', async () => {
  await withModel(async (settings, _requests, control) => withStore(async (store, p) => {
    p.steps = p.steps.filter((step) => [SYSTEM_START_NODE_ID, 'draft', 'review', SYSTEM_END_NODE_ID].includes(step.id));
    p.workflows![0].steps = p.steps;
    p.workflow!.edges = [
      { id: 'sd', source: SYSTEM_START_NODE_ID, target: 'draft' },
      { id: 'dr', source: 'draft', target: 'review' },
      { id: 're', source: 'review', target: SYSTEM_END_NODE_ID },
    ];
    p.workflow!.automationMode = 'automatic';
    p.chapters = [chapter(5)];
    control.onRequest = (index) => { if (index === 2) control.status = 503; };
    await new Runner(store).run(p, settings, { mode: 'regenerate', target: { kind: 'single', number: 5 } });
    assert.equal(p.run!.status, 'error');
    assert.equal(p.chapters[0].revision, 1);
    assert.equal(p.candidates![0].recoveryStatus, 'review-failed');
  }));
});

test('automatic structured review repairs within bound and explicit failure never saves a chapter', async () => {
  await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    p.steps = p.steps.filter((step) => [SYSTEM_START_NODE_ID, 'draft', 'review', SYSTEM_END_NODE_ID].includes(step.id));
    p.workflow!.edges = [
      { id: 'sd', source: SYSTEM_START_NODE_ID, target: 'draft' },
      { id: 'dr', source: 'draft', target: 'review' },
      { id: 're', source: 'review', target: SYSTEM_END_NODE_ID },
    ];
    p.workflow!.automationMode = 'automatic';
    p.workflow!.maxAutoRepairs = 1;
    control.onRequest = (index) => {
      control.response = index === 2 ? '{"status":"failed","issues":[{"message":"缺乏行动","evidence":"静止"}]}'
        : index === 4 ? '{"status":"passed","issues":[]}' : '第1章\n主角采取了行动。';
    };
    await new Runner(store).run(p, settings, { target: { kind: 'single', number: 1 } });
    assert.equal(requests.length, 4);
    assert.equal(p.run!.status, 'done');
    assert.equal(p.chapters.length, 1);
    assert.match(requests[2], /缺乏行动/);
    control.onRequest = () => { control.response = '审校不通过'; };
    await new Runner(store).run(p, settings, { target: { kind: 'single', number: 2 } });
    assert.equal(requests.length, 8);
    assert.equal(p.run!.errorCode, 'REVIEW_VALIDATION_FAILED');
    assert.equal(p.chapters.length, 1);
    assert.equal(p.candidates!.at(-1)!.repairAttempts, 1);
    assert.equal(p.candidates!.at(-1)!.reviewResult!.status, 'failed');
  }));
});

test('resume executes only unfinished targets under the original verified snapshot', async () => {
  await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    writerOnly(p);
    control.onRequest = (index) => { control.status = index === 2 ? 503 : 200; };
    const runner = new Runner(store);
    await runner.run(p, settings, { target: { kind: 'range', from: 1, to: 2 } });
    const original = structuredClone(p.chapters[0]);
    const interrupted = p.run!;
    assert.equal(interrupted.status, 'error');
    assert.equal(p.chapters.length, 1);
    const handle = runner.start(p, settings, {}, undefined, { runId: interrupted.id, fingerprint: interrupted.resumeSnapshot!.fingerprint });
    await handle.promise;
    assert.equal(requests.length, 3);
    assert.equal(p.chapters.length, 2);
    assert.deepEqual(p.chapters[0], original);
    assert.equal(p.run!.resumedFromRunId, interrupted.id);
    assert.equal(p.run!.status, 'done');
  }));
});

test('actual ready siblings overlap within cap while writers wait, and failure saves no chapter', async () => {
  for (const failing of [false, true]) await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    legacyChapterGraph(p);
    p.steps = p.steps.filter((step) => [SYSTEM_START_NODE_ID, 'outline', 'plan', 'draft', SYSTEM_END_NODE_ID].includes(step.id));
    p.workflow!.edges = [
      { id: 'so', source: SYSTEM_START_NODE_ID, target: 'outline' },
      { id: 'sp', source: SYSTEM_START_NODE_ID, target: 'plan' },
      { id: 'od', source: 'outline', target: 'draft' },
      { id: 'pd', source: 'plan', target: 'draft' },
      { id: 'de', source: 'draft', target: SYSTEM_END_NODE_ID },
    ];
    delete p.workflow!.auditNodeId;
    p.workflow!.maxParallelNodes = 2;
    control.wait = 30;
    control.status = failing ? 503 : 200;
    await new Runner(store).run(p, settings, { target: { kind: 'single', number: 1 } });
    assert.equal(control.maxActive, 2);
    assert.equal(p.chapters.length, failing ? 0 : 1);
    assert.equal(requests.length, failing ? 2 : 3);
    assert.equal(p.run!.status, failing ? 'error' : 'done');
    if (!failing) {
      assert.match(requests[2], /上游结果/);
      assert.equal(p.modelUsage?.length, 3);
    }
  }));
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function schedulingGraph(p: Project, protectedKind: 'writer' | 'audit' = 'writer') {
  const template = p.steps.find((step) => step.id === 'plan')!;
  const ordinary = ['fast', 'slow', 'descendant'].map((id) => ({ ...structuredClone(template), id, kind: 'custom' as const, prompt: `TASK_${id}` }));
  p.steps = [p.steps.find((step) => step.id === SYSTEM_START_NODE_ID)!, ...ordinary,
    p.steps.find((step) => step.id === 'draft')!,
    ...(protectedKind === 'audit' ? [p.steps.find((step) => step.id === 'review')!] : []),
    p.steps.find((step) => step.id === SYSTEM_END_NODE_ID)!];
  p.steps.find((step) => step.id === 'draft')!.prompt = 'TASK_writer';
  const entry = protectedKind === 'audit' ? 'draft' : SYSTEM_START_NODE_ID;
  const protectedId = protectedKind === 'audit' ? 'review' : 'draft';
  if (protectedKind === 'audit') p.steps.find((step) => step.id === 'review')!.prompt = 'TASK_audit';
  else delete p.workflow!.auditNodeId;
  const pairs = [
    ...(protectedKind === 'audit' ? [[SYSTEM_START_NODE_ID, 'draft']] : []),
    [entry, 'fast'], [entry, 'slow'], ['fast', 'descendant'],
    ['descendant', protectedId], ['slow', SYSTEM_END_NODE_ID], [protectedId, SYSTEM_END_NODE_ID],
  ];
  p.workflow!.edges = pairs.map(([source, target], index) => ({ id: `edge-${index}`, source, target }));
  p.workflow!.maxParallelNodes = 2;
  p.workflows![0].steps = p.steps;
}

test('ordinary descendants refill freed slots before slow siblings; writer and audit remain singleton barriers', { timeout: 15_000 }, async () => {
  for (const protectedKind of ['writer', 'audit'] as const) await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    schedulingGraph(p, protectedKind);
    const slow = gate();
    const descendant = gate();
    const slowStarted = gate();
    let descendantPersisted = false;
    const touch = store.touch.bind(store);
    store.touch = (project) => {
      touch(project);
      if (project.steps.find((step) => step.id === 'descendant')?.status === 'done') {
        descendantPersisted = true;
        descendant.resolve();
      }
    };
    control.respond = async (prompt) => {
      if (prompt.endsWith('TASK_slow')) { slowStarted.resolve(); await slow.promise; }
      return { response: prompt.endsWith('TASK_fast') ? 'FAST_UPSTREAM_EVIDENCE' : '完整正文' };
    };
    const runner = new Runner(store);
    const handle = runner.start(p, settings, { target: { kind: 'single', number: 1 } });
    try {
      await Promise.all([slowStarted.promise, descendant.promise]);
      assert.equal(descendantPersisted, true);
      assert.match(requests.find((prompt) => prompt.endsWith('TASK_descendant'))!, /FAST_UPSTREAM_EVIDENCE/);
      assert.equal(p.steps.find((step) => step.id === 'slow')!.status, 'running');
      assert.equal(requests.some((prompt) => prompt.includes(`当前任务：TASK_${protectedKind}`)), false);
      assert.throws(() => runner.start(p, settings), /已有运行中的任务/);
    } finally { slow.resolve(); }
    await handle.promise;
    assert.equal(p.run!.status, 'done');
    assert.equal(control.maxActive, 2);
    assert.equal(p.modelUsage?.length, protectedKind === 'audit' ? 5 : 4);
    assert.equal(runner.controllers.size, 0);
  }));
});

test('failure stops admissions and drains active siblings before persisting terminal state and unlocking', { timeout: 10_000 }, async () => {
  await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    schedulingGraph(p);
    const slow = gate();
    const slowStarted = gate();
    control.respond = async (prompt) => {
      if (prompt.endsWith('TASK_slow')) { slowStarted.resolve(); await slow.promise; }
      if (prompt.endsWith('TASK_fast')) { await slowStarted.promise; return { response: '', status: 400 }; }
      return { response: 'DRAINED_SIBLING_OUTPUT' };
    };
    const touch = store.touch.bind(store);
    // Failure is observed while the runner still owns its lock and drains slow.
    const runner = new Runner(store);
    const handle = runner.start(p, settings, { target: { kind: 'single', number: 1 } });
    let finished = false;
    void handle.promise.then(() => { finished = true; });
    // The sibling response is held while the fast failure reaches the scheduler.
    await slowStarted.promise;
    for (let attempt = 0; attempt < 100 && p.steps.find((step) => step.id === 'fast')!.status !== 'error'; attempt++) await delay(5);
    try {
      assert.equal(p.steps.find((step) => step.id === 'fast')!.status, 'error');
      assert.equal(finished, false);
      assert.throws(() => runner.start(p, settings), /已有运行中的任务/);
      assert.equal(requests.length, 2);
    } finally { slow.resolve(); store.touch = touch; }
    await handle.promise;
    assert.equal(p.run!.status, 'error');
    assert.equal(p.steps.find((step) => step.id === 'slow')!.status, 'done');
    assert.equal(p.steps.find((step) => step.id === 'descendant')!.status, 'idle');
    assert.equal(p.chapters.length, 0);
    assert.equal(runner.controllers.size, 0);
  }));
});

test('cancellation drains parallel work, stops descendants and permits a subsequent run', { timeout: 10_000 }, async () => {
  await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    schedulingGraph(p);
    const bothStarted = gate();
    const release = gate();
    control.respond = async () => {
      if (requests.length === 2) bothStarted.resolve();
      await release.promise;
      return { response: 'UNSAVED_CANCELLED_OUTPUT' };
    };
    const runner = new Runner(store);
    const handle = runner.start(p, settings, { target: { kind: 'single', number: 1 } });
    await bothStarted.promise;
    runner.controllers.get(p.id)!.abort();
    try { await handle.promise; } finally { release.resolve(); }
    assert.equal(p.run!.status, 'cancelled');
    assert.equal(requests.length, 2);
    assert.equal(p.chapters.length, 0);
    assert.equal(p.steps.some((step) => step.status === 'running'), false);
    assert.equal(p.steps.some((step) => step.output.includes('UNSAVED_CANCELLED_OUTPUT')), false);
    assert.equal(runner.controllers.size, 0);
    control.respond = undefined;
    await runner.run(p, settings, { target: { kind: 'single', number: 1 } });
    assert.equal(p.run!.status, 'done');
  }));
});

test('workflow parallelism accepts eight ordinary nodes and rejects values outside the bound', async () => {
  assert.equal(editableWorkflowSchema.safeParse({ maxParallelNodes: 8 }).success, true);
  for (const maxParallelNodes of [0, 9, 1.5]) assert.equal(editableWorkflowSchema.safeParse({ maxParallelNodes }).success, false);
  await withModel(async (settings, _requests, control) => withStore(async (store, p) => {
    writerOnly(p);
    const template = p.steps.find((step) => step.id === 'draft')!;
    const ordinary = Array.from({ length: 10 }, (_, index) => ({ ...structuredClone(template), id: `ordinary-${index}`, kind: 'custom' as const }));
    p.steps.splice(1, 0, ...ordinary);
    p.workflow!.edges = ordinary.flatMap((step) => [
      { id: `in-${step.id}`, source: SYSTEM_START_NODE_ID, target: step.id },
      { id: `out-${step.id}`, source: step.id, target: 'draft' },
    ]).concat([{ id: 'end', source: 'draft', target: SYSTEM_END_NODE_ID }]);
    p.workflow!.maxParallelNodes = 8;
    p.workflows![0].steps = p.steps;
    control.wait = 30;
    await new Runner(store).run(p, settings, { target: { kind: 'single', number: 1 } });
    assert.equal(control.maxActive, 8);
    assert.equal(p.run!.status, 'done');
  }));
});

test('newest oversized chapter retains its ending within recent-chapter budget', () => {
  const p = createProject('latest continuation');
  p.chapters = [1, 2, 3].map((number) => ({ ...chapter(number), content: `${number}:` + '旧'.repeat(12_000) + `LATEST_TAIL_${number}` }));
  const prompt = buildContext(p, 'draft', {
    runId: 'test', workflowId: p.workflow!.id!, number: 4, mode: 'create',
    requirements: emptyRequirements(), graphRevision: p.workflow!.graphRevision || 0,
  });
  assert.match(prompt, /LATEST_TAIL_3/);
  assert.match(prompt, /章节前文因上下文预算截断/);
  assert.doesNotMatch(prompt, /LATEST_TAIL_1/);
  assert.ok(prompt.length < 30_000);
});

test('conditional branch uses explicit JSON selection and any join excludes stale unselected output', async () => {
  await withModel(async (settings, requests, control) => withStore(async (store, p) => {
    legacyChapterGraph(p);
    p.steps = p.steps.filter((step) => [SYSTEM_START_NODE_ID, 'lore', 'outline', 'plan', 'draft', SYSTEM_END_NODE_ID].includes(step.id));
    const branch = p.steps.find((step) => step.id === 'lore')!;
    branch.kind = 'custom';
    const unselected = p.steps.find((step) => step.id === 'plan')!;
    unselected.output = 'STALE_UNSELECTED';
    const writer = p.steps.find((step) => step.id === 'draft')!;
    writer.join = 'any';
    p.workflow!.edges = [
      { id: 'sl', source: SYSTEM_START_NODE_ID, target: 'lore' },
      { id: 'lo', source: 'lore', target: 'outline', when: 'left' },
      { id: 'lp', source: 'lore', target: 'plan', when: 'right' },
      { id: 'od', source: 'outline', target: 'draft' },
      { id: 'pd', source: 'plan', target: 'draft' },
      { id: 'de', source: 'draft', target: SYSTEM_END_NODE_ID },
    ];
    delete p.workflow!.auditNodeId;
    control.onRequest = (index) => { control.response = index === 1 ? '{"branch":"left"}' : '完整章节正文'; };
    await new Runner(store).run(p, settings, { target: { kind: 'single', number: 1 } });
    assert.equal(requests.length, 3);
    assert.equal(p.run!.status, 'done');
    assert.doesNotMatch(requests[2], /STALE_UNSELECTED/);
    control.onRequest = () => { control.response = '没有合法分支'; };
    await new Runner(store).run(p, settings, { target: { kind: 'single', number: 2 } });
    assert.equal(requests.length, 4);
    assert.equal(p.chapters.length, 1);
    assert.equal(p.run!.status, 'error');
  }));
});

test('automatic mode uses configured batch defaults but single-node runs remain single-target', () => {
  const p = createProject('automatic defaults');
  legacyChapterGraph(p);
  p.workflow!.automationMode = 'automatic';
  p.workflow!.chapterCount = 3;
  p.workflow!.autoGenerate = false;
  assert.equal(prepareRun(p).targets.length, 3);
  assert.equal(prepareRun(p, { stepId: 'lore' }).targets.length, 1);
  const migrated = migrateProjects([p])[0];
  assert.equal(migrated.workflow!.automationMode, 'automatic');
  const legacy = createProject('manual migration');
  delete legacy.workflow!.automationMode;
  assert.equal(migrateProjects([legacy])[0].workflow!.automationMode, 'manual');
});

test('completion hook receives admitted workflow after durable success and lock release only', async () => {
  await withModel(async (settings) => withStore(async (store, p) => {
    writerOnly(p);
    p.workflow!.automationMode = 'automatic';
    p.chapters = [chapter(5)];
    let callbacks = 0;
    const runner: Runner = new Runner(store, async (project, run, workflow): Promise<void> => {
      callbacks++;
      assert.equal(runner.controllers.size, 0);
      assert.equal(run.status, 'done');
      assert.equal(workflow?.automationMode, 'automatic');
      assert.equal(project.chapters[0].revision, 2);
      const disk = new Store(store.dir).projects.find((item) => item.id === p.id)!;
      assert.equal(disk.run!.status, 'done');
      assert.equal(disk.chapters[0].revision, 2);
    });
    await runner.run(p, settings, { mode: 'regenerate', target: { kind: 'single', number: 5 } });
    assert.equal(callbacks, 1);
    p.requirements = { instructions: '', requiredText: ['NOT_IN_MODEL_RESULT'], forbiddenText: [] };
    await runner.run(p, settings, { target: { kind: 'single', number: 6 } });
    assert.equal(callbacks, 1);
    p.requirements = emptyRequirements();
    await runner.run(p, settings, { stepId: 'draft', target: { kind: 'single', number: 6 } });
    assert.equal(callbacks, 1);
  }));
});

test('literal failure preserves unapproved candidate and blocks adoption; truncation saves no chapter', async () => {
  await withModel(async (settings, _requests, control) =>
    withStore(async (store, p) => {
      writerOnly(p);
      p.requirements = { instructions: '', requiredText: ['missing phrase'], forbiddenText: [] };
      const runner = new Runner(store);
      await runner.run(p, settings, { target: { kind: 'single', number: 5 } });
      assert.equal(p.run!.status, 'error');
      assert.equal(p.chapters.length, 0);
      assert.equal(p.candidates!.length, 1);
      assert.equal(p.run!.chapters![0].validationStatus, 'failed');
      assert.throws(() => acceptCandidate(p, p.candidates![0].id), /硬性文本要求/);
      p.requirements = emptyRequirements();
      control.finish = 'length';
      await runner.run(p, settings, { target: { kind: 'single', number: 6 } });
      assert.equal(p.run!.status, 'error');
      assert.equal(p.chapters.length, 0);
      assert.equal(p.candidates!.length, 1);
    }),
  );
});

test('cancellation, concurrent runs and persistence errors release locks without changing originals', async () => {
  await withModel(async (settings, _requests, control) =>
    withStore(async (store, p) => {
      writerOnly(p);
      p.chapters = [chapter(5)];
      const original = structuredClone(p.chapters[0]);
      control.wait = 100;
      const runner = new Runner(store);
      const running = runner.run(p, settings, { mode: 'regenerate', target: { kind: 'single', number: 5 } });
      await assert.rejects(new Runner(store).run(p, settings, {}), /运行中/);
      runner.controllers.get(p.id)!.abort();
      await running;
      assert.equal(p.run!.status, 'cancelled');
      assert.deepEqual(p.chapters[0], original);
      assert.equal(p.candidates!.length, 0);
      assert.equal(runner.controllers.size, 0);
      const touch = store.touch.bind(store);
      store.touch = () => {
        throw new Error('simulated disk failure');
      };
      await assert.rejects(runner.run(p, settings, { target: { kind: 'single', number: 6 } }), {
        code: 'PERSISTENCE_FAILED',
        retryable: true,
      });
      assert.equal(runner.controllers.size, 0);
      assert.equal(p.run!.status, 'cancelled');
      store.touch = touch;
      control.wait = 0;
      await runner.run(p, settings, { target: { kind: 'single', number: 6 } });
      assert.equal(p.run!.status, 'done', p.run!.error);
      assert.equal(p.chapters.length, 2);
    }),
  );
});

test('standalone reruns invalidate actual descendants and reject different target upstream', async () => {
  await withModel(async (settings) =>
    withStore(async (store, p) => {
      legacyChapterGraph(p);
      const runner = new Runner(store);
      await runner.run(p, settings, { stepId: 'lore', target: { kind: 'single', number: 5 } });
      assert.equal(p.chapters.length, 0);
      const lore = p.steps.find((step) => step.id === 'lore')!;
      assert.equal(lore.status, 'done');
      assert.throws(
        () => prepareRun(p, { stepId: 'outline', target: { kind: 'single', number: 6 } }),
        /同一目标章节/,
      );
      await runner.run(p, settings, { stepId: 'outline', target: { kind: 'single', number: 5 } });
      assert.equal(p.run!.status, 'done');
      assert.equal(lore.status, 'done');
      await runner.run(p, settings, { stepId: 'plan', target: { kind: 'single', number: 5 } });
      await runner.run(p, settings, { stepId: 'draft', target: { kind: 'single', number: 5 } });
      assert.equal(p.chapters.length, 0);
      assert.equal(p.steps.find((step) => step.id === 'draft')!.status, 'done');
      await runner.run(p, settings, { stepId: 'plan', target: { kind: 'single', number: 5 } });
      assert.equal(p.steps.find((step) => step.id === 'draft')!.status, 'idle');
      assert.equal(lore.status, 'done');
    }),
  );
});

test('checkpoint is durable before downstream 524, retry before writer retains prose, explicit adoption checks warnings', async () => {
  await withModel(async (settings, requests, control) =>
    withStore(async (store, p) => {
      legacyChapterGraph(p);
      const runner = new Runner(store);
      const request = { target: { kind: 'single' as const, number: 5 } };
      let diskCheckpoint: Project['candidates'];
      control.onRequest = (index) => {
        if (index === 5) {
          const disk = JSON.parse(
            fs.readFileSync(path.join(store.dir, 'projects.json'), 'utf8'),
          )[0] as Project;
          diskCheckpoint = disk.candidates;
          control.status = 524;
        }
      };
      await runner.run(p, settings, request);
      assert.equal(requests.length, 5);
      assert.equal(diskCheckpoint?.length, 1);
      assert.equal(diskCheckpoint![0].recoveryStatus, 'pending-review');
      assert.equal(diskCheckpoint![0].reviewOutput, undefined);
      assert.equal(p.run!.errorCode, 'UPSTREAM_TIMEOUT');
      assert.equal(p.run!.retryable, true);
      assert.equal(p.run!.chapters![0].errorCode, 'UPSTREAM_TIMEOUT');
      assert.equal(p.chapters.length, 0);
      const saved = structuredClone(p.candidates![0]);
      assert.equal(saved.recoveryStatus, 'review-failed');
      assert.equal(saved.graphRevision, p.workflow!.graphRevision || 0);
      const prose = p.steps.find((s) => s.id === 'draft')!.output;
      control.onRequest = undefined;
      await runner.run(p, settings, request); // First upstream node fails, before the writer.
      assert.deepEqual(p.candidates, [saved]);
      const writer = p.steps.find((s) => s.id === 'draft')!;
      assert.equal(writer.output, prose);
      assert.equal(writer.status, 'idle');
      assert.equal(writer.generationContext, undefined);
      const reopened = new Store(store.dir).get(p.id)!;
      assert.deepEqual(reopened.candidates, JSON.parse(JSON.stringify([saved])));
      assert.equal(reopened.steps.find((s) => s.id === 'draft')!.output, prose);
      assert.equal(prepareRun(reopened, request).targets[0].number, 5);
      assert.equal(prepareRun(reopened).targets[0].number, 6);
      assert.throws(() => acceptCandidate(reopened, saved.id), { code: 'REVIEW_FAILURE_ACK_REQUIRED' });
      reopened.requirements!.requiredText = ['new unmet literal'];
      assert.throws(() => acceptCandidate(reopened, saved.id, undefined, true), {
        code: 'CANDIDATE_INVALID',
      });
      reopened.requirements = emptyRequirements();
      assert.equal(acceptCandidate(reopened, saved.id, undefined, true).number, 5);
      assert.equal(reopened.chapters.length, 1);
    }),
  );
});

test('admission persists before execution, archives previous runs and never forgets admitted keys', async () => {
  await withModel(async (settings, requests) =>
    withStore(async (store, p) => {
      writerOnly(p);
      const runner = new Runner(store);
      const request = { target: { kind: 'single' as const, number: 5 } };
      const admission = { key: 'request-one', requestHash: 'hash-one' };
      const handle = runner.start(p, settings, request, admission);
      assert.equal(requests.length, 0);
      const disk = JSON.parse(fs.readFileSync(path.join(store.dir, 'projects.json'), 'utf8'))[0] as Project;
      assert.equal(disk.run!.id, handle.run.id);
      assert.deepEqual(disk.runAdmissions![admission.key], {
        requestHash: admission.requestHash,
        runId: handle.run.id,
      });
      assert.throws(() => runner.start(p, settings, request), { code: 'RUN_CONFLICT' });
      await handle.promise;
      assert.equal(p.candidates!.length, 0);
      await runner.run(p, settings, { target: { kind: 'single', number: 6 } });
      assert.equal(p.runHistory!.at(-1)!.id, handle.run.id);
      p.runHistory = []; // Tombstones must be independent of history retention.
      assert.throws(() => runner.start(p, settings, { target: { kind: 'single', number: 7 } }, admission), {
        code: 'RUN_ALREADY_ADMITTED',
      });
      assert.throws(
        () =>
          runner.start(
            p,
            settings,
            { target: { kind: 'single', number: 7 } },
            { ...admission, requestHash: 'changed' },
          ),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      assert.throws(() => runner.start(p, settings, {}, { key: '__proto__', requestHash: 'x' }), {
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
      const before = structuredClone(p);
      const touch = store.touch.bind(store);
      store.touch = () => {
        throw new Error('secret path /private/data');
      };
      assert.throws(() => runner.start(p, settings, {}, { key: 'never-admitted', requestHash: 'x' }), {
        code: 'PERSISTENCE_FAILED',
      });
      assert.deepEqual(p, before);
      assert.equal(runner.controllers.size, 0);
      store.touch = touch;
    }),
  );
});

test('cancel and restart preserve pending checkpoint and original revision', async () => {
  await withModel(async (settings, _requests, control) =>
    withStore(async (store, p) => {
      legacyChapterGraph(p);
      p.chapters = [chapter(5)];
      const original = structuredClone(p.chapters[0]);
      const runner = new Runner(store);
      let restarted: Project | undefined;
      control.onRequest = (index) => {
        if (index === 5) {
          assert.throws(() => acceptCandidate(p, p.candidates![0].id, 1, true), { code: 'RUN_CONFLICT' });
          restarted = new Store(store.dir).get(p.id)!;
          runner.controllers.get(p.id)!.abort();
        }
      };
      await runner.run(p, settings, { mode: 'regenerate', target: { kind: 'single', number: 5 } });
      assert.equal(p.run!.status, 'cancelled');
      assert.equal(p.run!.errorCode, 'RUN_CANCELLED');
      assert.equal(p.candidates![0].recoveryStatus, 'review-failed');
      assert.deepEqual(p.chapters[0], original);
      assert.equal(restarted!.run!.errorCode, 'RUN_INTERRUPTED');
      assert.equal(restarted!.candidates![0].recoveryStatus, 'review-failed');
      assert.equal(restarted!.candidates![0].baseRevision, 1);
      const candidate = p.candidates![0];
      p.chapters[0].revision = 2;
      assert.throws(() => acceptCandidate(p, candidate.id, 2, true), { code: 'REVISION_CONFLICT' });
      p.chapters[0].revision = 1;
      candidate.recoveryStatus = 'pending-review';
      assert.throws(() => acceptCandidate(p, candidate.id, 1, true), { code: 'CANDIDATE_PENDING_REVIEW' });
    }),
  );
});

test('storage failure at promotion rolls back chapter and preserves writer checkpoint', async () => {
  await withModel(async (settings) =>
    withStore(async (store, p) => {
      writerOnly(p);
      const touch = store.touch.bind(store);
      let failed = false;
      store.touch = (project) => {
        if (!failed && project.chapters.some((c) => c.number === 5)) {
          failed = true;
          throw new Error('secret ENOSPC at private directory');
        }
        touch(project);
      };
      await assert.rejects(new Runner(store).run(p, settings, { target: { kind: 'single', number: 5 } }), {
        code: 'PERSISTENCE_FAILED',
        retryable: true,
      });
      assert.equal(p.chapters.length, 0);
      assert.equal(p.candidates!.length, 1);
      assert.match(p.candidates![0].content, /本地假模型/);
      assert.equal(p.run!.errorCode, 'PERSISTENCE_FAILED');
      assert.doesNotMatch(p.run!.error!, /secret|ENOSPC|private/);
      const disk = new Store(store.dir).get(p.id)!;
      assert.equal(disk.chapters.length, 0);
      assert.equal(disk.candidates!.length, 1);
    }),
  );
});

test('automatic adoption and explicit overwrite roll back on storage failure and expose successful chapter ids', async () => {
  await withModel(async (settings) => {
    for (const overwrite of [false, true]) {
      await withStore(async (store, p) => {
        writerOnly(p);
        p.workflow!.automationMode = 'automatic';
        p.chapters = [chapter(5)];
        const original = structuredClone(p.chapters[0]);
        const touch = store.touch.bind(store);
        let failed = false;
        store.touch = (project) => {
          if (!failed && project.chapters[0].revision === 2) {
            failed = true;
            throw new Error('ENOSPC');
          }
          touch(project);
        };
        const request = { mode: overwrite ? 'create' as const : 'regenerate' as const, overwrite,
          target: { kind: 'single' as const, number: 5 } };
        await assert.rejects(new Runner(store).run(p, settings, request), { code: 'PERSISTENCE_FAILED' });
        assert.deepEqual(p.chapters[0], original);
        assert.equal(p.candidates!.length, 1);
        assert.equal(p.run!.generatedChapterIds!.length, 0);
        store.touch = touch;
        await new Runner(store).run(p, settings, request);
        assert.equal(p.run!.status, 'done');
        assert.deepEqual(p.run!.generatedChapterIds, [original.id]);
        assert.equal(p.chapters[0].revision, 2);
        assert.equal(p.run!.candidateIds!.length, 0);
      });
    }
  });
});

test('preflight rejects incompatible workflow modes without making model requests', async () => {
  await withModel(async (settings, requests) => withStore(async (store, p) => {
    const runner = new Runner(store);
    assert.throws(() => runner.start(p, settings, { workflowMode: 'world' }), { code: 'WORKFLOW_MODE_MISMATCH' });
    assert.equal(requests.length, 0);
    const graph = createWorldWorkflowGraph();
    p.workflows = [graph];
    p.activeWorkflowId = graph.id;
    p.steps = graph.steps;
    p.workflow = graph.workflow;
    assert.throws(() => runner.start(p, settings, { workflowMode: 'chapter' }), { code: 'WORKFLOW_MODE_MISMATCH' });
    assert.equal(requests.length, 0);
    await runner.run(p, settings, { workflowMode: 'world' });
    assert.equal(p.run!.status, 'done');
    assert.equal(p.chapters.length, 0);
  }));
});

test('world workflow runs without reserving chapter numbers or creating prose', async () => {
  await withModel(async (settings) =>
    withStore(async (store, p) => {
      const { createWorldWorkflowGraph } = await import('../projects/defaults.js');
      const graph = createWorldWorkflowGraph();
      p.workflows = [graph];
      p.activeWorkflowId = graph.id;
      p.steps = graph.steps;
      p.workflow = graph.workflow;
      const { syncActiveWorkflow } = await import('../projects/defaults.js');
      syncActiveWorkflow(p);
      const before = p.chapterNumberHighWatermark || 0;
      await new Runner(store).run(p, settings, {});
      assert.equal(p.run?.status, 'done', p.run?.error);
      assert.equal(p.chapters.length, 0);
      assert.equal(p.candidates?.length || 0, 0);
      assert.equal(p.assets.filter((asset) => asset.category === 'world').length, 2);
      assert.match(p.assets.map((asset) => asset.name).join('\n'), /本地假模型/);
      assert.equal(p.chapterNumberHighWatermark || 0, before);
      assert.equal(
        p.steps.filter((step) => ['world', 'expand'].includes(step.kind || '') && step.status === 'done')
          .length,
        2,
      );
      assert.doesNotThrow(() => prepareRun(p, {}));
    }),
  );
});

test('global demo intent cannot trigger live per-node profiles', () => {
  const p = createProject('demo');
  const step: Step = { ...p.steps.find((item) => item.id === 'draft')!, modelId: 'live-profile' };
  const settings: RuntimeSettings = {
    ...demoSettings,
    modelProfiles: [{ ...demoSettings, id: 'live-profile', mode: 'live' }],
  };
  assert.equal(settingsForStep(step, settings).mode, 'demo');
});
