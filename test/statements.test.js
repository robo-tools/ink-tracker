import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChaseStatementPages, pdfTextItemsToLines } from '../packages/chase-core/lib/statements.js';
import {
  chaseStatementErrorMessage,
  extractStatementDocuments,
  elementIsVisible,
  isRetryableStatementFetchError,
  mergeStatementCoverage,
  selectedStatementYear,
  statementAccountButton,
  statementYearOptions
} from '../packages/chase-core/app/chase-statements.js';

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
  assert.equal(result.transactions[1].description, 'ATT BILL PAYMENT');
  assert.equal(result.transactions[1].kind, 'purchase');
  assert.equal(result.transactions[1].spendCents, 5_000);
  assert.equal(result.transactions[2].kind, 'payment');
  assert.equal(result.transactions[2].spendCents, 0);
});

test('statement parser accepts Chase amounts below one dollar without a leading zero', () => {
  const pages = samplePages('$1,250.01').map((page) => page.flatMap((line) => (
    line === '01/05 01/06 ATT BILL PAYMENT 50.00'
      ? [line, '01/06 01/06 TINY PURCHASE .01']
      : [line]
  )));
  const result = parseChaseStatementPages(pages, account);
  assert.equal(result.parsedPurchaseCents, 125_001);
  const tinyPurchase = result.transactions.find((item) => item.description === 'TINY PURCHASE');
  assert.equal(tinyPurchase?.spendCents, 1);
});

test('statement parser rejects the entire statement when Chase totals do not reconcile', () => {
  assert.throws(() => parseChaseStatementPages(samplePages('$1,249.99'), account), /reconciliation failed/);
});

test('statement parser rejects a PDF belonging to a different card', () => {
  const pages = samplePages().map((page) => page.map((line) => line.replace('0000 0000 0000 1234', '0000 0000 0000 9876')));
  assert.throws(() => parseChaseStatementPages(pages, account), /does not match the selected card ending/);
});

test('statement parser rejects missing payment or credit rows when Chase provides a summary total', () => {
  const pages = samplePages().map((page) => page.filter((line) => !line.includes('PAYMENT THANK YOU')));
  assert.throws(() => parseChaseStatementPages(pages, account), /payment\/credit reconciliation failed/);
});

test('statement discovery reads Chase styled-select years and its selected input value', () => {
  const options = [2026, 2025, 2024].map((year) => ({
    textContent: String(year),
    classList: { contains: () => false },
    getAttribute: () => null,
    querySelector: (selector) => selector === '.primary' ? { textContent: String(year) } : null
  }));
  const root = {
    querySelectorAll: () => options,
    querySelector: (selector) => selector === '#header-filterstyledselect-0' ? { value: '2025' } : null
  };
  assert.deepEqual(statementYearOptions(root).map((item) => item.year), [2026, 2025, 2024]);
  assert.equal(selectedStatementYear(root), 2025);
});

test('statement discovery expands and matches the target account by last four', () => {
  const buttons = [
    { textContent: 'FREEDOM UNLIMITED (...9740)' },
    { textContent: 'WORLD OF HYATT (...1234)' }
  ];
  assert.equal(statementAccountButton({ querySelectorAll: () => buttons }, '1234'), buttons[1]);
});

test('statement discovery derives the date from Chase table rows when the PDF link omits data-date', () => {
  const row = {
    textContent: 'Dec 15, 2022 Statement 4 pages',
    querySelector: () => ({ textContent: 'Dec 15, 2022' })
  };
  const anchor = {
    id: 'accountsTable-1-row0-cell3-requestThisDocumentAnchor-pdf',
    dataset: { documentid: 'statement-document-id', accountid: 'account-document-id' },
    textContent: 'Dec 15, 2022 Statement WORLD OF HYATT (...1234)',
    closest: () => row
  };
  const root = {
    querySelectorAll: () => [anchor],
    querySelector: (selector) => selector === '#button-documentsAccordion-1'
      ? { textContent: 'WORLD OF HYATT (...1234)' }
      : null
  };
  assert.deepEqual(extractStatementDocuments(root, '1234'), [{
    documentId: 'statement-document-id',
    statementDate: '20221215',
    last4: '1234',
    accountDocumentId: 'account-document-id',
    accountLabel: 'WORLD OF HYATT (...1234)'
  }]);
});

test('statement discovery ignores a loader mounted inside a hidden Chase container', () => {
  const hiddenParent = {
    hidden: false,
    classList: { contains: (name) => name === 'hide' },
    parentElement: null
  };
  const spinner = {
    hidden: false,
    classList: { contains: () => false },
    parentElement: hiddenParent
  };
  assert.equal(elementIsVisible(spinner), false);
});

test('statement discovery surfaces a visible Chase service error instead of treating it as no documents', () => {
  const dialog = {
    textContent: "It looks like our site isn't working right now. Please try again.",
    hidden: false,
    classList: { contains: () => false },
    parentElement: null
  };
  const root = { querySelectorAll: () => [dialog] };
  assert.match(chaseStatementErrorMessage(root), /site isn't working/i);
});

test('statement PDF retries are limited to transient failures', () => {
  assert.equal(isRetryableStatementFetchError({ status: 429, retryable: true, name: 'Error' }), true);
  assert.equal(isRetryableStatementFetchError({ status: 503, retryable: true, name: 'Error' }), true);
  assert.equal(isRetryableStatementFetchError({ name: 'NetworkError' }), true);
  assert.equal(isRetryableStatementFetchError({ status: 403, retryable: false, name: 'Error' }), false);
  assert.equal(isRetryableStatementFetchError({ name: 'AbortError' }), false);
});

test('statement coverage only becomes complete with continuous start-to-recent periods', () => {
  const first = {
    parserVersion: 1, openingDate: '2020-01-02', closingDate: '2020-02-01', statementDate: '2020-02-01',
    purchaseTotalCents: 10_000, transactionCount: 1
  };
  const second = {
    parserVersion: 1, openingDate: '2020-02-02', closingDate: '2020-03-01', statementDate: '2020-03-01',
    purchaseTotalCents: 20_000, transactionCount: 2
  };
  const incomplete = mergeStatementCoverage({}, [first], {
    benefitStartDate: '2020-01-10', activityEarliest: '2020-02-15'
  });
  assert.equal(incomplete.complete, false);

  const complete = mergeStatementCoverage(incomplete, [second], {
    benefitStartDate: '2020-01-10', activityEarliest: '2020-02-15'
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.statementCount, 2);
  assert.deepEqual(complete.gaps, []);
});
