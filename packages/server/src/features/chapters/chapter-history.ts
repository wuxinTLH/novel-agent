import type { Chapter, Project } from '../../../../../shared/types.js';
import { archiveChapterRevision, normalizeChapterHistory } from '../../../../../shared/chapter-history.js';
import { inputError } from '../projects/project-operations.js';

export function restoreChapterRevision(
  project: Project,
  chapterId: string,
  expectedRevision: number,
  revision: number,
): Chapter {
  const chapter = project.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw inputError(404, 'CHAPTER_NOT_FOUND', '章节不存在。');
  if (chapter.revision !== expectedRevision)
    throw inputError(409, 'REVISION_CONFLICT', '章节已被修改，当前输入已保留，请刷新版本后重试。');
  const previous = normalizeChapterHistory(chapter.revisions).find((item) => item.revision === revision);
  if (!previous) throw inputError(404, 'CHAPTER_REVISION_NOT_FOUND', '该历史版本不存在或已超过保留范围。');
  archiveChapterRevision(chapter);
  Object.assign(chapter, {
    title: previous.title,
    content: previous.content,
    mode: previous.mode,
    revision: chapter.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  return chapter;
}
