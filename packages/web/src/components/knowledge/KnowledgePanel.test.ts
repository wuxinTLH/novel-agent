import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import KnowledgePanel, { isKnowledgeDraftDirty, type KnowledgeDraft } from './KnowledgePanel.js';
import type { KnowledgeFact } from '../../../../../shared/knowledge.js';

const blank: KnowledgeDraft = { title: '', content: '', kind: 'fact', tags: '', chapterIds: [] };
const fact = {
  id: 'f1',
  type: 'character',
  title: '人物',
  content: '设定',
  tags: ['主角', '能力'],
  chapterIds: ['c1', 'c2'],
  revision: 1,
} as KnowledgeFact;
const existing: KnowledgeDraft = {
  title: fact.title,
  content: fact.content,
  kind: fact.type,
  tags: fact.tags.join('，'),
  chapterIds: [...fact.chapterIds],
};

test('empty editor and unchanged existing facts are clean, including reordered chapter selection', () => {
  assert.equal(isKnowledgeDraftDirty(blank, null), false);
  assert.equal(isKnowledgeDraftDirty(existing, fact), false);
  assert.equal(isKnowledgeDraftDirty({ ...existing, chapterIds: ['c2', 'c1'] }, fact), false);
});

test('every editable field protects an unsaved draft, even before required fields are complete', () => {
  for (const change of [
    { title: '草稿' },
    { content: '内容' },
    { kind: 'character' as const },
    { tags: '标签' },
    { chapterIds: ['c1'] },
  ])
    assert.equal(isKnowledgeDraftDirty({ ...blank, ...change }, null), true);
  for (const change of [
    { title: '' },
    { content: '' },
    { kind: 'fact' as const },
    { tags: '' },
    { chapterIds: [] },
    { chapterIds: ['c1', 'c3'] },
  ])
    assert.equal(isKnowledgeDraftDirty({ ...existing, ...change }, fact), true);
});

test('knowledge secondary page renders without browser globals or importing SCSS', () => {
  const html = renderToStaticMarkup(createElement(KnowledgePanel, { projectId: 'p1' }));
  assert.ok(html.includes('aria-label="知识事实管理"'));
  assert.ok(html.includes('aria-label="新建事实"'));
  assert.ok(html.includes('aria-label="搜索事实"'));
  assert.ok(html.includes('保存事实'));
});
