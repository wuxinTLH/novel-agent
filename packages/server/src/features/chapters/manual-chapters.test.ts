import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MAX_CHAPTER_NUMBER } from '../../../../../shared/generation.js';
import { MANUAL_CHAPTER_MAX_CONTENT_LENGTH, manualChapterRequestSchema } from '../../../../../shared/manual-chapters.js';
import { createProject } from '../projects/defaults.js';
import { addManualChapter } from './manual-chapters.js';
import { migrateProjects } from '../projects/store.js';

function request() {
  return { number: 3, title: ' 手动正文 ', content: '\n正文第一行。\n\n第二行。\n', requestId: randomUUID() };
}

test('manual addition creates local live revision one, preserves prose and advances watermark', () => {
  const project = createProject('manual');
  const before = structuredClone(project);
  const input = request();
  const { chapter, created } = addManualChapter(project, input);
  assert.equal(created, true);
  assert.equal(chapter.number, 3);
  assert.equal(chapter.title, '手动正文');
  assert.equal(chapter.content, input.content);
  assert.equal(chapter.mode, 'live');
  assert.equal(chapter.revision, 1);
  assert.equal(chapter.workflowId, project.activeWorkflowId);
  assert.equal(chapter.manualRequestId, input.requestId);
  assert.equal(typeof chapter.manualRequestHash, 'string');
  assert.equal(chapter.runId, undefined);
  assert.equal(chapter.outputWriterNodeId, undefined);
  assert.equal(chapter.legacyPublishedAt, undefined);
  assert.equal(project.chapterNumberHighWatermark, 3);
  assert.deepEqual(
    { ...project, chapters: before.chapters, chapterNumberHighWatermark: before.chapterNumberHighWatermark },
    before,
  );
});

test('exact replay returns the original chapter without mutation, even after edits and reload', () => {
  const project = createProject('replay');
  const input = request();
  const first = addManualChapter(project, input).chapter;
  first.title = '后来改过的标题';
  first.content = '后来编辑的正文';
  first.revision++;
  const [restored] = migrateProjects([project]);
  const before = structuredClone(restored);
  const replay = addManualChapter(restored, input);
  assert.equal(replay.created, false);
  assert.equal(replay.chapter.id, first.id);
  assert.equal(replay.chapter.content, '后来编辑的正文');
  assert.deepEqual(restored, before);
});

test('request identity conflicts and occupied numbers fail before any mutation', () => {
  const project = createProject('conflicts');
  const input = request();
  addManualChapter(project, input);
  const before = structuredClone(project);
  for (const changes of [
    { number: 4 },
    { title: '另一标题' },
    { content: '另一个正文' },
    { workflowId: 'other-workflow' },
  ]) {
    assert.throws(() => addManualChapter(project, { ...input, ...changes }), {
      status: 409,
      code: 'MANUAL_REQUEST_CONFLICT',
    });
    assert.deepEqual(project, before);
  }
  assert.throws(() => addManualChapter(project, { ...input, requestId: randomUUID() }), {
    status: 409,
    code: 'CHAPTER_NUMBER_CONFLICT',
  });
  assert.deepEqual(project, before);
});

test('strict schema bounds chapter number, title, nonempty prose and request identity without mutation', () => {
  const project = createProject('invalid');
  const before = structuredClone(project);
  const input = request();
  for (const changes of [
    { number: 0 },
    { number: -1 },
    { number: 1.5 },
    { number: MAX_CHAPTER_NUMBER + 1 },
    { number: '3' },
    { title: '' },
    { title: ' \t\n' },
    { title: '文'.repeat(121) },
    { content: '' },
    { content: '\uFEFF \n\t' },
    { content: '文'.repeat(MANUAL_CHAPTER_MAX_CONTENT_LENGTH + 1) },
    { requestId: '' },
    { requestId: 'not-a-uuid' },
    { requestId: undefined },
    { workflowId: '' },
    { unknown: true },
  ]) {
    assert.throws(() => addManualChapter(project, { ...input, ...changes }));
    assert.deepEqual(project, before);
  }
  assert.equal(manualChapterRequestSchema.safeParse({ ...input, number: 1 }).success, true);
  assert.equal(manualChapterRequestSchema.safeParse({ ...input, number: MAX_CHAPTER_NUMBER }).success, true);
  assert.equal(
    manualChapterRequestSchema.safeParse({
      ...input,
      content: '文'.repeat(MANUAL_CHAPTER_MAX_CONTENT_LENGTH),
    }).success,
    true,
  );
});

test('free lower explicit numbers never lower the high watermark, including candidate reservations', () => {
  const project = createProject('watermark');
  project.chapterNumberHighWatermark = 10;
  addManualChapter(project, request());
  assert.equal(project.chapterNumberHighWatermark, 10);
  project.chapters = [];
  addManualChapter(project, { ...request(), number: 11 });
  assert.equal(project.chapterNumberHighWatermark, 11);
  project.chapterNumberHighWatermark = 0;
  project.candidates = [{ number: 20 } as NonNullable<typeof project.candidates>[number]];
  addManualChapter(project, { ...request(), number: 12 });
  assert.equal(project.chapterNumberHighWatermark, 20);
});
