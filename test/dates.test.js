import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnniversaryWindow, parseDateOnly } from '../src/lib/dates.js';

test('anniversary window spans the current cardmember year', () => {
  assert.deepEqual(getAnniversaryWindow('2026-01-15', 2, 10), {
    start: '2025-02-10',
    endExclusive: '2026-02-10',
    nextReset: '2026-02-10',
    daysRemaining: 26
  });
  assert.equal(getAnniversaryWindow('2026-08-19', 6, 3).start, '2026-06-03');
  assert.equal(getAnniversaryWindow('2026-08-19', 6, 3).nextReset, '2027-06-03');
});

test('Feb 29 anniversaries clamp safely in non-leap years', () => {
  const window = getAnniversaryWindow('2025-02-28', 2, 29);
  assert.equal(window.start, '2025-02-28');
  assert.equal(window.nextReset, '2026-02-28');
});

test('date-only parsing supports Chase and ISO formats', () => {
  assert.equal(parseDateOnly('8/19/2026').toISOString().slice(0, 10), '2026-08-19');
  assert.equal(parseDateOnly('08/19/26').toISOString().slice(0, 10), '2026-08-19');
  assert.equal(parseDateOnly('not a date'), null);
});
