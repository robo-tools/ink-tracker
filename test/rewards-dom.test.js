import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRewardsActivity, parseRewardsListItemAttributes } from '../apps/ink/rewards-dom.js';

test('parses an authoritative Ultimate Rewards purchase row', () => {
  const reward = parseRewardsListItemAttributes({
    label: 'OFFICEMAX/DEPOT 6120',
    description: 'Mar 20, 2026&lt;br/&gt;5% earn',
    secondaryDescription: '$1,781.55',
    secondaryLabel: '8,907.75 pts'
  });
  assert.equal(reward.date, '2026-03-20');
  assert.equal(reward.amountCents, 178_155);
  assert.equal(reward.reportedMultiplier, 5);
  assert.equal(reward.reportedPoints, 8_907.75);
  assert.equal(reward.category, 'office_supplies');
});

test('ignores redemptions and adjustments without an earn rate', () => {
  assert.equal(parseRewardsListItemAttributes({
    label: 'Combine points',
    description: 'Apr 17, 2026&lt;br/&gt;',
    secondaryLabel: '-47,509 pts'
  }), null);
});

test('an explicitly complete rewards page may contain zero purchase rows', () => {
  const result = extractRewardsActivity({
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { innerText: "You've reached the end of your transaction details" }
  });
  assert.equal(result.reachedEnd, true);
  assert.deepEqual(result.rewardRecords, []);
});
