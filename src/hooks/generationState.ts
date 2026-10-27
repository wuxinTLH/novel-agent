import type {
  Asset,
  Category,
  Chapter,
  ChapterCandidate,
  Project,
  RunRequest,
  Step,
  WorkflowSettings,
} from '../../shared/types';
import { GENERATION_LIMITS, runRequestSchema } from '../../shared/generation';

export function previousOutputControl(step: Pick<Step, 'reusePreviousOutput' | 'output'>, locked: boolean) {
  const checked = !!step.reusePreviousOutput;
  const available = !!step.output.trim();
  return {
    checked,
    // A stale checked preference must remain switchable off, even after invalidation clears output.
    disabled: locked || (!available && !checked),
    hint: available
      ? '开启后跳过此节点的模型请求，沿用当前结果'
      : checked
        ? '前次结果已失效，请取消勾选后重新运行此节点或完整工作流'
        : '该节点尚无可复用结果，请先运行节点',
  };
}

export function workflowIdOf(project: Project) {
  return project.activeWorkflowId || project.workflow?.id || project.workflows?.[0]?.id || '';
}
export function projectIdentity(project: Project) {
  return `${project.id}/${workflowIdOf(project)}`;
}
export function sortedChapters(chapters: Chapter[]) {
  return [...chapters].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
}
export function nextChapterNumber(project: Project) {
  const saved = new Set(project.chapters.map((chapter) => chapter.number));
  let number = 1;
  while (saved.has(number)) number += 1;
  return number;
}
const assetSearchCache = new WeakMap<Asset[], Map<string, Asset[]>>();
export function filterAssets(assets: Asset[], category: Category | 'all', query: string) {
  const term = query.trim().toLocaleLowerCase();
  const key = `${category}\u0000${term}`;
  const cached = assetSearchCache.get(assets)?.get(key);
  if (cached) return cached;
  const result = assets.filter(
    (asset) =>
      (category === 'all' || asset.category === category) &&
      (!term ||
        asset.name.toLocaleLowerCase().includes(term) ||
        asset.content.toLocaleLowerCase().includes(term)),
  );
  const bucket = assetSearchCache.get(assets) || new Map<string, Asset[]>();
  bucket.set(key, result);
  assetSearchCache.set(assets, bucket);
  return result;
}
export type GraphSnapshot = {
  identity: string;
  workflowId: string;
  steps: Pick<
    Step,
    'id' | 'title' | 'subtitle' | 'prompt' | 'position' | 'kind' | 'modelId' | 'assetIds' | 'enabled'
    | 'outputName' | 'reusePreviousOutput' | 'characterName' | 'characterGender'
    | 'characterPersonality' | 'characterExperience' | 'characterCount' | 'characterTemplate'
  >[];
  workflow: Pick<
    WorkflowSettings,
    'name' | 'edges' | 'auditNodeId' | 'chapterCount' | 'autoGenerate' | 'automationMode' | 'publication' | 'outputWriterNodeId' | 'outputName'
  >;
};
export function graphSnapshot(project: Project): GraphSnapshot {
  return structuredClone({
    identity: projectIdentity(project),
    workflowId: workflowIdOf(project),
    steps: project.steps.map(
      ({ id, title, subtitle, prompt, position, kind, modelId, assetIds, enabled,
        outputName, reusePreviousOutput, characterName, characterGender,
        characterPersonality, characterExperience, characterCount, characterTemplate }) => ({
        id,
        title,
        subtitle,
        prompt,
        position,
        kind,
        modelId: modelId || '',
        assetIds,
        enabled,
        outputName: outputName || '',
        reusePreviousOutput: reusePreviousOutput || false,
        characterName: characterName || '',
        characterGender: characterGender || '',
        characterPersonality: characterPersonality || '',
        characterExperience: characterExperience || '',
        characterCount: characterCount || 1,
        characterTemplate: characterTemplate || '',
      }),
    ),
    workflow: {
      name: project.workflow?.name,
      edges: project.workflow?.edges || [],
      auditNodeId: project.workflow?.auditNodeId || '',
      chapterCount: project.workflow?.chapterCount || 1,
      autoGenerate: project.workflow?.autoGenerate || false,
      automationMode: project.workflow?.automationMode || 'manual',
      publication: project.workflow?.publication,
      outputWriterNodeId: project.workflow?.outputWriterNodeId || '',
      outputName: project.workflow?.outputName || '',
    },
  });
}
export function canApplyProject(current: Project | null, incoming: Project, identity: string) {
  if (projectIdentity(incoming) !== identity) return false;
  if (!current || projectIdentity(current) !== identity) return true;
  if (Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt)) return false;
  if ((incoming.workflow?.graphRevision ?? 0) < (current.workflow?.graphRevision ?? 0)) return false;
  return !current.chapters.some((chapter) => {
    const next = incoming.chapters.find((item) => item.id === chapter.id);
    return next && next.revision < chapter.revision;
  });
}
export function candidateBlockReason(candidate: ChapterCandidate, chapters: Chapter[]) {
  if (candidate.issues.length) return '候选稿存在硬性文本违规，不能采用。请修改要求或重新生成。';
  if (!candidate.chapterId)
    return chapters.some((chapter) => chapter.number === candidate.number)
      ? '该章号已有正文，不能覆盖。请重新生成并对比。'
      : '';
  const original = chapters.find((chapter) => chapter.id === candidate.chapterId);
  if (!original) return '原章节已删除，不能采用此候选稿。';
  if (original.revision !== candidate.baseRevision) return '原稿已修改，此候选稿基于旧版本。请重新生成。';
  return '';
}
export function targetNumbers(project: Project, request: RunRequest) {
  const parsed = runRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join('；'));
  const target = parsed.data.target || { kind: 'next' as const, count: 1 };
  const first =
    target.kind === 'next'
      ? Math.max(nextChapterNumber(project), (project.chapterNumberHighWatermark || 0) + 1)
      : target.kind === 'single'
        ? target.number
        : target.from;
  const last =
    target.kind === 'next'
      ? first + (target.count ?? 1) - 1
      : target.kind === 'single'
        ? target.number
        : target.to;
  if (last > GENERATION_LIMITS.maxChapterNumber) throw new Error('目标章号超出上限。');
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
