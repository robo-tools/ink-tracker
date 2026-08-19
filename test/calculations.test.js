import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRewardEnrichment, calculateAllCards, calculateCardMetrics, scoreRewardAccount } from '../src/lib/calculations.js';

const account = { id: 'cash-1', name: 'Ink Business Cash', last4: '1111', productId: 'ink-cash' };

function transaction(overrides) {
  return {
    id: Math.random().toString(),
    accountId: account.id,
    last4: account.last4,
    date: '2026-08-01',
    description: 'Test',
    amountCents: 0,
    spendCents: 0,
    kind: 'purchase',
    category: 'other',
    categorySource: 'reported',
    reportedMultiplier: null,
    reportedPoints: null,
    ...overrides
  };
}

test('calculates capped 5x spend, base points, and bonus points', () => {
  const metrics = calculateCardMetrics(account, [
    transaction({ spendCents: 100_000, category: 'office_supplies' }),
    transaction({ spendCents: 20_000, category: 'other' }),
    transaction({ spendCents: -10_000, category: 'office_supplies', kind: 'credit' }),
    transaction({ spendCents: 0, amountCents: -50_000, kind: 'payment' })
  ], { anniversaryMonth: 7, anniversaryDay: 1 }, '2026-08-19');

  assert.equal(metrics.qualifyingSpendCents, 90_000);
  assert.equal(metrics.totalSpendCents, 110_000);
  assert.equal(metrics.basePoints, 1_100);
  assert.equal(metrics.bonusPoints, 3_600);
  assert.equal(metrics.estimatedPoints, 4_700);
  assert.equal(metrics.remainingCents, 2_410_000);
  assert.equal(metrics.windowSource, 'anniversary');
});

test('stops bonus spend and bonus points at the $25,000 cap', () => {
  const metrics = calculateCardMetrics(account, [
    transaction({ spendCents: 3_000_000, category: 'office_supplies' })
  ], { anniversaryMonth: 1, anniversaryDay: 1 }, '2026-08-19');
  assert.equal(metrics.qualifyingSpendCents, 2_500_000);
  assert.equal(metrics.remainingCents, 0);
  assert.equal(metrics.usedPercent, 100);
  assert.equal(metrics.bonusPoints, 100_000);
  assert.equal(metrics.basePoints, 30_000);
});

test('a promotional 5x rate does not make an unrelated merchant eligible for the office cap', () => {
  const metrics = calculateCardMetrics(account, [
    transaction({ description: 'Lyft', spendCents: 12_500, category: 'travel', reportedMultiplier: 5 })
  ], {}, '2026-08-19');
  assert.equal(metrics.qualifyingSpendCents, 0);
  assert.equal(metrics.windowSource, 'calendar-fallback');
});

test('an authoritative 1x reward overrides merchant category inference', () => {
  const metrics = calculateCardMetrics(account, [
    transaction({ spendCents: 12_500, category: 'office_supplies', categorySource: 'merchant', reportedMultiplier: 1 })
  ], {}, '2026-08-19');
  assert.equal(metrics.qualifyingSpendCents, 0);
});

test('legacy zero multipliers fall back to the calculated card rate', async () => {
  const { estimateTransactionMultiplier } = await import('../src/lib/calculations.js');
  const metrics = calculateCardMetrics(account, [
    transaction({ spendCents: 12_500, category: 'office_supplies', reportedMultiplier: 0 })
  ], {}, '2026-08-19');
  assert.equal(estimateTransactionMultiplier(metrics.periodTransactions[0], metrics.rule), 5);
});

test('includes Ink Cash 2x gas/dining points without mixing them into the 5x cap', () => {
  const metrics = calculateCardMetrics(account, [
    transaction({ spendCents: 10_000, category: 'gas' }),
    transaction({ spendCents: 20_000, category: 'dining' })
  ], { anniversaryMonth: 1, anniversaryDay: 1 }, '2026-08-19');
  assert.equal(metrics.qualifyingSpendCents, 0);
  assert.equal(metrics.basePoints, 300);
  assert.equal(metrics.secondaryBonusPoints, 300);
  assert.equal(metrics.estimatedPoints, 600);
});

test('rewards activity enriches the matching transaction with actual rate and points', () => {
  const transactions = [transaction({
    date: '2026-03-21',
    description: 'OfficeMax',
    spendCents: 178_155,
    category: 'office_supplies',
    categorySource: 'merchant'
  })];
  const rewards = [{
    accountId: account.id,
    date: '2026-03-20',
    description: 'OFFICEMAX/DEPOT 6120',
    amountCents: 178_155,
    reportedMultiplier: 5,
    reportedPoints: 8_907.75
  }];
  assert.equal(scoreRewardAccount(transactions, rewards, account), 1);
  const result = applyRewardEnrichment(transactions, rewards, account);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.transactions[0].reportedMultiplier, 5);
  assert.equal(result.transactions[0].reportedPoints, 8_907.75);
  assert.equal(result.transactions[0].rewardMatched, true);
  assert.equal(result.transactions[0].categorySource, 'merchant');
});

test('same amount and nearby date do not match unrelated merchants', () => {
  const transactions = [transaction({
    date: '2026-08-01', description: 'LOCAL RESTAURANT', spendCents: 5_000
  })];
  const rewards = [{
    accountId: account.id, date: '2026-08-02', description: 'OFFICE DEPOT',
    amountCents: 5_000, reportedMultiplier: 5, reportedPoints: 250
  }];
  assert.equal(scoreRewardAccount(transactions, rewards, account), 0);
});

test('uses reported points only when every point-eligible period transaction is covered', () => {
  const covered = calculateCardMetrics(account, [
    transaction({ spendCents: 10_000, category: 'office_supplies', reportedPoints: 501 })
  ], {}, '2026-08-19');
  assert.equal(covered.displayPoints, 501);
  assert.equal(covered.pointsSource, 'rewards');

  const partial = calculateCardMetrics(account, [
    transaction({ spendCents: 10_000, category: 'office_supplies', reportedPoints: 501 }),
    transaction({ spendCents: 10_000, category: 'office_supplies' })
  ], {}, '2026-08-19');
  assert.equal(partial.displayPoints, 1_000);
  assert.equal(partial.pointsSource, 'estimated');
});

test('pending transactions are excluded from spend and point totals', () => {
  const metrics = calculateCardMetrics(account, [
    transaction({ spendCents: 10_000, category: 'office_supplies', status: 'pending' }),
    transaction({ spendCents: 20_000, category: 'office_supplies', status: 'posted' })
  ], {}, '2026-08-19');
  assert.equal(metrics.qualifyingSpendCents, 20_000);
  assert.equal(metrics.pendingTransactionCount, 1);
  assert.equal(metrics.transactionCount, 1);
});

test('matches multiple identical purchases to multiple identical rewards one-to-one', () => {
  const transactions = Array.from({ length: 3 }, () => transaction({
    date: '2026-03-20',
    description: 'OfficeMax',
    spendCents: 59_385,
    category: 'office_supplies'
  }));
  const rewards = Array.from({ length: 3 }, () => ({
    accountId: account.id,
    date: '2026-03-20',
    description: 'OFFICEMAX/DEPOT 6120',
    amountCents: 59_385,
    reportedMultiplier: 5,
    reportedPoints: 2_969.25
  }));
  const result = applyRewardEnrichment(transactions, rewards, account);
  assert.equal(result.matchedCount, 3);
  assert.equal(result.transactions.filter((item) => item.rewardMatched).length, 3);
});

test('summary confirmation counts are limited to the displayed anniversary period', () => {
  const transactions = [
    transaction({ id: 'current', date: '2026-07-10', description: 'OfficeMax', amountCents: 10_000, spendCents: 10_000 }),
    transaction({ id: 'prior', date: '2026-05-10', description: 'OfficeMax', amountCents: 20_000, spendCents: 20_000 })
  ];
  const rewardRecords = [
    { accountId: account.id, date: '2026-07-10', description: 'OFFICEMAX', amountCents: 10_000, reportedMultiplier: 5, reportedPoints: 500 },
    { accountId: account.id, date: '2026-05-10', description: 'OFFICEMAX', amountCents: 20_000, reportedMultiplier: 5, reportedPoints: 1_000 }
  ];
  const [metrics] = calculateAllCards({
    accounts: [account], transactions, rewardRecords,
    cardConfig: { [account.id]: { anniversaryMonth: 6, anniversaryDay: 1 } }
  }, '2026-08-19');
  assert.equal(metrics.rewardMatchedCount, 1);
  assert.equal(metrics.unmatchedRewardCount, 0);
  assert.equal(metrics.inferredCount, 0);
});

test('a verified empty anniversary period is labeled as no activity instead of estimated', () => {
  const [metrics] = calculateAllCards({
    accounts: [account], transactions: [], rewardRecords: [],
    cardConfig: { [account.id]: { anniversaryMonth: 6, anniversaryDay: 1 } },
    coverage: { [account.id]: { activity: { complete: true, rowCount: 0, earliest: null, latest: null } } }
  }, '2026-08-19');
  assert.equal(metrics.displayPoints, 0);
  assert.equal(metrics.pointsSource, 'no-activity');
});
