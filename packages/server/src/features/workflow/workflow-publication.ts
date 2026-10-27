import type { Project, Run, WorkflowSettings } from '../../../../../shared/types.js';
import type { PlatformRuntime } from '../platforms/platform-runtime.js';
import type { Store } from '../projects/store.js';

/** A completed, persisted workflow may hand off only its own validated chapters. Never retry on restart. */
export async function completeWorkflowPublication(
  store: Store,
  runtime: Pick<PlatformRuntime, 'preparePublication'>,
  project: Project,
  run: Run,
  workflow: WorkflowSettings,
): Promise<void> {
  const config = workflow.publication;
  if (workflow.automationMode !== 'automatic' || !config?.enabled || run.status !== 'done' ||
      run.stepId || run.mode !== 'live' || project.run?.id !== run.id || run.publication) return;
  const ids = [...new Set(run.generatedChapterIds ?? [])];
  if (!ids.length || !run.chapters?.length || run.chapters.some(item => item.status !== 'done' || item.validationStatus !== 'passed')) return;
  if (ids.some(id => !project.chapters.some(chapter => chapter.id === id && chapter.runId === run.id && chapter.mode === 'live'))) return;
  // Durable admission precedes any remote preparation. A crash here requires read-only inspection, not automatic replay.
  run.publication = { state: 'pending' };
  store.touch(project);
  try {
    const batch = await runtime.preparePublication(project.id, config.linkId, ids, config.action, config.useAi, config.volumeId, true);
    run.publication = { state: 'queued', batchId: batch.id };
  } catch {
    // Browser errors may contain sensitive page information; detailed diagnostics stay in the publication queue.
    run.publication = { state: 'failed', error: '自动远端接续未完成，请到平台作品页核对队列与远端结果；不会自动重试。' };
  }
  store.touch(project);
}
