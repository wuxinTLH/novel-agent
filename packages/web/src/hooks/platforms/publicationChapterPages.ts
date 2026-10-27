import type { PlatformChapterChoice } from '../../../../../shared/platforms';

export const PUBLICATION_BATCH_LIMIT = 50;

export function publicationChapterPages(chapters: readonly PlatformChapterChoice[]) {
  const sorted = [...chapters].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  return Array.from({ length: Math.ceil(sorted.length / PUBLICATION_BATCH_LIMIT) }, (_, index) =>
    sorted.slice(index * PUBLICATION_BATCH_LIMIT, (index + 1) * PUBLICATION_BATCH_LIMIT));
}
