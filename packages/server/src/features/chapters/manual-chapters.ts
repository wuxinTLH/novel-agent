import { createHash, randomUUID } from 'node:crypto';
import { manualChapterRequestSchema } from '../../../../../shared/manual-chapters.js';
import type { Chapter, Project } from '../../../../../shared/types.js';

function conflict(code: string, message: string) {
  return Object.assign(new Error(message), { status: 409, code });
}

/** Apply to a mutateProject draft only. All validation happens before any mutation. */
export function addManualChapter(project: Project, value: unknown): { chapter: Chapter; created: boolean } {
  const request = manualChapterRequestSchema.parse(value);
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        number: request.number,
        title: request.title,
        content: request.content,
        workflowId: request.workflowId ?? null,
      }),
    )
    .digest('hex');
  const existing = project.chapters.find((chapter) => chapter.manualRequestId === request.requestId);
  if (existing) {
    if (existing.manualRequestHash !== requestHash)
      throw conflict('MANUAL_REQUEST_CONFLICT', '此请求标识已用于其他章节内容，请勿更改重试内容。');
    return { chapter: existing, created: false };
  }
  if (project.chapters.some((chapter) => chapter.number === request.number))
    throw conflict('CHAPTER_NUMBER_CONFLICT', '此章号已有正式正文，请更换章号或编辑已有章节。');

  const chapter: Chapter = {
    id: randomUUID(),
    number: request.number,
    title: request.title,
    content: request.content,
    mode: 'live',
    revision: 1,
    updatedAt: new Date().toISOString(),
    workflowId: project.activeWorkflowId,
    manualRequestId: request.requestId,
    manualRequestHash: requestHash,
  };
  const highWatermark = Math.max(
    project.chapterNumberHighWatermark || 0,
    request.number,
    ...project.chapters.map((item) => item.number),
    ...(project.candidates || []).map((item) => item.number),
  );
  project.chapters.push(chapter);
  project.chapterNumberHighWatermark = highWatermark;
  return { chapter, created: true };
}
