import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLimiter } from './request-limiter.js';

test('rejected bursts keep constant state and quotas recover at expiry', () => {
  let time = 0;
  const limiter = createRequestLimiter({ limit: 2, windowMs: 2000, now: () => time });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);
  for (let i = 0; i < 100_000; i++) assert.equal(limiter.check('a').allowed, false);
  assert.equal(limiter.size, 1);
  assert.equal(limiter.check('a').retryAfter, 2);
  time = 1500;
  assert.equal(limiter.check('a').retryAfter, 1);
  time = 2000;
  assert.equal(limiter.check('a').allowed, true);
});

test('rotating identities cannot grow state or evict an active quota; idle clients expire', () => {
  let time = 0;
  const limiter = createRequestLimiter({ limit: 1, maxClients: 2, windowMs: 1000, now: () => time });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('b').allowed, true);
  for (let i = 0; i < 1000; i++) assert.equal(limiter.check(`other-${i}`).allowed, false);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.check('a').allowed, false);
  time = 1000;
  assert.equal(limiter.check('c').allowed, true);
  assert.equal(limiter.size, 1);
});
