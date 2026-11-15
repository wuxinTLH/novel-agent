import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogTime, logger, readLogTimeZone, installOperationalLogSink, emitBoundaryEvent } from './logger.js';

test('operational sink receives only explicit codes, never runtime text, and failure does not replay business work', context => {
  context.mock.method(console, 'error', () => {});
  const events: string[] = [];
  const remove = installOperationalLogSink(code => { events.push(code); });
  try {
    logger.error('private token and project text must not be forwarded');
    logger.error('another private detail', 'HTTP_INTERNAL_ERROR');
    assert.deepEqual(events, ['HTTP_INTERNAL_ERROR']);
    emitBoundaryEvent('ORIGIN_REJECTED');
    emitBoundaryEvent('ORIGIN_REJECTED');
    assert.equal(events.filter(code => code === 'ORIGIN_REJECTED').length, 1);
  } finally { remove(); }
  const failing = installOperationalLogSink(() => { throw new Error('disk failure'); });
  try { assert.doesNotThrow(() => logger.error('safe', 'HTTP_INTERNAL_ERROR')); }
  finally { failing(); }
});
test('logs default to UTC+8 minute format without timezone suffix', () => {
  assert.equal(readLogTimeZone({}), 'Asia/Shanghai');
  assert.equal(formatLogTime(new Date('2026-11-07T05:03:04Z'), readLogTimeZone({})), '2026:11:07 13:03');
  assert.equal(formatLogTime(new Date('2025-12-31T20:00:00Z'), 'Asia/Shanghai'), '2026:01:01 04:00');
});
test('configuration supports UTC and DST-aware IANA zones without changing process TZ', () => {
  const before = process.env.TZ;
  assert.equal(readLogTimeZone({ LOG_TIME_ZONE: ' UTC ' }), 'UTC');
  assert.equal(formatLogTime(new Date('2026-11-07T05:03:04Z'), 'UTC'), '2026:11:07 05:03');
  assert.equal(formatLogTime(new Date('2026-07-01T12:00:00Z'), 'America/New_York'), '2026:07:01 08:00');
  assert.equal(formatLogTime(new Date('2026-01-01T12:00:00Z'), 'America/New_York'), '2026:01:01 07:00');
  assert.equal(process.env.TZ, before);
  assert.throws(() => readLogTimeZone({ LOG_TIME_ZONE: 'invalid-secret-value' }), /^Error: LOG_TIME_ZONE_INVALID$/);
});
test('runtime logger prefixes each severity without globally patching console', (context) => {
  const original = process.env.LOG_TIME_ZONE;
  process.env.LOG_TIME_ZONE = 'UTC';
  try {
    for (const [method, output, level] of [['info', 'log', 'INFO'], ['warn', 'warn', 'WARN'], ['error', 'error', 'ERROR']] as const) {
      const spy = context.mock.method(console, output, () => {});
      logger[method]('safe message');
      assert.match(spy.mock.calls[0].arguments[0], new RegExp(`^\\[\\d{4}:\\d{2}:\\d{2} \\d{2}:\\d{2}\\] \\[${level}\\] safe message$`));
      spy.mock.restore();
    }
  } finally {
    if (original === undefined) delete process.env.LOG_TIME_ZONE;
    else process.env.LOG_TIME_ZONE = original;
  }
});
