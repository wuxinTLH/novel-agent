import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countChapterWords, literalIssues, prepareRun, resolveRequirements } from './generation.js';
import { parseReviewResult } from './review.js';
import { retrievePassages } from './context.js';
import { prepareResume, runSnapshotFingerprint, targetOriginals } from './recovery.js';
import { createProject } from '../projects/defaults.js';
import type { Chapter } from '../../../../../shared/types.js';
import { buildContext, type RuntimeSettings } from './engine.js';

const settings: RuntimeSettings = { mode: 'demo', baseUrl: '', model: '', apiKey: '', hasKey: false };
const chapter = (number: number, content: string): Chapter => ({ id: `c${number}`, number, revision: 1, title: `第${number}章`, content, mode: 'demo', updatedAt: '2026-01-01' });

test('hard length uses Unicode letters and digits, not UTF-16, punctuation or emoji', () => {
  assert.equal(countChapterWords('中𠀀文 A9，。😀 \n#'), 5);
  const requirements = { instructions: '', requiredText: [], forbiddenText: [], wordCount: { min: 6, max: 7 } };
  assert.match(literalIssues('中文ABC', requirements)[0], /实际 5 字/);
  assert.equal(literalIssues('中文ABCD', requirements).length, 0);
  assert.match(literalIssues('中文ABCDEFG', requirements)[0], /字数超限/);
  const p = createProject('cross scope');
  p.requirements = { ...requirements, wordCount: { min: 20 } };
  p.chapterRequirements = { '1': { ...requirements, wordCount: { max: 10 } } };
  assert.throws(() => resolveRequirements(p, 1), /最少字数大于最多字数/);
});

test('review rejects explicit failure, contradictions and malformed verdicts', () => {
  assert.equal(parseReviewResult('{"status":"passed","issues":[]}').status, 'passed');
  assert.equal(parseReviewResult('{"status":"passed","issues":[{"message":"人物矛盾"}]}').status, 'failed');
  assert.equal(parseReviewResult('审校不通过，但文笔很好').status, 'failed');
  assert.equal(parseReviewResult('{"status":"failed","issues":"bad"}').status, 'failed');
  assert.equal(parseReviewResult('总体很好').status, 'unknown');
  assert.equal(parseReviewResult('{"status":"passed","issues":[{}]}').status, 'unknown');
});

test('automatic audits cannot reuse a verdict from previous prose', () => {
  const p = createProject('audit reuse');
  p.workflow!.automationMode = 'automatic';
  const audit = p.steps.find((step) => step.id === p.workflow!.auditNodeId)!;
  audit.reusePreviousOutput = true;
  audit.output = '{"status":"passed","issues":[]}';
  assert.throws(() => prepareRun(p), /必须重新审校/);
});

test('retrieval searches older actual passages and honors budget', () => {
  const passages = retrievePassages([chapter(1, '普通日常。'.repeat(300) + '赤霄剑藏在古井之中。'), chapter(2, '无关内容。'.repeat(400))], '寻找赤霄剑和古井', 1100);
  assert.equal(passages[0].chapterNumber, 1);
  assert.match(passages[0].text, /赤霄剑/);
  assert.ok(passages[0].offset > 0);
  assert.ok(passages.reduce((sum, item) => sum + item.text.length, 0) <= 1100);
});

test('structured knowledge context includes prior and global facts while excluding future references', () => {
  const p = createProject('knowledge context');
  p.chapters = [chapter(1, '第一章'), chapter(3, '未来')];
  p.knowledgeFacts = [
    { id: 'global', type: 'fact', title: 'GLOBAL_FACT', content: '所有时间有效', tags: ['设定'], chapterIds: [], revision: 1, createdAt: '', updatedAt: '' },
    { id: 'past', type: 'character', title: 'PAST_FACT', content: '旧身份', tags: [], chapterIds: ['c1'], revision: 1, createdAt: '', updatedAt: '' },
    { id: 'future', type: 'foreshadow', title: 'FUTURE_SECRET', content: '未来秘密', tags: [], chapterIds: ['c3'], revision: 1, createdAt: '', updatedAt: '' },
  ];
  const context = buildContext(p, 'draft', { runId: 'r', workflowId: p.activeWorkflowId!, number: 2, mode: 'create', graphRevision: 0, requirements: resolveRequirements(p, 2) });
  assert.match(context, /GLOBAL_FACT/);
  assert.match(context, /PAST_FACT/);
  assert.doesNotMatch(context, /FUTURE_SECRET/);
});

test('resume skips saved progress and rejects configuration or target snapshot changes', () => {
  const p = createProject('resume');
  const fingerprint = runSnapshotFingerprint(p, settings, [1, 2]);
  p.run = { id: 'old-run', status: 'error', mode: 'demo', startedAt: 'now', workflowId: p.activeWorkflowId, request: { target: { kind: 'range', from: 1, to: 2 } }, targets: [1, 2], chapters: [1, 2].map((number) => ({ number, status: number === 1 ? 'done' : 'error', validationStatus: 'pending', reviewStatus: 'pending', requirements: resolveRequirements(p, number), issues: [] })), resumeSnapshot: { workflowId: p.activeWorkflowId!, graphRevision: 0, fingerprint, targetOriginals: targetOriginals(p, [1, 2]) } };
  p.chapters.push(chapter(1, 'saved prose'));
  assert.deepEqual(prepareResume(p, settings, 'old-run', fingerprint).plan.targets.map((target) => target.number), [2]);
  p.chapters.push(chapter(2, 'do not overwrite'));
  assert.throws(() => prepareResume(p, settings, 'old-run', fingerprint), /快照已变化|已保存/);
  p.chapters.pop();
  p.description += 'changed';
  assert.throws(() => prepareResume(p, settings, 'old-run', fingerprint), /拒绝恢复旧快照/);
});
