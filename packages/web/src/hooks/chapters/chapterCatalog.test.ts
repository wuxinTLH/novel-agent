import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chapterPage,
  chapterSelectedPage,
  toggleChapterSelection,
  chapterSelectionStale,
  chapterDeletePayload,
} from './chapterCatalog.js';
const chapters = Array.from({ length: 55 }, (_, index) => ({ id: `chapter-${index + 1}`, revision: 1 }));
test('catalog pages have twenty entries, clamp after deletion and reveal selected chapter', () => {
  assert.deepEqual(chapterPage(55, 0, 20), { page: 0, pages: 3, start: 0, end: 20 });
  assert.deepEqual(chapterPage(55, 2, 20), { page: 2, pages: 3, start: 40, end: 55 });
  assert.deepEqual(chapterPage(0, 9, 20), { page: 0, pages: 1, start: 0, end: 0 });
  assert.equal(chapterPage(19, 2, 20).page, 0);
  assert.equal(chapterSelectedPage(chapters, 'chapter-41', 20), 2);
  assert.equal(chapterSelectedPage(chapters, 'chapter-41', 50), 0);
  assert.equal(chapterSelectedPage(chapters, 'missing', 20), 0);
});
test('page selection is explicit, additive across pages, and deselects current page only', () => {
  const initial = toggleChapterSelection([], chapters.slice(0, 20), false);
  assert.deepEqual(initial, []);
  const first = toggleChapterSelection(initial, chapters.slice(0, 20), true);
  const both = toggleChapterSelection(first, chapters.slice(20, 40), true);
  assert.equal(both.length, 40);
  assert.equal(toggleChapterSelection(both, chapters.slice(0, 20), true).length, 40);
  assert.deepEqual(toggleChapterSelection(both, chapters.slice(20, 40), false), first);
  assert.equal(initial.length, 0);
});
test('selected revisions stay pinned across polling and detect stale or missing chapters', () => {
  const selected = toggleChapterSelection([], chapters.slice(0, 1), true);
  const changed = [{ id: 'chapter-1', revision: 2 }, ...chapters.slice(1)];
  assert.equal(chapterSelectionStale(selected, chapters), false);
  assert.equal(chapterSelectionStale(selected, changed), true);
  assert.equal(chapterSelectionStale(selected, chapters.slice(1)), true);
  assert.deepEqual(toggleChapterSelection(selected, changed.slice(0, 1), true), selected);
  assert.deepEqual(chapterDeletePayload(selected), [{ id: 'chapter-1', expectedRevision: 1 }]);
});
