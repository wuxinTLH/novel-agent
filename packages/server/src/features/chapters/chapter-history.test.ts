import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../projects/defaults.js';
import { addManualChapter } from './manual-chapters.js';
import { restoreChapterRevision } from './chapter-history.js';
import { archiveChapterRevision, normalizeChapterHistory, CHAPTER_HISTORY_LIMIT } from '../../../../../shared/chapter-history.js';
import { randomUUID } from 'node:crypto';

function fixture() {
  const project = createProject('history');
  const { chapter } = addManualChapter(project, { number: 1, title: '旧标题', content: '旧正文', requestId: randomUUID() });
  archiveChapterRevision(chapter);
  Object.assign(chapter, { revision: 2, title: '当前标题', content: '当前正文' });
  return { project, chapter };
}
test('restore enforces CAS before mutation and requires an existing historical revision', () => {
  const { project, chapter } = fixture();
  const before = structuredClone(project);
  assert.throws(() => restoreChapterRevision(project, chapter.id, 1, 1), { status: 409, code: 'REVISION_CONFLICT' });
  assert.deepEqual(project, before);
  assert.throws(() => restoreChapterRevision(project, chapter.id, 2, 99), { status: 404, code: 'CHAPTER_REVISION_NOT_FOUND' });
  assert.deepEqual(project, before);
});
test('restore creates a new monotonic revision and retains current prose for reversing restore', () => {
  const { project, chapter } = fixture();
  restoreChapterRevision(project, chapter.id, 2, 1);
  assert.equal(chapter.revision, 3);
  assert.equal(chapter.content, '旧正文');
  assert.equal(chapter.revisions?.[0].revision, 2);
  assert.equal(chapter.revisions?.[0].content, '当前正文');
  restoreChapterRevision(project, chapter.id, 3, 2);
  assert.equal(chapter.revision, 4);
  assert.equal(chapter.content, '当前正文');
  assert.deepEqual(chapter.revisions?.map((item) => item.revision), [3, 2, 1]);
});
test('history normalizes mixed legacy ordering, deduplicates and retains newest twenty', () => {
  const { chapter } = fixture();
  const versions = Array.from({ length: 30 }, (_, index) => ({ ...chapter.revisions![0], revision: index + 1 }));
  const result = normalizeChapterHistory([...versions.slice(10), ...versions.slice(0, 15)]);
  assert.equal(result.length, CHAPTER_HISTORY_LIMIT);
  assert.deepEqual(result.map((item) => item.revision), Array.from({ length: 20 }, (_, index) => 30 - index));
});
