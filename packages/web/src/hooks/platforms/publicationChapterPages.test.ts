import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformChapterChoice } from '../../../../../shared/platforms';
import { publicationChapterPages } from './publicationChapterPages';

const chapter = (number: number): PlatformChapterChoice => ({
  id: `c${number}`, number, title: `第${number}章`, revision: 1, updatedAt: '', contentHash: '',
});

test('more than 50 saved chapters remain reachable in ordered, bounded groups', () => {
  const chapters = Array.from({ length: 123 }, (_, index) => chapter(123 - index));
  const pages = publicationChapterPages(chapters);
  assert.deepEqual(pages.map((page) => page.length), [50, 50, 23]);
  assert.deepEqual(pages.map((page) => [page[0].number, page[page.length - 1].number]), [
    [1, 50], [51, 100], [101, 123],
  ]);
  assert.equal(new Set(pages.flat().map((item) => item.id)).size, 123);
  assert.deepEqual(publicationChapterPages([]), []);
});
