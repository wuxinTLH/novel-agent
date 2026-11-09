import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterContinuityAnchor } from './context.js';
import { buildContext } from './engine.js';
import { resolveRequirements } from './generation.js';
import { createProject } from '../projects/defaults.js';
import type { Chapter } from '../../../../../shared/types.js';

const chapter = (number: number, content: string, revision = 1): Chapter => ({
  id: `canonical-${number}`, number, revision, title: `chapter ${number}`, content,
  mode: 'live', updatedAt: '2026-01-01T00:00:00Z',
});

test('anchor uses latest canonical revision and nearest prior number, not array position or future prose', () => {
  const chapters = [chapter(6, 'RECENT_REVISED_END', 4), chapter(8, 'FUTURE_SECRET'), chapter(2, 'OLDER_SECRET')];
  const before = structuredClone(chapters);
  const anchor = chapterContinuityAnchor(chapters, 7);
  assert.match(anchor, /RECENT_REVISED_END/);
  assert.match(anchor, /修订 4/);
  assert.match(anchor, /直接前章/);
  assert.doesNotMatch(anchor, /FUTURE_SECRET|OLDER_SECRET/);
  assert.deepEqual(chapters, before);
});

test('bounded anchor preserves oversized chapter ending without splitting Unicode characters', () => {
  const anchor = chapterContinuityAnchor([chapter(6, 'OMITTED_PREFIX' + '𠀀'.repeat(6500) + 'LATEST_END')], 7);
  assert.match(anchor, /LATEST_END/);
  assert.doesNotMatch(anchor, /OMITTED_PREFIX/);
  const body = anchor.split('<前章结尾原文>\n')[1].split('\n</前章结尾原文>')[0];
  assert.ok(Array.from(body).length < 6100);
  assert.ok(Array.from(body).every(point => !/^[\uD800-\uDFFF]$/u.test(point)), 'no unpaired UTF-16 surrogate');
});

test('missing or empty prior manuscript is explicit, including noncontiguous numbering', () => {
  assert.match(chapterContinuityAnchor([], 1), /没有.*已保存正文/);
  assert.match(chapterContinuityAnchor([chapter(4, 'OLDER_END')], 7), /直接前章缺失/);
  assert.match(chapterContinuityAnchor([chapter(6, '')], 7), /正文为空/);
});

test('plan writer and audit retain separate continuity anchor under saturated ordinary context budgets', () => {
  const p = createProject('continuity');
  p.chapters = [chapter(5, 'OLD'.repeat(10000)), chapter(6, '前文'.repeat(20000) + 'CAR_SEATED_RECOVERING_END'), chapter(8, 'FUTURE_SECRET')];
  const before = structuredClone(p);
  const generation = { runId: 'run', workflowId: p.activeWorkflowId!, number: 7, mode: 'create' as const,
    graphRevision: p.workflow?.graphRevision || 0, outputWriterNodeId: 'draft', requirements: resolveRequirements(p, 7) };
  for (const id of ['plan', 'draft', p.workflow!.auditNodeId!]) {
    const prompt = buildContext(p, id, generation);
    const anchor = prompt.split('<前章衔接锚点>\n')[1].split('\n</前章衔接锚点>')[0];
    assert.match(anchor, /CAR_SEATED_RECOVERING_END/);
    assert.doesNotMatch(anchor, /FUTURE_SECRET/);
    assert.match(prompt, /前章结束状态 → 本章开场状态 → 所需过渡/);
    assert.match(prompt, /引用两侧证据/);
    assert.match(prompt, /必须 failed/);
  }
  assert.deepEqual(p, before);
});

test('regeneration derives anchor from preceding manuscript, not the target original or future', () => {
  const p = createProject('regenerate');
  p.chapters = [chapter(6, 'PREVIOUS_END'), chapter(7, 'TARGET_ORIGINAL'), chapter(8, 'FUTURE_SECRET')];
  const prompt = buildContext(p, 'draft', { runId: 'r', workflowId: p.activeWorkflowId!, number: 7,
    chapterId: 'canonical-7', mode: 'regenerate', graphRevision: 0, requirements: resolveRequirements(p, 7) });
  const anchor = prompt.split('<前章衔接锚点>\n')[1].split('\n</前章衔接锚点>')[0];
  assert.match(anchor, /PREVIOUS_END/);
  assert.doesNotMatch(anchor, /TARGET_ORIGINAL|FUTURE_SECRET/);
  assert.match(prompt, /<本章原稿>\nTARGET_ORIGINAL/);
});
