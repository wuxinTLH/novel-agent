import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultTokenUsageRange, inclusiveUtcDays, modelChartData, positiveChartData, tokenUsageQuery, utcDay, validTokenUsageRange } from './tokenUsageHelpers';
import { tokenUsageEn, tokenUsageZhCN } from '../../locals/token-usage';

test('UTC date ranges enforce 1–31 inclusive days, including leap years and calendar validity', () => {
  assert.equal(inclusiveUtcDays('2026-01-01', '2026-01-31'), 31);
  assert.equal(validTokenUsageRange('2026-01-01', '2026-01-01'), true);
  assert.equal(validTokenUsageRange('2026-01-01', '2026-02-01'), false);
  assert.equal(validTokenUsageRange('2026-01-02', '2026-01-01'), false);
  assert.equal(validTokenUsageRange('2026-02-29', '2026-03-01'), false);
  assert.equal(inclusiveUtcDays('2024-02-29', '2024-03-01'), 2);
  for (const invalid of ['', '2026-2-01', '2026-13-01', '2026-04-31', '2026-01-01T00:00:00Z']) assert.equal(utcDay(invalid), undefined);
  assert.equal(inclusiveUtcDays('2026-03-07', '2026-03-10'), 4, 'DST must not affect UTC calendar day count');
});

test('default range uses UTC today, not browser timezone, and spans seven days', () => {
  assert.deepEqual(defaultTokenUsageRange(new Date('2026-01-01T00:05:00Z')), { from: '2025-12-26', to: '2026-01-01' });
  assert.deepEqual(defaultTokenUsageRange(new Date('2026-07-02T01:00:00+09:00')), { from: '2026-06-25', to: '2026-07-01' });
});

test('request query preserves exact model and safely encodes query metacharacters', () => {
  const query = tokenUsageQuery('2026-01-01', '2026-01-31', 'model & admin?中文/<>');
  const parsed = new URL(query, 'http://localhost');
  assert.equal(parsed.searchParams.get('model'), 'model & admin?中文/<>');
  assert.equal(parsed.pathname, '/admin/token-usage');
  assert.equal(parsed.searchParams.size, 3);
  assert.equal(new URL(tokenUsageQuery('2026-01-01', '2026-01-01', ''), 'http://localhost').searchParams.has('model'), false);
  assert.throws(() => tokenUsageQuery('2026-01-01', '2026-02-01', ''), RangeError);
});

test('chart data drops unsafe geometry values and groups without losing totals or mutating source', () => {
  assert.deepEqual(positiveChartData([{ label: 'zero', value: 0 }, { label: 'negative', value: -1 }, { label: 'infinite', value: Infinity }, { label: 'nan', value: NaN }, { label: 'good', value: 12 }]), [{ label: 'good', value: 12 }]);
  const input = Array.from({ length: 10 }, (_, index) => ({ label: `model-${index}`, value: index + 1 }));
  const before = structuredClone(input);
  const output = modelChartData(input, 'Other');
  assert.equal(output.length, 8);
  assert.deepEqual(output.at(-1), { label: 'Other', value: 6 });
  assert.equal(output.reduce((sum, row) => sum + row.value, 0), 55);
  assert.deepEqual(input, before);
});

test('token usage dictionaries have exact locale parity', () => {
  assert.deepEqual(Object.keys(tokenUsageZhCN).sort(), Object.keys(tokenUsageEn).sort());
  for (const value of Object.values(tokenUsageEn)) assert.ok(value.length > 0);
});

test('panel keeps Three.js lazy and cancellation/table fallback explicit', async () => {
  const panel = await readFile(new URL('./TokenUsagePanel.tsx', import.meta.url), 'utf8');
  const charts = await readFile(new URL('./TokenUsageCharts.tsx', import.meta.url), 'utf8');
  assert.match(panel, /lazy\(\(\) => import\('\.\/TokenUsageCharts'\)\)/);
  assert.doesNotMatch(panel, /from ['"]three['"]|localStorage/);
  assert.match(panel, /return \(\) => controller\.abort\(\)/);
  assert.match(panel, /controller\.signal\.aborted/);
  assert.match(panel, /<caption>/);
  assert.match(panel, /scope="col"/);
  assert.match(panel, /scope="row"/);
  for (const cleanup of ['cancelAnimationFrame(frame)', 'observer?.disconnect()', 'object.geometry.dispose()', 'material.dispose()', 'renderer.dispose()', 'renderer.forceContextLoss()']) assert.ok(charts.includes(cleanup), cleanup);
  assert.match(charts, /webglcontextlost/);
  assert.match(charts, /token-usage-chart-fallback/);
});
