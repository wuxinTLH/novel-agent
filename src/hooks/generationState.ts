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
  >[];
  workflow: Pick<
    WorkflowSettings,
    'name' | 'edges' | 'auditNodeId' | 'chapterCount' | 'autoGenerate' | 'outputWriterNodeId'
  >;
};
export function graphSnapshot(project: Project): GraphSnapshot {
  return structuredClone({
    identity: projectIdentity(project),
    workflowId: workflowIdOf(project),
    steps: project.steps.map(
      ({ id, title, subtitle, prompt, position, kind, modelId, assetIds, enabled }) => ({
        id,
        title,
        subtitle,
        prompt,
        position,
        kind,
        modelId: modelId || '',
        assetIds,
        enabled,
      }),
    ),
    workflow: {
      name: project.workflow?.name,
      edges: project.workflow?.edges || [],
      auditNodeId: project.workflow?.auditNodeId || '',
      chapterCount: project.workflow?.chapterCount || 1,
      autoGenerate: project.workflow?.autoGenerate || false,
      outputWriterNodeId: project.workflow?.outputWriterNodeId || '',
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
      ? nextChapterNumber(project)
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
