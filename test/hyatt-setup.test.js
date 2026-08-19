import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHyattSetup } from '../apps/hyatt/setup.js';

const personal = { name: 'World of Hyatt (...1111)', productId: 'hyatt-personal' };
const business = { name: 'World of Hyatt Business (...2222)', productId: 'hyatt-business' };

test('personal full-history setup requires an explicit completeness confirmation', () => {
  assert.throws(() => normalizeHyattSetup(personal, {
    historyMode: 'full',
    benefitStartDate: '2024-01-10'
  }), /Confirm that no qualifying purchases are missing/);

  assert.deepEqual(normalizeHyattSetup(personal, {
    historyMode: 'full',
    benefitStartDate: '2024-01-10',
    historyConfirmed: true
  }), {
    productId: 'hyatt-personal',
    benefitStartDate: '2024-01-10',
    historyMode: 'full',
    historyConfirmed: true
  });
});

test('personal baseline converts Chase-reported remaining spend to accumulated progress', () => {
  const config = normalizeHyattSetup(personal, {
    historyMode: 'baseline',
    benefitStartDate: '2024-01-10',
    baselineDate: '2026-08-01',
    baselineAmountType: 'remaining',
    baselineAmount: '1250',
    baselineHistoryConfirmed: true,
    yearHistoryConfirmed: true
  }, {}, '2026-08-19');

  assert.equal(config.baselineProgressCents, 375_000);
  assert.equal(config.yearHistoryConfirmed, 2026);
});

test('personal baseline requires complete activity after its effective date', () => {
  assert.throws(() => normalizeHyattSetup(personal, {
    historyMode: 'baseline',
    benefitStartDate: '2024-01-10',
    baselineDate: '2026-08-01',
    baselineAmountType: 'progress',
    baselineAmount: '750'
  }), /every posted transaction after the baseline date/);
});

test('personal award-date fallback validates dates and remains an estimate configuration', () => {
  assert.throws(() => normalizeHyattSetup(personal, {
    historyMode: 'estimate',
    benefitStartDate: '2025-01-01',
    lastAwardDate: '2024-12-31'
  }), /on or after the Hyatt benefit start date/);

  assert.deepEqual(normalizeHyattSetup(personal, {
    historyMode: 'estimate',
    benefitStartDate: '2025-01-01',
    lastAwardDate: '2026-05-15'
  }), {
    productId: 'hyatt-personal',
    benefitStartDate: '2025-01-01',
    historyMode: 'estimate',
    lastAwardDate: '2026-05-15'
  });
});

test('business setup records the year whose transaction history was confirmed', () => {
  assert.deepEqual(normalizeHyattSetup(business, {
    yearHistoryConfirmed: true
  }, { preserved: true }, '2026-08-19'), {
    preserved: true,
    productId: 'hyatt-business',
    yearHistoryConfirmed: 2026
  });
});
