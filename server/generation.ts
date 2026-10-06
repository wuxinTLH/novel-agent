import { randomUUID } from 'node:crypto';
import {
  chapterRequirementsSchema,
  emptyRequirements,
  MAX_BATCH_SIZE,
  MAX_CHAPTER_NUMBER,
  requirementsSchema,
  runRequestSchema,
} from '../shared/generation.js';
import {
  SYSTEM_END_NODE_ID,
  SYSTEM_START_NODE_ID,
  type Chapter,
  type ChapterCandidate,
  type GenerationMode,
  type Project,
  type Requirements,
  type RunRequest,
  type Step,
  type StepGenerationContext,
} from '../shared/types.js';
import type { RuntimeSettings } from './engine.js';
import { downstreamIds, orderedSteps, upstreamIds, validateGraph } from './workflow-graph.js';

export class GenerationError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'INVALID_GENERATION',
    public conflicts?: number[],
    public retryable = false,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

/** Runtime failures never expose provider bodies, credentials, URLs or filesystem paths. */
export function runtimeGenerationError(error: unknown, cancelled = false): GenerationError {
  if (cancelled)
    return new GenerationError(
      '运行已停止，已完成的正文与恢复稿已保留。',
      409,
      'RUN_CANCELLED',
      undefined,
      true,
    );
  if (error instanceof GenerationError) return error;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return new GenerationError(
      '模型请求超时，已保存的结果仍保留，请重试当前目标章节。',
      504,
      'UPSTREAM_TIMEOUT',
      undefined,
      true,
    );
  return new GenerationError(
    '生成失败，已保存的结果仍保留，请检查模型配置后重试当前目标章节。',
    502,
    'GENERATION_FAILED',
    undefined,
    true,
  );
}
export function persistenceError(): GenerationError {
  return new GenerationError(
    '运行内容无法持久化，请检查数据目录和可用空间；先前已保存的正文仍保留。',
    503,
    'PERSISTENCE_FAILED',
    undefined,
    true,
  );
}
export interface PreparedTarget {
  number: number;
  outputName?: string;
  requirements: Requirements;
  chapterId?: string;
  baseRevision?: number;
}
export interface PreparedRun {
  request: RunRequest;
  workflowId: string;
  mode: GenerationMode;
  outputWriterNodeId?: string;
  stepId?: string;
  targets: PreparedTarget[];
  orderedStepIds: string[];
}

export function literalIssues(content: string, requirements: Requirements): string[] {
  return [
    ...requirements.requiredText
      .filter((text) => !content.includes(text))
      .map((text) => `缺少必须原文出现的文本：${text}`),
    ...requirements.forbiddenText
      .filter((text) => content.includes(text))
      .map((text) => `包含禁止出现的文本：${text}`),
  ];
}
export const checkLiteralRequirements = literalIssues;
export function validateRequirements(requirements: Requirements): Requirements {
  const parsed = requirementsSchema.parse(requirements);
  for (const required of parsed.requiredText) {
    const forbidden = parsed.forbiddenText.find((text) => required.includes(text));
    if (forbidden !== undefined)
      throw new GenerationError(
        `要求冲突：必须文本「${required}」包含禁止文本「${forbidden}」。`,
        400,
        'REQUIREMENTS_CONFLICT',
      );
  }
  return parsed;
}
export function resolveRequirements(
  p: Pick<Project, 'requirements' | 'chapterRequirements'>,
  number: number,
): Requirements {
  const project = validateRequirements(p.requirements || emptyRequirements());
  const chapter = validateRequirements(p.chapterRequirements?.[String(number)] || emptyRequirements());
  // Individual scopes are bounded; their effective union may legitimately contain twice as many items.
  const combined = {
    instructions: [project.instructions, chapter.instructions].filter(Boolean).join('\n\n'),
    requiredText: [...new Set([...project.requiredText, ...chapter.requiredText])],
    forbiddenText: [...new Set([...project.forbiddenText, ...chapter.forbiddenText])],
  };
  for (const required of combined.requiredText) {
    const forbidden = combined.forbiddenText.find((text) => required.includes(text));
    if (forbidden !== undefined)
      throw new GenerationError(
        `第 ${number} 章要求冲突：必须文本「${required}」包含禁止文本「${forbidden}」。`,
        400,
        'REQUIREMENTS_CONFLICT',
      );
  }
  return combined;
}
export function isWriter(step: Step): boolean {
  return step.kind === 'writer' || step.id === 'draft';
}
export function settingsForStep(step: Step, settings: RuntimeSettings): RuntimeSettings {
  const chosen = step.modelId
    ? settings.modelProfiles?.find((profile) => profile.id === step.modelId)
    : settings;
  if (!chosen) throw new GenerationError(`节点「${step.title}」指定的模型不存在。`, 400, 'MODEL_UNAVAILABLE');
  // The global execution intent wins over the persisted per-profile mode.
  const selected = { ...chosen, mode: settings.mode };
  if (selected.enabled === false)
    throw new GenerationError(`节点「${step.title}」指定的模型已禁用。`, 400, 'MODEL_UNAVAILABLE');
  if (selected.mode !== 'demo' && (!selected.apiKey || !selected.model || !selected.baseUrl))
    throw new GenerationError(
      `节点「${step.title}」指定的模型未完整配置地址、模型名称和 API Key。`,
      400,
      'MODEL_UNAVAILABLE',
    );
  return selected;
}

export function matchesContext(
  context: StepGenerationContext | undefined,
  target: PreparedTarget,
  p: Project,
  mode: GenerationMode,
): boolean {
  return (
    !!context &&
    context.workflowId === (p.activeWorkflowId || p.workflow?.id) &&
    context.graphRevision === (p.workflow?.graphRevision || 0) &&
    context.number === target.number &&
    context.mode === mode &&
    context.chapterId === target.chapterId &&
    context.baseRevision === target.baseRevision &&
    JSON.stringify(context.requirements) === JSON.stringify(target.requirements)
  );
}

/** Side-effect-free synchronous preflight; call before returning HTTP 202. */
export function prepareRun(
  p: Project,
  request: RunRequest | string = {},
  settings?: RuntimeSettings,
): PreparedRun {
  const parsed = runRequestSchema.parse(typeof request === 'string' ? { stepId: request } : request);
  if (p.run?.status === 'running')
    throw new GenerationError('当前项目已有运行中的任务。', 409, 'RUN_CONFLICT');
  const workflowId = p.activeWorkflowId || p.workflow?.id;
  if (!workflowId || (parsed.workflowId && parsed.workflowId !== workflowId))
    throw new GenerationError('活动工作流已变化，请刷新后重试。', 409, 'WORKFLOW_CONFLICT');
  validateGraph(p, !parsed.stepId);
  const selectedStep = parsed.stepId ? p.steps.find((step) => step.id === parsed.stepId) : undefined;
  if (parsed.stepId && !selectedStep) throw new GenerationError('节点不存在。', 404, 'STEP_NOT_FOUND');
  if (
    selectedStep &&
    (selectedStep.enabled === false ||
      selectedStep.id === SYSTEM_START_NODE_ID ||
      selectedStep.id === SYSTEM_END_NODE_ID)
  )
    throw new GenerationError('系统边界或禁用节点不能单独调用模型。');
  const mode = parsed.mode || 'create';
  const defaultCount = !parsed.stepId && p.workflow?.autoGenerate ? p.workflow.chapterCount : 1;
  const target = parsed.target || { kind: 'next' as const, count: defaultCount };
  const highWatermark = Math.max(
    p.chapterNumberHighWatermark || 0,
    ...p.chapters.map((chapter) => chapter.number),
    ...(p.candidates || []).map((candidate) => candidate.number),
  );
  const count =
    target.kind === 'range'
      ? target.to - target.from + 1
      : target.kind === 'next'
        ? (target.count ?? defaultCount)
        : 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_SIZE)
    throw new GenerationError(`每批只能生成 1–${MAX_BATCH_SIZE} 章，请缩小章节范围。`);
  if (parsed.stepId && count !== 1) throw new GenerationError('单节点运行只能指定一章。');
  const start =
    target.kind === 'single' ? target.number : target.kind === 'range' ? target.from : highWatermark + 1;
  if (!Number.isSafeInteger(start) || start < 1 || start + count - 1 > MAX_CHAPTER_NUMBER)
    throw new GenerationError('目标章节号超出范围。');
  const numbers = Array.from({ length: count }, (_, index) => start + index);
  const existing = new Map(p.chapters.map((chapter) => [chapter.number, chapter]));
  if (existing.size !== p.chapters.length) throw new GenerationError('作品包含重复章号，请先修复存储数据。');
  const conflicts = numbers.filter((number) =>
    mode === 'create' ? existing.has(number) : !existing.has(number),
  );
  if (conflicts.length)
    throw new GenerationError(
      mode === 'create'
        ? `章节已存在：${conflicts.join('、')}。请选择重生成以保留原稿。`
        : `重生成目标章节不存在：${conflicts.join('、')}。`,
      409,
      'CHAPTER_CONFLICT',
      conflicts,
    );
  if (p.chapterRequirements) chapterRequirementsSchema.parse(p.chapterRequirements);
  const targets = numbers.map((number): PreparedTarget => {
    const chapter = existing.get(number);
    return {
      number,
      outputName: p.steps.find(
        (step) => step.id === (parsed.outputWriterNodeId || p.workflow?.outputWriterNodeId),
      )?.outputName,
      requirements: resolveRequirements(p, number),
      ...(chapter ? { chapterId: chapter.id, baseRevision: chapter.revision } : {}),
    };
  });
  const selected = selectedStep ? [selectedStep] : orderedSteps(p);
  const writers = p.steps.filter((step) => step.enabled !== false && isWriter(step));
  let writerId = parsed.outputWriterNodeId || p.workflow?.outputWriterNodeId;
  if (writerId && !writers.some((writer) => writer.id === writerId))
    throw new GenerationError('所选最终正文节点不存在、不是正文节点或已禁用。');
  if (!writerId && writers.length === 1) writerId = writers[0].id;
  const writingWorkflow = selected.some(isWriter);
  const resultWithoutWriter = (): PreparedRun => ({
    request: structuredClone({ ...parsed, workflowId, target, mode }),
    workflowId,
    mode,
    targets: structuredClone(targets),
    orderedStepIds: selected.map((step) => step.id),
  });
  if (!writingWorkflow && !selectedStep) return resultWithoutWriter();
  if (!selectedStep) {
    if (!writerId) throw new GenerationError('有多个正文节点，请明确选择一个最终正文输出节点。');
    const auditId = p.workflow?.auditNodeId;
    if (auditId) {
      const audit = p.steps.find((step) => step.id === auditId && step.enabled !== false);
      if (!audit || audit.id === writerId || !downstreamIds(p, writerId).has(auditId))
        throw new GenerationError('指定审校节点必须启用且位于最终正文节点的下游。');
    }
  } else if (selectedStep) {
    const targetContext = targets[0];
    const upstream = upstreamIds(p, selectedStep.id);
    const visit = (ids: Set<string>): Set<string> => {
      const result = new Set(ids);
      for (const id of ids) for (const parent of upstreamIds(p, id)) result.add(parent);
      return result.size === ids.size ? result : visit(result);
    };
    for (const id of visit(upstream)) {
      if (id === SYSTEM_START_NODE_ID || id === SYSTEM_END_NODE_ID) continue;
      const dependency = p.steps.find((step) => step.id === id)!;
      if (
        dependency.enabled === false ||
        dependency.status !== 'done' ||
        !dependency.output.trim() ||
        !matchesContext(dependency.generationContext, targetContext, p, mode)
      )
        throw new GenerationError(
          `请先在同一目标章节和要求下运行上游节点「${dependency.title}」，或运行完整工作流。`,
          400,
          'DEPENDENCY_CONTEXT_MISMATCH',
        );
    }
  }
  if (settings)
    for (const step of selected) {
      if (step.id !== SYSTEM_START_NODE_ID && step.id !== SYSTEM_END_NODE_ID) settingsForStep(step, settings);
    }
  return {
    request: structuredClone({
      ...parsed,
      workflowId,
      target,
      mode,
      ...(writerId ? { outputWriterNodeId: writerId } : {}),
    }),
    workflowId,
    mode,
    stepId: parsed.stepId,
    outputWriterNodeId: writerId,
    targets: structuredClone(targets),
    orderedStepIds: selected.map((step) => step.id),
  };
}

export function acceptCandidate(
  p: Project,
  id: string,
  expectedRevision?: number,
  acknowledgeReviewFailure = false,
): Chapter {
  if (p.run?.status === 'running')
    throw new GenerationError('生成运行中，暂不能采用候选。', 409, 'RUN_CONFLICT');
  const candidate = p.candidates?.find((item) => item.id === id);
  if (!candidate) throw new GenerationError('候选版本不存在。', 404, 'CANDIDATE_NOT_FOUND');
  if (candidate.recoveryStatus === 'pending-review')
    throw new GenerationError(
      '候选仍在审校中，暂不能采用。',
      409,
      'CANDIDATE_PENDING_REVIEW',
      undefined,
      true,
    );
  if (candidate.recoveryStatus === 'review-failed' && !acknowledgeReviewFailure)
    throw new GenerationError(
      '审校失败的恢复稿需要作者确认风险后才能采用。',
      409,
      'REVIEW_FAILURE_ACK_REQUIRED',
      undefined,
      false,
    );
  if (
    !candidate.content.trim() ||
    candidate.issues.length ||
    literalIssues(candidate.content, candidate.requirements).length ||
    literalIssues(candidate.content, resolveRequirements(p, candidate.number)).length
  )
    throw new GenerationError(
      '候选不符合硬性文本要求，不能采用。请调整后重新生成。',
      409,
      'CANDIDATE_INVALID',
    );
  const original = p.chapters.find((chapter) => chapter.number === candidate.number);
  const now = new Date().toISOString();
  let chapter: Chapter;
  if (candidate.generationMode === 'regenerate') {
    if (
      !original ||
      original.id !== candidate.chapterId ||
      original.revision !== candidate.baseRevision ||
      (expectedRevision !== undefined && expectedRevision !== original.revision)
    )
      throw new GenerationError(
        '原稿版本已变化或章节已删除，请保留当前正文并重新生成候选。',
        409,
        'REVISION_CONFLICT',
      );
    original.revisions ||= [];
    original.revisions.push({
      revision: original.revision,
      title: original.title,
      content: original.content,
      updatedAt: original.updatedAt,
      mode: original.mode,
    });
    original.revision++;
    chapter = original;
  } else {
    if (original || expectedRevision !== undefined)
      throw new GenerationError('目标章节已存在，不能覆盖。', 409, 'CHAPTER_CONFLICT', [candidate.number]);
    chapter = {
      id: randomUUID(),
      number: candidate.number,
      revision: 1,
      title: '',
      content: '',
      mode: candidate.mode,
      updatedAt: now,
    };
    p.chapters.push(chapter);
  }
  Object.assign(chapter, {
    title: candidate.title,
    content: candidate.content,
    updatedAt: now,
    mode: candidate.mode,
    workflowId: candidate.workflowId,
    runId: candidate.runId,
    outputWriterNodeId: candidate.outputWriterNodeId,
    requirements: structuredClone(candidate.requirements),
  });
  p.chapterNumberHighWatermark = Math.max(p.chapterNumberHighWatermark || 0, candidate.number);
  p.candidates = p.candidates!.filter((item) => item.id !== id);
  return chapter;
}

export function candidateFromOutput(
  p: Project,
  plan: PreparedRun,
  target: PreparedTarget,
  content: string,
  mode: 'demo' | 'live',
  issues: string[],
): ChapterCandidate {
  return {
    id: randomUUID(),
    number: target.number,
    title:
      (plan.request.outputName || target.outputName || '').trim() ||
      content
        .split('\n')
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, '')
        .slice(0, 120) ||
      `第 ${target.number} 章`,
    content,
    chapterId: target.chapterId,
    baseRevision: target.baseRevision,
    issues,
    createdAt: new Date().toISOString(),
    mode,
    generationMode: plan.mode,
    workflowId: plan.workflowId,
    runId: p.run!.id,
    outputWriterNodeId: plan.outputWriterNodeId!,
    requirements: structuredClone(target.requirements),
    graphRevision: p.workflow?.graphRevision || 0,
    recoveryStatus: 'pending-review',
    semanticStatus: 'pending-author',
  };
}
