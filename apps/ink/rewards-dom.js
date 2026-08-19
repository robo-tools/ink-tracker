import { formatDateOnly } from '../../packages/chase-core/lib/dates.js';
import { normalizeCategory, parseMoneyCents, stableId } from '../../packages/chase-core/lib/normalize.js';

const rewardsWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parsePoints(value) {
  const normalized = String(value ?? '').replace(/[^\d.-]/g, '');
  if (!normalized || normalized === '-') return null;
  const points = Number(normalized);
  return Number.isFinite(points) ? points : null;
}

export function parseRewardsListItemAttributes(attributes) {
  const description = String(attributes.description ?? '').replace(/(?:&lt;|<)br\s*\/?(?:&gt;|>)/gi, ' ');
  const dateText = description.match(/[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/)?.[0] ?? '';
  const rate = Number(description.match(/(\d+(?:\.\d+)?)%\s*earn/i)?.[1]);
  const merchant = String(attributes.label ?? '').trim();
  const amountCents = parseMoneyCents(attributes.secondaryDescription ?? attributes['secondary-description']);
  const reportedPoints = parsePoints(attributes.secondaryLabel ?? attributes['secondary-label']);
  const date = formatDateOnly(dateText);
  if (!merchant || !date || amountCents === null || !Number.isFinite(rate) || rate <= 0) return null;
  const categoryResult = normalizeCategory('', merchant);
  return {
    id: stableId(['rewards', date, merchant, amountCents, reportedPoints]),
    accountId: '',
    last4: '',
    date,
    description: merchant,
    amountCents: Math.abs(amountCents),
    reportedMultiplier: rate,
    reportedPoints,
    category: categoryResult.category,
    categorySource: categoryResult.source,
    source: 'rewards-dom'
  };
}

export function extractRewardsActivity(doc = document) {
  const nodes = [...doc.querySelectorAll('transaction-details-item mds-list-item')];
  const rewardRecords = nodes.map((node) => parseRewardsListItemAttributes({
    label: node.getAttribute('label'),
    description: node.getAttribute('description'),
    secondaryLabel: node.getAttribute('secondary-label'),
    secondaryDescription: node.getAttribute('secondary-description')
  })).filter(Boolean);
  const text = doc.body?.innerText ?? '';
  return {
    rewardRecords,
    reachedEnd: /reached the end of your transaction details/i.test(text),
    validEmpty: /(?:no|don['’]t have any)\s+(?:rewards?\s+)?(?:activity|transactions?)/i.test(text),
    balancePoints: parsePoints(doc.querySelector('ur-nav-header[data-displayed-balance]')?.getAttribute('data-displayed-balance'))
  };
}

export async function loadRewardsActivity(onProgress = () => {}) {
  if (!/\/rewards-activity\/transaction-details/i.test(location.pathname)) {
    const seeAll = document.querySelector('mds-button[navigate-to="/rewards-activity/transaction-details"]');
    if (!seeAll) throw new Error('Open Rewards Activity → See all transactions, then retry.');
    onProgress('Opening all rewards transactions…');
    (seeAll.shadowRoot?.querySelector('button') ?? seeAll).click();
    for (let poll = 0; poll < 80; poll += 1) {
      await rewardsWait(250);
      if (/\/rewards-activity\/transaction-details/i.test(location.pathname)) break;
    }
  }

  for (let poll = 0; poll < 80; poll += 1) {
    const result = extractRewardsActivity();
    if (result.reachedEnd || (result.validEmpty && result.rewardRecords.length === 0)) return result;
    await rewardsWait(250);
  }
  const result = extractRewardsActivity();
  throw new Error(`Ultimate Rewards did not reach the end of the transaction list${result.rewardRecords.length ? ` (${result.rewardRecords.length} partial rows were ignored)` : ''}. No rewards data was saved.`);
}
