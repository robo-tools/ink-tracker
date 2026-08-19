import { formatDateOnly } from './dates.js';
import { parseCsv, rowsToObjects } from './csv.js';

const DATE_KEYS = ['postDate', 'postedDate', 'transactionDate', 'date', 'effectiveDate', 'activityDate'];
const DESCRIPTION_KEYS = ['description', 'merchantName', 'merchant', 'transactionDescription', 'displayName', 'name'];
const AMOUNT_KEYS = ['transactionAmount', 'amount', 'purchaseAmount', 'billingAmount', 'amountValue'];
const ACCOUNT_ID_KEYS = ['accountId', 'accountReferenceId', 'relationshipId', 'displayAccountId'];
const LAST4_KEYS = ['last4', 'lastFour', 'lastFourDigits', 'accountMask', 'maskedAccountNumber'];

const CATEGORY_PATTERNS = [
  ['office_supplies', /office\s*(supplies|store)|stationery|business services/i],
  ['phone', /phone|telecom|wireless|cellular/i],
  ['internet', /internet|broadband|online service/i],
  ['cable', /cable|television service|streaming cable/i],
  ['shipping', /shipping|postal|courier|freight/i],
  ['travel', /travel|airline|hotel|motel|car rental|transit/i],
  ['advertising', /advertis|marketing/i],
  ['social_media', /social media/i],
  ['gas', /gas station|fuel|service station/i],
  ['dining', /restaurant|dining|fast food|cafe/i]
];

const MERCHANT_PATTERNS = [
  ['office_supplies', /\b(staples|office\s*depot|office\s*max|officemax|quill)\b/i],
  ['phone', /\b(verizon|t-?mobile|at&t|att\s*(wireless|mobility)|mint mobile|visible)\b/i],
  ['internet', /\b(comcast|xfinity|spectrum|cox communications|centurylink|frontier|google fiber|fios)\b/i],
  ['cable', /\b(directv|dish network|optimum)\b/i],
  ['shipping', /\b(fedex|ups store|united parcel|usps|postal service|dhl)\b/i],
  ['advertising', /\b(google ads|meta ads|facebook ads|microsoft ads|linkedin ads)\b/i],
  ['social_media', /\b(facebook|instagram|linkedin|tiktok|twitter|x corp)\b/i],
  ['travel', /\b(airlines?|airways|hotel|hotels|marriott|hyatt|hilton|hertz|avis|enterprise rent)\b/i],
  ['gas', /\b(shell|exxon|mobil|chevron|sunoco|marathon|speedway)\b/i]
];

export function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return null;
}

export function parseMoneyCents(value) {
  if (value && typeof value === 'object') {
    return parseMoneyCents(firstValue(value, ['amount', 'value', 'dollarAmount', 'displayValue']));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  let text = String(value ?? '').trim();
  if (!text) return null;
  const parenthesized = /^\(.*\)$/.test(text);
  const negative = parenthesized || /^\s*-/.test(text) || /-\s*$/.test(text);
  text = text.replace(/[^\d.]/g, '');
  if (!text || Number.isNaN(Number(text))) return null;
  return Math.round(Number(text) * 100) * (negative ? -1 : 1);
}

export function normalizeLast4(value) {
  const matches = String(value ?? '').match(/\d/g);
  return matches?.length ? matches.slice(-4).join('') : '';
}

export function normalizeCategory(value, description = '') {
  const raw = typeof value === 'object'
    ? firstValue(value, ['name', 'description', 'label', 'code'])
    : value;
  const categoryText = String(raw ?? '').replace(/[_-]+/g, ' ').trim();
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(categoryText)) return { category, source: 'reported' };
  }
  for (const [category, pattern] of MERCHANT_PATTERNS) {
    if (pattern.test(description)) return { category, source: 'merchant' };
  }
  return { category: categoryText ? categoryText.toLowerCase().replace(/\W+/g, '_') : 'other', source: 'unknown' };
}

export function inferTransactionKind(description, type, amountCents) {
  const text = `${type ?? ''} ${description ?? ''}`;
  if (/payment|thank you|autopay/i.test(text)) return 'payment';
  if (/refund|return|reversal|statement credit|credit adjustment/i.test(text)) return 'credit';
  if (/interest|fee|cash advance/i.test(text)) return 'non_purchase';
  if (/sale|purchase|debit/i.test(text)) return 'purchase';
  return Number(amountCents) < 0 ? 'credit' : 'purchase';
}

function spendFromAmount(amountCents, kind, sourceType = '') {
  if (kind === 'payment' || kind === 'non_purchase') return 0;
  if (kind === 'credit') return -Math.abs(amountCents ?? 0);
  if (kind === 'purchase' || /csv/i.test(sourceType)) return Math.abs(amountCents ?? 0);
  return amountCents ?? 0;
}

export function stableId(parts) {
  const text = parts.map((part) => String(part ?? '')).join('|');
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `it-${(hash >>> 0).toString(36)}`;
}

function numberValue(value) {
  if (value && typeof value === 'object') value = firstValue(value, ['value', 'amount', 'points', 'rate']);
  const normalized = String(value ?? '').replace(/[^\d.-]/g, '');
  if (!normalized || normalized === '-' || normalized === '.') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function normalizeTransaction(candidate, context = {}, source = 'network') {
  if (!candidate || typeof candidate !== 'object') return null;
  const date = formatDateOnly(firstValue(candidate, DATE_KEYS));
  const description = String(firstValue(candidate, DESCRIPTION_KEYS) ?? '').trim();
  const rawAmount = firstValue(candidate, AMOUNT_KEYS);
  const amountCents = parseMoneyCents(rawAmount);
  if (!date || amountCents === null || !description) return null;

  const type = String(firstValue(candidate, ['transactionType', 'type', 'activityType', 'debitCreditCode']) ?? '');
  const rawStatus = String(firstValue(candidate, ['status', 'transactionStatus', 'postingStatus', 'activityStatus']) ?? '');
  const status = /pending|authorized|authorization/i.test(`${rawStatus} ${type}`) ? 'pending' : 'posted';
  const kind = inferTransactionKind(description, type, amountCents);
  const accountId = String(firstValue(candidate, ACCOUNT_ID_KEYS) ?? context.accountId ?? '');
  const last4 = normalizeLast4(firstValue(candidate, LAST4_KEYS) ?? context.last4);
  const categoryResult = normalizeCategory(
    firstValue(candidate, ['merchantCategory', 'category', 'spendCategory', 'merchantCategoryDescription']),
    description
  );
  const reportedMultiplier = numberValue(firstValue(candidate, ['earnRate', 'rewardsMultiplier', 'pointsMultiplier', 'multiplier']));
  const reportedPoints = numberValue(firstValue(candidate, ['pointsEarned', 'rewardPoints', 'rewardsEarned', 'points']));
  const reportedId = firstValue(candidate, ['transactionId', 'activityId', 'id', 'referenceNumber']);
  const id = String(reportedId ?? stableId([accountId, last4, date, description, amountCents]));

  return {
    id,
    accountId,
    last4,
    date,
    description,
    amountCents,
    spendCents: spendFromAmount(amountCents, kind, source),
    kind,
    status,
    category: categoryResult.category,
    categorySource: categoryResult.source,
    reportedMultiplier,
    reportedPoints,
    source
  };
}

export function extractNormalizedData(payload, sourceUrl = '', options = {}) {
  const identifyProduct = typeof options.identifyProduct === 'function' ? options.identifyProduct : () => null;
  const acceptsAccount = typeof options.acceptsAccount === 'function'
    ? options.acceptsAccount
    : (account) => Boolean(account.last4);
  const accounts = [];
  const transactions = [];
  const seen = new WeakSet();

  function visit(value, context = {}, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, context, depth + 1);
      return;
    }

    const accountId = String(firstValue(value, ACCOUNT_ID_KEYS) ?? context.accountId ?? '');
    const last4 = normalizeLast4(firstValue(value, LAST4_KEYS) ?? context.last4);
    const name = String(firstValue(value, ['accountName', 'productName', 'displayName', 'nickname']) ?? context.name ?? '');
    const nextContext = { accountId, last4, name };
    const product = identifyProduct(name);
    if (accountId && (last4 || product)) {
      const account = {
        id: accountId,
        name: name || `Card ending ${last4}`,
        last4,
        productId: product?.id ?? null,
        source: 'network'
      };
      if (acceptsAccount(account)) accounts.push(account);
    }

    const transaction = normalizeTransaction(value, nextContext, 'network');
    if (transaction) transactions.push(transaction);
    for (const child of Object.values(value)) visit(child, nextContext, depth + 1);
  }

  visit(payload);
  const supportedAccounts = dedupeAccounts(accounts);
  const supportedIds = new Set(supportedAccounts.map((account) => String(account.id)));
  const supportedLast4 = new Set(supportedAccounts.map((account) => account.last4).filter(Boolean));
  const supportedTransactions = transactions.filter((transaction) =>
    supportedIds.has(String(transaction.accountId)) || supportedLast4.has(transaction.last4)
  );
  return { accounts: supportedAccounts, transactions: dedupeTransactions(supportedTransactions), sourceUrl };
}

export function normalizeChaseActivityRow(dataValues, account) {
  const raw = String(dataValues ?? '');
  const row = parseCsv(raw)[0] ?? [];
  const date = row[0];
  const maskIndex = row.findIndex((value, index) => index > 0 && /\(\.{3}\d{4}\)/.test(value));
  const description = row.slice(1, maskIndex > 1 ? maskIndex : 2).join(',').trim();
  const accountMask = maskIndex >= 0 ? row[maskIndex] : '';
  const afterAccountMask = accountMask ? raw.slice(raw.indexOf(accountMask) + accountMask.length) : raw;
  const amount = afterAccountMask.match(/\(?-?\$?[\d,]+\.\d{2}\)?/)?.[0]
    ?? [...row].reverse().find((value) => /^-?\s*\$?[\d,]+\.\d{2}$/.test(value.trim()))
    ?? row[row.length - 2];
  return normalizeTransaction({
    transactionDate: date,
    description,
    amount,
    transactionType: '',
    accountId: account.id,
    last4: normalizeLast4(accountMask) || account.last4
  }, account, 'chase-dom');
}

export function normalizeChaseCsv(text, account) {
  const objects = rowsToObjects(parseCsv(text));
  return objects.map((row) => normalizeTransaction({
    transactionDate: firstValue(row, ['Post Date', 'Posting Date', 'Transaction Date', 'Date']),
    description: firstValue(row, ['Description', 'Merchant', 'Details']),
    amount: firstValue(row, ['Amount', 'Transaction Amount']),
    transactionType: firstValue(row, ['Type', 'Transaction Type']),
    category: firstValue(row, ['Category', 'Merchant Category']),
    accountId: account.id,
    last4: account.last4
  }, account, 'chase-csv')).filter(Boolean);
}

export function dedupeTransactions(transactions) {
  const byId = new Map();
  for (const transaction of transactions.filter(Boolean)) byId.set(transaction.id, transaction);
  return [...byId.values()];
}

export function dedupeAccounts(accounts) {
  const byKey = new Map();
  for (const account of accounts.filter(Boolean)) {
    const key = String(account.id || account.last4);
    if (!key) continue;
    const merged = { ...(byKey.get(key) ?? {}) };
    for (const [field, value] of Object.entries(account)) {
      if (value !== '' && value !== null && value !== undefined) merged[field] = value;
    }
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}
