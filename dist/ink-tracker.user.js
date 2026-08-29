// ==UserScript==
// @name         Ink Tracker for Chase
// @namespace    https://github.com/robo-tools/ink-tracker
// @version      1.1.3
// @description  Tracks Chase Ink bonus-category spend, anniversary caps, and verified or estimated points locally.
// @author       Robo (@robo77 on Discord)
// @homepageURL  https://github.com/robo-tools/ink-tracker
// @supportURL   https://github.com/robo-tools/ink-tracker/issues
// @updateURL    https://robo-tools.github.io/ink-tracker/ink-tracker.meta.js
// @downloadURL  https://robo-tools.github.io/ink-tracker/ink-tracker.user.js
// @match        https://secure.chase.com/*
// @match        https://ultimaterewardspoints.chase.com/*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(() => {
  'use strict';

// ---- packages/chase-core/lib/dates.js ----
const DAY_MS = 86_400_000;

function parseDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const text = String(value ?? '').trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return safeUtcDate(+match[1], +match[2], +match[3]);
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const year = +match[3] < 100 ? 2000 + +match[3] : +match[3];
    return safeUtcDate(year, +match[1], +match[2]);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf())
    ? null
    : new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

function safeUtcDate(year, month, day) {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day
    ? result
    : null;
}

function anniversaryInYear(year, month, day) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

function formatDateOnly(value) {
  const date = parseDateOnly(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

function formatMonthYear(value) {
  const date = parseDateOnly(value);
  return date
    ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'unknown';
}

function getAnniversaryWindow(asOf, anniversaryMonth, anniversaryDay) {
  const current = parseDateOnly(asOf) ?? parseDateOnly(new Date());
  const month = Number(anniversaryMonth);
  const day = Number(anniversaryDay);
  if (!current || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;

  let start = anniversaryInYear(current.getUTCFullYear(), month, day);
  if (start > current) start = anniversaryInYear(current.getUTCFullYear() - 1, month, day);
  const nextReset = anniversaryInYear(start.getUTCFullYear() + 1, month, day);
  return {
    start: formatDateOnly(start),
    endExclusive: formatDateOnly(nextReset),
    nextReset: formatDateOnly(nextReset),
    daysRemaining: Math.max(0, Math.ceil((nextReset - current) / DAY_MS))
  };
}

function getCalendarYearWindow(asOf) {
  const current = parseDateOnly(asOf) ?? parseDateOnly(new Date());
  const year = current.getUTCFullYear();
  return {
    start: `${year}-01-01`,
    endExclusive: `${year + 1}-01-01`,
    nextReset: `${year + 1}-01-01`,
    daysRemaining: Math.max(0, Math.ceil((Date.UTC(year + 1, 0, 1) - current) / DAY_MS))
  };
}

function dateIsInWindow(dateValue, window) {
  const date = formatDateOnly(dateValue);
  return Boolean(date && window && date >= window.start && date < window.endExclusive);
}

// end packages/chase-core/lib/dates.js

// ---- packages/chase-core/lib/csv.js ----
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text ?? '').replace(/^\uFEFF/, '');

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  row.push(field.replace(/\r$/, ''));
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header).trim());
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

// end packages/chase-core/lib/csv.js

// ---- packages/chase-core/lib/matching.js ----
function merchantKey(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\b(PP|BHN|STORE|PURCHASE|PAYMENT|ONLINE|COM)\b/g, '')
    .replace(/\d{3,}/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function merchantSimilarity(left, right) {
  const a = merchantKey(left);
  const b = merchantKey(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const pairs = (value) => new Set([...value].slice(0, -1).map((char, index) => char + value[index + 1]));
  const aPairs = pairs(a);
  const bPairs = pairs(b);
  const intersection = [...aPairs].filter((pair) => bPairs.has(pair)).length;
  return intersection / Math.max(1, Math.max(aPairs.size, bPairs.size));
}

function dateDistanceDays(left, right) {
  const a = parseDateOnly(left);
  const b = parseDateOnly(right);
  return a && b ? Math.abs(a - b) / 86_400_000 : Number.POSITIVE_INFINITY;
}

function belongsToAccount(item, account) {
  if (item?.accountId && account?.id) return String(item.accountId) === String(account.id);
  return Boolean(item?.last4 && account?.last4 && item.last4 === account.last4);
}

function isPending(transaction) {
  return transaction?.status === 'pending';
}

// end packages/chase-core/lib/matching.js

// ---- packages/chase-core/lib/normalize.js ----
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

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return null;
}

function parseMoneyCents(value) {
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

function normalizeLast4(value) {
  const matches = String(value ?? '').match(/\d/g);
  return matches?.length ? matches.slice(-4).join('') : '';
}

function normalizeCategory(value, description = '') {
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

function inferTransactionKind(description, type, amountCents) {
  const text = `${type ?? ''} ${description ?? ''}`;
  if (/\b(?:automatic payment|autopay|online payment|mobile payment|payment thank you|payment - thank you|thank you-mobile)\b/i.test(text)) return 'payment';
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

function stableId(parts) {
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

function normalizeTransaction(candidate, context = {}, source = 'network') {
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

function extractNormalizedData(payload, sourceUrl = '', options = {}) {
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

function normalizeChaseActivityRow(dataValues, account) {
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

function normalizeChaseCsv(text, account) {
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

function dedupeTransactions(transactions) {
  const byId = new Map();
  for (const transaction of transactions.filter(Boolean)) byId.set(transaction.id, transaction);
  return [...byId.values()];
}

function dedupeAccounts(accounts) {
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

// end packages/chase-core/lib/normalize.js

// ---- packages/chase-core/app/storage.js ----
function emptyState() {
  return {
    schemaVersion: 2,
    accounts: [],
    transactions: [],
    rewardRecords: [],
    coverage: {},
    cardConfig: {},
    rewardSync: null,
    captureStats: { payloads: 0, lastSource: '', lastCapturedAt: '' },
    updatedAt: ''
  };
}

function sameAccount(left, right) {
  if (left.accountId && right.accountId) return String(left.accountId) === String(right.accountId);
  return Boolean(left.last4 && right.last4 && left.last4 === right.last4);
}

function sourceList(transaction) {
  return [...new Set([...(transaction.sources ?? []), transaction.source].filter(Boolean))];
}

function semanticAmount(transaction) {
  return Number.isFinite(transaction.spendCents) ? transaction.spendCents : transaction.amountCents;
}

function compatibleKind(left, right) {
  const group = (transaction) => ['payment', 'non_purchase'].includes(transaction.kind)
    ? transaction.kind
    : Number(semanticAmount(transaction)) < 0 || transaction.kind === 'credit' ? 'credit' : 'purchase';
  return group(left) === group(right);
}

function transactionMatchScore(left, right) {
  if (!sameAccount(left, right) || !compatibleKind(left, right)) return null;
  if (semanticAmount(left) !== semanticAmount(right)) return null;
  const days = dateDistanceDays(left.date, right.date);
  if (days > 3) return null;
  const similarity = merchantSimilarity(left.description, right.description);
  if (similarity < 0.45) return null;
  return similarity * 100 - days * 5 + (left.id && right.id && left.id === right.id ? 50 : 0);
}

function richness(transaction) {
  let score = transaction.source === 'network' ? 3
    : transaction.source === 'chase-csv' ? 2
    : transaction.source === 'chase-dom' ? 1
    : 0;
  if (transaction.categorySource === 'reported') score += 4;
  if (Number.isFinite(transaction.reportedMultiplier)) score += 2;
  if (Number.isFinite(transaction.reportedPoints)) score += 2;
  if (transaction.status === 'posted') score += 8;
  return score;
}

function mergeTransactionPair(previous, transaction) {
  const preferred = richness(transaction) >= richness(previous) ? transaction : previous;
  const secondary = preferred === transaction ? previous : transaction;
  const merged = { ...secondary };
  for (const [field, value] of Object.entries(preferred)) {
    if (value !== '' && value !== null && value !== undefined) merged[field] = value;
  }
  merged.id = previous.id || transaction.id;
  merged.sources = [...new Set([...sourceList(previous), ...sourceList(transaction)])];
  if (previous.status === 'posted' || transaction.status === 'posted') merged.status = 'posted';
  return merged;
}

function mergeCoverage(current = {}, incoming = {}) {
  const merged = { ...current };
  for (const [accountId, coverage] of Object.entries(incoming)) {
    merged[accountId] = { ...(current[accountId] ?? {}), ...coverage };
  }
  return merged;
}

function combineTransactions(existing, incoming, allowNew) {
  const merged = existing.filter(Boolean).map((transaction) => ({
    ...transaction,
    sources: sourceList(transaction)
  }));
  const availableCount = merged.length;
  const used = new Set();
  for (const transaction of incoming.filter(Boolean)) {
    let best = null;
    for (let index = 0; index < availableCount; index += 1) {
      if (used.has(index)) continue;
      const score = transactionMatchScore(merged[index], transaction);
      if (score !== null && (!best || score > best.score)) best = { index, score };
    }
    if (best) {
      used.add(best.index);
      merged[best.index] = mergeTransactionPair(merged[best.index], transaction);
    } else if (allowNew) {
      merged.push({ ...transaction, sources: sourceList(transaction) });
    }
  }
  return merged.sort((left, right) => right.date.localeCompare(left.date) || left.description.localeCompare(right.description));
}

function mergeTransactions(existing, incoming) {
  return combineTransactions(existing, incoming, true);
}

function mergeSupplementalTransactions(existing, incoming) {
  return combineTransactions(existing, incoming, false);
}

function reconcileTransactions(transactions) {
  const groups = new Map();
  for (const transaction of transactions.filter(Boolean)) {
    const group = transaction.source || sourceList(transaction).sort().join('+') || 'unknown';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(transaction);
  }
  let reconciled = [];
  for (const group of groups.values()) reconciled = mergeTransactions(reconciled, group);
  return reconciled;
}

function mergeRewardRecords(existing, incoming) {
  const merged = new Map();
  for (const rewards of [existing, incoming]) {
    const occurrences = new Map();
    for (const reward of rewards.filter(Boolean)) {
      const baseKey = [reward.accountId, reward.date, reward.description, reward.amountCents, reward.reportedPoints]
        .map((value) => String(value ?? '').trim().toLowerCase())
        .join('|');
      const occurrence = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, occurrence + 1);
      const key = `${baseKey}|occurrence:${occurrence}`;
      merged.set(key, { ...(merged.get(key) ?? {}), ...reward });
    }
  }
  return [...merged.values()].sort((left, right) => right.date.localeCompare(left.date));
}

function commitFullSync(current, draft, source = 'full-sync') {
  const syncedAccountIds = new Set((draft.accounts ?? []).map((account) => String(account.id)));
  const isReplaceableActivity = (transaction) => {
    const sources = sourceList(transaction);
    return sources.length && sources.every((item) => ['chase-dom', 'network'].includes(item));
  };
  const base = {
    ...current,
    transactions: (current.transactions ?? []).filter((transaction) =>
      !syncedAccountIds.has(String(transaction.accountId)) || !isReplaceableActivity(transaction)
    ),
    rewardRecords: (current.rewardRecords ?? []).filter((reward) =>
      !syncedAccountIds.has(String(reward.accountId))
    )
  };
  return mergeState(base, draft, source);
}

function mergeState(current, data, source = '') {
  const transactions = mergeTransactions(current.transactions ?? [], data.transactions ?? []);
  const accounts = repairAccountMetadata(
    dedupeAccounts([...(current.accounts ?? []), ...(data.accounts ?? [])]),
    transactions
  );
  const next = {
    ...emptyState(),
    ...current,
    accounts,
    transactions,
    rewardRecords: mergeRewardRecords(current.rewardRecords ?? [], data.rewardRecords ?? []),
    cardConfig: { ...(current.cardConfig ?? {}) },
    coverage: mergeCoverage(current.coverage, data.coverage),
    captureStats: {
      ...(current.captureStats ?? {}),
      payloads: (current.captureStats?.payloads ?? 0) + (data.payloadCount ?? 0),
      lastSource: source || current.captureStats?.lastSource || '',
      lastCapturedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  };
  return next;
}

function repairAccountMetadata(accounts, transactions) {
  return accounts.map((account) => {
    if (account.last4) return account;
    const matching = transactions.find((transaction) =>
      transaction.last4 && transaction.accountId && String(transaction.accountId) === String(account.id)
    );
    return matching ? { ...account, last4: matching.last4 } : account;
  });
}

function repairStateAccountMetadata(state) {
  const accounts = repairAccountMetadata(state.accounts ?? [], state.transactions ?? []);
  const coverage = { ...(state.coverage ?? {}) };
  for (const account of accounts) {
    const current = coverage[account.id];
    if (!current) continue;
    const owns = (item) => item.accountId && String(item.accountId) === String(account.id)
      || !item.accountId && item.last4 && item.last4 === account.last4;
    const activityRows = (state.transactions ?? []).filter((transaction) => {
      const sources = [...(transaction.sources ?? []), transaction.source].filter(Boolean);
      return owns(transaction) && sources.includes('chase-dom');
    });
    const rewardRows = (state.rewardRecords ?? []).filter(owns);
    const range = (items) => {
      const dates = items.map((item) => item.date).filter(Boolean).sort();
      return { rowCount: items.length, earliest: dates[0] ?? null, latest: dates.at(-1) ?? null };
    };
    coverage[account.id] = {
      ...current,
      activity: current.activity?.complete && activityRows.length
        ? { ...current.activity, ...range(activityRows) }
        : current.activity,
      rewards: current.rewards?.complete && rewardRows.length
        ? { ...current.rewards, ...range(rewardRows) }
        : current.rewards
    };
  }
  return { ...state, accounts, coverage };
}

function createStorage(options = {}) {
  const storageKey = options.storageKey || 'ink-tracker-state-v1';
  const label = options.label || 'Chase Tracker';
  const hasGm = typeof GM !== 'undefined' && typeof GM.getValue === 'function';
  return {
    async load() {
      try {
        const value = hasGm ? await GM.getValue(storageKey, null) : localStorage.getItem(storageKey);
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (!parsed) return emptyState();
        const loaded = { ...emptyState(), ...parsed, schemaVersion: 2 };
        loaded.transactions = reconcileTransactions(loaded.transactions ?? []);
        return loaded;
      } catch (error) {
        console.warn(`[${label}] Could not load local state.`, error);
        return emptyState();
      }
    },
    async save(state) {
      const next = { ...state, updatedAt: new Date().toISOString() };
      if (hasGm) await GM.setValue(storageKey, next);
      else localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    },
    async clear() {
      if (hasGm && typeof GM.deleteValue === 'function') await GM.deleteValue(storageKey);
      else localStorage.removeItem(storageKey);
    }
  };
}

// end packages/chase-core/app/storage.js

// ---- packages/chase-core/app/chase-dom.js ----
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

function productFor(name, options = {}) {
  return typeof options.identifyProduct === 'function' ? options.identifyProduct(name) : null;
}

function accountIsSupported(account, options = {}) {
  return typeof options.acceptsAccount === 'function' ? options.acceptsAccount(account) : Boolean(account.last4);
}

function accountFromRoute(name, route, options = {}) {
  const account = {
    id: route[1],
    name,
    last4: normalizeLast4(name),
    accountType: route[2],
    accountDetailType: route[3],
    productId: productFor(name, options)?.id ?? null,
    source: 'chase-dom'
  };
  return accountIsSupported(account, options) ? account : null;
}

function extractChaseAccounts(html = document.documentElement?.innerHTML ?? '', options = {}) {
  const decoded = decodeHtmlEntities(String(html));
  const accounts = [];
  const pattern = /"value":"([^"]{1,180}\(\.\.\.\d{4}\))"\s*}[\s\S]{0,1000}?{\s*"accountId":\s*"?(\d+)"?[\s\S]{0,300}?"accountType":"([^"]+)"[\s\S]{0,200}?"accountDetailType":"([^"]+)"/gi;
  for (const match of decoded.matchAll(pattern)) {
    const name = match[1].trim();
    const account = {
      id: match[2],
      name,
      last4: normalizeLast4(name),
      accountType: match[3],
      accountDetailType: match[4],
      productId: productFor(name, options)?.id ?? null,
      source: 'chase-dom'
    };
    if (accountIsSupported(account, options)) accounts.push(account);
  }
  return [...new Map(accounts.map((account) => [account.id, account])).values()];
}

function supportedNameFromText(text, options = {}) {
  const candidates = [...String(text ?? '').matchAll(/([^\n|]{1,140}\(\.\.\.\d{4}\))/g)]
    .map((match) => match[1].replace(/^.*?Account:\s*/i, '').trim());
  return candidates.find((name) => accountIsSupported({ name, last4: normalizeLast4(name), productId: productFor(name, options)?.id ?? null }, options)) ?? '';
}

function extractCurrentChaseAccount(doc = document, hash = location.hash, options = {}) {
  const route = String(hash).match(/#\/dashboard\/summary\/([^/]+)\/([^/]+)\/([^/?]+)/i);
  if (!route) return null;
  const bodyText = doc.body?.innerText ?? '';
  const name = supportedNameFromText(`${bodyText}\n${doc.title ?? ''}`, options);
  if (!name) return null;
  return accountFromRoute(name, route, options);
}

function extractChaseActivity(doc = document, account = null, options = {}) {
  account = account ?? extractCurrentChaseAccount(doc, typeof location === 'undefined' ? '' : location.hash, options);
  if (!account) return { accounts: [], transactions: [], reachedEnd: false, validEmpty: false };
  const rows = [...doc.querySelectorAll('.mds-activity-table__row[data-values], tr[data-values]')];
  const transactions = rows
    .map((row) => {
      const transaction = normalizeChaseActivityRow(row.getAttribute('data-values'), account);
      if (transaction && /\bpending\b/i.test(deepText(row))) transaction.status = 'pending';
      return transaction;
    })
    .filter(Boolean);
  const text = `${doc.body?.innerText ?? ''} ${doc.body?.textContent ?? ''}`;
  const endMarker = doc.querySelector?.('[data-testid="contentList.transactionSummaryMessages.items.endOfActivityMessage.value"], [data-testid*="endOfActivityMessage"]');
  return {
    accounts: [account],
    transactions,
    reachedEnd: Boolean(endMarker) || /reached the end of your account activity/i.test(text),
    validEmpty: /(?:no|don['’]t have any)\s+(?:recent\s+)?(?:account\s+)?activity|no transactions (?:were )?found/i.test(text)
  };
}

function deepText(element) {
  if (!element) return '';
  const own = element.textContent ?? '';
  const shadow = [...(element.shadowRoot?.querySelectorAll?.('button, a, [role="button"], [role="option"], .option') ?? [])]
    .map((item) => item.textContent ?? '')
    .join(' ');
  const attributes = ['aria-label', 'accessible-text', 'label', 'text', 'button-text', 'primary-button-text']
    .map((name) => element.getAttribute?.(name) ?? '')
    .join(' ');
  return `${own} ${shadow} ${attributes}`.replace(/\s+/g, ' ').trim();
}

async function clickAllTransactions(doc = document) {
  const option = [...doc.querySelectorAll('mds-select-option')]
    .find((item) => /all transactions/i.test(item.getAttribute('label') ?? deepText(item)));
  if (!option) return false;
  if (option.getAttribute('selected') === 'true') return false;
  const select = option.closest('mds-select');
  const trigger = select?.shadowRoot?.querySelector('button, [role="button"]');
  trigger?.click();
  await wait(150);
  (option.shadowRoot?.querySelector('.option, [role="option"]') ?? option).click();
  return true;
}

function controlIsDisabled(element) {
  return Boolean(element.disabled
    || element.getAttribute?.('disabled') !== null
    || element.getAttribute?.('inactive') === 'true'
    || element.getAttribute?.('aria-disabled') === 'true');
}

function findLoadMore(doc = document) {
  const footer = doc.querySelector?.('#activity-footer-buttons, .activity-tile__footer-container');
  const candidates = [...(footer ?? doc).querySelectorAll('button, mds-button, a, [role="button"]')];
  return candidates.find((element) => {
    const text = deepText(element);
    const testId = `${element.id ?? ''} ${element.getAttribute?.('data-testid') ?? ''}`;
    const labelMatches = /\b(?:see|show|load|view)\s+more(?:\s+(?:account\s+)?(?:activity|transactions?))?\b/i.test(text);
    const testIdMatches = /(?:see|show|load|view)[-_ ]?more/i.test(testId);
    return (labelMatches || testIdMatches) && !controlIsDisabled(element);
  }) ?? null;
}

function scrollToActivityFooter(doc = document) {
  const target = doc.querySelector?.('#activity_messages_id, .activity-tile__footer-container')
    ?? [...doc.querySelectorAll('.mds-activity-table__row[data-values], tr[data-values]')].at(-1);
  target?.scrollIntoView?.({ block: 'end', behavior: 'auto' });
}

async function waitForActivityControl(doc = document, options = {}, account = null) {
  for (let poll = 0; poll < 16; poll += 1) {
    const result = extractChaseActivity(doc, account, options);
    if (result.reachedEnd || (result.validEmpty && result.transactions.length === 0)) return { result, button: null };
    const button = findLoadMore(doc);
    if (button) return { result, button };
    scrollToActivityFooter(doc);
    await wait(250);
  }
  return { result: extractChaseActivity(doc, account, options), button: findLoadMore(doc) };
}

async function waitForActivity(account, options = {}, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = extractCurrentChaseAccount(document, location.hash, options);
    const routeId = String(location.hash).match(/#\/dashboard\/summary\/([^/]+)/i)?.[1];
    const correctCard = String(current?.id ?? routeId ?? '') === String(account.id)
      && (!account.last4 || !current || current.last4 === account.last4 || document.title.includes(account.last4));
    if (correctCard && document.querySelector('mds-select-option[label="All transactions"], .mds-activity-table')) return true;
    await wait(250);
  }
  return false;
}

async function loadAllCurrentActivity(onProgress = () => {}, options = {}, account = null) {
  const before = document.querySelectorAll('.mds-activity-table__row[data-values], tr[data-values]').length;
  const changedFilter = await clickAllTransactions();
  if (changedFilter) {
    onProgress('Loading the full activity range…');
    await wait(1_500);
    let previous = before;
    let stableRounds = 0;
    for (let round = 0; round < 80 && stableRounds < 4; round += 1) {
      await wait(250);
      const count = document.querySelectorAll('.mds-activity-table__row[data-values], tr[data-values]').length;
      stableRounds = count === previous ? stableRounds + 1 : 0;
      previous = count;
    }
  }

  for (let page = 0; page < 100; page += 1) {
    const control = await waitForActivityControl(document, options, account);
    if (control.result.reachedEnd || (control.result.validEmpty && control.result.transactions.length === 0)) break;
    const button = control.button;
    if (!button) break;
    const oldCount = document.querySelectorAll('.mds-activity-table__row[data-values], tr[data-values]').length;
    onProgress(`Loading more activity (${oldCount} rows)…`);
    (button.shadowRoot?.querySelector('button, a, [role="button"]') ?? button).click();
    for (let poll = 0; poll < 40; poll += 1) {
      await wait(250);
      const newCount = document.querySelectorAll('.mds-activity-table__row[data-values], tr[data-values]').length;
      const result = extractChaseActivity(document, account, options);
      if (newCount > oldCount || result.reachedEnd || !document.contains(button)) break;
    }
  }
  const result = extractChaseActivity(document, account, options);
  if (!result.reachedEnd && !(result.validEmpty && result.transactions.length === 0)) {
    throw new Error(`Chase did not confirm the end of this card's activity${result.transactions.length ? ` (${result.transactions.length} partial rows were ignored)` : ''}. No activity data was saved.`);
  }
  return result;
}

async function syncAllCards(onProgress = () => {}, options = {}) {
  const originalHash = location.hash;
  const discovered = extractChaseAccounts(document.documentElement?.innerHTML ?? '', options);
  const current = extractCurrentChaseAccount(document, location.hash, options);
  const accounts = discovered.length ? discovered : current ? [current] : [];
  if (!accounts.length) {
    const label = options.cardLabel || 'supported cards';
    throw new Error(`No ${label} were found. Open the Chase Accounts dashboard or a supported card activity page, then retry.`);
  }

  const result = { accounts, transactions: [], coverage: {} };
  try {
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index];
      onProgress(`Syncing ${account.name} (${index + 1} of ${accounts.length})…`);
      const route = `#/dashboard/summary/${account.id}/${account.accountType || 'CARD'}/${account.accountDetailType || 'BCC'}`;
      if (location.hash !== route) {
        location.hash = route.slice(1);
        const ready = await waitForActivity(account, options);
        if (!ready) throw new Error(`Timed out while opening ${account.name}.`);
      }
      const data = await loadAllCurrentActivity(onProgress, options, account);
      result.transactions.push(...data.transactions);
      const dates = data.transactions.map((transaction) => transaction.date).filter(Boolean).sort();
      result.coverage[account.id] = {
        activity: {
          complete: true,
          rowCount: data.transactions.length,
          earliest: dates[0] ?? null,
          latest: dates.at(-1) ?? null,
          capturedAt: new Date().toISOString()
        }
      };
    }
  } finally {
    if (originalHash && location.hash !== originalHash) location.hash = originalHash.slice(1);
  }
  return result;
}

// end packages/chase-core/app/chase-dom.js

// ---- packages/chase-core/app/capture.js ----
const INTERESTING_URL = /(account|activity|transaction|reward|earn|spend|card)/i;

function installChaseNetworkCapture(onNormalizedData, options = {}) {
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const marker = options.marker || '__chaseTrackerCaptureV1';
  const requestUrlKey = `${marker}Url`;
  const label = options.label || 'Chase Tracker';
  const normalizePayload = options.normalizePayload
    || ((payload, url) => extractNormalizedData(payload, url, options.normalizerOptions));
  if (page[marker]) return { installed: true, reused: true };

  const inspect = async (response, url) => {
    try {
      if (!INTERESTING_URL.test(String(url))) return;
      const contentType = response.headers?.get?.('content-type') ?? '';
      if (!/json/i.test(contentType)) return;
      const payload = await response.clone().json();
      const normalized = normalizePayload(payload, String(url));
      if (normalized.accounts.length || normalized.transactions.length) onNormalizedData(normalized);
    } catch {
      // Chase responses that cannot be cloned or parsed are intentionally ignored.
    }
  };

  try {
    if (typeof page.fetch === 'function') {
      const originalFetch = page.fetch;
      page.fetch = async function chaseTrackerFetch(...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0]?.url ?? args[0] ?? response.url;
        void inspect(response, url);
        return response;
      };
    }

    const xhrPrototype = page.XMLHttpRequest?.prototype;
    if (xhrPrototype) {
      const originalOpen = xhrPrototype.open;
      const originalSend = xhrPrototype.send;
      xhrPrototype.open = function chaseTrackerOpen(method, url, ...rest) {
        this[requestUrlKey] = String(url);
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrPrototype.send = function chaseTrackerSend(...args) {
        this.addEventListener('load', () => {
          try {
            if (!INTERESTING_URL.test(this[requestUrlKey]) || this.status < 200 || this.status >= 300) return;
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            const normalized = normalizePayload(payload, this[requestUrlKey]);
            if (normalized.accounts.length || normalized.transactions.length) onNormalizedData(normalized);
          } catch {
            // Non-JSON and protected responses are ignored.
          }
        }, { once: true });
        return originalSend.apply(this, args);
      };
    }
    page[marker] = true;
    return { installed: true, reused: false };
  } catch (error) {
    console.warn(`[${label}] Network capture was unavailable; DOM sync and CSV import still work.`, error);
    return { installed: false, error: String(error) };
  }
}

// end packages/chase-core/app/capture.js

// ---- apps/ink/products.js ----
const PRODUCT_RULES = Object.freeze([
  {
    id: 'ink-cash',
    names: [/ink business cash/i, /ink cash/i],
    label: 'Ink Business Cash®',
    baseMultiplier: 1,
    bonusMultiplier: 5,
    annualCapCents: 2_500_000,
    categoryLabel: '5× category (office · phone · internet · cable)',
    qualifyingCategories: ['office_supplies', 'phone', 'internet', 'cable'],
    secondaryTiers: [{ multiplier: 2, annualCapCents: 2_500_000, categories: ['gas', 'dining'] }]
  },
  {
    id: 'ink-preferred',
    names: [/ink business preferred/i, /ink preferred/i],
    label: 'Ink Business Preferred®',
    baseMultiplier: 1,
    bonusMultiplier: 3,
    annualCapCents: 15_000_000,
    categoryLabel: '3× category (shipping · travel · ads · social · comms)',
    qualifyingCategories: ['shipping', 'travel', 'advertising', 'social_media', 'phone', 'internet', 'cable']
  },
  {
    id: 'ink-unlimited',
    names: [/ink business unlimited/i, /ink unlimited/i],
    label: 'Ink Business Unlimited®',
    baseMultiplier: 1.5,
    bonusMultiplier: 1.5,
    annualCapCents: null,
    categoryLabel: '1.5× on purchases',
    qualifyingCategories: ['all']
  },
  {
    id: 'ink-premier',
    names: [/ink business premier/i, /ink premier/i],
    label: 'Ink Business Premier℠',
    baseMultiplier: 2,
    bonusMultiplier: 2,
    annualCapCents: null,
    categoryLabel: '2× on purchases (2.5× on eligible $5,000+ purchases)',
    qualifyingCategories: ['all'],
    largePurchaseThresholdCents: 500_000,
    largePurchaseMultiplier: 2.5
  }
]);

function identifyProduct(accountOrName) {
  const text = typeof accountOrName === 'string'
    ? accountOrName
    : `${accountOrName?.name ?? ''} ${accountOrName?.productName ?? ''}`;
  return PRODUCT_RULES.find((rule) => rule.names.some((pattern) => pattern.test(text))) ?? null;
}

function getProductRule(productId, fallbackName = '') {
  return PRODUCT_RULES.find((rule) => rule.id === productId) ?? identifyProduct(fallbackName);
}

function isInkAccount(account) {
  return Boolean(identifyProduct(account));
}

// end apps/ink/products.js

// ---- apps/ink/calculations.js ----
function transactionQualifies(transaction, rule) {
  if (!transaction || isPending(transaction) || transaction.kind === 'payment' || transaction.kind === 'non_purchase') return false;
  if (rule.qualifyingCategories.includes('all')) return true;
  if (!rule.qualifyingCategories.includes(transaction.category)) return false;
  if (Number.isFinite(transaction.reportedMultiplier) && transaction.reportedMultiplier > 0) {
    return transaction.reportedMultiplier >= rule.bonusMultiplier;
  }
  return true;
}

function estimateTransactionMultiplier(transaction, rule) {
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

function rewardMatchesForAccount(transactions, rewardRecords, account) {
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

function scoreRewardAccount(transactions, rewardRecords, account) {
  return rewardMatchesForAccount(transactions, rewardRecords, account).length;
}

function applyRewardEnrichment(transactions, rewardRecords, account) {
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

function calculateCardMetrics(account, transactions, config = {}, asOf = new Date()) {
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

function calculateAllCards(state, asOf = new Date()) {
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

// end apps/ink/calculations.js

// ---- apps/ink/rewards-dom.js ----
const rewardsWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parsePoints(value) {
  const normalized = String(value ?? '').replace(/[^\d.-]/g, '');
  if (!normalized || normalized === '-') return null;
  const points = Number(normalized);
  return Number.isFinite(points) ? points : null;
}

function parseRewardsListItemAttributes(attributes) {
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

function extractRewardsActivity(doc = document) {
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

async function loadRewardsActivity(onProgress = () => {}) {
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

// end apps/ink/rewards-dom.js

// ---- apps/ink/ui.js ----
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const preciseMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const pointsNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatUpdated(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf())
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
    : 'Never';
}

function itemDateRange(items) {
  const dates = items.map((item) => item.date).filter(Boolean).sort();
  if (!dates.length) return 'None';
  const format = (value) => new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`));
  return `${format(dates[0])} – ${format(dates.at(-1))}`;
}

function anniversaryText(metric) {
  return metric.windowSource === 'anniversary'
    ? `Anniversary resets ${formatMonthYear(metric.window.nextReset)}`
    : 'Anniversary needed — click here to set it';
}

function displayAccountName(name) {
  return String(name ?? '').replace(/\s*\((?:\.{3}|…)?\d{4}\)\s*$/, '').trim();
}

function summaryCard(metric) {
  const { account, rule } = metric;
  const cap = metric.capCents;
  const percentage = metric.usedPercent ?? 0;
  const periodBadge = metric.windowSource === 'anniversary'
    ? '<span class="badge good">✓ anniversary-to-date</span>'
    : '<span class="badge warn">calendar YTD fallback</span>';
  const spendLine = cap === null
    ? `<strong>${money.format(metric.qualifyingSpendCents / 100)}</strong> eligible spend`
    : `<strong>${money.format(metric.qualifyingSpendCents / 100)} / ${money.format(cap / 100)}</strong> spent in category
       <span class="muted"> · ${Math.round(percentage)}% used · ${money.format(metric.remainingCents / 100)} left · ${integer.format(metric.bonusPoints)} bonus pts</span>`;
  const progress = cap === null ? '' : `
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percentage)}">
      <span style="width:${Math.max(0.5, percentage)}%"></span>
    </div>`;
  const confidence = metric.inferredCount
    ? `<span class="inference" title="Review these in Detailed view">${metric.inferredCount} merchant-inferred</span>`
    : '';
  const confirmed = metric.rewardMatchedCount
    ? `<span class="badge good">${metric.rewardMatchedCount} rewards-confirmed</span>`
    : '';
  const unmatched = metric.unmatchedRewardCount
    ? `<span class="badge warn">${metric.unmatchedRewardCount} rewards unmatched</span>`
    : '';
  const incomplete = !metric.coverage?.activity?.complete
    ? '<span class="badge warn" title="Run Refresh to verify that Chase reached the end of activity">activity coverage unverified</span>'
    : !metric.activityCoversWindow
      ? `<span class="badge warn">activity starts ${escapeHtml(metric.coverage.activity.earliest || 'after this period')}</span>`
      : '';
  const pointLabel = metric.pointsSource === 'rewards'
    ? 'rewards reported'
    : metric.pointsSource === 'no-activity' ? 'no activity' : 'estimated';
  const pointCoverage = metric.pointTransactionCount
    ? `${metric.pointCoverageCount}/${metric.pointTransactionCount} point rows matched`
    : 'No point-eligible transactions';

  return `<article class="card">
    <div class="card-title-row">
      <div>
        <h3>${escapeHtml(displayAccountName(account.name))} <span class="last4">(…${escapeHtml(account.last4)})</span></h3>
        <button class="anniversary-link ${metric.windowSource === 'anniversary' ? '' : 'needs'}" data-action="anniversary" data-id="${escapeHtml(account.id)}">${escapeHtml(anniversaryText(metric))}</button>
      </div>
      <div class="points"><strong>${integer.format(metric.displayPoints)} pts</strong><span>${pointLabel}</span></div>
    </div>
    <div class="category-row"><strong>${escapeHtml(rule.categoryLabel)}</strong> ${periodBadge} ${confirmed} ${unmatched} ${confidence} ${incomplete}</div>
    ${progress}
    <div class="spend-line">${spendLine}</div>
    <div class="card-footer"><span>${metric.qualifyingTransactionCount} qualifying of ${metric.transactionCount} posted transactions${metric.pendingTransactionCount ? ` · ${metric.pendingTransactionCount} pending excluded` : ''}</span><strong>${pointCoverage}</strong></div>
  </article>`;
}

function emptySummary() {
  return `<div class="empty">
    <div class="empty-icon">⚡</div>
    <h2>Ready to find your Ink cards</h2>
    <p>Start on Chase’s Accounts dashboard, then choose <strong>Refresh</strong>. Ink Tracker will visit each Ink card, select <strong>All transactions</strong>, and bring you back.</p>
    <p class="muted">Everything stays in this browser. No credentials, raw Chase responses, or transaction data are sent anywhere.</p>
    <button class="primary large" data-action="sync">Refresh all Ink cards</button>
  </div>`;
}

function summaryView(metrics) {
  const needsAnniversary = metrics.some((metric) => metric.windowSource !== 'anniversary');
  const anniversaryHelp = needsAnniversary ? `<aside class="anniversary-help">
    <strong>Don’t know a card’s anniversary date?</strong>
    In Chase, open <strong>Secure messages → New message</strong> and ask: “What is the cardmember anniversary date for my card ending in XXXX?” Then click the orange anniversary label to save the month and day.
  </aside>` : '';
  return `${anniversaryHelp}<div class="cards">${metrics.map(summaryCard).join('')}</div>`;
}

function syncingView(state) {
  const sync = state.rewardSync;
  const total = sync?.queue?.length ?? state.accounts.length;
  const current = sync?.currentIndex ?? 0;
  const accountId = sync?.queue?.[current];
  const account = [...(sync?.draft?.accounts ?? []), ...state.accounts]
    .find((item) => String(item.id) === String(accountId));
  const detail = sync?.active && total
    ? `Collecting card ${Math.min(current + 1, total)} of ${total}${account?.last4 ? ` (…${escapeHtml(account.last4)})` : ''}`
    : 'Collecting Chase activity before checking rewards';
  return `<div class="syncing-view" aria-live="polite">
    <div class="sync-spinner" aria-hidden="true"></div>
    <h2>Refreshing all Ink cards</h2>
    <p>${detail}</p>
    <p class="muted">Results are being staged. The dashboard will update once, after the complete sync finishes.</p>
  </div>`;
}

function buildDetailRows(metrics, filters = {}) {
  const cardId = filters.cardId ?? 'all';
  const mode = filters.mode ?? 'purchases';
  return metrics
    .flatMap((metric) => metric.periodTransactions.map((transaction) => ({ metric, transaction })))
    .filter(({ metric }) => cardId === 'all' || String(metric.account.id) === String(cardId))
    .filter(({ metric, transaction }) => {
      const earnsPoints = !['payment', 'non_purchase'].includes(transaction.kind);
      if (mode === 'bonus') return earnsPoints && transactionQualifies(transaction, metric.rule);
      if (mode === 'unmatched') return earnsPoints && !transaction.rewardMatched;
      if (mode === 'payments') return !earnsPoints;
      return earnsPoints;
    })
    .sort((left, right) => right.transaction.date.localeCompare(left.transaction.date)
      || left.metric.account.last4.localeCompare(right.metric.account.last4)
      || left.transaction.description.localeCompare(right.transaction.description));
}

function detailStatus(transaction) {
  if (['payment', 'non_purchase'].includes(transaction.kind)) return { label: 'Not point eligible', className: 'neutral' };
  if (transaction.rewardMatched) return { label: 'Rewards matched', className: 'good' };
  if (transaction.categorySource === 'reported') return { label: 'Chase category', className: 'reported' };
  if (transaction.categorySource === 'merchant') return { label: 'Merchant estimate', className: 'warn' };
  return { label: 'Unmatched', className: 'warn' };
}

function detailView(metrics, filters) {
  const rows = buildDetailRows(metrics, filters);
  const allPurchaseCount = metrics.reduce((count, metric) => count + metric.pointTransactionCount, 0);
  const scopeMetrics = filters.cardId === 'all'
    ? metrics
    : metrics.filter((metric) => String(metric.account.id) === String(filters.cardId));
  const purchaseCount = scopeMetrics.reduce((count, metric) => count + metric.pointTransactionCount, 0);
  const paymentCount = scopeMetrics.reduce((count, metric) => count
    + metric.periodTransactions.filter((transaction) => ['payment', 'non_purchase'].includes(transaction.kind)).length, 0);
  const matchedCount = scopeMetrics.reduce((count, metric) => count + metric.rewardMatchedCount, 0);
  const cardButtons = [
    { id: 'all', label: 'All cards', count: allPurchaseCount },
    ...metrics.map((metric) => ({ id: String(metric.account.id), label: `…${metric.account.last4}`, count: metric.pointTransactionCount }))
  ];
  const modes = [
    { id: 'purchases', label: 'Purchases', count: purchaseCount },
    { id: 'bonus', label: 'Bonus-category spend', count: scopeMetrics.reduce((count, metric) => count + metric.qualifyingTransactionCount, 0) },
    { id: 'unmatched', label: 'Rewards unmatched', count: Math.max(0, purchaseCount - matchedCount) },
    { id: 'payments', label: 'Payments/other', count: paymentCount }
  ];
  const table = rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Card</th><th>Merchant</th><th>Category</th><th class="right">Spend</th><th class="right">Rate</th><th class="right">Points</th><th>Verification</th></tr></thead>
      <tbody>${rows.map(({ metric, transaction }) => {
        const earnsPoints = !['payment', 'non_purchase'].includes(transaction.kind);
        const rate = earnsPoints ? estimateTransactionMultiplier(transaction, metric.rule) : null;
        const exactRate = Number.isFinite(transaction.reportedMultiplier) && transaction.reportedMultiplier > 0;
        const status = detailStatus(transaction);
        const category = earnsPoints ? transaction.category.replaceAll('_', ' ') : transaction.kind.replaceAll('_', ' ');
        return `<tr>
          <td>${escapeHtml(transaction.date)}</td>
          <td><span class="card-pill">…${escapeHtml(metric.account.last4)}</span></td>
          <td class="merchant" title="${escapeHtml(transaction.description)}">${escapeHtml(transaction.description)}</td>
          <td><span class="category ${transaction.categorySource === 'merchant' ? 'estimated' : ''}">${escapeHtml(category)}</span></td>
          <td class="right ${transaction.spendCents < 0 ? 'credit' : ''}">${earnsPoints ? preciseMoney.format(transaction.spendCents / 100) : '—'}</td>
          <td class="right"><strong>${rate === null ? '—' : `${rate}×`}</strong>${rate !== null && !exactRate ? '<small>est.</small>' : ''}</td>
          <td class="right points-cell">${Number.isFinite(transaction.reportedPoints) ? pointsNumber.format(transaction.reportedPoints) : '—'}</td>
          <td><span class="verify ${status.className}">${status.label}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : `<div class="detail-empty">No transactions match this filter.</div>`;

  return `<section class="detail-review">
    <div class="detail-heading"><div><h2>Transaction review</h2><p>Each card uses its current anniversary period.</p></div><div class="detail-totals"><strong>${rows.length}</strong> shown · <strong>${matchedCount}/${purchaseCount}</strong> purchases Rewards-matched</div></div>
    <div class="filter-group" aria-label="Filter by card">${cardButtons.map((item) => `<button class="filter-chip ${filters.cardId === item.id ? 'active' : ''}" data-detail-card="${escapeHtml(item.id)}">${escapeHtml(item.label)} <span>${item.count}</span></button>`).join('')}</div>
    <div class="filter-group modes" aria-label="Filter transactions">${modes.map((item) => `<button class="filter-chip ${filters.mode === item.id ? 'active' : ''}" data-detail-mode="${item.id}">${item.label} <span>${item.count}</span></button>`).join('')}</div>
    <p class="detail-note">Orange categories are merchant-inferred. “Rewards matched” confirms the earn rate and points; it does not independently identify the merchant category.</p>
    ${table}
  </section>`;
}

function debugView(state, captureStatus) {
  const sourceCounts = Object.entries(state.transactions.reduce((counts, transaction) => {
    counts[transaction.source] = (counts[transaction.source] ?? 0) + 1;
    return counts;
  }, {}));
  const coverageRows = state.accounts.map((account) => {
    const owns = (item) => item.accountId && String(item.accountId) === String(account.id)
      || !item.accountId && item.last4 && item.last4 === account.last4;
    const coverage = state.coverage?.[account.id] ?? {};
    const activityStatus = coverage.activity?.complete ? 'list end verified' : 'unverified';
    const rewardsStatus = coverage.rewards?.complete ? 'list end verified' : 'unverified';
    return `<div><dt>${escapeHtml(displayAccountName(account.name))} …${escapeHtml(account.last4)}</dt><dd>Activity (${activityStatus}): ${itemDateRange(state.transactions.filter(owns))}<br>Rewards (${rewardsStatus}): ${itemDateRange((state.rewardRecords ?? []).filter(owns))}</dd></div>`;
  }).join('');
  return `<div class="debug-grid">
    <section><h2>Local data</h2>
      <dl>
        <div><dt>Ink cards</dt><dd>${state.accounts.length}</dd></div>
        <div><dt>Transactions</dt><dd>${state.transactions.length}</dd></div>
        <div><dt>Rewards records</dt><dd>${state.rewardRecords?.length ?? 0}</dd></div>
        <div><dt>Activity coverage</dt><dd>${itemDateRange(state.transactions)}</dd></div>
        <div><dt>Rewards coverage</dt><dd>${itemDateRange(state.rewardRecords ?? [])}</dd></div>
        <div><dt>Captured payloads</dt><dd>${state.captureStats?.payloads ?? 0}</dd></div>
        <div><dt>Network listener</dt><dd>${captureStatus?.installed ? 'Active' : 'Fallback only'}</dd></div>
      </dl>
      <div class="source-list">${sourceCounts.length ? sourceCounts.map(([source, count]) => `<span>${escapeHtml(source)}: ${count}</span>`).join('') : '<span>No data yet</span>'}</div>
    </section>
    <section><h2>Data controls</h2>
      <p>Import Chase CSV files when you want reported merchant categories or a manual backup.</p>
      <div class="action-stack">
        <button data-action="import">Import Chase CSV</button>
        <button data-action="export">Export tracker JSON</button>
        <button class="danger" data-action="clear">Clear local tracker data</button>
      </div>
    </section>
    <section class="history"><h2>Coverage by card</h2>
      <dl class="coverage-list">${coverageRows || '<div><dt>No cards</dt><dd>None</dd></div>'}</dl>
    </section>
    <section class="privacy"><h2>Privacy boundary</h2>
      <p>Only normalized fields are stored: card name/last four, transaction date, description, amount, category, and optional points metadata. Raw responses and authentication data are never persisted.</p>
    </section>
  </div>`;
}

const STYLES = `
  :host { all: initial; color-scheme: light; }
  *, *::before, *::after { box-sizing: border-box; }
  button, input { font: inherit; }
  .launcher { position: fixed; right: 22px; bottom: 22px; z-index: 2147483645; border: 0; border-radius: 999px; padding: 11px 16px; background: #133c77; color: white; font: 700 14px/1.2 system-ui, sans-serif; box-shadow: 0 6px 24px #001b3c55; cursor: pointer; }
  .launcher:hover { background: #0c2f64; transform: translateY(-1px); }
  .backdrop { position: fixed; inset: 0; z-index: 2147483646; display: none; align-items: flex-start; justify-content: center; padding: min(4vh, 34px) 18px; background: #07192f4d; font: 13px/1.42 Inter, "Open Sans", system-ui, sans-serif; color: #24282d; }
  .backdrop.open { display: flex; }
  .modal { width: min(860px, calc(100vw - 24px)); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #aab4c0; border-radius: 10px; background: #f9fafb; box-shadow: 0 18px 55px #00142f55; }
  .header { min-height: 64px; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: linear-gradient(135deg, #173f7a, #0d326a); color: #fff; }
  .brand { display: flex; align-items: baseline; gap: 9px; margin-right: auto; min-width: 190px; }
  .brand strong { font-size: 14px; white-space: nowrap; }
  .version { font-size: 10px; opacity: .65; }
  .creator { display: inline-flex; align-items: center; gap: 3px; color: #fff; font-size: 10px; opacity: .68; text-decoration: none; white-space: nowrap; }
  .creator:hover { opacity: 1; text-decoration: underline; }
  .creator svg { width: 11px; height: 11px; fill: currentColor; }
  .controls { display: flex; gap: 8px; align-items: center; }
  button { border: 1px solid #c5ccd4; border-radius: 6px; padding: 7px 12px; background: #fff; color: #1b365d; cursor: pointer; }
  button:hover { background: #f0f5fa; }
  .header button { border-color: #ffffff26; background: #ffffff19; color: #fff; }
  .header button:hover { background: #ffffff2b; }
  .header button.active { background: white; color: #173f7a; }
  .header .icon { width: 32px; padding: 7px; font-weight: 800; }
  .primary { border-color: #145da0; background: #145da0; color: #fff; font-weight: 700; }
  .primary:hover { background: #0e4b88; }
  .large { padding: 10px 16px; }
  .updated { padding: 10px 14px 6px; color: #505861; background: #fff; }
  .body { min-height: 220px; overflow: auto; padding: 0 14px 14px; background: #fff; }
  .cards { display: grid; gap: 10px; }
  .anniversary-help { margin-bottom: 10px; padding: 10px 12px; border: 1px solid #edcf92; border-radius: 8px; background: #fff7e8; color: #6f4700; }
  .anniversary-help strong:first-child { display: block; margin-bottom: 2px; color: #895000; }
  .card { border: 1px solid #e0e4e8; border-radius: 10px; padding: 12px; background: #fff; box-shadow: 0 1px 2px #0b223808; }
  .card-title-row { display: flex; justify-content: space-between; gap: 16px; }
  h2, h3, p { margin: 0; }
  h3 { color: #25292e; font-size: 15px; line-height: 1.25; }
  .last4 { font-weight: 500; color: #5b626a; }
  .anniversary-link { border: 0; padding: 2px 0; background: none; color: #71767c; font-style: italic; font-size: 12px; }
  .anniversary-link:hover { background: none; color: #075da5; text-decoration: underline; }
  .anniversary-link.needs { color: #9c5800; font-weight: 700; }
  .points { min-width: 94px; text-align: right; color: #173e75; }
  .points strong, .points span { display: block; }
  .points strong { font-size: 15px; }
  .points span { color: #72777e; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .category-row { margin-top: 7px; color: #3f4449; }
  .badge, .inference { display: inline-block; margin-left: 5px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .badge.good { background: #e1f1e4; color: #28673a; }
  .badge.warn, .inference { background: #fff0d7; color: #895000; }
  .progress { height: 7px; margin: 4px 0 3px; overflow: hidden; border-radius: 99px; background: #eceeef; }
  .progress span { display: block; height: 100%; min-width: 3px; border-radius: inherit; background: linear-gradient(90deg, #439458 0%, #cf9c2d 92%); }
  .spend-line { padding-bottom: 6px; border-bottom: 1px dashed #d8dce0; color: #3d4247; }
  .spend-line strong { color: #173e75; }
  .muted { color: #7b8086; }
  .card-footer { display: flex; justify-content: space-between; padding-top: 6px; color: #65707b; }
  .card-footer strong { color: #173e75; font-size: 14px; }
  .empty { max-width: 560px; margin: 24px auto; padding: 24px; text-align: center; }
  .empty-icon { margin-bottom: 8px; color: #dcae2f; font-size: 30px; }
  .empty h2 { margin-bottom: 8px; color: #173e75; font-size: 20px; }
  .empty p { margin: 8px 0 16px; }
  .syncing-view { max-width: 520px; margin: 38px auto; padding: 28px; text-align: center; }
  .syncing-view h2 { margin: 12px 0 7px; color: #173e75; font-size: 20px; }
  .syncing-view p { margin: 7px 0; }
  .sync-spinner { width: 34px; height: 34px; margin: 0 auto; border: 4px solid #dbe5ef; border-top-color: #173f7a; border-radius: 50%; animation: ink-spin .8s linear infinite; }
  @keyframes ink-spin { to { transform: rotate(360deg); } }
  .detail-tools { display: flex; justify-content: space-between; gap: 18px; padding: 8px 0; }
  .detail-review { padding-top: 8px; }
  .detail-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 10px; }
  .detail-heading h2 { color: #173e75; font-size: 18px; }
  .detail-heading p, .detail-totals, .detail-note { color: #68737f; }
  .detail-totals { white-space: nowrap; }
  .detail-totals strong { color: #173e75; }
  .filter-group { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; }
  .filter-group.modes { padding-bottom: 8px; border-bottom: 1px solid #e4e8ec; }
  .filter-chip { padding: 5px 9px; border-color: #cbd4de; border-radius: 999px; color: #31516f; }
  .filter-chip span { display: inline-block; min-width: 18px; margin-left: 3px; padding: 0 5px; border-radius: 999px; background: #edf2f7; color: #586674; font-size: 10px; }
  .filter-chip.active { border-color: #174b84; background: #174b84; color: #fff; }
  .filter-chip.active span { background: #ffffff2e; color: #fff; }
  .detail-note { margin: 7px 0 9px; font-size: 11px; }
  .detail-empty { margin-top: 10px; padding: 30px 16px; border: 1px dashed #ccd5df; border-radius: 8px; color: #65717c; text-align: center; }
  .table-wrap { overflow: auto; border: 1px solid #dfe3e7; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { position: sticky; top: 0; z-index: 1; padding: 8px; background: #f1f4f7; color: #44505d; text-align: left; }
  td { max-width: 280px; padding: 8px; overflow: hidden; border-top: 1px solid #edf0f2; text-overflow: ellipsis; white-space: nowrap; }
  td.merchant { min-width: 180px; }
  .right { text-align: right; }
  .right small { display: block; color: #8a9096; font-size: 9px; font-weight: 400; text-transform: uppercase; }
  .credit { color: #28713d; }
  .points-cell { color: #173e75; font-weight: 700; }
  .card-pill { color: #173e75; font-weight: 700; }
  .category { display: inline-block; padding: 2px 6px; border-radius: 4px; background: #eaf2f8; color: #23547c; }
  .category.estimated { background: #fff0d7; color: #895000; }
  .category.confirmed { background: #e1f1e4; color: #28673a; }
  .verify { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; }
  .verify.good { background: #e1f1e4; color: #28673a; }
  .verify.reported { background: #e3edf8; color: #23547c; }
  .verify.warn { background: #fff0d7; color: #895000; }
  .verify.neutral { background: #edf0f2; color: #616970; }
  .debug-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 8px; }
  .debug-grid section { padding: 14px; border: 1px solid #e0e4e8; border-radius: 8px; }
  .debug-grid h2 { margin-bottom: 8px; color: #173e75; font-size: 15px; }
  dl { margin: 0; }
  dl div { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #edf0f2; }
  dd { margin: 0; font-weight: 700; }
  .source-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .source-list span { padding: 2px 6px; border-radius: 4px; background: #edf2f7; }
  .action-stack { display: grid; gap: 7px; margin-top: 10px; }
  .danger { border-color: #b44; color: #a22; }
  .privacy { grid-column: 1 / -1; }
  .history { grid-column: 1 / -1; }
  .coverage-list dt { font-weight: 700; }
  .coverage-list dd { text-align: right; font-weight: 400; }
  .status { display: none; margin: 0 14px 10px; padding: 9px 11px; border-radius: 6px; background: #eaf2f8; color: #174e7a; }
  .status.show { display: block; }
  .status.error { background: #fbe9e9; color: #8e2424; }
  @media (max-width: 700px) {
    .backdrop { padding: 8px; }
    .header { align-items: flex-start; flex-wrap: wrap; }
    .brand { width: 100%; }
    .controls { width: 100%; overflow-x: auto; }
    .debug-grid { grid-template-columns: 1fr; }
    .privacy { grid-column: auto; }
    .history { grid-column: auto; }
    .muted { display: inline; }
    .detail-heading { align-items: flex-start; flex-direction: column; gap: 4px; }
    .detail-totals { white-space: normal; }
  }
`;

function createInkTrackerUi(handlers) {
  const host = document.createElement('div');
  host.id = 'ink-tracker-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLES}</style>
    <button class="launcher" data-action="open">⚡ Ink Tracker</button>
    <div class="backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Ink Tracker">
        <header class="header">
          <div class="brand"><strong>Ways to Earn — All Ink Cards</strong><span class="version">v1.1.3</span><a class="creator" href="https://discord.com/app" target="_blank" rel="noopener noreferrer" aria-label="Created by Robo, @robo77 on Discord" title="@robo77 on Discord"><span>by Robo</span><svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83A97.68 97.68 0 0 0 49 6.83 72.37 72.37 0 0 0 45.64 0 105.89 105.89 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15A77.7 77.7 0 0 0 39.6 87a68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2 20.89 9.77 43.56 9.77 64.2 0 .87.71 1.76 1.39 2.66 2A70.17 70.17 0 0 1 87.4 87a77.48 77.48 0 0 0 6.89 9.34 105.25 105.25 0 0 0 32.17-16.16C129.1 52.84 122 29.1 107.7 8.07ZM42.45 65.69c-9.95 0-18.11-9.11-18.11-20.35S32.3 25 42.45 25s18.27 9.19 18.1 20.34c0 11.24-8.04 20.35-18.1 20.35Zm42.24 0c-10 0-18.11-9.11-18.11-20.35S74.54 25 84.69 25 103 34.17 102.8 45.34c0 11.24-8.05 20.35-18.11 20.35Z"/></svg></a></div>
          <nav class="controls">
            <button data-view="summary" class="active">Summary</button>
            <button data-view="detail">Detailed</button>
            <button data-action="sync">Refresh</button>
            <button data-view="debug">Debug</button>
            <button class="icon" data-action="close" aria-label="Close">×</button>
          </nav>
        </header>
        <div class="updated"></div>
        <div class="status" role="status"></div>
        <main class="body"></main>
      </section>
    </div>
    <input type="file" accept=".csv,text/csv" hidden>`;
  document.documentElement.append(host);

  let state = { accounts: [], transactions: [], cardConfig: {} };
  let view = 'summary';
  let detailFilters = { cardId: 'all', mode: 'purchases' };
  let captureStatus = null;
  let locallySyncing = false;
  const backdrop = root.querySelector('.backdrop');
  const status = root.querySelector('.status');
  const fileInput = root.querySelector('input[type="file"]');

  function render() {
    const isSyncing = locallySyncing || state.rewardSync?.active;
    const metrics = isSyncing ? [] : calculateAllCards(state);
    root.querySelector('.updated').textContent = `Updated ${formatUpdated(state.updatedAt)}`;
    root.querySelector('.body').innerHTML = isSyncing ? syncingView(state) : view === 'summary'
      ? metrics.length ? summaryView(metrics) : emptySummary()
      : view === 'detail' ? detailView(metrics, detailFilters) : debugView(state, captureStatus);
    root.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
    status.classList.add('show');
  }

  function hideStatus() {
    status.classList.remove('show', 'error');
  }

  async function run(action, startMessage) {
    showStatus(startMessage);
    try {
      await action((message) => showStatus(message));
      hideStatus();
    } catch (error) {
      showStatus(error?.message || String(error), true);
    }
  }

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.detailCard) {
      detailFilters = { ...detailFilters, cardId: target.dataset.detailCard };
      render();
      return;
    }
    if (target.dataset.detailMode) {
      detailFilters = { ...detailFilters, mode: target.dataset.detailMode };
      render();
      return;
    }
    if (target.dataset.view) {
      view = target.dataset.view;
      render();
      return;
    }
    const action = target.dataset.action;
    if (action === 'open') { backdrop.classList.add('open'); render(); }
    if (action === 'close') backdrop.classList.remove('open');
    if (action === 'sync') {
      locallySyncing = true;
      render();
      await run(handlers.sync, 'Discovering Ink cards…');
      if (!state.rewardSync?.active) {
        locallySyncing = false;
        render();
      }
    }
    if (action === 'import') fileInput.click();
    if (action === 'export') handlers.exportData();
    if (action === 'clear' && confirm('Clear all locally stored Ink Tracker data?')) await run(handlers.clear, 'Clearing local data…');
    if (action === 'anniversary') {
      const current = state.cardConfig?.[target.dataset.id];
      const defaultValue = current?.anniversaryMonth
        ? `2000-${String(current.anniversaryMonth).padStart(2, '0')}-${String(current.anniversaryDay).padStart(2, '0')}`
        : '';
      const last4 = state.accounts.find((account) => String(account.id) === String(target.dataset.id))?.last4 || '';
      const value = prompt(`Enter this card’s anniversary date (only month/day are used).\n\nDon’t know it? Send Chase a Secure Message and ask for the cardmember anniversary date for card ending …${last4}.`, defaultValue);
      if (value) await run((progress) => handlers.setAnniversary(target.dataset.id, value, progress), 'Saving anniversary…');
    }
  });

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) backdrop.classList.remove('open');
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && backdrop.classList.contains('open')) {
      backdrop.classList.remove('open');
    }
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) await run((progress) => handlers.importCsv(file, progress), `Importing ${file.name}…`);
    fileInput.value = '';
  });

  return {
    setState(next) { state = next; render(); },
    setCaptureStatus(next) { captureStatus = next; render(); },
    setProgress(message) { showStatus(message); },
    setBusy(next) { locallySyncing = Boolean(next); render(); },
    open() { backdrop.classList.add('open'); render(); }
  };
}

// end apps/ink/ui.js

// ---- apps/ink/main.js ----
const INK_CHASE_OPTIONS = Object.freeze({
  identifyProduct,
  acceptsAccount: isInkAccount,
  cardLabel: 'Ink cards'
});

void (async function startInkTracker() {
  const storage = createStorage({ storageKey: 'ink-tracker-state-v1', label: 'Ink Tracker' });
  const pendingCapture = [];
  let state = null;
  let ui = null;
  let saveChain = Promise.resolve();
  let batchingCapture = false;
  let batchedCaptures = [];

  function publish(next) {
    state = next;
    ui?.setState(state);
  }

  function save(next) {
    publish(next);
    saveChain = saveChain.then(async () => publish(await storage.save(state))).catch((error) => {
      console.warn('[Ink Tracker] Save failed.', error);
    });
    return saveChain;
  }

  function acceptCapture(data) {
    if (!state) {
      pendingCapture.push(data);
      return;
    }
    if (batchingCapture || state.rewardSync?.active) {
      if (location.hostname === 'secure.chase.com') batchedCaptures.push(data);
      return;
    }
    const next = mergeState(state, { ...data, transactions: [], payloadCount: 1 }, 'network');
    next.transactions = mergeSupplementalTransactions(next.transactions, data.transactions ?? []);
    void save(next);
  }

  const captureStatus = installChaseNetworkCapture(acceptCapture, {
    marker: '__inkTrackerCaptureV2',
    label: 'Ink Tracker',
    normalizePayload: (payload, url) => extractNormalizedData(payload, url, INK_CHASE_OPTIONS)
  });
  state = repairStateAccountMetadata(await storage.load());
  for (const captured of pendingCapture) {
    state = mergeState(state, { ...captured, transactions: [], payloadCount: 1 }, 'network');
    state.transactions = mergeSupplementalTransactions(state.transactions, captured.transactions ?? []);
  }
  if (pendingCapture.length) state = await storage.save(state);

  if (document.readyState === 'loading') {
    await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  function resolveRewardsAccount(rewardRecords) {
    const scored = state.accounts
      .map((account) => ({ account, score: scoreRewardAccount(state.transactions, rewardRecords, account) }))
      .sort((left, right) => right.score - left.score);
    if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score ?? -1)) return scored[0].account;
    if (state.accounts.length === 1) return state.accounts[0];

    const last4 = normalizeLast4(prompt('Which Ink card is this Rewards Activity page for? Enter its last four digits:') ?? '');
    const account = state.accounts.find((item) => item.last4 === last4);
    if (!account) throw new Error('No tracked Ink card matched those last four digits. Sync the Chase Accounts page first.');
    return account;
  }

  function rewardsHomeUrl(accountId) {
    return `https://ultimaterewardspoints.chase.com/home?AI=${encodeURIComponent(accountId)}`;
  }

  function rewardsCoverage(rewards) {
    const dates = rewards.rewardRecords.map((record) => record.date).filter(Boolean).sort();
    return {
      complete: Boolean(rewards.reachedEnd || rewards.validEmpty),
      rowCount: rewards.rewardRecords.length,
      earliest: dates[0] ?? null,
      latest: dates.at(-1) ?? null,
      capturedAt: new Date().toISOString()
    };
  }

  function validateRewardsSelection(expectedAccount, rewardRecords, transactions, accounts) {
    if (!rewardRecords.length) {
      const recentCutoff = Date.now() - 400 * 86_400_000;
      const recentPurchases = transactions.filter((transaction) =>
        String(transaction.accountId) === String(expectedAccount.id)
        && transaction.status !== 'pending'
        && !['payment', 'non_purchase'].includes(transaction.kind)
        && new Date(`${transaction.date}T00:00:00Z`).valueOf() >= recentCutoff
      );
      if (recentPurchases.length) {
        throw new Error(`Ultimate Rewards showed zero rows for …${expectedAccount.last4}, but Chase has ${recentPurchases.length} recent purchases. The selected Rewards card could not be verified, so no data was saved.`);
      }
      return;
    }
    const scores = accounts.map((account) => ({
      account,
      score: scoreRewardAccount(transactions, rewardRecords, account)
    })).sort((left, right) => right.score - left.score);
    const expected = scores.find((item) => String(item.account.id) === String(expectedAccount.id));
    const rival = scores.find((item) => String(item.account.id) !== String(expectedAccount.id) && item.score > 0);
    if (!expected?.score) {
      throw new Error(`Could not verify that Ultimate Rewards is showing …${expectedAccount.last4}; none of its rewards rows matched this card's Chase activity.`);
    }
    if (rival && rival.score >= expected.score) {
      throw new Error(`Ultimate Rewards card selection is ambiguous: …${expectedAccount.last4} matched ${expected.score} rows and …${rival.account.last4} matched ${rival.score}. No rewards data was saved.`);
    }
  }

  const handlers = {
    async sync(progress) {
      if (location.hostname === 'ultimaterewardspoints.chase.com') {
        const rewards = await loadRewardsActivity(progress);
        const account = resolveRewardsAccount(rewards.rewardRecords);
        const rewardRecords = rewards.rewardRecords.map((record) => ({
          ...record,
          accountId: account.id,
          last4: account.last4
        }));
        const accountUpdate = Number.isFinite(rewards.balancePoints) && rewards.balancePoints > 0
          ? { ...account, rewardsBalancePoints: rewards.balancePoints }
          : account;
        await save(mergeState(state, {
          accounts: [accountUpdate],
          rewardRecords,
          coverage: { [account.id]: { rewards: rewardsCoverage(rewards) } }
        }, 'rewards-dom'));
        progress(`Imported ${rewardRecords.length} rewards rows for …${account.last4}.`);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return;
      }
      batchingCapture = true;
      batchedCaptures = [];
      try {
        const data = await syncAllCards(progress, INK_CHASE_OPTIONS);
        await new Promise((resolve) => setTimeout(resolve, 250));
        let draftState = mergeState(emptyState(), data, 'chase-dom');
        for (const captured of batchedCaptures) {
          draftState = mergeState(draftState, { ...captured, transactions: [], payloadCount: 1 }, 'network');
          draftState.transactions = mergeSupplementalTransactions(draftState.transactions, captured.transactions ?? []);
        }
        const queue = data.accounts.map((account) => account.id);
        const draft = {
          accounts: draftState.accounts,
          transactions: draftState.transactions,
          rewardRecords: [],
          coverage: draftState.coverage,
          payloadCount: batchedCaptures.length
        };
        if (queue.length) {
          await save({
            ...state,
            rewardSync: {
              active: true,
              mode: 'same-tab',
              queue,
              currentIndex: 0,
              returnUrl: location.href,
              showResultsOnReturn: true,
              startedAt: new Date().toISOString(),
              draft
            }
          });
          const firstLast4 = state.accounts.find((item) => String(item.id) === String(queue[0]))?.last4 || data.accounts[0].last4;
          progress(`Activity collected. Opening Ultimate Rewards for …${firstLast4}…`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          location.assign(rewardsHomeUrl(queue[0]));
          return;
        }
        await save(commitFullSync(state, draft));
        progress(`Synced ${data.accounts.length} Ink cards and ${data.transactions.length} activity rows.`);
      } finally {
        batchingCapture = false;
        batchedCaptures = [];
      }
    },
    async setAnniversary(accountId, value, progress) {
      const date = formatDateOnly(value);
      if (!date) throw new Error('Use a valid date such as 2026-08-19. Only its month and day will be stored.');
      const [, month, day] = date.split('-').map(Number);
      const next = {
        ...state,
        cardConfig: {
          ...state.cardConfig,
          [accountId]: { ...(state.cardConfig?.[accountId] ?? {}), anniversaryMonth: month, anniversaryDay: day }
        }
      };
      await save(next);
      progress('Anniversary saved.');
    },
    async importCsv(file, progress) {
      const text = await file.text();
      let account = null;
      const filenameLast4 = normalizeLast4(file.name);
      if (filenameLast4) account = state.accounts.find((item) => item.last4 === filenameLast4) ?? null;
      if (!account && state.accounts.length === 1) account = state.accounts[0];
      if (!account && state.accounts.length > 1) {
        const last4 = normalizeLast4(prompt('Which card is this CSV for? Enter its last four digits:') ?? '');
        account = state.accounts.find((item) => item.last4 === last4) ?? null;
        if (!account) throw new Error('No tracked Ink card matched those last four digits.');
      }
      if (!account) {
        const name = prompt('Card name for this CSV:', 'Ink Business Cash')?.trim();
        const last4 = normalizeLast4(prompt('Last four digits for this card:') ?? '');
        if (!name || last4.length !== 4 || !identifyProduct(name)) throw new Error('A supported Ink card name and four-digit card ending are required.');
        account = { id: `manual-${last4}`, name: `${name} (…${last4})`, last4, productId: identifyProduct(name).id, source: 'csv' };
      }
      const transactions = normalizeChaseCsv(text, account);
      if (!transactions.length) throw new Error('No Chase transactions were found in that CSV. Check that it includes Date, Description, Type, Amount, and Category columns.');
      await save(mergeState(state, { accounts: [account], transactions }, 'chase-csv'));
      progress(`Imported ${transactions.length} transactions for …${account.last4}.`);
      await new Promise((resolve) => setTimeout(resolve, 900));
    },
    exportData() {
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `ink-tracker-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
    async clear(progress) {
      await storage.clear();
      publish(emptyState());
      progress('Local tracker data cleared.');
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  };

  ui = createInkTrackerUi(handlers);
  ui.setCaptureStatus(captureStatus);
  ui.setState(state);
  if (location.hostname === 'secure.chase.com' && !state.rewardSync?.active && state.rewardSync?.showResultsOnReturn) {
    ui.open();
    const { showResultsOnReturn: _showResultsOnReturn, ...returnedSync } = state.rewardSync;
    await save({ ...state, rewardSync: returnedSync });
  }

  async function continueAutomatedRewardsSync() {
    const sync = state.rewardSync;
    if (!sync?.active || location.hostname !== 'ultimaterewardspoints.chase.com') return;
    const accountId = sync.queue?.[sync.currentIndex];
    const availableAccounts = [...(sync.draft?.accounts ?? []), ...state.accounts];
    const account = availableAccounts.find((item) => String(item.id) === String(accountId));
    if (!account) {
      await save({ ...state, rewardSync: { ...sync, active: false, error: 'Queued card was not found.' } });
      return;
    }

    ui.setBusy(true);
    ui.open();
    ui.setProgress(`Syncing Ultimate Rewards for …${account.last4} (${sync.currentIndex + 1} of ${sync.queue.length})…`);
    try {
      if (!/\/rewards-activity\/transaction-details/i.test(location.pathname)) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        location.assign('https://ultimaterewardspoints.chase.com/rewards-activity/transaction-details');
        return;
      }

      const rewards = await loadRewardsActivity((message) => ui.setProgress(message));
      const currentDraft = sync.draft ?? { accounts: [], transactions: [], rewardRecords: [], coverage: {}, payloadCount: 0 };
      validateRewardsSelection(account, rewards.rewardRecords, currentDraft.transactions ?? [], availableAccounts);
      const rewardRecords = rewards.rewardRecords.map((record) => ({
        ...record,
        accountId: account.id,
        last4: account.last4
      }));
      const accountUpdate = Number.isFinite(rewards.balancePoints) && rewards.balancePoints > 0
        ? { ...account, rewardsBalancePoints: rewards.balancePoints }
        : account;
      const updatedDraft = mergeState(currentDraft, {
        accounts: [accountUpdate],
        rewardRecords,
        coverage: { [account.id]: { rewards: rewardsCoverage(rewards) } }
      }, 'rewards-dom');
      const updatedSync = { ...sync, draft: updatedDraft };
      await save({ ...state, rewardSync: updatedSync });
      const count = rewardRecords.length;
      const nextIndex = sync.currentIndex + 1;
      if (nextIndex < sync.queue.length) {
        await save({ ...state, rewardSync: { ...updatedSync, currentIndex: nextIndex } });
        const nextAccount = availableAccounts.find((item) => String(item.id) === String(sync.queue[nextIndex]));
        ui.setProgress(`Imported ${count} rewards rows. Opening …${nextAccount?.last4 || ''}…`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        location.assign(rewardsHomeUrl(sync.queue[nextIndex]));
        return;
      }

      const returnUrl = sync.returnUrl || 'https://secure.chase.com/web/auth/dashboard#/dashboard/overview';
      const committed = commitFullSync(state, updatedDraft);
      const { draft: _completedDraft, ...completedSync } = updatedSync;
      await save({
        ...committed,
        rewardSync: { ...completedSync, active: false, completedAt: new Date().toISOString() }
      });
      ui.setProgress(`Rewards synced for all ${sync.queue.length} Ink cards. Returning to Chase…`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      location.assign(returnUrl);
    } catch (error) {
      const { draft: _failedDraft, ...failedSync } = state.rewardSync ?? sync;
      await save({ ...state, rewardSync: { ...failedSync, active: false, error: error?.message || String(error) } });
      ui.setBusy(false);
      ui.setProgress(`Rewards sync paused: ${error?.message || String(error)}`);
    }
  }

  void continueAutomatedRewardsSync();

  let scanTimer = null;
  let foundAccountMetadata = false;
  async function scanCurrentPage() {
    if (location.hostname !== 'secure.chase.com') return;
    if (batchingCapture || state.rewardSync?.active) return;
    if (foundAccountMetadata) return;
    const accounts = extractChaseAccounts(document.documentElement?.innerHTML ?? '', INK_CHASE_OPTIONS);
    const activity = extractChaseActivity(document, null, INK_CHASE_OPTIONS);
    if (!accounts.length && !activity.accounts.length) return;
    foundAccountMetadata = true;
    await save(mergeState(state, {
      accounts: [...accounts, ...activity.accounts],
      transactions: []
    }, 'chase-dom'));
  }

  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scanCurrentPage(), 800);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scanCurrentPage(), 600);
  });
  void scanCurrentPage();
})();

// end apps/ink/main.js
})();
