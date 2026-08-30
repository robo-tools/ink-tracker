import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChaseStatementPages, pdfTextItemsToLines } from '../packages/chase-core/lib/statements.js';
import { mergeStatementCoverage } from '../packages/chase-core/app/chase-statements.js';

const account = { id: 'hyatt-1234', name: 'World of Hyatt Credit Card (…1234)', last4: '1234' };

function samplePages(purchaseSummary = '$1,250.00') {
  return [[
    'Account Number: 0000 0000 0000 1234',
    'Statement Date: 01/09/26',
    'Opening/Closing Date 12/10/25 - 01/09/26',
    `Purchases +${purchaseSummary}`,
    'Payments, Credits -$1,250.00',
    'PURCHASES',
    '12/30 12/31 OFFICE STORE 1,200.00',
    '01/05 01/06 ATT BILL PAYMENT 50.00',
    'PAYMENTS AND OTHER CREDITS',
    '01/07 01/07 PAYMENT THANK YOU-MOBILE -1,250.00'
  ]];
}

test('PDF text items are grouped into visual lines and left-to-right order', () => {
  const lines = pdfTextItemsToLines([
    { str: 'STORE', transform: [1, 0, 0, 1, 80, 700] },
    { str: '12/31', transform: [1, 0, 0, 1, 10, 700.4] },
    { str: '$10.00', transform: [1, 0, 0, 1, 180, 700] },
    { str: 'Second line', transform: [1, 0, 0, 1, 10, 680] }
  ]);
  assert.deepEqual(lines, ['12/31 STORE $10.00', 'Second line']);
});

test('statement parser reconciles purchases and resolves year rollover', () => {
  const result = parseChaseStatementPages(samplePages(), account);
  assert.equal(result.openingDate, '2025-12-10');
  assert.equal(result.closingDate, '2026-01-09');
  assert.equal(result.purchaseTotalCents, 125_000);
  assert.equal(result.parsedPurchaseCents, 125_000);
  assert.equal(result.parsedCreditCents, -125_000);
  assert.deepEqual(result.transactions.map((item) => item.date), ['2025-12-31', '2026-01-06', '2026-01-07']);
});

test('statement parser accepts Chase amounts below one dollar without a leading zero', () => {
  const pages = samplePages('$1,250.01').map((page) => page.flatMap((line) => (
    line === '01/05 01/06 ATT BILL PAYMENT 50.00'
      ? [line, '01/06 01/06 TINY PURCHASE .01']
      : [line]
  )));
  const result = parseChaseStatementPages(pages, account);
  assert.equal(result.parsedPurchaseCents, 125_001);
});

test('statement parser rejects the entire statement when Chase totals do not reconcile', () => {
  assert.throws(() => parseChaseStatementPages(samplePages('$1,249.99'), account), /reconciliation failed/);
});

test('statement parser requires the account ending inside the PDF', () => {
  const pages = samplePages().map((page) => page.filter((line) => !line.startsWith('Account Number:')));
  assert.throws(() => parseChaseStatementPages(pages, account), /recognizable Chase account ending/);
});

test('statement parser requires a date inside the PDF instead of trusting its filename', () => {
  const pages = samplePages().map((page) => page.filter((line) => (
    !line.startsWith('Statement Date:') && !line.startsWith('Opening\/Closing Date')
  )));
  assert.throws(() => parseChaseStatementPages(pages, account, '20240131'), /recognizable Chase statement date/);
});

test('statement parser rejects a different card with structured mismatch details', () => {
  const pages = samplePages().map((page) => page.map((line) => line.replace('0000 0000 0000 1234', '0000 0000 0000 9876')));
  assert.throws(() => parseChaseStatementPages(pages, account), (error) => {
    assert.equal(error.code, 'statement-card-ending-mismatch');
    assert.equal(error.statementLast4, '9876');
    assert.equal(error.selectedLast4, '1234');
    return true;
  });
});

test('confirmed prior ending remains audited while transactions use the current card', () => {
  const pages = samplePages().map((page) => page.map((line) => line.replace('0000 0000 0000 1234', '0000 0000 0000 9876')));
  const result = parseChaseStatementPages(pages, { ...account, statementLast4Aliases: ['9876'] });
  assert.equal(result.statementAccountLast4, '9876');
  assert.ok(result.transactions.every((transaction) => transaction.accountId === account.id));
  assert.ok(result.transactions.every((transaction) => transaction.last4 === account.last4));
});

test('confirming a prior ending never bypasses purchase reconciliation', () => {
  const pages = samplePages('$1,249.99').map((page) => page.map((line) => (
    line.replace('0000 0000 0000 1234', '0000 0000 0000 9876')
  )));
  assert.throws(() => parseChaseStatementPages(pages, {
    ...account,
    statementLast4Aliases: ['9876']
  }), /reconciliation failed/);
});

test('statement parser rejects missing payment rows when Chase provides a credit total', () => {
  const pages = samplePages().map((page) => page.filter((line) => !line.includes('PAYMENT THANK YOU')));
  assert.throws(() => parseChaseStatementPages(pages, account), /payment\/credit reconciliation failed/);
});

test('statement coverage becomes complete only with a continuous bridge to recent activity', () => {
  const first = {
    parserVersion: 1,
    openingDate: '2024-01-01',
    closingDate: '2024-01-31',
    statementDate: '2024-01-31',
    statementAccountLast4: '9876',
    purchaseTotalCents: 100,
    transactionCount: 1
  };
  const second = {
    ...first,
    openingDate: '2024-02-01',
    closingDate: '2024-02-29',
    statementDate: '2024-02-29'
  };
  const complete = mergeStatementCoverage({}, [first, second], {
    benefitStartDate: '2024-01-15',
    activityEarliest: '2024-02-20'
  });
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.gaps, []);
  assert.equal(complete.periods[0].statementAccountLast4, '9876');
});

test('statement coverage rejects conflicting PDFs for the same closing date', () => {
  const existing = mergeStatementCoverage({}, [{
    parserVersion: 1,
    openingDate: '2024-01-01',
    closingDate: '2024-01-31',
    statementDate: '2024-01-31',
    statementAccountLast4: '1234',
    purchaseTotalCents: 100,
    transactionCount: 1
  }]);
  assert.throws(() => mergeStatementCoverage(existing, [{
    parserVersion: 1,
    openingDate: '2024-01-01',
    closingDate: '2024-01-31',
    statementDate: '2024-01-31',
    statementAccountLast4: '9876',
    purchaseTotalCents: 200,
    transactionCount: 1
  }]), /different statement is already saved/);
});
