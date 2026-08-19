import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHyattDetailRows, findHyattSetupTarget } from '../apps/hyatt/ui.js';

const metric = {
  account: { id: 'hyatt', last4: '1234' },
  periodTransactions: [
    { date: '2026-03-03', description: 'Purchase', spendCents: 10_000, kind: 'purchase', status: 'posted' },
    { date: '2026-03-02', description: 'Refund', spendCents: -5_000, kind: 'credit', status: 'posted' },
    { date: '2026-03-01', description: 'Payment Thank You', spendCents: 0, kind: 'payment', status: 'posted' }
  ]
};

test('Hyatt detail filters distinguish qualifying spend, refunds, and excluded activity', () => {
  assert.equal(buildHyattDetailRows([metric], { cardId: 'all', mode: 'eligible' }).length, 2);
  assert.deepEqual(buildHyattDetailRows([metric], { cardId: 'all', mode: 'refunds' })
    .map((row) => row.transaction.description), ['Refund']);
  assert.deepEqual(buildHyattDetailRows([metric], { cardId: 'all', mode: 'excluded' })
    .map((row) => row.transaction.description), ['Payment Thank You']);
});

test('a completed refresh leads directly to the first card needing user setup', () => {
  const readyPersonal = { account: { id: 'ready' }, rule: { type: 'personal' }, setupStatus: 'verified-full', yearHistoryVerified: true };
  const businessNeedsCoverage = { account: { id: 'business' }, rule: { type: 'business' }, setupStatus: 'calendar-year', yearHistoryVerified: false };
  const personalNeedsSetup = { account: { id: 'personal' }, rule: { type: 'personal' }, setupStatus: 'setup-needed', yearHistoryVerified: false };

  assert.equal(findHyattSetupTarget([readyPersonal, businessNeedsCoverage, personalNeedsSetup]), businessNeedsCoverage);
  assert.equal(findHyattSetupTarget([readyPersonal]), null);
});
