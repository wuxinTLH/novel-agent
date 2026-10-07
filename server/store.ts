import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { chapterRequirementsSchema, MAX_CHAPTER_NUMBER, requirementsSchema } from '../shared/generation.js';
import type { Project, Step } from '../shared/types.js';
import { normalizeWorkflow, starterProject, syncActiveWorkflow } from './defaults.js';
import { validateGraph } from './workflow-graph.js';

export const PROJECT_DATA_VERSION = 2;
const stepSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    subtitle: z.string(),
    prompt: z.string(),
    status: z.enum(['idle', 'running', 'done', 'error']),
    output: z.string(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).passthrough(),
    enabled: z.boolean().optional(),
  })
  .passthrough();
const workflowSchema = z
  .object({
    edges: z
      .array(z.object({ id: z.string().min(1), source: z.string(), target: z.string() }).passthrough())
      .optional(),
    chapterCount: z.number().int().positive().optional(),
    autoGenerate: z.boolean().optional(),
    autoPublish: z.boolean().optional(),
    graphRevision: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const chapterSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    content: z.string(),
    updatedAt: z.string(),
    mode: z.enum(['demo', 'live']),
    number: z.number().int().min(1).max(MAX_CHAPTER_NUMBER).optional(),
    revision: z.number().int().positive().optional(),
  })
  .passthrough();
const storedRunSchema = z.object({
  id: z.string(),
  status: z.enum(['running', 'done', 'error', 'cancelled']),
  mode: z.enum(['demo', 'live']),
  startedAt: z.string(),
  errorCode: z.string().optional(),
  retryable: z.boolean().optional(),
  admissionKey: z.string().optional(),
  requestHash: z.string().optional(),
}).passthrough();
const projectSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    genre: z.string(),
    description: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    steps: z.array(stepSchema),
    assets: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          category: z.enum(['world', 'characters', 'plot', 'chapters']),
          content: z.string(),
        })
        .passthrough(),
    ),
    chapters: z.array(chapterSchema),
    workflow: workflowSchema.optional(),
    workflows: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string(),
            steps: z.array(stepSchema),
            workflow: workflowSchema,
            createdAt: z.string(),
            updatedAt: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    run: storedRunSchema.optional(),
    runHistory: z.array(storedRunSchema).optional(),
    runAdmissions: z.record(z.string(), z.object({ requestHash: z.string(), runId: z.string() }).strict()).optional(),
    requirements: requirementsSchema.optional(),
    chapterRequirements: chapterRequirementsSchema.optional(),
    chapterNumberHighWatermark: z.number().int().min(0).max(MAX_CHAPTER_NUMBER).optional(),
    dataVersion: z.number().int().min(0).max(PROJECT_DATA_VERSION).optional(),
    candidates: z
      .array(
        z
          .object({
            id: z.string().min(1),
            number: z.number().int().min(1).max(MAX_CHAPTER_NUMBER),
            title: z.string(),
            content: z.string(),
            mode: z.enum(['demo', 'live']),
            generationMode: z.enum(['create', 'regenerate']),
            chapterId: z.string().optional(),
            baseRevision: z.number().int().positive().optional(),
            issues: z.array(z.string()),
            createdAt: z.string(),
            workflowId: z.string(),
            runId: z.string(),
            outputWriterNodeId: z.string(),
            recoveryStatus: z.enum(['pending-review', 'review-failed', 'ready']).optional(),
            graphRevision: z.number().int().nonnegative().optional(),
            errorCode: z.string().optional(),
            error: z.string().optional(),
            requirements: requirementsSchema,
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
function assertUnique(items: { id: string }[], name: string) {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error(`${name}包含重复 ID，原始数据未修改。`);
}
function checkRawGraph(p: Pick<Project, 'steps' | 'workflow'>) {
  assertUnique(p.steps, '工作流节点');
  const ids = new Set(p.steps.map((step) => step.id));
  const edges = p.workflow?.edges || [];
  assertUnique(edges, '工作流连线');
  for (const edge of edges)
    if (!ids.has(edge.source) || !ids.has(edge.target))
      throw new Error('工作流连线指向不存在的节点，原始数据未修改。');
}
function normalizeStoredSteps(steps: Step[]) {
  for (const step of steps) {
    step.kind ||= step.id === 'draft' ? 'writer' : step.id === 'review' ? 'audit' : 'agent';
    step.enabled ??= true;
    // Preserve prior output, but do not treat an interrupted step as reusable.
    if (step.status === 'running') step.status = 'error';
  }
}

/** Versioned, copy-on-migrate: validation failure cannot modify the source object or file. */
export function migrateProjects(value: unknown): Project[] {
  z.array(projectSchema).parse(value);
  // Validate with Zod, but retain source key order and unknown historical fields.
  const projects = structuredClone(value as Project[]);
  assertUnique(projects, '项目');
  for (const p of projects) {
    const current = (p.dataVersion || 0) >= 1;
    assertUnique(p.chapters, '章节');
    assertUnique(p.candidates || [], '候选版本');
    const numbers = new Set<number>();
    for (const chapter of p.chapters) {
      if (chapter.number !== undefined) {
        if (numbers.has(chapter.number)) throw new Error('章节号重复，原始数据未修改。');
        numbers.add(chapter.number);
      } else if (current) throw new Error('当前版本章节缺少稳定章号，原始数据未修改。');
      if (current && chapter.revision === undefined)
        throw new Error('当前版本章节缺少修订号，原始数据未修改。');
    }
    let next = 1;
    for (const chapter of p.chapters) {
      if (chapter.number === undefined) {
        while (numbers.has(next)) next++;
        chapter.number = next;
        numbers.add(next++);
      }
      chapter.revision ??= 1;
      const legacy = chapter as typeof chapter & { publishedAt?: string };
      if (legacy.publishedAt) chapter.legacyPublishedAt ||= legacy.publishedAt;
      delete legacy.publishedAt;
    }
    p.chapterNumberHighWatermark = Math.max(
      p.chapterNumberHighWatermark || 0,
      ...p.chapters.map((chapter) => chapter.number),
      ...(p.candidates || []).map((candidate) => candidate.number),
    );
    if (p.chapterNumberHighWatermark > MAX_CHAPTER_NUMBER)
      throw new Error('章节号超出范围，原始数据未修改。');
    p.requirements ||= { instructions: '', requiredText: [], forbiddenText: [] };
    p.chapterRequirements ||= {};
    p.candidates ||= [];
    p.runAdmissions ||= {};
    for (const candidate of p.candidates) candidate.recoveryStatus ||= 'ready';
    checkRawGraph(p);
    normalizeStoredSteps(p.steps);
    if (!p.workflow) {
      p.workflow = {
        edges: p.steps
          .slice(1)
          .map((step, index) => ({ id: `e-${step.id}`, source: p.steps[index].id, target: step.id })),
        auditNodeId: p.steps.find((step) => step.id === 'review' || step.kind === 'audit')?.id,
        chapterCount: 1,
        autoGenerate: false,
      };
    } else if (!p.workflow.edges) {
      p.workflow.edges = p.steps
        .slice(1)
        .map((step, index) => ({ id: `e-${step.id}`, source: p.steps[index].id, target: step.id }));
    }
    if (current) validateGraph(p);
    normalizeWorkflow(p);
    assertUnique(p.workflows || [], '工作流');
    for (const graph of p.workflows || []) {
      checkRawGraph(graph);
      normalizeStoredSteps(graph.steps);
      graph.workflow.edges ||= graph.steps
        .slice(1)
        .map((step, index) => ({ id: `e-${step.id}`, source: graph.steps[index].id, target: step.id }));
      if (current) validateGraph(graph);
      const view = { ...p, steps: graph.steps, workflow: graph.workflow, activeWorkflowId: graph.id };
      normalizeWorkflow(view);
      graph.steps = view.steps;
      graph.workflow = view.workflow!;
      validateGraph(graph);
    }
    syncActiveWorkflow(p);
    validateGraph(p);
    if (p.run?.status === 'running') {
      p.run.status = 'error';
      p.run.error = '服务已重启，可按原章号重试；已保存恢复稿仍保留。';
      p.run.errorCode = 'RUN_INTERRUPTED';
      p.run.retryable = true;
      p.run.finishedAt = new Date().toISOString();
      for (const progress of p.run.chapters || []) {
        if (progress.status === 'pending' || progress.status === 'running') {
          progress.status = 'error';
          progress.error = p.run.error;
          progress.errorCode = p.run.errorCode;
          progress.retryable = true;
        }
      }
    }
    for (const candidate of p.candidates) {
      if (candidate.recoveryStatus === 'pending-review') {
        candidate.recoveryStatus = 'review-failed';
        candidate.errorCode = 'RUN_INTERRUPTED';
        candidate.error = '审校中断，已保存正文可在确认风险后采用。';
      }
    }
    p.dataVersion = PROJECT_DATA_VERSION;
  }
  // Revalidate the complete migrated collection before committing any data.
  z.array(projectSchema).parse(projects);
  return projects;
}

export class Store {
  projects: Project[];
  constructor(public dir: string) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(path.join(this.dir, 'uploads'), { recursive: true });
    const file = path.join(this.dir, 'projects.json');
    if (fs.existsSync(file)) {
      const original = fs.readFileSync(file, 'utf8');
      this.projects = migrateProjects(JSON.parse(original));
      const next = JSON.stringify(this.projects, null, 2);
      if (next !== original) {
        const backup = path.join(this.dir, `projects.pre-generation-v${PROJECT_DATA_VERSION}.json.bak`);
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx' });
        this.save();
      }
    } else {
      this.projects = [starterProject()];
      this.save();
    }
  }
  get(id: string) {
    return this.projects.find((p) => p.id === id);
  }
  save() {
    const file = path.join(this.dir, 'projects.json');
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(this.projects, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch (error) {
      try {
        fs.rmSync(file + '.tmp', { force: true });
      } catch {
        /* Preserve original persistence failure. */
      }
      throw error;
    }
  }
  touch(p: Project) {
    p.updatedAt = new Date().toISOString();
    this.save();
  }
}
