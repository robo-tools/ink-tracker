import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateHyattCardMetrics, hyattTransactionQualifies } from '../apps/hyatt/calculations.js';

const personal = { id: 'personal', name: 'World of Hyatt (...1111)', last4: '1111', productId: 'hyatt-personal' };
const business = { id: 'business', name: 'World of Hyatt Business (...2222)', last4: '2222', productId: 'hyatt-business' };

function transaction(account, date, spendCents, overrides = {}) {
  return {
    id: `${account.id}-${date}-${spendCents}-${Math.random()}`,
    accountId: account.id,
    last4: account.last4,
    date,
    description: 'Purchase',
    amountCents: spendCents,
    spendCents,
    kind: spendCents < 0 ? 'credit' : 'purchase',
    status: 'posted',
    ...overrides
  };
}

test('personal full history uses lifetime spend modulo $5,000 and assigns crossings to the current year', () => {
  const metrics = calculateHyattCardMetrics(personal, [
    transaction(personal, '2025-12-20', 480_000),
    transaction(personal, '2026-01-05', 30_000),
    transaction(personal, '2026-05-01', 500_000)
  ], {
    historyMode: 'full', benefitStartDate: '2025-01-01', historyConfirmed: true
  }, { listEndVerified: true, earliest: '2025-12-20', rowCount: 3 }, '2026-08-19');

  assert.equal(metrics.lifetimeSpendCents, 1_010_000);
  assert.equal(metrics.progressCents, 10_000);
  assert.equal(metrics.spendNightsYtd, 4);
  assert.equal(metrics.cardNightsYtd, 9);
  assert.equal(metrics.setupStatus, 'verified-full');
});

test('personal baseline preserves rollover and tracks a later threshold exactly', () => {
  const metrics = calculateHyattCardMetrics(personal, [
    transaction(personal, '2026-08-02', 30_000)
  ], {
    historyMode: 'baseline',
    baselineDate: '2026-08-01',
    baselineProgressCents: 480_000,
    baselineHistoryConfirmed: true,
    yearHistoryConfirmed: 2026
  }, { listEndVerified: true, earliest: '2026-08-02', rowCount: 1 }, '2026-08-19');

  assert.equal(metrics.progressCents, 10_000);
  assert.equal(metrics.spendNightsYtd, 2);
  assert.equal(metrics.cardNightsYtd, 7);
  assert.equal(metrics.setupStatus, 'verified-baseline');
});

test('personal last-award initialization remains visibly estimated', () => {
  const metrics = calculateHyattCardMetrics(personal, [
    transaction(personal, '2026-06-01', 250_000),
    transaction(personal, '2026-07-01', 300_000)
  ], { historyMode: 'estimate', lastAwardDate: '2026-05-15' }, {}, '2026-08-19');

  assert.equal(metrics.progressCents, 50_000);
  assert.equal(metrics.spendNightsYtd, 2);
  assert.equal(metrics.setupStatus, 'estimated-award-date');
});

test('personal calendar-year spend separately tracks the $15,000 free-night threshold', () => {
  const metrics = calculateHyattCardMetrics(personal, [
    transaction(personal, '2025-12-31', 900_000),
    transaction(personal, '2026-01-02', 1_000_000),
    transaction(personal, '2026-03-02', 500_000)
  ], { historyMode: 'full', benefitStartDate: '2025-01-01', historyConfirmed: true }, {}, '2026-08-19');

  assert.equal(metrics.currentYearSpendCents, 1_500_000);
  assert.equal(metrics.annualFreeNightEarned, true);
});

test('business card earns five nights per calendar-year $10,000 and resets January 1', () => {
  const metrics = calculateHyattCardMetrics(business, [
    transaction(business, '2025-12-31', 900_000),
    transaction(business, '2026-01-02', 1_500_000),
    transaction(business, '2026-04-02', 700_000),
    transaction(business, '2026-05-02', -100_000)
  ], {}, { listEndVerified: true, earliest: '2026-01-02', rowCount: 4 }, '2026-08-19');

  assert.equal(metrics.currentYearSpendCents, 2_100_000);
  assert.equal(metrics.progressCents, 100_000);
  assert.equal(metrics.spendNightsYtd, 10);
  assert.equal(metrics.cardNightsYtd, 10);
  assert.equal(metrics.yearHistoryVerified, true);
});

test('current Hyatt Biz name repairs a stale personal product classification', () => {
  const renamedBusiness = {
    id: 'renamed-business',
    name: 'Hyatt Biz Visa (...3333)',
    last4: '3333',
    productId: 'hyatt-personal'
  };
  const metrics = calculateHyattCardMetrics(renamedBusiness, [
    transaction(renamedBusiness, '2026-02-01', 1_000_000)
  ], {
    productId: 'hyatt-personal',
    historyMode: 'full',
    benefitStartDate: '2025-01-01',
    historyConfirmed: true
  }, { activity: { complete: true, earliest: '2026-01-01' } }, new Date('2026-08-31T12:00:00Z'));

  assert.equal(metrics.rule.id, 'hyatt-business');
  assert.equal(metrics.cardNightsYtd, 5);
  assert.equal(metrics.baseNights, 0);
  assert.equal(metrics.annualFreeNightThresholdCents, null);
});

test('business coverage is automatic when captured activity reaches January 1', () => {
  const metrics = calculateHyattCardMetrics(business, [
    transaction(business, '2025-12-20', 10_000),
    transaction(business, '2026-03-02', 500_000)
  ], {}, { listEndVerified: false, earliest: '2025-12-20', rowCount: 2 }, '2026-08-19');

  assert.equal(metrics.yearHistoryVerified, true);
});

test('business coverage remains unverified for a partial import beginning after January 1', () => {
  const metrics = calculateHyattCardMetrics(business, [
    transaction(business, '2026-03-02', 500_000)
  ], {}, { listEndVerified: false, earliest: '2026-03-02', rowCount: 1 }, '2026-08-19');

  assert.equal(metrics.yearHistoryVerified, false);
});

test('payments, pending charges, fees, and cash-like transactions do not qualify', () => {
  assert.equal(hyattTransactionQualifies(transaction(personal, '2026-01-01', 10_000, { kind: 'payment' })), false);
  assert.equal(hyattTransactionQualifies(transaction(personal, '2026-01-01', 10_000, { status: 'pending' })), false);
  assert.equal(hyattTransactionQualifies(transaction(personal, '2026-01-01', 10_000, { description: 'Annual Fee' })), false);
  assert.equal(hyattTransactionQualifies(transaction(personal, '2026-01-01', 10_000, { description: 'Cash Advance' })), false);
  assert.equal(hyattTransactionQualifies(transaction(personal, '2026-01-01', 10_000)), true);
});
