import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHyattDetailRows, displayAccountName, findHyattSetupTarget, statementAliasConfirmationText, statementCoverageSummary } from '../apps/hyatt/ui.js';

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

  assert.equal(findHyattSetupTarget([readyPersonal, businessNeedsCoverage, personalNeedsSetup]), personalNeedsSetup);
  assert.equal(findHyattSetupTarget([businessNeedsCoverage]), null);
  assert.equal(findHyattSetupTarget([readyPersonal]), null);
});

test('Hyatt card names do not repeat an ASCII or Unicode masked ending', () => {
  assert.equal(displayAccountName('World of Hyatt Credit Card (...1111)'), 'World of Hyatt Credit Card');
  assert.equal(displayAccountName('World of Hyatt Credit Card (…1111)'), 'World of Hyatt Credit Card');
});

test('prior-card confirmation clearly identifies both endings', () => {
  assert.equal(statementAliasConfirmationText({ priorLast4: '9876', selectedLast4: '1234' }),
    'This statement is for card ending …9876, but the selected Hyatt card currently ends …1234. Did Chase replace or reissue this same card account?');
});

test('statement import guidance shows the exact bridge range and missing edges', () => {
  const empty = statementCoverageSummary({
    coverage: { activity: { earliest: '2025-06-20' }, statements: {} }
  }, '2023-01-05');
  assert.match(empty, /Needed statement range:<\/strong> Jan 2023 – Jun 2025/);
  assert.match(empty, /No older statements imported yet/);

  const partial = statementCoverageSummary({
    coverage: {
      activity: { earliest: '2025-06-20' },
      statements: {
        statementCount: 2,
        earliest: '2023-02-01',
        latest: '2025-05-31',
        gaps: [{ after: '2023-02-28', before: '2025-05-01' }]
      }
    }
  }, '2023-01-05');
  assert.match(partial, /beginning months missing/);
  assert.match(partial, /1 internal gap/);
  assert.match(partial, /ending months missing/);
});
