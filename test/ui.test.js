import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDetailRows } from '../src/app/ui.js';
import { getProductRule } from '../src/lib/products.js';

const rule = getProductRule('ink-cash');
const metrics = [
  {
    account: { id: 'a', last4: '1111' }, rule,
    periodTransactions: [
      { date: '2026-08-03', description: 'Staples', kind: 'purchase', category: 'office_supplies', rewardMatched: true },
      { date: '2026-08-02', description: 'Restaurant', kind: 'purchase', category: 'dining', rewardMatched: false },
      { date: '2026-08-01', description: 'Payment', kind: 'payment', category: 'other', rewardMatched: false }
    ]
  },
  {
    account: { id: 'b', last4: '2222' }, rule,
    periodTransactions: [
      { date: '2026-08-04', description: 'Office Depot', kind: 'purchase', category: 'office_supplies', rewardMatched: true }
    ]
  }
];

test('detailed rows default to purchases and can filter by card', () => {
  assert.equal(buildDetailRows(metrics).length, 3);
  const rows = buildDetailRows(metrics, { cardId: 'a', mode: 'purchases' });
  assert.deepEqual(rows.map((row) => row.transaction.description), ['Staples', 'Restaurant']);
});

test('detailed rows filter bonus, unmatched, and payment activity', () => {
  assert.equal(buildDetailRows(metrics, { cardId: 'all', mode: 'bonus' }).length, 2);
  assert.deepEqual(buildDetailRows(metrics, { cardId: 'all', mode: 'unmatched' })
    .map((row) => row.transaction.description), ['Restaurant']);
  assert.deepEqual(buildDetailRows(metrics, { cardId: 'all', mode: 'payments' })
    .map((row) => row.transaction.description), ['Payment']);
});
