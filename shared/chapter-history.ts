import type { Chapter, ChapterRevision } from './types.js';

export const CHAPTER_HISTORY_LIMIT = 20;

/** History is newest revision first, unique by revision, with a shared retention limit. */
export function normalizeChapterHistory(history: readonly ChapterRevision[] = []): ChapterRevision[] {
  const unique = new Map<number, ChapterRevision>();
  for (const item of history) if (!unique.has(item.revision)) unique.set(item.revision, item);
  return [...unique.values()].sort((a, b) => b.revision - a.revision).slice(0, CHAPTER_HISTORY_LIMIT);
}

export function chapterSnapshot(chapter: Chapter): ChapterRevision {
  const { revision, title, content, updatedAt, mode } = chapter;
  return { revision, title, content, updatedAt, mode };
}

export function archiveChapterRevision(chapter: Chapter): void {
  chapter.revisions = normalizeChapterHistory([chapterSnapshot(chapter), ...(chapter.revisions || [])]);
}
