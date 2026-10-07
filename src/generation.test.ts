import assert from 'node:assert/strict';
import test from 'node:test';
import type { Asset, Chapter, ChapterCandidate, Project } from '../shared/types';
import { emptyRequirements } from '../shared/generation';
import {
  acknowledgeChapterSave,
  editorDirty,
  editorForChapter,
  reconcileChapterEditor,
} from './hooks/useChapterEditor';
import {
  canApplyProject,
  candidateBlockReason,
  filterAssets,
  graphSnapshot,
  nextChapterNumber,
  projectIdentity,
  sortedChapters,
  targetNumbers,
} from './hooks/generationState';

const chapter = (number = 5, revision = 1): Chapter => ({
  id: `chapter-${number}`,
  number,
  revision,
  title: `第 ${number} 章`,
  content: '原稿',
  updatedAt: '2026-10-01T00:00:00.000Z',
  mode: 'demo',
});
function project(): Project {
  return {
    id: 'project',
    title: '测试作品',
    genre: '幻想',
    description: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    assets: [],
    chapters: [chapter(5), chapter(2)],
    activeWorkflowId: 'workflow',
    chapterNumberHighWatermark: 8,
    workflow: {
      id: 'workflow',
      name: '工作流',
      graphRevision: 7,
      edges: [],
      chapterCount: 1,
      autoGenerate: false,
      autoPublish: true,
      startNodeId: 'system-start',
      endNodeId: 'system-end',
    },
    steps: [
      {
        id: 'writer',
        title: '正文',
        subtitle: '创作',
        prompt: '生成',
        kind: 'writer',
        position: { x: 10, y: 20 },
        status: 'done',
        output: '不可恢复的旧正文',
        generationContext: {
          runId: 'run',
          workflowId: 'workflow',
          number: 5,
          mode: 'create',
          requirements: emptyRequirements(),
          graphRevision: 7,
        },
      },
    ],
  };
}
const candidate = (): ChapterCandidate => ({
  id: 'candidate',
  number: 5,
  title: '候选',
  content: '新稿',
  chapterId: 'chapter-5',
  baseRevision: 1,
  issues: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  mode: 'demo',
  generationMode: 'regenerate',
  workflowId: 'workflow',
  runId: 'run',
  outputWriterNodeId: 'writer',
  requirements: emptyRequirements(),
  semanticStatus: 'pending-author',
});

test('save acknowledgement preserves typing made while a save was pending', () => {
  const base = editorForChapter('project/workflow', chapter(), 1);
  const submitted = { ...base, title: '提交的标题', content: '提交的正文', editVersion: 1 };
  const current = { ...submitted, content: '保存期间继续输入', editVersion: 2 };
  const result = acknowledgeChapterSave(current, submitted, {
    ...chapter(5, 2),
    title: submitted.title,
    content: submitted.content,
  });
  assert.equal(result.content, '保存期间继续输入');
  assert.equal(result.baseRevision, 2);
  assert.equal(result.savedContent, submitted.content);
  assert.equal(editorDirty(result), true);
});

test('clean save adopts canonical normalized response and clears dirty flag', () => {
  const submitted = {
    ...editorForChapter('project/workflow', chapter(), 1),
    title: ' 标题 ',
    content: '新稿',
    editVersion: 1,
  };
  const result = acknowledgeChapterSave(submitted, submitted, {
    ...chapter(5, 2),
    title: '标题',
    content: '新稿',
  });
  assert.equal(result.title, '标题');
  assert.equal(result.baseRevision, 2);
  assert.equal(editorDirty(result), false);
});

test('late saves cannot replace another chapter, workflow, selection generation, or baseline', () => {
  const submitted = editorForChapter('project/workflow', chapter(), 1);
  for (const current of [
    editorForChapter('project/workflow', chapter(6), 2),
    editorForChapter('project/other', chapter(), 1),
    editorForChapter('project/workflow', chapter(), 3),
    editorForChapter('project/workflow', chapter(5, 3), 1),
  ])
    assert.strictEqual(acknowledgeChapterSave(current, submitted, chapter(5, 2)), current);
});

test('polls do not overwrite dirty drafts or advance their optimistic concurrency baseline', () => {
  const current = {
    ...editorForChapter('project/workflow', chapter(), 1),
    content: '未保存',
    editVersion: 1,
  };
  assert.strictEqual(
    reconcileChapterEditor(current, current.identity, [{ ...chapter(5, 2), content: '外部更新' }], true),
    current,
  );
  assert.strictEqual(reconcileChapterEditor(current, current.identity, [], true), current);
});

test('polls can refresh clean editors and choose highest stable chapter number', () => {
  const clean = editorForChapter('project/workflow', chapter(), 1);
  const updated = reconcileChapterEditor(
    clean,
    clean.identity,
    [{ ...chapter(5, 2), content: '新版本' }],
    true,
  );
  assert.equal(updated.content, '新版本');
  assert.equal(updated.baseRevision, 2);
  const fallback = reconcileChapterEditor(clean, clean.identity, [chapter(9), chapter(3)], true);
  assert.equal(fallback.chapterId, 'chapter-9');
});

test('project responses reject stale workflow, graph, content version, and update time', () => {
  const current = project();
  const identity = projectIdentity(current);
  assert.equal(canApplyProject(current, { ...current, activeWorkflowId: 'other' }, identity), false);
  assert.equal(
    canApplyProject(current, { ...current, workflow: { ...current.workflow!, graphRevision: 6 } }, identity),
    false,
  );
  assert.equal(canApplyProject({ ...current, chapters: [chapter(5, 3)] }, current, identity), false);
  assert.equal(
    canApplyProject(current, { ...current, updatedAt: '2026-09-30T00:00:00.000Z' }, identity),
    false,
  );
  assert.equal(canApplyProject(current, { ...current, chapters: [chapter(5, 2)] }, identity), true);
});

test('graph history contains editable config only, never chapters or stale execution state', () => {
  const snapshot = graphSnapshot(project());
  assert.equal(snapshot.identity, 'project/workflow');
  assert.equal(snapshot.steps[0].position.x, 10);
  assert.equal(snapshot.steps[0].modelId, '');
  for (const forbidden of ['output', 'status', 'generationContext'])
    assert.equal(forbidden in snapshot.steps[0], false);
  for (const forbidden of ['chapters', 'run', 'assets', 'requirements', 'candidates'])
    assert.equal(forbidden in snapshot, false);
  for (const forbidden of ['startNodeId', 'endNodeId', 'autoPublish', 'graphRevision'])
    assert.equal(forbidden in snapshot.workflow, false);
});

test('stable chapter ordering and high-watermark continuation never reuse deleted numbers', () => {
  const p = project();
  assert.deepEqual(
    sortedChapters(p.chapters).map((c) => c.number),
    [2, 5],
  );
  assert.deepEqual(
    p.chapters.map((c) => c.number),
    [5, 2],
  );
  assert.equal(nextChapterNumber(p), 1);
  assert.deepEqual(targetNumbers(p, { target: { kind: 'next', count: 2 } }), [9, 10]);
  assert.deepEqual(targetNumbers(p, { target: { kind: 'single', number: 5 } }), [5]);
  assert.deepEqual(targetNumbers(p, { target: { kind: 'range', from: 3, to: 5 } }), [3, 4, 5]);
});

test('target validation rejects invalid bounds, excessive batches, and ambiguous regeneration', () => {
  const p = project();
  assert.throws(() => targetNumbers(p, { target: { kind: 'range', from: 5, to: 3 } }));
  assert.throws(() => targetNumbers(p, { target: { kind: 'range', from: 1, to: 101 } }));
  assert.throws(() => targetNumbers(p, { target: { kind: 'single', number: 1.5 } }));
  assert.throws(() => targetNumbers(p, { target: { kind: 'next' }, mode: 'regenerate' }));
  assert.throws(() => targetNumbers(p, { target: { kind: 'next', count: 2 }, stepId: 'writer' }));
  assert.throws(() =>
    targetNumbers({ ...p, chapterNumberHighWatermark: 1_000_000 }, { target: { kind: 'next' } }),
  );
});

test('candidate adoption blocks literal violations and stale revisions but not advisory semantics', () => {
  assert.equal(candidateBlockReason(candidate(), [chapter()]), '');
  assert.match(candidateBlockReason({ ...candidate(), issues: ['缺少原文'] }, [chapter()]), /硬性/);
  assert.match(candidateBlockReason(candidate(), [chapter(5, 2)]), /旧版本/);
  assert.match(candidateBlockReason(candidate(), []), /删除/);
  assert.match(candidateBlockReason({ ...candidate(), chapterId: undefined }, [chapter()]), /已有正文/);
});

test('blank asset search avoids materializing or reading large content strings', () => {
  const asset: Asset = { id: 'asset', name: '地图', category: 'world', content: '', size: 0, createdAt: '' };
  Object.defineProperty(asset, 'content', {
    get() {
      throw new Error('blank search must not read content');
    },
  });
  assert.deepEqual(filterAssets([asset], 'all', '   '), [asset]);
  assert.deepEqual(filterAssets([asset], 'characters', ''), []);
});
