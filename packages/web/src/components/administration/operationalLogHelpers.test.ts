import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultLogAlertConfig, updateLogAlertConfigSchema } from '../../../../../shared/operational-logs';
import { alertConfigBody, emptyLogFilters, operationalLogsQuery, validLogFilters } from './operationalLogHelpers';
import { operationalLogsEn, operationalLogsZhCN } from '../../locals/operational-logs';
import { formatDateTime } from '../../lib/dateTime';

test('bounded queries encode search and UTC+8 calendar days', () => {
  const url = new URL(operationalLogsQuery({ ...emptyLogFilters, from: '2024-02-29', to: '2024-02-29', level: 'warning', category: 'high-risk', search: '&secret=<>' }, 50), 'http://localhost');
  assert.equal(url.pathname, '/admin/logs');
  assert.equal(url.searchParams.get('from'), '2024-02-28T16:00:00.000Z');
  assert.equal(url.searchParams.get('to'), '2024-02-29T15:59:59.999Z');
  assert.equal(url.searchParams.get('search'), '&secret=<>');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(url.searchParams.get('level'), 'warning');
  assert.equal(url.searchParams.get('category'), 'high-risk');
  assert.equal(new URL(operationalLogsQuery(emptyLogFilters), 'http://localhost').searchParams.size, 2);
  assert.equal(formatDateTime('2024-02-28T16:01:00.000Z'), '2024:02:29 00:01');
});
test('calendar, search and page validation rejects invalid input', () => {
  for (const patch of [{ from: '2026-02-29' }, { to: '2026-04-31' }, { from: '2026-01-02', to: '2026-01-01' }, { search: 'a'.repeat(101) }, { search: 'line'+String.fromCharCode(10) }]) {
    assert.equal(validLogFilters({ ...emptyLogFilters, ...patch }), false);
    assert.throws(() => operationalLogsQuery({ ...emptyLogFilters, ...patch }));
  }
  for (const offset of [-1, 0.5, 10001, Infinity]) assert.throws(() => operationalLogsQuery(emptyLogFilters, offset));
});
test('alert CAS payload excludes revision and shares backend validation', () => {
  const config = { ...defaultLogAlertConfig(), revision: 7 };
  const body = alertConfigBody(config);
  assert.equal(body.expectedRevision, 7);
  assert.equal('revision' in body, false);
  assert.equal(config.revision, 7);
  assert.equal(updateLogAlertConfigSchema.safeParse(body).success, true);
  for (const patch of [{ cooldownSeconds: 0 }, { cooldownSeconds: 86401 }, { categories: [] }]) assert.equal(updateLogAlertConfigSchema.safeParse({ ...body, ...patch }).success, false);
});
test('panel retains cancellation, identity, permissions and unsaved edit boundaries', () => {
  const panel = readFileSync(new URL('./OperationalLogsPanel.tsx', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('./Administration.tsx', import.meta.url), 'utf8');
  for (const fragment of ['return () => controller.abort()', 'request.signal.aborted', 'novel-auth-expired', 'setData(undefined)', 'reason.status === 409', 'onDirty(dirty)', 'gate.current', 'await confirm(', '预留，未接入', '不代表通知已发送']) assert.ok(panel.includes(fragment), fragment);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|dangerouslySetInnerHTML/);
  for (const fragment of ["logs: 'logs.read'", "logsOpened && allowed('logs.read')", "writable={allowed('alerts.manage')}", 'appearanceDirty || logsDirty']) assert.ok(admin.includes(fragment), fragment);
});
test('log styles override inherited checkbox sizing and contain table intrinsic width', () => {
  const styles = readFileSync(new URL('./operational-logs.scss', import.meta.url), 'utf8');
  assert.ok(styles.includes('.administration .operational-logs-panel'));
  assert.ok(styles.includes('grid-template-columns: minmax(0, 1fr)'));
  assert.ok(styles.includes('input[type=checkbox] { flex: 0 0 16px; width: 16px;'));
  assert.ok(styles.includes('min-width: 16px; max-width: 16px; height: 16px;'));
  assert.ok(styles.includes('white-space: nowrap'));
  assert.ok(styles.includes('.operational-log-table { max-width: 100%; overflow: auto;'));
});
test('operational locale catalogs have exact parity and non-Han English', () => {
  assert.deepEqual(Object.keys(operationalLogsEn).sort(), Object.keys(operationalLogsZhCN).sort());
  for (const value of Object.values(operationalLogsEn)) assert.doesNotMatch(value, /[\u4e00-\u9fff]/);
});
