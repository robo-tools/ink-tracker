import { formatDateOnly, parseDateOnly } from '../../packages/chase-core/lib/dates.js';
import { getHyattProductRule } from './products.js';

export function normalizeHyattSetup(account, input, existing = {}, asOf = new Date(), coverage = {}) {
  const rule = getHyattProductRule(account?.productId, account?.name);
  if (!rule) throw new Error('This is not a supported World of Hyatt card.');
  const currentYear = (parseDateOnly(asOf) ?? new Date()).getUTCFullYear();

  if (rule.type === 'business') {
    return {
      ...existing,
      productId: rule.id,
      yearHistoryConfirmed: input.yearHistoryConfirmed ? currentYear : null
    };
  }

  const benefitStartDate = formatDateOnly(input.benefitStartDate);
  if (!benefitStartDate) throw new Error('Enter the date this card began earning the current Hyatt benefits.');
  const mode = input.historyMode;
  if (!['full', 'baseline', 'estimate'].includes(mode)) throw new Error('Choose an initialization method.');
  const config = { productId: rule.id, benefitStartDate, historyMode: mode };

  if (mode === 'full') {
    const statements = coverage.statements ?? {};
    const activityEarliest = coverage.activity?.earliest ?? statements.activityEarliest ?? '';
    const statementHistoryComplete = Boolean(
      statements.earliest
      && statements.earliest <= benefitStartDate
      && activityEarliest
      && statements.latest >= activityEarliest
      && !statements.gaps?.length
    );
    if (!input.historyConfirmed && !statementHistoryComplete) {
      throw new Error('Confirm that no qualifying purchases are missing, backfill the older Chase statements, or choose a baseline method.');
    }
    config.historyConfirmed = true;
    config.historySource = statementHistoryComplete ? 'statements' : 'user';
  }

  if (mode === 'baseline') {
    const baselineDate = formatDateOnly(input.baselineDate);
    const amountDollars = Number(input.baselineAmount);
    if (!baselineDate || baselineDate < benefitStartDate) throw new Error('Enter a baseline date on or after the Hyatt benefit start date.');
    if (!input.baselineHistoryConfirmed) throw new Error('Confirm that every posted transaction after the baseline date is included.');
    if (!Number.isFinite(amountDollars) || amountDollars < 0 || amountDollars > 5_000) throw new Error('Enter a baseline amount between $0 and $5,000.');
    let progressCents = Math.round(amountDollars * 100);
    if (input.baselineAmountType === 'remaining') {
      if (progressCents <= 0 || progressCents > rule.thresholdCents) throw new Error('Remaining spend must be greater than $0 and no more than $5,000.');
      progressCents = (rule.thresholdCents - progressCents) % rule.thresholdCents;
    } else if (progressCents >= rule.thresholdCents) {
      throw new Error('Accumulated progress must be less than $5,000.');
    }
    config.baselineDate = baselineDate;
    config.baselineProgressCents = progressCents;
    config.baselineHistoryConfirmed = true;
    config.yearHistoryConfirmed = input.yearHistoryConfirmed ? currentYear : null;
  }

  if (mode === 'estimate') {
    const lastAwardDate = formatDateOnly(input.lastAwardDate);
    if (!lastAwardDate || lastAwardDate < benefitStartDate) throw new Error('Enter the last award or threshold date on or after the Hyatt benefit start date.');
    config.lastAwardDate = lastAwardDate;
  }

  return config;
}
