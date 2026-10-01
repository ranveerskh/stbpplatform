const test = require('node:test');
const assert = require('node:assert/strict');
const { addCalendarMonths } = require('../functions/expiry');

test('monthly validity clamps at the target month end and preserves UTC time', () => {
  const start = Date.parse('2026-01-31T10:15:30.500Z');
  assert.equal(new Date(addCalendarMonths(start, 1)).toISOString(), '2026-02-28T10:15:30.500Z');
});

test('yearly validity handles leap day by clamping to February end', () => {
  const start = Date.parse('2024-02-29T23:59:00.000Z');
  assert.equal(new Date(addCalendarMonths(start, 12)).toISOString(), '2025-02-28T23:59:00.000Z');
});

test('validity months must be within the supported range', () => {
  assert.throws(() => addCalendarMonths(Date.now(), 0), RangeError);
  assert.throws(() => addCalendarMonths(Date.now(), 121), RangeError);
});
