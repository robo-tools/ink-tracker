import { dateIsInWindow, getAnniversaryWindow, getCalendarYearWindow } from './dates.js';
import { getProductRule } from './products.js';
import { belongsToAccount, dateDistanceDays, isPending, merchantSimilarity } from './matching.js';

export function transactionQualifies(transaction, rule) {
  if (!transaction || isPending(transaction) || transaction.kind === 'payment' || transaction.kind === 'non_purchase') return false;
  if (rule.qualifyingCategories.includes('all')) return true;
  if (!rule.qualifyingCategories.includes(transaction.category)) return false;
  if (Number.isFinite(transaction.reportedMultiplier) && transaction.reportedMultiplier > 0) {
    return transaction.reportedMultiplier >= rule.bonusMultiplier;
  }
  return true;
}

export function estimateTransactionMultiplier(transaction, rule) {
  if (Number.isFinite(transaction.reportedMultiplier) && transaction.reportedMultiplier > 0) return transaction.reportedMultiplier;
  if (rule.largePurchaseThresholdCents && transaction.spendCents >= rule.largePurchaseThresholdCents) {
    return rule.largePurchaseMultiplier;
  }
  if (transactionQualifies(transaction, rule)) return rule.bonusMultiplier;
  const secondary = rule.secondaryTiers?.find((tier) => tier.categories.includes(transaction.category));
  return secondary?.multiplier ?? rule.baseMultiplier;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

export function rewardMatchesForAccount(transactions, rewardRecords, account) {
  const available = transactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => belongsToAccount(transaction, account)
      && !isPending(transaction)
      && !['payment', 'non_purchase'].includes(transaction.kind));
  const pairs = [];
  for (let rewardIndex = 0; rewardIndex < rewardRecords.length; rewardIndex += 1) {
    const reward = rewardRecords[rewardIndex];
    for (const candidate of available) {
      if (Math.abs(candidate.transaction.spendCents) !== Math.abs(reward.amountCents)) continue;
      if (Number(reward.reportedPoints) < 0 && candidate.transaction.spendCents >= 0) continue;
      if (Number(reward.reportedPoints) > 0 && candidate.transaction.spendCents < 0) continue;
      const days = dateDistanceDays(candidate.transaction.date, reward.date);
      if (days > 7) continue;
      const similarity = merchantSimilarity(candidate.transaction.description, reward.description);
      if (similarity < 0.45) continue;
      pairs.push({
        ...candidate,
        reward,
        rewardIndex,
        similarity,
        score: similarity * 100 - days * 4 + (days === 0 ? 5 : 0)
      });
    }
  }
  pairs.sort((left, right) => right.score - left.score);
  const usedTransactions = new Set();
  const usedRewards = new Set();
  const matches = [];
  for (const pair of pairs) {
    if (usedTransactions.has(pair.index) || usedRewards.has(pair.rewardIndex)) continue;
    usedTransactions.add(pair.index);
    usedRewards.add(pair.rewardIndex);
    matches.push(pair);
  }
  return matches;
}

export function scoreRewardAccount(transactions, rewardRecords, account) {
  return rewardMatchesForAccount(transactions, rewardRecords, account).length;
}

export function applyRewardEnrichment(transactions, rewardRecords, account) {
  const relevantRewards = rewardRecords.filter((reward) => !reward.accountId || String(reward.accountId) === String(account.id));
  const enriched = transactions.map((transaction) => ({ ...transaction }));
  const matches = rewardMatchesForAccount(enriched, relevantRewards, account);
  for (const match of matches) {
    const transaction = enriched[match.index];
    transaction.reportedMultiplier = match.reward.reportedMultiplier;
    transaction.reportedPoints = match.reward.reportedPoints;
    transaction.rewardMatched = true;
  }
  return { transactions: enriched, matchedCount: matches.length, rewardCount: relevantRewards.length };
}

export function calculateCardMetrics(account, transactions, config = {}, asOf = new Date()) {
  const rule = getProductRule(config.productId ?? account.productId, account.name);
  if (!rule) return null;
  const anniversary = getAnniversaryWindow(asOf, config.anniversaryMonth, config.anniversaryDay);
  const window = anniversary ?? getCalendarYearWindow(asOf);
  const allPeriodTransactions = transactions.filter((transaction) =>
    belongsToAccount(transaction, account) && dateIsInWindow(transaction.date, window)
  );
  const pendingTransactionCount = allPeriodTransactions.filter(isPending).length;
  const periodTransactions = allPeriodTransactions.filter((transaction) => !isPending(transaction));
  const purchaseTransactions = periodTransactions.filter((transaction) => !['payment', 'non_purchase'].includes(transaction.kind));
  const qualifyingTransactions = purchaseTransactions.filter((transaction) => transactionQualifies(transaction, rule));
  const totalSpendCents = Math.max(0, sum(purchaseTransactions.map((transaction) => transaction.spendCents)));
  const rawQualifyingSpendCents = Math.max(0, sum(qualifyingTransactions.map((transaction) => transaction.spendCents)));
  const capCents = rule.annualCapCents;
  const qualifyingSpendCents = capCents === null
    ? rawQualifyingSpendCents
    : Math.min(rawQualifyingSpendCents, capCents);
  const remainingCents = capCents === null ? null : Math.max(0, capCents - qualifyingSpendCents);
  const basePoints = Math.round((totalSpendCents / 100) * rule.baseMultiplier);
  const bonusPoints = Math.round((qualifyingSpendCents / 100) * Math.max(0, rule.bonusMultiplier - rule.baseMultiplier));
  const secondaryBonusPoints = sum((rule.secondaryTiers ?? []).map((tier) => {
    const tierSpend = Math.max(0, sum(purchaseTransactions
      .filter((transaction) => tier.categories.includes(transaction.category))
      .map((transaction) => transaction.spendCents)));
    const cappedTierSpend = Math.min(tierSpend, tier.annualCapCents ?? tierSpend);
    return Math.round((cappedTierSpend / 100) * (tier.multiplier - rule.baseMultiplier));
  }));
  const largePurchaseBonusPoints = rule.largePurchaseThresholdCents
    ? Math.round(sum(purchaseTransactions
      .filter((transaction) => transaction.spendCents >= rule.largePurchaseThresholdCents)
      .map((transaction) => (transaction.spendCents / 100) * (rule.largePurchaseMultiplier - rule.baseMultiplier))))
    : 0;
  const capturedPointsValues = purchaseTransactions
    .map((transaction) => transaction.reportedPoints)
    .filter((value) => Number.isFinite(value));
  const inferredCount = qualifyingTransactions.filter((transaction) => transaction.categorySource === 'merchant' && !transaction.rewardMatched).length;
  const estimatedPoints = basePoints + bonusPoints + secondaryBonusPoints + largePurchaseBonusPoints;
  const exactPointCoverage = purchaseTransactions.length > 0 && capturedPointsValues.length === purchaseTransactions.length;
  const capturedPoints = capturedPointsValues.length ? Math.round(sum(capturedPointsValues)) : null;

  return {
    account,
    rule,
    window,
    windowSource: anniversary ? 'anniversary' : 'calendar-fallback',
    qualifyingSpendCents,
    uncappedQualifyingSpendCents: rawQualifyingSpendCents,
    capCents,
    remainingCents,
    usedPercent: capCents ? Math.min(100, (qualifyingSpendCents / capCents) * 100) : null,
    totalSpendCents,
    basePoints,
    bonusPoints,
    secondaryBonusPoints,
    largePurchaseBonusPoints,
    estimatedPoints,
    capturedPoints,
    displayPoints: exactPointCoverage ? capturedPoints : estimatedPoints,
    pointsSource: exactPointCoverage ? 'rewards' : 'estimated',
    pointCoverageCount: capturedPointsValues.length,
    pointTransactionCount: purchaseTransactions.length,
    transactionCount: periodTransactions.length,
    pendingTransactionCount,
    qualifyingTransactionCount: qualifyingTransactions.length,
    inferredCount,
    periodTransactions
  };
}

export function calculateAllCards(state, asOf = new Date()) {
  return state.accounts
    .map((account) => {
      const enrichment = applyRewardEnrichment(state.transactions, state.rewardRecords ?? [], account);
      const metrics = calculateCardMetrics(account, enrichment.transactions, state.cardConfig?.[account.id] ?? {}, asOf);
      if (!metrics) return null;
      const periodRewardCount = (state.rewardRecords ?? []).filter((reward) =>
        (!reward.accountId || String(reward.accountId) === String(account.id))
        && dateIsInWindow(reward.date, metrics.window)
      ).length;
      const periodMatchedCount = metrics.periodTransactions.filter((transaction) => transaction.rewardMatched).length;
      const coverage = state.coverage?.[account.id] ?? {};
      const activity = coverage.activity;
      const activityCoversWindow = Boolean(activity?.complete
        && (activity.rowCount === 0 || (activity.earliest && activity.earliest <= metrics.window.start)));
      return {
        ...metrics,
        coverage,
        activityCoversWindow,
        pointsSource: metrics.pointTransactionCount === 0 && activityCoversWindow ? 'no-activity' : metrics.pointsSource,
        rewardMatchedCount: periodMatchedCount,
        unmatchedRewardCount: Math.max(0, periodRewardCount - periodMatchedCount)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.account.name.localeCompare(right.account.name) || left.account.last4.localeCompare(right.account.last4));
}
