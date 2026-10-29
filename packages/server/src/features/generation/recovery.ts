import { createHash } from 'node:crypto';
import type { Project, Run } from '../../../../../shared/types.js';
import type { RuntimeSettings } from './engine.js';
import { GenerationError, prepareRun, type PreparedRun } from './generation.js';

/** Fingerprint configuration and all original context outside this run's mutable targets.
 * Target identities/revisions are checked separately against durable progress below. */
export function runSnapshotFingerprint(p: Project, settings: RuntimeSettings, targets: number[]): string {
  const { apiKey, modelProfiles, ...model } = settings;
  const profiles = modelProfiles?.map(({ apiKey: key, ...profile }) => ({ ...profile, credentialHash: createHash('sha256').update(key).digest('hex') }));
  const data = {
    title: p.title, genre: p.genre, description: p.description,
    workflowId: p.activeWorkflowId, workflow: p.workflow,
    steps: p.steps.map(({ status: _status, output, generationContext: _context, lastError: _error, ...step }) => ({ ...step, ...(step.reusePreviousOutput ? { output } : {}) })),
    requirements: p.requirements, chapterRequirements: p.chapterRequirements, assets: p.assets, knowledgeFacts: p.knowledgeFacts,
    chapters: p.chapters.filter((chapter) => !targets.includes(chapter.number)),
    model, credentialHash: createHash('sha256').update(apiKey).digest('hex'), profiles,
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export function targetOriginals(p: Project, targets: number[]) {
  return targets.map((number) => {
    const chapter = p.chapters.find((item) => item.number === number);
    return { number, ...(chapter ? { chapterId: chapter.id, revision: chapter.revision, contentHash: createHash('sha256').update(chapter.content).digest('hex') } : {}) };
  });
}

export function prepareResume(p: Project, settings: RuntimeSettings, runId: string, fingerprint: string): { plan: PreparedRun; original: Run } {
  const original = [p.run, ...(p.runHistory || [])].find((run) => run?.id === runId);
  if (!original || !original.request || !original.resumeSnapshot || !original.chapters?.length || original.request.stepId)
    throw new GenerationError('该任务没有可验证的恢复快照。', 409, 'RESUME_UNAVAILABLE');
  if (p.run?.status === 'running') throw new GenerationError('当前项目已有运行中的任务。', 409, 'RUN_CONFLICT');
  if (original.status === 'done') throw new GenerationError('该任务已完成。', 409, 'RESUME_COMPLETE');
  if (fingerprint !== original.resumeSnapshot.fingerprint || runSnapshotFingerprint(p, settings, original.targets || []) !== fingerprint)
    throw new GenerationError('模型、资料、要求、工作流或章节上下文已变化，拒绝恢复旧快照。', 409, 'RESUME_SNAPSHOT_CONFLICT');
  const remaining = original.chapters.filter((progress) => progress.status !== 'done');
  if (!remaining.length) throw new GenerationError('没有待恢复的章节。', 409, 'RESUME_COMPLETE');
  for (const target of remaining) {
    const saved = p.chapters.find((chapter) => chapter.number === target.number);
    const snapshot = original.resumeSnapshot.targetOriginals?.find((item) => item.number === target.number);
    if (!snapshot || JSON.stringify(targetOriginals(p, [target.number])[0]) !== JSON.stringify(snapshot))
      throw new GenerationError('恢复目标原快照已变化。', 409, 'RESUME_CHAPTER_CONFLICT');
    if (saved && (!target.chapterId || saved.id !== target.chapterId || saved.revision !== target.baseRevision))
      throw new GenerationError('恢复目标已保存或原稿版本已变化，拒绝覆盖。', 409, 'RESUME_CHAPTER_CONFLICT');
    if (target.chapterId && !saved) throw new GenerationError('恢复原稿已删除。', 409, 'RESUME_CHAPTER_CONFLICT');
  }
  const plan = prepareRun(p, { ...original.request, target: { kind: 'single', number: remaining[0].number } }, settings);
  plan.targets = remaining.map((target) => ({ number: target.number, requirements: structuredClone(target.requirements), chapterId: target.chapterId, baseRevision: target.baseRevision }));
  return { plan, original };
}
