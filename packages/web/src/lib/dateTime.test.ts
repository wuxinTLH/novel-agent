import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCalendarDate, formatDateTime } from './dateTime';

test('timestamps display fixed eight-hour offset, minute precision, no zone suffix', () => {
  assert.equal(formatDateTime('2026-11-07T05:03:04.206Z'), '2026:11:07 13:03');
  assert.equal(formatDateTime('2026-01-01T20:30:59Z'), '2026:01:02 04:30');
  assert.equal(formatDateTime('2025-12-31T23:59:00Z'), '2026:01:01 07:59');
  assert.equal(formatDateTime('2024-02-29T18:00:00Z'), '2024:03:01 02:00');
  assert.equal(formatDateTime('2026-11-07T13:03:04+08:00'), '2026:11:07 13:03');
});

test('numeric epochs and Date inputs are immutable and host-timezone independent', () => {
  const date = new Date('2026-03-08T07:30:00Z');
  const time = date.getTime();
  assert.equal(formatDateTime(date), '2026:03:08 15:30');
  assert.equal(formatDateTime(time), '2026:03:08 15:30');
  assert.equal(date.getTime(), time);
  assert.equal(formatDateTime(0), '1970:01:01 08:00');
});

test('missing or invalid timestamps have a safe non-date fallback', () => {
  for (const value of [undefined, null, '', 'invalid', NaN, new Date(NaN)]) assert.equal(formatDateTime(value), '—');
});

test('day bucket labels preserve their actual statistical calendar day', () => {
  assert.equal(formatCalendarDate('2026-11-07'), '2026:11:07');
  assert.equal(formatCalendarDate('invalid'), '—');
});
