import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChaseActivityRow,
  normalizeChaseCsv,
  normalizeCategory,
  parseMoneyCents
} from '../src/lib/normalize.js';

const account = { id: '123', name: 'Ink Business Cash (…4321)', last4: '4321' };

test('money parser handles Chase display formats', () => {
  assert.equal(parseMoneyCents('$1,234.56'), 123456);
  assert.equal(parseMoneyCents('-$54.00'), -5400);
  assert.equal(parseMoneyCents('($12.34)'), -1234);
});

test('saved Chase activity row normalizes from data-values', () => {
  const transaction = normalizeChaseActivityRow('08/18/2026,"STAPLES #123",(...4321),,$19.25,', account);
  assert.equal(transaction.date, '2026-08-18');
  assert.equal(transaction.spendCents, 1925);
  assert.equal(transaction.category, 'office_supplies');
  assert.equal(transaction.categorySource, 'merchant');
  assert.equal(transaction.reportedMultiplier, null);
  assert.equal(transaction.reportedPoints, null);
});

test('activity-row parser preserves an unquoted comma in the description', () => {
  const transaction = normalizeChaseActivityRow('08/18/2026,STAPLES, NEW YORK,(...4321),,$19.25,', account);
  assert.equal(transaction.description, 'STAPLES, NEW YORK');
  assert.equal(transaction.spendCents, 1925);
});

test('activity-row parser reconstructs an unquoted thousands separator in the amount', () => {
  const transaction = normalizeChaseActivityRow('08/04/2026,GIFTCARDSCOM,(...4321),,$1,350.00,', account);
  assert.equal(transaction.amountCents, 135_000);
  assert.equal(transaction.spendCents, 135_000);
});

test('Chase CSV signs and reported categories are normalized', () => {
  const csv = [
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
    '08/17/2026,08/18/2026,OFFICE DEPOT,Office Supplies,Sale,-100.00,',
    '08/16/2026,08/17/2026,AUTOMATIC PAYMENT,Payment,Payment,500.00,',
    '08/15/2026,08/16/2026,OFFICE DEPOT,Office Supplies,Return,20.00,'
  ].join('\n');
  const transactions = normalizeChaseCsv(csv, account);
  assert.deepEqual(transactions.map((item) => item.spendCents), [10000, 0, -2000]);
  assert.equal(transactions[0].categorySource, 'reported');
});

test('merchant inference recognizes core Ink categories', () => {
  assert.equal(normalizeCategory('', 'COMCAST CABLE').category, 'internet');
  assert.equal(normalizeCategory('', 'FEDEX OFFICE').category, 'shipping');
});
