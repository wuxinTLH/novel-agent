import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Run, RunChapterProgress } from '../../../../../shared/types.js';
import { completedChapterPresence, GenerationProgressView } from './GenerationProgress.js';

function chapter(overrides: Partial<RunChapterProgress> = {}): RunChapterProgress {
  return {
    number: 5,
    status: 'done',
    chapterId: 'original-5',
    validationStatus: 'passed',
    reviewStatus: 'done',
    requirements: { instructions: '', requiredText: [], forbiddenText: [] },
    issues: [],
    ...overrides,
  };
}
function render(progress: RunChapterProgress, evidence?: { id: string }[], locale: 'en' | 'zh-CN' = 'zh-CN') {
  return renderRecords([progress], evidence, locale);
}

function renderRecords(
  chapters: RunChapterProgress[],
  evidence?: { id: string }[],
  locale: 'en' | 'zh-CN' = 'zh-CN',
  runOverrides: Partial<Run> = {},
) {
  const run: Run = { id: 'history', status: 'done', mode: 'live', startedAt: '', chapters, ...runOverrides };
  return renderToStaticMarkup(
    createElement(GenerationProgressView, {
      run,
      savedChapters: evidence?.length ?? 0,
      savedChapterEvidence: evidence,
      locale,
      onRetry() {
        throw new Error('render must never retry');
      },
    }),
  );
}

test('deleted completed chapters show absent without changing immutable run records or offering retry', () => {
  const progress = Object.freeze(chapter());
  assert.equal(completedChapterPresence(progress, []), 'absent');
  const html = render(progress, []);
  assert.match(html, /正式章节目录：0 章/);
  assert.match(html, /已从书稿删除 \/ 不在当前书稿/);
  assert.match(html, /删除章节不会删除运行记录/);
  assert.match(html, /<details open=""><summary>/);
  assert.match(html, /<details><summary>已从书稿删除 \/ 不在当前书稿的历史（1 章，默认收起）<\/summary><ul><li>/);
  assert.equal((html.match(/<details/g) ?? []).length, 2);
  assert.doesNotMatch(html, /正文已保存|重试|<button/);
  assert.equal(progress.status, 'done');
  assert.equal(progress.chapterId, 'original-5');
});

test('exact matching identity proves chapter is in manuscript', () => {
  assert.equal(completedChapterPresence(chapter(), [{ id: 'original-5' }]), 'present');
  assert.match(render(chapter(), [{ id: 'original-5' }]), /正文已保存 · 在当前书稿中/);
});

test('recreated chapter at the same number is not evidence of the original result', () => {
  const recreated = { id: 'replacement-5', number: 5 };
  assert.equal(completedChapterPresence(chapter(), [recreated]), 'absent');
  assert.doesNotMatch(render(chapter(), [recreated]), /正文已保存/);
});

test('missing evidence or historical chapter identity stays uncertain, never inferred from count', () => {
  assert.equal(completedChapterPresence(chapter()), 'unknown');
  assert.equal(completedChapterPresence(chapter({ chapterId: undefined }), []), 'unknown');
  assert.match(render(chapter()), /当前书稿状态未核实/);
  assert.match(render(chapter({ chapterId: undefined }), []), /当前书稿状态未核实/);
  assert.doesNotMatch(render(chapter()), /已从书稿删除|正文已保存/);
});

test('pending and failed chapters retain run status; absence does not create retry for completed results', () => {
  for (const status of ['pending', 'running', 'candidate', 'cancelled'] as const) {
    assert.equal(completedChapterPresence(chapter({ status }), []), 'not-completed');
    assert.doesNotMatch(render(chapter({ status }), []), /已从书稿删除|正文已保存|<button/);
  }
  assert.match(render(chapter({ status: 'error' }), []), /重试第 5 章/);
  assert.doesNotMatch(render(chapter({ validationStatus: 'failed' }), []), /<button/);
});

test('mixed history keeps active, failed, present and unknown records outside the closed absent group', () => {
  const records = [
    chapter({ number: 1, chapterId: 'removed-1' }),
    chapter({ number: 2, chapterId: 'present-2' }),
    chapter({ number: 3, chapterId: undefined }),
    chapter({ number: 4, status: 'running' }),
    chapter({ number: 5, status: 'error', error: 'failed-five' }),
    chapter({ number: 6, chapterId: 'removed-6' }),
    chapter({ number: 7, status: 'pending' }),
    chapter({ number: 8, status: 'candidate' }),
    chapter({ number: 9, status: 'cancelled' }),
    chapter({ number: 10, status: 'running', validationStatus: 'failed' }),
  ];
  const html = renderRecords(records, [{ id: 'present-2' }]);
  const [visible, collapsed] = html.split('<details><summary>');
  assert.ok(collapsed, 'removed group must use a closed native disclosure');
  for (const number of [2, 3, 4, 5, 7, 8, 9, 10]) {
    assert.match(visible, new RegExp(`第 ${number} 章 ·`));
    assert.doesNotMatch(collapsed, new RegExp(`第 ${number} 章 ·`));
  }
  for (const number of [1, 6]) {
    assert.doesNotMatch(visible, new RegExp(`第 ${number} 章 ·`));
    assert.match(collapsed, new RegExp(`第 ${number} 章 ·`));
  }
  assert.match(collapsed, /历史（2 章，默认收起）/);
  assert.match(visible, /当前书稿状态未核实/);
  assert.match(visible, /重试第 5 章/);
  assert.equal((html.match(/<li>/g) ?? []).length, records.length);
  const running = renderRecords(records, [{ id: 'present-2' }], 'zh-CN', { status: 'running' });
  assert.match(running, /<button[^>]*disabled=""[^>]*>重试第 5 章<\/button>/);
});

test('unknown evidence and missing historical identity never create a deleted-history disclosure', () => {
  for (const html of [
    render(chapter()),
    render(chapter({ chapterId: undefined }), []),
    render(chapter(), [{ id: 'original-5' }]),
  ]) {
    assert.equal((html.match(/<details/g) ?? []).length, 1);
    assert.doesNotMatch(html, /默认收起/);
    assert.match(html, /<details open=""><summary>/);
  }
});

test('English presentation has no fixed Chinese UI in all statuses and evidence branches', () => {
  for (const status of ['pending', 'running', 'done', 'candidate', 'error', 'cancelled'] as const) {
    for (const evidence of [undefined, [], [{ id: 'original-5' }]]) {
      assert.doesNotMatch(render(chapter({ status }), evidence, 'en'), /[\u3400-\u9fff]/);
    }
  }
  assert.match(render(chapter(), [], 'en'), /Removed \/ not in the current manuscript/);
  assert.match(render(chapter({ error: '原始错误', issues: ['原始问题'] }), [], 'en'), /原始错误/);
  const empty = renderToStaticMarkup(createElement(GenerationProgressView, { locale: 'en' }));
  assert.match(empty, /No per-chapter run records/);
  assert.doesNotMatch(empty, /[\u3400-\u9fff]/);
});
