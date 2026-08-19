import { readFile } from 'node:fs/promises';
import { normalizeChaseActivityRow } from '../packages/chase-core/lib/normalize.js';
import { parseRewardsListItemAttributes } from '../apps/ink/rewards-dom.js';
import { applyRewardEnrichment, calculateCardMetrics } from '../apps/ink/calculations.js';
import { mergeRewardRecords, mergeTransactions } from '../packages/chase-core/app/storage.js';

const [activityPath, rewardsPath, last4 = '0000'] = process.argv.slice(2);
if (!activityPath || !rewardsPath) {
  throw new Error('Usage: node scripts/analyze-saved-matches.mjs <activity.html> <rewards.html> <last4>');
}

function decode(value) {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)]
    .map((match) => [match[1], decode(match[2])]));
}

function dayDistance(left, right) {
  return Math.abs(new Date(`${left}T00:00:00Z`) - new Date(`${right}T00:00:00Z`)) / 86_400_000;
}

const account = { id: 'debug', name: `Ink Business Cash (...${last4})`, last4 };
const activityHtml = await readFile(activityPath, 'utf8');
const rewardsHtml = await readFile(rewardsPath, 'utf8');
const transactions = [...activityHtml.matchAll(/data-values="([^"]*)"/g)]
  .map((match) => normalizeChaseActivityRow(decode(match[1]), account))
  .filter(Boolean);
const rewardAttributeRows = [...rewardsHtml.matchAll(/<transaction-details-item\b[\s\S]*?<mds-list-item\b([^>]*)>/gi)]
  .map((match) => attributes(match[1]));
const rewardRecords = rewardAttributeRows
  .map((row) => parseRewardsListItemAttributes(row))
  .filter(Boolean);
const transactionGroups = [...transactions.reduce((groups, transaction) => {
  const key = [transaction.date, transaction.description, transaction.spendCents].join('|');
  const current = groups.get(key) ?? { date: transaction.date, transaction: transaction.description, amount: (transaction.spendCents / 100).toFixed(2), count: 0 };
  current.count += 1;
  groups.set(key, current);
  return groups;
}, new Map()).values()].filter((group) => group.count > 1);

const report = rewardRecords.map((reward) => {
  const exactAmount = transactions
    .filter((transaction) => Math.abs(transaction.spendCents) === Math.abs(reward.amountCents))
    .map((transaction) => ({
      days: dayDistance(transaction.date, reward.date),
      date: transaction.date,
      transaction: transaction.description
    }))
    .sort((left, right) => left.days - right.days);
  return {
    rewardDate: reward.date,
    amount: (reward.amountCents / 100).toFixed(2),
    reward: reward.description,
    closestDays: exactAmount[0]?.days ?? null,
    closestDate: exactAmount[0]?.date ?? '',
    transaction: exactAmount[0]?.transaction ?? '',
    candidatesWithin7: exactAmount.filter((candidate) => candidate.days <= 7).length
  };
});
const storedTransactions = mergeTransactions([], transactions);
const storedRewards = mergeRewardRecords([], rewardRecords.map((reward) => ({ ...reward, accountId: account.id, last4 })));
const enrichment = applyRewardEnrichment(storedTransactions, storedRewards, account);
const metrics = calculateCardMetrics(account, enrichment.transactions, { anniversaryMonth: 2, anniversaryDay: 1 }, '2026-08-19');

console.log(JSON.stringify({
  transactionCount: transactions.length,
  rewardCount: rewardRecords.length,
  activityRange: {
    earliest: transactions.map((item) => item.date).sort()[0] ?? null,
    latest: transactions.map((item) => item.date).sort().at(-1) ?? null
  },
  rewardsRange: {
    earliest: rewardRecords.map((item) => item.date).sort()[0] ?? null,
    latest: rewardRecords.map((item) => item.date).sort().at(-1) ?? null
  },
  storedTransactionCount: storedTransactions.length,
  storedRewardCount: storedRewards.length,
  actualMatchedCount: enrichment.matchedCount,
  activityReachedEnd: /reached the end of your account activity/i.test(activityHtml),
  rewardsReachedEnd: /reached the end of your transaction details/i.test(rewardsHtml),
  februaryAnniversaryMetrics: {
    transactionCount: metrics.transactionCount,
    qualifyingTransactionCount: metrics.qualifyingTransactionCount,
    qualifyingSpend: (metrics.qualifyingSpendCents / 100).toFixed(2),
    estimatedPoints: metrics.estimatedPoints,
    capturedPoints: metrics.capturedPoints,
    displayPoints: metrics.displayPoints,
    pointsSource: metrics.pointsSource,
    pointsCoverage: `${metrics.pointCoverageCount}/${metrics.pointTransactionCount}`
  },
  duplicateTransactionGroups: transactionGroups,
  rawRewardSample: rewardAttributeRows.slice(0, 5).map((row) => ({
    label: row.label,
    description: row.description,
    secondaryLabel: row['secondary-label'],
    secondaryDescription: row['secondary-description']
  })),
  rewardsWithCandidateWithin7Days: report.filter((row) => row.candidatesWithin7 > 0).length,
  rewardsWithoutCandidateWithin7Days: report.filter((row) => row.candidatesWithin7 === 0)
}, null, 2));
console.table(report);
console.table(transactions
  .filter((transaction) => transaction.date >= '2026-01-01')
  .map((transaction) => ({ date: transaction.date, amount: (transaction.spendCents / 100).toFixed(2), transaction: transaction.description })));
