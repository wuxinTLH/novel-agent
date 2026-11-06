import type { Chapter } from '../../../../../shared/types';

export const CHAPTER_PAGE_SIZES = [20, 50, 100] as const;
export type ChapterSelection = Pick<Chapter, 'id' | 'revision'>[];
export function chapterPage(total: number, requested: number, size: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.max(0, Math.min(requested, pages - 1));
  return { page, pages, start: page * size, end: Math.min(total, (page + 1) * size) };
}
export function chapterSelectedPage(chapters: Pick<Chapter, 'id'>[], id: string, size: number) {
  const index = chapters.findIndex((chapter) => chapter.id === id);
  return index < 0 ? 0 : Math.floor(index / size);
}
/** Preserve selected revisions: a poll must not silently approve a newer manuscript. */
export function toggleChapterSelection(
  selection: ChapterSelection,
  chapters: ChapterSelection,
  checked: boolean,
) {
  const ids = new Set(chapters.map((chapter) => chapter.id));
  if (!checked) return selection.filter((chapter) => !ids.has(chapter.id));
  const existing = new Set(selection.map((chapter) => chapter.id));
  return [
    ...selection,
    ...chapters.filter((chapter) => !existing.has(chapter.id)).map(({ id, revision }) => ({ id, revision })),
  ];
}
export function chapterSelectionStale(selection: ChapterSelection, chapters: ChapterSelection) {
  const revisions = new Map(chapters.map((chapter) => [chapter.id, chapter.revision]));
  return selection.some((chapter) => revisions.get(chapter.id) !== chapter.revision);
}
export function chapterDeletePayload(selection: ChapterSelection) {
  return selection.map(({ id, revision }) => ({ id, expectedRevision: revision }));
}
