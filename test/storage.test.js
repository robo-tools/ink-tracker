import test from 'node:test';
import assert from 'node:assert/strict';
import { commitFullSync, emptyState, mergeRewardRecords, mergeState, mergeSupplementalTransactions, mergeTransactions, reconcileTransactions, repairStateAccountMetadata } from '../src/app/storage.js';

test('account merges preserve a known last four when a later scan omits it', () => {
  const current = {
    ...emptyState(),
    accounts: [{ id: '123', name: 'Ink Business Cash (...4321)', last4: '4321' }]
  };
  const next = mergeState(current, {
    accounts: [{ id: '123', name: 'Ink Business Cash', last4: '' }]
  });
  assert.equal(next.accounts[0].last4, '4321');
});

test('stored accounts recover their last four from matching activity rows', () => {
  const repaired = repairStateAccountMetadata({
    ...emptyState(),
    accounts: [{ id: '123', name: 'Ink Business Cash', last4: '' }],
    transactions: [{ accountId: '123', last4: '4321', date: '2026-08-19' }]
  });
  assert.equal(repaired.accounts[0].last4, '4321');
});

test('verified coverage is repaired from all stored Chase rows after a passive slice overwrote it', () => {
  const repaired = repairStateAccountMetadata({
    ...emptyState(),
    accounts: [{ id: '123', name: 'Ink Business Cash', last4: '4321' }],
    transactions: [
      { accountId: '123', last4: '4321', date: '2024-10-01', source: 'chase-dom' },
      { accountId: '123', last4: '4321', date: '2026-08-04', source: 'chase-dom' }
    ],
    coverage: { '123': { activity: { complete: true, rowCount: 1, earliest: '2026-08-04', latest: '2026-08-04' } } }
  });
  assert.deepEqual(repaired.coverage['123'].activity, {
    complete: true, rowCount: 2, earliest: '2024-10-01', latest: '2026-08-04'
  });
});

test('transaction merging preserves real duplicates without multiplying repeated scans', () => {
  const transaction = {
    id: 'same-derived-id', accountId: '123', last4: '4321', date: '2026-03-20',
    description: 'OfficeMax', amountCents: 59_385, spendCents: 59_385, source: 'chase-dom'
  };
  const firstScan = mergeTransactions([], [transaction, transaction, transaction]);
  const secondScan = mergeTransactions(firstScan, [transaction, transaction, transaction]);
  assert.equal(firstScan.length, 3);
  assert.equal(secondScan.length, 3);
});

test('reward merging preserves identical same-day rewards without multiplying repeated scans', () => {
  const reward = {
    id: 'same-derived-id', accountId: '123', date: '2026-03-20', description: 'OFFICEMAX',
    amountCents: 59_385, reportedPoints: 2_969.25
  };
  const firstScan = mergeRewardRecords([], [reward, reward, reward]);
  const secondScan = mergeRewardRecords(firstScan, [reward, reward, reward]);
  assert.equal(firstScan.length, 3);
  assert.equal(secondScan.length, 3);
});

test('cross-source merchant and posting-date variants reconcile to one transaction', () => {
  const dom = {
    id: 'dom', accountId: '123', last4: '4321', date: '2026-03-20',
    description: 'OfficeMax', amountCents: 178_155, spendCents: 178_155,
    kind: 'purchase', source: 'chase-dom'
  };
  const network = {
    id: 'network', accountId: '123', last4: '4321', date: '2026-03-21',
    description: 'OFFICEMAX/DEPOT 6686', amountCents: 178_155, spendCents: 178_155,
    kind: 'purchase', category: 'office_supplies', categorySource: 'reported', source: 'network'
  };
  const merged = mergeTransactions([dom], [network]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.sort(), ['chase-dom', 'network']);
  assert.equal(merged[0].categorySource, 'reported');
});

test('same-amount unrelated merchants remain separate transactions', () => {
  const base = {
    accountId: '123', last4: '4321', date: '2026-03-20', amountCents: 5_000,
    spendCents: 5_000, kind: 'purchase', source: 'chase-dom'
  };
  const merged = mergeTransactions(
    [{ ...base, id: 'one', description: 'LOCAL RESTAURANT' }],
    [{ ...base, id: 'two', description: 'OFFICE DEPOT', source: 'network' }]
  );
  assert.equal(merged.length, 2);
});

test('stored legacy cross-source duplicates are reconciled during migration', () => {
  const base = {
    accountId: '123', last4: '4321', amountCents: 178_155, spendCents: 178_155,
    kind: 'purchase'
  };
  const reconciled = reconcileTransactions([
    { ...base, id: 'dom', date: '2026-03-20', description: 'OfficeMax', source: 'chase-dom' },
    { ...base, id: 'network', date: '2026-03-21', description: 'OFFICEMAX/DEPOT 6686', source: 'network' }
  ]);
  assert.equal(reconciled.length, 1);
});

test('supplemental network capture enriches known rows but cannot invent extra spend', () => {
  const base = {
    accountId: '123', last4: '4321', date: '2026-03-20', amountCents: 5_000,
    spendCents: 5_000, kind: 'purchase'
  };
  const merged = mergeSupplementalTransactions(
    [{ ...base, id: 'dom', description: 'OFFICE DEPOT', source: 'chase-dom' }],
    [
      { ...base, id: 'match', description: 'OFFICE DEPOT 123', category: 'office_supplies', categorySource: 'reported', source: 'network' },
      { ...base, id: 'extra', description: 'LOCAL RESTAURANT', source: 'network' }
    ]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].categorySource, 'reported');
});

test('a completed refresh replaces stale DOM rows while retaining imported history', () => {
  const current = {
    ...emptyState(),
    accounts: [{ id: '123', name: 'Ink Business Cash', last4: '4321' }],
    transactions: [
      { id: 'bad', accountId: '123', date: '2026-03-20', description: 'OfficeMax', amountCents: 78_155, spendCents: 78_155, source: 'chase-dom' },
      { id: 'csv', accountId: '123', date: '2024-01-01', description: 'Older purchase', amountCents: 100, spendCents: 100, source: 'chase-csv' }
    ]
  };
  const next = commitFullSync(current, {
    accounts: current.accounts,
    transactions: [{ id: 'good', accountId: '123', date: '2026-03-20', description: 'OfficeMax', amountCents: 178_155, spendCents: 178_155, source: 'chase-dom' }],
    rewardRecords: []
  });
  assert.deepEqual(next.transactions.map((item) => item.id).sort(), ['csv', 'good']);
});
