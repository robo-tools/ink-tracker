import { dateIsInWindow, formatDateOnly, getCalendarYearWindow, parseDateOnly } from '../../packages/chase-core/lib/dates.js';
import { belongsToAccount, isPending } from '../../packages/chase-core/lib/matching.js';
import { getHyattProductRule } from './products.js';

const EXCLUDED_PURCHASE = /\b(?:annual\s+fee|cash\s+advance|balance\s+transfer|money\s+order|wire\s+transfer|foreign\s+currency|traveler'?s?\s+check|lottery|casino|gaming\s+chip|race\s*track|wager|betting|person[- ]to[- ]person|account\s+funding|cryptocurrency)\b/i;

function sumCents(transactions) {
  return transactions.reduce((total, transaction) => total + (Number(transaction.spendCents) || 0), 0);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function throughDate(transaction, asOfDate) {
  return Boolean(transaction.date && transaction.date <= asOfDate);
}

export function hyattTransactionQualifies(transaction) {
  if (!transaction || isPending(transaction)) return false;
  if (['payment', 'non_purchase'].includes(transaction.kind)) return false;
  if (EXCLUDED_PURCHASE.test(transaction.description ?? '')) return false;
  return Number.isFinite(transaction.spendCents) && transaction.spendCents !== 0;
}

function coverageFor(state, account) {
  const activity = state.coverage?.[account.id]?.activity ?? null;
  const ownTransactions = (state.transactions ?? []).filter((transaction) => belongsToAccount(transaction, account));
  const dates = ownTransactions.map((transaction) => transaction.date).filter(Boolean).sort();
  return {
    activity,
    listEndVerified: Boolean(activity?.complete),
    earliest: activity?.earliest ?? dates[0] ?? null,
    latest: activity?.latest ?? dates.at(-1) ?? null,
    rowCount: activity?.rowCount ?? ownTransactions.length
  };
}

function calendarHistoryVerified(config, coverage, year, benefitStartDate = '') {
  const yearStart = `${year}-01-01`;
  if (benefitStartDate && benefitStartDate >= yearStart) return Boolean(config.historyConfirmed);
  if (Number(config.yearHistoryConfirmed) === year) return true;
  if (!coverage.listEndVerified) return false;
  if (coverage.rowCount === 0 || (coverage.earliest && coverage.earliest <= yearStart)) return true;
  return false;
}

function setupStatus(rule, config) {
  if (rule.type === 'business') return 'calendar-year';
  if (config.historyMode === 'full' && config.benefitStartDate && config.historyConfirmed) return 'verified-full';
  if (config.historyMode === 'baseline' && config.baselineDate && Number.isFinite(config.baselineProgressCents) && config.baselineHistoryConfirmed) return 'verified-baseline';
  if (config.historyMode === 'estimate' && config.lastAwardDate) return 'estimated-award-date';
  return 'setup-needed';
}

function progressFromBaseline(rule, eligibleTransactions, config, yearWindow, coverage, year) {
  const threshold = rule.thresholdCents;
  const baselineDate = formatDateOnly(config.baselineDate);
  const baselineProgress = Math.max(0, Math.min(threshold - 1, Number(config.baselineProgressCents) || 0));
  const afterBaseline = eligibleTransactions.filter((transaction) => transaction.date > baselineDate);
  const afterNet = sumCents(afterBaseline);
  const rawProgress = baselineProgress + afterNet;
  const progressCents = positiveModulo(rawProgress, threshold);
  const yearVerified = calendarHistoryVerified(config, coverage, year, config.benefitStartDate);
  let thresholdsYtd = null;

  if (baselineDate < yearWindow.start && yearVerified) {
    const beforeYearNet = sumCents(afterBaseline.filter((transaction) => transaction.date < yearWindow.start));
    const progressAtYearStart = positiveModulo(baselineProgress + beforeYearNet, threshold);
    const yearNet = sumCents(afterBaseline.filter((transaction) => dateIsInWindow(transaction.date, yearWindow)));
    thresholdsYtd = Math.max(0, Math.floor((progressAtYearStart + yearNet) / threshold));
  } else if (yearVerified) {
    const yearThroughBaseline = sumCents(eligibleTransactions.filter((transaction) =>
      dateIsInWindow(transaction.date, yearWindow) && transaction.date <= baselineDate
    ));
    const progressAtYearStart = positiveModulo(baselineProgress - yearThroughBaseline, threshold);
    const thresholdsThroughBaseline = Math.trunc((progressAtYearStart + yearThroughBaseline - baselineProgress) / threshold);
    const afterBaselineYtd = sumCents(afterBaseline.filter((transaction) => dateIsInWindow(transaction.date, yearWindow)));
    const thresholdsAfterBaseline = Math.floor((baselineProgress + afterBaselineYtd) / threshold);
    thresholdsYtd = Math.max(0, thresholdsThroughBaseline + thresholdsAfterBaseline);
  }

  return { progressCents, thresholdsYtd, yearVerified };
}

function calculatePersonal(account, rule, transactions, config, coverage, asOfDate, yearWindow) {
  const status = setupStatus(rule, config);
  const benefitStartDate = formatDateOnly(config.benefitStartDate);
  const eligibleTransactions = transactions.filter((transaction) =>
    hyattTransactionQualifies(transaction)
    && throughDate(transaction, asOfDate)
    && (!benefitStartDate || transaction.date >= benefitStartDate)
  );
  const yearTransactions = eligibleTransactions.filter((transaction) => dateIsInWindow(transaction.date, yearWindow));
  const currentYearSpendCents = Math.max(0, sumCents(yearTransactions));
  let progressCents = null;
  let spendNightsYtd = null;
  let lifetimeSpendCents = null;
  let yearHistoryVerified = false;

  if (status === 'verified-full') {
    const lifetimeNet = Math.max(0, sumCents(eligibleTransactions));
    const beforeYearNet = Math.max(0, sumCents(eligibleTransactions.filter((transaction) => transaction.date < yearWindow.start)));
    lifetimeSpendCents = lifetimeNet;
    progressCents = positiveModulo(lifetimeNet, rule.thresholdCents);
    spendNightsYtd = Math.max(0,
      Math.floor(lifetimeNet / rule.thresholdCents) - Math.floor(beforeYearNet / rule.thresholdCents)
    ) * rule.nightsPerThreshold;
    yearHistoryVerified = true;
  } else if (status === 'verified-baseline') {
    const baseline = progressFromBaseline(rule, eligibleTransactions, config, yearWindow, coverage, Number(yearWindow.start.slice(0, 4)));
    progressCents = baseline.progressCents;
    spendNightsYtd = baseline.thresholdsYtd === null ? null : baseline.thresholdsYtd * rule.nightsPerThreshold;
    yearHistoryVerified = baseline.yearVerified;
  } else if (status === 'estimated-award-date') {
    const afterAward = eligibleTransactions.filter((transaction) => transaction.date > config.lastAwardDate);
    progressCents = positiveModulo(sumCents(afterAward), rule.thresholdCents);
    const estimatedYearNet = sumCents(afterAward.filter((transaction) => dateIsInWindow(transaction.date, yearWindow)));
    spendNightsYtd = Math.max(0, Math.floor(estimatedYearNet / rule.thresholdCents)) * rule.nightsPerThreshold;
  }

  const baseNights = benefitStartDate && benefitStartDate > asOfDate ? 0 : rule.baseNights;
  return {
    setupStatus: status,
    progressCents,
    lifetimeSpendCents,
    spendNightsYtd,
    baseNights,
    cardNightsYtd: spendNightsYtd === null ? null : baseNights + spendNightsYtd,
    currentYearSpendCents,
    annualFreeNightThresholdCents: rule.annualFreeNightThresholdCents,
    annualFreeNightEarned: currentYearSpendCents >= rule.annualFreeNightThresholdCents,
    yearHistoryVerified
  };
}

function calculateBusiness(account, rule, transactions, config, coverage, asOfDate, yearWindow) {
  const eligibleTransactions = transactions.filter((transaction) =>
    hyattTransactionQualifies(transaction)
    && throughDate(transaction, asOfDate)
    && dateIsInWindow(transaction.date, yearWindow)
  );
  const currentYearSpendCents = Math.max(0, sumCents(eligibleTransactions));
  const completedThresholds = Math.floor(currentYearSpendCents / rule.thresholdCents);
  const year = Number(yearWindow.start.slice(0, 4));
  return {
    setupStatus: 'calendar-year',
    progressCents: positiveModulo(currentYearSpendCents, rule.thresholdCents),
    lifetimeSpendCents: null,
    spendNightsYtd: completedThresholds * rule.nightsPerThreshold,
    baseNights: 0,
    cardNightsYtd: completedThresholds * rule.nightsPerThreshold,
    currentYearSpendCents,
    annualFreeNightThresholdCents: null,
    annualFreeNightEarned: false,
    yearHistoryVerified: calendarHistoryVerified(config, coverage, year)
  };
}

export function calculateHyattCardMetrics(account, transactions, config = {}, coverage = {}, asOf = new Date()) {
  const rule = getHyattProductRule(config.productId ?? account.productId, account.name);
  if (!rule) return null;
  const asOfDate = formatDateOnly(asOf);
  const yearWindow = getCalendarYearWindow(asOfDate);
  const ownTransactions = transactions.filter((transaction) => belongsToAccount(transaction, account));
  const pendingTransactionCount = ownTransactions.filter(isPending).length;
  const calculation = rule.type === 'personal'
    ? calculatePersonal(account, rule, ownTransactions, config, coverage, asOfDate, yearWindow)
    : calculateBusiness(account, rule, ownTransactions, config, coverage, asOfDate, yearWindow);
  const periodTransactions = ownTransactions.filter((transaction) =>
    throughDate(transaction, asOfDate) && dateIsInWindow(transaction.date, yearWindow)
  );
  const qualifyingTransactionCount = periodTransactions.filter(hyattTransactionQualifies).length;
  const opening = parseDateOnly(config.benefitStartDate);
  const earliest = parseDateOnly(coverage.earliest);
  const openingGapDays = opening && earliest && earliest >= opening
    ? Math.round((earliest - opening) / 86_400_000)
    : null;

  return {
    account,
    rule,
    config,
    coverage,
    yearWindow,
    periodTransactions,
    transactionCount: periodTransactions.length,
    qualifyingTransactionCount,
    pendingTransactionCount,
    openingGapDays,
    ...calculation
  };
}

export function calculateAllHyattCards(state, asOf = new Date()) {
  return (state.accounts ?? [])
    .map((account) => calculateHyattCardMetrics(
      account,
      state.transactions ?? [],
      state.cardConfig?.[account.id] ?? {},
      coverageFor(state, account),
      asOf
    ))
    .filter(Boolean)
    .sort((left, right) => left.account.name.localeCompare(right.account.name) || left.account.last4.localeCompare(right.account.last4));
}
