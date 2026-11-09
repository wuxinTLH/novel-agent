import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ChapterAnalysisPanel, { analysisSelection, analysisSubmissionUnknown } from './ChapterAnalysisPanel';
import { ApiError } from '../../services/api';
import { chapterAnalysisEn, chapterAnalysisZhCN } from '../../locals/chapter-analysis';

const chapters = [1, 3, 8].map((number) => ({ number }));

test('range uses actual saved chapter count, requires existing endpoints and never edits inputs', () => {
  const original = structuredClone(chapters);
  assert.deepEqual(analysisSelection(chapters, 'range', '1', '8', ''), { count: 3, selection: { kind: 'range', from: 1, to: 8 } });
  assert.deepEqual(analysisSelection(chapters, 'range', '1', '7', ''), { count: 2, error: 'missing' });
  assert.deepEqual(analysisSelection(chapters, 'range', '2', '7', ''), { count: 1, error: 'missing' });
  assert.deepEqual(chapters, original);
});

test('recent mode refuses insufficient chapters rather than claiming N chapters were selected', () => {
  assert.deepEqual(analysisSelection(chapters, 'recent', '', '', '4'), { count: 3, error: 'missing' });
  assert.deepEqual(analysisSelection([], 'recent', '', '', '1'), { count: 0, error: 'missing' });
  assert.deepEqual(analysisSelection(chapters, 'recent', '', '', '2'), { count: 2, selection: { kind: 'recent', count: 2 } });
});

test('invalid, reversed and excessive scopes cannot be submitted', () => {
  for (const value of ['', '0', '-1', '1.5', '1e2', 'NaN', '101', '9007199254740992']) {
    assert.equal(analysisSelection(chapters, 'recent', '', '', value).error, 'invalid');
  }
  for (const [from, to] of [['3', '1'], ['0', '3'], ['1.2', '3'], ['1', '101']]) {
    assert.equal(analysisSelection(chapters, 'range', from, to, '').error, 'invalid');
  }
});

test('network and ambiguous server outcomes require GET reconciliation; explicit rejection permits correction', () => {
  for (const status of [0, 200, 500, 502, 524]) assert.equal(analysisSubmissionUnknown(new ApiError('unknown', status)), true);
  assert.equal(analysisSubmissionUnknown(new Error('connection interrupted')), true);
  for (const status of [400, 401, 403, 409, 422, 429]) assert.equal(analysisSubmissionUnknown(new ApiError('rejected', status)), false);
});

test('initial render is a passive accessible entry, without report/request or model invocation', () => {
  const html = renderToStaticMarkup(createElement(ChapterAnalysisPanel, { projectId: 'test', chapters: [], settings: { mode: 'demo', baseUrl: '', model: '', hasKey: false } }));
  assert.match(html, /<button type="button" class="button secondary">章节解析<\/button>/);
  assert.doesNotMatch(html, /<form|<pre|<dialog|解析中/);
});

test('new catalog has exact bilingual keys and interpolation parity', () => {
  assert.deepEqual(Object.keys(chapterAnalysisEn).sort(), Object.keys(chapterAnalysisZhCN).sort());
  for (const key of Object.keys(chapterAnalysisZhCN) as (keyof typeof chapterAnalysisZhCN)[]) {
    assert.ok(chapterAnalysisEn[key].trim());
    assert.deepEqual(chapterAnalysisEn[key].match(/\{\w+\}/g)?.sort(), chapterAnalysisZhCN[key].match(/\{\w+\}/g)?.sort());
  }
});

test('report rendering and request lifecycle keep strict safety boundaries', () => {
  const source = readFileSync(new URL('./ChapterAnalysisPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|sessionStorage|localStorage|method: 'PUT'|method: 'DELETE'/);
  assert.equal((source.match(/method: 'POST'/g) || []).length, 1);
  assert.match(source, /crypto.randomUUID\(\)/);
  assert.match(source, /controller.abort\(\)/);
  assert.match(source, /currentProject.current !== sentProject/);
  assert.match(source, /novel-auth-expired/);
  assert.match(source, /event.key === 'novel-auth-identity'/);
  assert.match(source, /<pre tabIndex=\{0\}>\{report.report/);
  assert.match(source, /formatDateTime\(report.createdAt\)/);
  assert.match(source, /revision/);
});
