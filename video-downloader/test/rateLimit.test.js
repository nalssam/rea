import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDailyLimiter, createWindowLimiter, seoulDayKey } from '../src/rateLimit.js';

test('the day changes at Asia/Seoul midnight, not UTC midnight', () => {
  const beforeMidnight = Date.parse('2026-03-01T23:59:59+09:00');
  const afterMidnight = Date.parse('2026-03-02T00:00:00+09:00');
  assert.equal(seoulDayKey(afterMidnight) - seoulDayKey(beforeMidnight), 1);
  // 2026-03-01T15:00Z is exactly Seoul midnight; UTC midnight must not roll the day.
  assert.equal(seoulDayKey(Date.parse('2026-03-01T23:59:59Z')), seoulDayKey(Date.parse('2026-03-02T00:00:01Z')));
});

test('counts per IP, refuses past the limit, and resets on day rollover', () => {
  let t = Date.parse('2026-03-01T12:00:00+09:00');
  const limiter = createDailyLimiter({ limit: 2, now: () => t });
  assert.equal(limiter.tryConsume('1.1.1.1'), true);
  assert.equal(limiter.tryConsume('1.1.1.1'), true);
  assert.equal(limiter.tryConsume('1.1.1.1'), false);
  assert.equal(limiter.used('1.1.1.1'), 2, 'a refused attempt is not counted');
  assert.equal(limiter.tryConsume('2.2.2.2'), true, 'other IPs are independent');
  assert.equal(limiter.used('3.3.3.3'), 0);

  t = Date.parse('2026-03-01T23:59:59+09:00');
  assert.equal(limiter.tryConsume('1.1.1.1'), false);
  t = Date.parse('2026-03-02T00:00:00+09:00');
  assert.equal(limiter.used('1.1.1.1'), 0);
  assert.equal(limiter.tryConsume('1.1.1.1'), true);
});

test('window limiter resets after its window', () => {
  let t = 0;
  const limiter = createWindowLimiter({ limit: 1, windowMs: 1000, now: () => t });
  assert.equal(limiter.tryConsume('a'), true);
  assert.equal(limiter.tryConsume('a'), false);
  t = 1000;
  assert.equal(limiter.tryConsume('a'), true);
});
