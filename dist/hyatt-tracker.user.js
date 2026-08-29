// ==UserScript==
// @name         Hyatt Card Elite Night Tracker for Chase
// @namespace    https://github.com/robo-tools/ink-tracker
// @version      1.1.7
// @description  Tracks World of Hyatt personal and business card spend toward elite-night thresholds locally.
// @author       Robo (@robo77 on Discord)
// @homepageURL  https://github.com/robo-tools/ink-tracker
// @supportURL   https://github.com/robo-tools/ink-tracker/issues
// @updateURL    https://robo-tools.github.io/ink-tracker/hyatt-tracker.meta.js
// @downloadURL  https://robo-tools.github.io/ink-tracker/hyatt-tracker.user.js
// @match        https://secure.chase.com/*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.getResourceText
// @grant        unsafeWindow
// @resource     CHASE_TRACKER_PDFJS https://robo-tools.github.io/ink-tracker/vendor/pdf-5.6.205.min.mjs
// @resource     CHASE_TRACKER_PDFJS_WORKER https://robo-tools.github.io/ink-tracker/vendor/pdf.worker-5.6.205.min.mjs
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
const REQUEST_CONTEXT_MARKER = '__chaseTrackerRequestContextV1';

function headerValue(headers, wantedName) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get(wantedName) ?? '').trim();
  } catch {
    // Fall through to the iterable/plain-object readers.
  }
  const wanted = wantedName.toLowerCase();
  try {
    for (const [name, value] of headers) {
      if (String(name).toLowerCase() === wanted) return String(value ?? '').trim();
    }
  } catch {
    // Some page-realm Headers objects are not iterable through the userscript proxy.
  }
  try {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === wanted) return String(value ?? '').trim();
    }
  } catch {
    // Ignore header containers that cannot be enumerated.
  }
  return '';
}

function extractChaseRequestContext(input, init = {}, capturedAt = Date.now()) {
  const sources = [input?.headers, init?.headers];
  const readLatest = (name) => {
    let value = '';
    for (const headers of sources) value = headerValue(headers, name) || value;
    return value;
  };
  const csrfToken = readLatest('X-Jpmc-Csrf-Token');
  const channel = readLatest('X-Jpmc-Channel');
  const clientRequestId = readLatest('X-Jpmc-Client-Request-Id');
  if (!csrfToken && !channel && !clientRequestId) return null;
  return { csrfToken, channel, clientRequestId, capturedAt };
}

function rememberChaseRequestContext(page, input, init) {
  const captured = extractChaseRequestContext(input, init);
  if (!captured) return;
  const previous = page[REQUEST_CONTEXT_MARKER] ?? {};
  page[REQUEST_CONTEXT_MARKER] = {
    csrfToken: captured.csrfToken || previous.csrfToken || '',
    channel: captured.channel || previous.channel || '',
    clientRequestId: captured.clientRequestId || previous.clientRequestId || '',
    capturedAt: captured.csrfToken ? captured.capturedAt : previous.capturedAt || captured.capturedAt
  };
}

function chaseRequestContext(page = null) {
  const target = page ?? (typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : (typeof window !== 'undefined' ? window : null));
  const context = target?.[REQUEST_CONTEXT_MARKER];
  if (!context || typeof context !== 'object') return null;
  return {
    csrfToken: String(context.csrfToken ?? ''),
    channel: String(context.channel ?? ''),
    clientRequestId: String(context.clientRequestId ?? ''),
    capturedAt: Number(context.capturedAt ?? 0)
  };
}

function installChaseNetworkCapture(onNormalizedData, options = {}) {
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const marker = options.marker || '__chaseTrackerCaptureV1';
  const requestUrlKey = `${marker}Url`;
  const requestHeadersKey = `${marker}Headers`;
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
        rememberChaseRequestContext(page, args[0], args[1]);
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
      const originalSetRequestHeader = xhrPrototype.setRequestHeader;
      xhrPrototype.open = function chaseTrackerOpen(method, url, ...rest) {
        this[requestUrlKey] = String(url);
        this[requestHeadersKey] = {};
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrPrototype.setRequestHeader = function chaseTrackerSetRequestHeader(name, value) {
        this[requestHeadersKey] ??= {};
        this[requestHeadersKey][String(name)] = String(value);
        return originalSetRequestHeader.call(this, name, value);
      };
      xhrPrototype.send = function chaseTrackerSend(...args) {
        rememberChaseRequestContext(page, null, { headers: this[requestHeadersKey] });
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

// ---- packages/chase-core/lib/statements.js ----
const PARSER_VERSION = 1;
const MONEY_AT_END = '(-?\\$?\\s*(?:[\\d,]+\\.\\d{2}|\\.\\d{2}))';
const ROW_PATTERN = new RegExp(`^(\\d{2}/\\d{2})(?!/\\d)\\s+(?:(\\d{2}/\\d{2})(?!/\\d)\\s+)?(.+?)\\s+${MONEY_AT_END}$`);

function cleanLine(value) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function dateFromMmDd(value, closingDate) {
  const match = String(value ?? '').match(/^(\d{2})\/(\d{2})$/);
  const closing = new Date(`${closingDate}T00:00:00Z`);
  if (!match || Number.isNaN(closing.valueOf())) return '';
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = closing.getUTCFullYear();
  if (month > closing.getUTCMonth() + 1) year -= 1;
  return formatDateOnly(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

function dateFromShort(value) {
  const match = String(value ?? '').match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (!match) return '';
  const year = match[3].length === 2 ? 2_000 + Number(match[3]) : Number(match[3]);
  return formatDateOnly(`${year}-${match[1]}-${match[2]}`);
}

function dateFromDocumentValue(value) {
  const match = String(value ?? '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? formatDateOnly(`${match[1]}-${match[2]}-${match[3]}`) : formatDateOnly(value);
}

function lineSection(line, current) {
  const normalized = line.toUpperCase().replace(/\s*\([^)]*CONTINUED[^)]*\)\s*/g, '').trim();
  if (/^(?:PAYMENTS?(?: AND OTHER CREDITS)?\s*){1,2}$/.test(normalized)) return 'credits';
  if (/^(?:PURCHASES?\s*){1,2}$/.test(normalized)) return 'purchases';
  if (/^(?:CASH ADVANCES?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  if (/^(?:BALANCE TRANSFERS?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  if (/^(?:FEES?(?: CHARGED)?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  if (/^(?:INTEREST(?: CHARGED| CHARGES)?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  return current;
}

function pdfTextItemsToLines(items, tolerance = 1.25) {
  const groups = [];
  for (const item of items ?? []) {
    const text = cleanLine(item?.str);
    const x = Number(item?.transform?.[4]);
    const y = Number(item?.transform?.[5]);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    let group = groups.find((candidate) => Math.abs(candidate.y - y) <= tolerance);
    if (!group) {
      group = { y, items: [] };
      groups.push(group);
    }
    group.items.push({ x, text });
  }
  return groups.sort((left, right) => right.y - left.y).map((group) => cleanLine(
    group.items.sort((left, right) => left.x - right.x).map((item) => item.text).join(' ')
  )).filter(Boolean);
}

function parseChaseStatementPages(pages, account, fallbackStatementDate = '') {
  const lines = (pages ?? []).flat().map(cleanLine).filter(Boolean);
  const accountLine = lines.find((line) => /Account Number:/i.test(line));
  const statementLast4 = normalizeLast4(accountLine);
  if (account?.last4 && statementLast4 && statementLast4 !== account.last4) {
    throw new Error('This statement does not match the selected card ending.');
  }
  const cycleLine = lines.find((line) => /Opening\/Closing Date/i.test(line));
  const cycleMatch = cycleLine?.match(/Opening\/Closing Date\s+(\d{2}\/\d{2}\/\d{2,4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  const statementLine = lines.find((line) => /Statement Date:/i.test(line));
  const statementMatch = statementLine?.match(/Statement Date:\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  const openingDate = dateFromShort(cycleMatch?.[1]);
  const closingDate = dateFromShort(cycleMatch?.[2])
    || dateFromShort(statementMatch?.[1])
    || dateFromDocumentValue(fallbackStatementDate);
  if (!closingDate) throw new Error('This PDF did not contain a recognizable Chase statement date.');

  const summaryLine = lines.find((line) => /^Purchases\s+\+?\$[\d,]+\.\d{2}$/i.test(line));
  const purchaseTotalCents = parseMoneyCents(summaryLine?.match(/\+?(\$[\d,]+\.\d{2})$/)?.[1]);
  if (!Number.isFinite(purchaseTotalCents)) throw new Error('This PDF did not contain a recognizable Chase purchase total.');
  const creditSummaryLine = lines.find((line) => /^Payments?(?:\s*(?:,|&|and)\s*(?:Other\s+)?Credits?)?\s+-?\$[\d,]+\.\d{2}$/i.test(line));
  const creditTotalCents = parseMoneyCents(creditSummaryLine?.match(/(-?\$[\d,]+\.\d{2})$/)?.[1]);

  const transactions = [];
  const purchaseRows = [];
  const creditRows = [];
  let section = null;
  for (const line of lines) {
    section = lineSection(line, section);
    const match = line.match(ROW_PATTERN);
    if (!match || !section) continue;
    const amountCents = parseMoneyCents(match[4]);
    const description = cleanLine(match[3]);
    const date = dateFromMmDd(match[2] || match[1], closingDate);
    if (!date || !description || !Number.isFinite(amountCents)) continue;
    const transactionType = section === 'purchases' ? 'purchase'
      : section === 'non_purchase' ? 'fee'
      : '';
    const transaction = normalizeTransaction({
      transactionDate: date,
      description,
      amount: amountCents / 100,
      transactionType,
      accountId: account.id,
      last4: account.last4
    }, account, 'chase-statement');
    if (!transaction) continue;
    transaction.statementDate = closingDate;
    transactions.push(transaction);
    if (section === 'purchases' && amountCents > 0) purchaseRows.push(amountCents);
    if (section === 'credits') creditRows.push(amountCents);
  }

  const parsedPurchaseCents = purchaseRows.reduce((total, amount) => total + amount, 0);
  if (parsedPurchaseCents !== purchaseTotalCents) {
    throw new Error(`Statement purchase reconciliation failed: parsed ${parsedPurchaseCents} cents but Chase reports ${purchaseTotalCents} cents.`);
  }
  const parsedCreditCents = creditRows.reduce((total, amount) => total + amount, 0);
  if (Number.isFinite(creditTotalCents) && parsedCreditCents !== creditTotalCents) {
    throw new Error(`Statement payment/credit reconciliation failed: parsed ${parsedCreditCents} cents but Chase reports ${creditTotalCents} cents.`);
  }

  return {
    parserVersion: PARSER_VERSION,
    openingDate: openingDate || null,
    closingDate,
    statementDate: closingDate,
    purchaseTotalCents,
    parsedPurchaseCents,
    creditTotalCents: Number.isFinite(creditTotalCents) ? creditTotalCents : null,
    parsedCreditCents,
    transactionCount: transactions.length,
    transactions
  };
}

// end packages/chase-core/lib/statements.js

// ---- packages/chase-core/app/chase-statements.js ----
const PDF_RESOURCE = 'CHASE_TRACKER_PDFJS';
const PDF_WORKER_RESOURCE = 'CHASE_TRACKER_PDFJS_WORKER';
const STATEMENTS_ROUTE = '#/dashboard/documents/myDocs/index;mode=documents';
const YEAR_SETTLE_DELAY = Object.freeze({ min: 1_000, max: 1_500 });
const PDF_REQUEST_DELAY = Object.freeze({ min: 600, max: 900 });
const PDF_RETRY_DELAYS = Object.freeze([2_000, 5_000]);
const DOCUMENT_ACCESS_PATH = '/svc/rr/documents/secure/idal/v2/dockey/list';
const DEFAULT_PDF_PATH = '/svc/rr/documents/secure/idal/v5/pdfdoc/star/list';
let pdfJsPromise = null;

function waitForStatementUi(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomDelay({ min, max }) {
  return Math.round(min + (Math.random() * (max - min)));
}

function waitWithCancellation(milliseconds, signal) {
  assertNotCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Statement backfill cancelled.', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitFor(predicate, message, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await waitForStatementUi(200);
  }
  throw new Error(message);
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Statement backfill cancelled.', 'AbortError');
}

function dashboardPath() {
  return `${location.pathname}${location.search}`;
}

function statementRoute() {
  return STATEMENTS_ROUTE;
}

function statementYearOptions(root = document) {
  const options = [...root.querySelectorAll([
    '#ul-list-container-filterstyledselect-0 a.option',
    '#ul-list-container-filterstyledselect-0 [role="option"]'
  ].join(','))];
  return [...new Set(options)].map((option) => ({
    option,
    year: Number(option.querySelector('.primary')?.textContent?.trim() || option.textContent?.trim())
  })).filter((item) => Number.isInteger(item.year));
}

function selectedStatementYear(root = document) {
  const control = root.querySelector('#header-filterstyledselect-0');
  const controlText = String(control?.value ?? control?.getAttribute?.('value') ?? control?.textContent ?? control?.getAttribute?.('aria-label') ?? '');
  const controlYear = Number(controlText.match(/\b(20\d{2})\b/)?.[1]);
  if (Number.isInteger(controlYear)) return controlYear;
  return statementYearOptions(root).find((item) => (
    item.option.classList?.contains('active') || item.option.getAttribute?.('aria-selected') === 'true'
  ))?.year ?? null;
}

function compactStatementDate(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  let match = text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (match) return `${match[1]}${match[2]}${match[3]}`;
  match = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return `${match[1]}${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`;
  match = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}${match[1].padStart(2, '0')}${match[2].padStart(2, '0')}`;
  }
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  match = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(20\d{2})\b/i);
  return match ? `${match[3]}${months[match[1].slice(0, 3).toLowerCase()]}${match[2].padStart(2, '0')}` : '';
}

function statementDateForAnchor(anchor) {
  const direct = compactStatementDate(anchor.dataset?.date);
  if (direct) return direct;
  const row = anchor.closest?.('tr,[id^="accountsTable-"][id*="-row"]');
  const dateCell = row?.querySelector?.('[id$="-cell0"],td:first-child');
  return compactStatementDate(dateCell?.textContent ?? row?.textContent ?? anchor.textContent);
}

function statementAccountLabel(root, index) {
  return root.querySelector(`#header-documentsAccordion-${index}`)?.textContent
    || root.querySelector(`#button-documentsAccordion-${index}`)?.textContent
    || '';
}

function extractStatementDocuments(root = document, wantedLast4 = '') {
  const documents = new Map();
  for (const anchor of root.querySelectorAll('a[data-documentid]')) {
    if (!/requestThisDocumentAnchor-(?:pdf|download)$/i.test(anchor.id ?? '')) continue;
    const match = anchor.id.match(/accountsTable-(\d+)-/);
    const heading = match ? statementAccountLabel(root, match[1]) : '';
    const last4 = normalizeLast4(heading);
    if (wantedLast4 && last4 !== wantedLast4) continue;
    const documentId = String(anchor.dataset.documentid ?? '').trim();
    const statementDate = statementDateForAnchor(anchor);
    if (!documentId || !/^\d{8}$/.test(statementDate)) continue;
    documents.set(`${last4}|${statementDate}`, {
      documentId,
      statementDate,
      last4,
      accountDocumentId: String(anchor.dataset.accountid ?? ''),
      accountLabel: String(heading ?? '').replace(/\s+/g, ' ').trim()
    });
  }
  return [...documents.values()].sort((left, right) => left.statementDate.localeCompare(right.statementDate));
}

function statementAccountButton(root = document, wantedLast4 = '') {
  return [...root.querySelectorAll('button[id^="button-documentsAccordion-"]')]
    .find((button) => normalizeLast4(button.textContent) === wantedLast4) ?? null;
}

function elementIsVisible(element) {
  if (!element) return false;
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.classList?.contains('hide')) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
  }
  return true;
}

function chaseStatementErrorMessage(root = document) {
  const pattern = /site isn['’]t working|having trouble|unable to (?:complete|load)|please try again/i;
  const candidates = root.querySelectorAll([
    '#serviceErrorModal',
    '#globalErrorContainer',
    '[role="dialog"]'
  ].join(','));
  for (const element of candidates) {
    const text = String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text && pattern.test(text) && elementIsVisible(element)) return text;
  }
  return '';
}

function assertNoChaseStatementError() {
  const message = chaseStatementErrorMessage(document);
  if (message) {
    throw new Error('Chase reported that Statements & Documents is temporarily unavailable. Close Chase’s error message, refresh the page, and retry the statement scan.');
  }
}

function statementUiIsLoading(root = document) {
  return [...root.querySelectorAll('#content-spinner-overlay,[id^="spinner-payments-"]')]
    .some(elementIsVisible);
}

function statementPanelIsEmpty(block) {
  const text = String(block?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return /(?:no|don['’]t have any) (?:statements|documents)|nothing to (?:display|show)/i.test(text);
}

async function expandStatementAccount(wantedLast4, year, signal) {
  assertNotCancelled(signal);
  assertNoChaseStatementError();
  let button = await waitFor(
    () => statementAccountButton(document, wantedLast4),
    `Chase did not list the card ending …${wantedLast4} on Statements & Documents.`
  );
  if (button.getAttribute('aria-expanded') !== 'true') button.click();
  await waitFor(() => {
    assertNotCancelled(signal);
    assertNoChaseStatementError();
    button = statementAccountButton(document, wantedLast4);
    if (!button) return false;
    const blockId = button.getAttribute('aria-controls');
    const block = blockId ? document.getElementById(blockId) : null;
    if (!block) return false;
    const documents = extractStatementDocuments(document, wantedLast4);
    if (documents.length) return documents.every((item) => item.statementDate.startsWith(String(year)));
    if (button.getAttribute('aria-expanded') !== 'true') return false;
    return !statementUiIsLoading(block) && statementPanelIsEmpty(block);
  }, `Chase did not finish loading statements for card …${wantedLast4}.`, 30_000);
}

async function selectStatementYear(year, signal) {
  assertNotCancelled(signal);
  assertNoChaseStatementError();
  let item = statementYearOptions().find((candidate) => candidate.year === year);
  if (!item) return false;
  if (selectedStatementYear() !== year) {
    const control = document.querySelector('#header-filterstyledselect-0');
    if (control?.getAttribute('aria-expanded') !== 'true') control?.click();
    item = statementYearOptions().find((candidate) => candidate.year === year) ?? item;
    item.option.click();
  }
  await waitFor(() => {
    assertNotCancelled(signal);
    assertNoChaseStatementError();
    if (selectedStatementYear() !== year) return false;
    if (statementUiIsLoading()) return false;
    const documents = extractStatementDocuments(document);
    return !documents.length || documents.every((item) => item.statementDate.startsWith(String(year)));
  }, `Chase did not finish loading ${year} statements.`);
  await waitWithCancellation(randomDelay(YEAR_SETTLE_DELAY), signal);
  assertNoChaseStatementError();
  return true;
}

async function loadPdfJs() {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = (async () => {
    if (typeof GM === 'undefined' || typeof GM.getResourceText !== 'function') {
      throw new Error('Tampermonkey did not provide the bundled statement parser. Reinstall or update the userscript.');
    }
    const [moduleSource, workerSource] = await Promise.all([
      GM.getResourceText(PDF_RESOURCE),
      GM.getResourceText(PDF_WORKER_RESOURCE)
    ]);
    if (!moduleSource || !workerSource) throw new Error('The bundled statement parser resources are unavailable.');
    const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    try {
      const pdfjs = await import(moduleUrl);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    } catch (error) {
      URL.revokeObjectURL(moduleUrl);
      URL.revokeObjectURL(workerUrl);
      pdfJsPromise = null;
      throw error;
    }
  })();
  return pdfJsPromise;
}

async function parseChaseStatementPdf(bytes, account, fallbackStatementDate = '') {
  const pdfjs = await loadPdfJs();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(pdfTextItemsToLines(content.items));
    }
    return parseChaseStatementPages(pages, account, fallbackStatementDate);
  } finally {
    await pdf.destroy();
  }
}

function secureChaseOrigin(value) {
  if (!String(value ?? '').trim()) return '';
  try {
    const url = new URL(String(value ?? ''), 'https://secure.chase.com/');
    return url.protocol === 'https:' && /^secure(?:[0-9a-z-]+)?\.chase\.com$/i.test(url.hostname)
      ? url.origin
      : '';
  } catch {
    return '';
  }
}

function statementRequestOriginCandidates(context = {}) {
  const pageOrigin = secureChaseOrigin(context.pageOrigin
    ?? (typeof location !== 'undefined' ? location.origin : ''));
  const sources = context.sources ?? (() => {
    const entries = typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
      ? performance.getEntriesByType('resource').map((entry) => entry.name)
      : [];
    const elementUrls = typeof document !== 'undefined'
      ? [...document.querySelectorAll('iframe[src],script[src],link[href]')]
        .map((element) => element.src || element.href)
      : [];
    return [
      typeof location !== 'undefined' ? location.href : '',
      typeof document !== 'undefined' ? document.referrer : '',
      ...entries,
      ...elementUrls
    ];
  })();
  const explicit = new Set();
  const detected = new Set();
  for (const source of sources) {
    try {
      const url = new URL(String(source ?? ''), pageOrigin || 'https://secure.chase.com/');
      const nestedOrigin = secureChaseOrigin(url.searchParams.get('fromOrigin'));
      if (nestedOrigin) explicit.add(nestedOrigin);
      const origin = secureChaseOrigin(url.origin);
      if (origin) detected.add(origin);
    } catch {
      // Ignore unrelated or malformed page resources.
    }
  }
  if (pageOrigin) detected.add(pageOrigin);
  const canonical = 'https://secure.chase.com';
  const nonCanonical = [...detected].filter((origin) => origin !== canonical);
  return [...new Set([
    ...explicit,
    ...(pageOrigin && pageOrigin !== canonical ? [pageOrigin] : []),
    ...nonCanonical,
    ...(pageOrigin === canonical ? [pageOrigin] : []),
    canonical
  ])];
}

function statementHttpError(status) {
  const error = new Error(`Chase returned HTTP ${status} for this statement.`);
  error.status = status;
  error.retryable = status === 408 || status === 429 || status >= 500;
  return error;
}

function validateStatementPdfBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  if (signature !== '%PDF') {
    const error = new Error('Chase did not return a PDF. The session may have expired.');
    error.retryable = true;
    throw error;
  }
  return bytes;
}

function pageFetch() {
  if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.fetch === 'function') {
    return unsafeWindow.fetch.bind(unsafeWindow);
  }
  return fetch.bind(globalThis);
}

function statementAuthorizationError(message, status = 401) {
  const error = statementHttpError(status);
  error.message = message;
  error.authorization = true;
  return error;
}

function nextClientRequestId(previous = '') {
  const generated = globalThis.crypto?.randomUUID?.() ?? '';
  if (!generated) return previous;
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  return uuidPattern.test(previous) ? previous.replace(uuidPattern, generated) : generated;
}

function statementAccessBody(item) {
  const body = new URLSearchParams();
  body.set('accountFilter', item.accountDocumentId);
  body.set('dateFilter.idalDateFilterType', 'CURRENT_YEAR');
  body.set('documentId', item.documentId);
  return body;
}

function statementPdfUrlFromAccess(payload, context = {}) {
  const code = String(payload?.code ?? 'SUCCESS').toUpperCase();
  if (code !== 'SUCCESS') throw new Error(`Chase could not authorize this statement (${code}).`);
  const docKey = String(payload?.docKey ?? '').trim();
  if (!docKey) throw new Error('Chase did not provide an authorized document key.');
  const rawUri = String(payload?.docURI ?? payload?.docUri ?? DEFAULT_PDF_PATH).trim();
  let url;
  try {
    url = new URL(rawUri || DEFAULT_PDF_PATH, 'https://secure.chase.com');
  } catch {
    throw new Error('Chase returned an invalid statement document address.');
  }
  if (!secureChaseOrigin(url.origin) || !/^\/svc\/rr\/documents\/secure\/idal\//i.test(url.pathname)) {
    throw new Error('Chase returned an unexpected statement document address.');
  }
  if (!url.searchParams.get('docKey')) url.searchParams.set('docKey', docKey);
  if (!url.searchParams.get('download')) url.searchParams.set('download', 'false');
  if (!url.searchParams.get('adaVersion')) url.searchParams.set('adaVersion', 'false');
  const csrfToken = String(payload?.csrfToken ?? payload?.csrftoken ?? context.csrfToken ?? '').trim();
  if (csrfToken && ![...url.searchParams.keys()].some((key) => key.toLowerCase() === 'csrftoken')) {
    url.searchParams.set('csrfToken', csrfToken);
  }
  const fromOrigin = secureChaseOrigin(context.fromOrigin);
  if (fromOrigin && !url.searchParams.get('fromOrigin')) url.searchParams.set('fromOrigin', fromOrigin);
  return url;
}

async function authorizeStatementDocument(item, signal) {
  const auth = chaseRequestContext();
  if (!auth?.csrfToken) {
    throw statementAuthorizationError(
      'Chase’s current document authorization token was not available. Reload Chase, then retry the statement scan.'
    );
  }
  if (!item.accountDocumentId) {
    throw new Error('Chase did not expose the selected card’s statement account identifier.');
  }
  const requestId = nextClientRequestId(auth.clientRequestId);
  if (!requestId) {
    throw statementAuthorizationError(
      'Chase’s current document request context was incomplete. Reload Chase, then retry the statement scan.'
    );
  }
  const response = await pageFetch()(new URL(DOCUMENT_ACCESS_PATH, 'https://secure.chase.com').href, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Jpmc-Channel': auth.channel || 'WEB',
      'X-Jpmc-Client-Request-Id': requestId,
      'X-Jpmc-Csrf-Token': auth.csrfToken
    },
    body: statementAccessBody(item).toString()
  });
  if (!response.ok) throw statementHttpError(response.status);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Chase did not return a valid statement authorization response.');
  }
  const fromOrigin = statementRequestOriginCandidates()[0] || 'https://secure.chase.com';
  return statementPdfUrlFromAccess(payload, { csrfToken: auth.csrfToken, fromOrigin });
}

async function fetchAuthorizedStatementPdf(item, signal) {
  const url = await authorizeStatementDocument(item, signal);
  const response = await pageFetch()(url.href, {
    credentials: 'include',
    signal,
    headers: { Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8' }
  });
  if (!response.ok) throw statementHttpError(response.status);
  return validateStatementPdfBytes(await response.arrayBuffer());
}

function isRetryableStatementFetchError(error) {
  if (!error || error.name === 'AbortError') return false;
  return error.retryable === true || ['TypeError', 'NetworkError', 'TimeoutError'].includes(error.name);
}

async function fetchStatementPdfWithRetry(item, options = {}) {
  const { signal, onRetry = () => {} } = options;
  for (let attempt = 0; ; attempt += 1) {
    assertNotCancelled(signal);
    try {
      return await fetchAuthorizedStatementPdf(item, signal);
    } catch (error) {
      const baseDelay = PDF_RETRY_DELAYS[attempt];
      if (baseDelay == null || !isRetryableStatementFetchError(error)) throw error;
      const delay = Math.round(baseDelay * (0.9 + (Math.random() * 0.2)));
      onRetry({ attempt: attempt + 2, delay, error });
      await waitWithCancellation(delay, signal);
    }
  }
}

function daysBetween(left, right) {
  const start = new Date(`${left}T00:00:00Z`);
  const end = new Date(`${right}T00:00:00Z`);
  return Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) ? Infinity : Math.round((end - start) / 86_400_000);
}

function mergeStatementCoverage(existing = {}, results = [], context = {}) {
  const periodMap = new Map((existing.periods ?? []).map((period) => [period.statementDate, period]));
  for (const result of results) periodMap.set(result.statementDate, {
    parserVersion: result.parserVersion,
    openingDate: result.openingDate,
    closingDate: result.closingDate,
    statementDate: result.statementDate,
    purchaseTotalCents: result.purchaseTotalCents,
    transactionCount: result.transactionCount
  });
  const periods = [...periodMap.values()].filter((period) => period.openingDate && period.closingDate)
    .sort((left, right) => left.openingDate.localeCompare(right.openingDate));
  const gaps = [];
  for (let index = 1; index < periods.length; index += 1) {
    const gapDays = daysBetween(periods[index - 1].closingDate, periods[index].openingDate);
    if (gapDays > 2) gaps.push({ after: periods[index - 1].closingDate, before: periods[index].openingDate });
  }
  const earliest = periods[0]?.openingDate ?? null;
  const latest = periods.at(-1)?.closingDate ?? null;
  const benefitStartDate = context.benefitStartDate || existing.benefitStartDate || '';
  const activityEarliest = context.activityEarliest || existing.activityEarliest || '';
  const startCovered = Boolean(benefitStartDate && earliest && earliest <= benefitStartDate);
  const endCovered = Boolean(activityEarliest && latest && latest >= activityEarliest);
  return {
    periods,
    statementCount: periods.length,
    earliest,
    latest,
    gaps,
    benefitStartDate,
    activityEarliest,
    complete: startCovered && endCovered && gaps.length === 0,
    updatedAt: new Date().toISOString()
  };
}

async function collectChaseStatementBackfill(options) {
  const {
    account,
    benefitStartDate,
    activityEarliest,
    importedStatementDates = [],
    progress = () => {},
    onResult = async () => {},
    onFailure = async () => {},
    signal
  } = options;
  if (!account?.last4) throw new Error('The Hyatt card must have a last four before statements can be matched.');
  if (!benefitStartDate) throw new Error('Enter when the current Hyatt benefits began before starting a statement backfill.');
  if (!activityEarliest) throw new Error('Refresh or import the recent Chase activity before backfilling older statements.');

  const originalPath = dashboardPath();
  const originalHash = location.hash;
  const imported = new Set(importedStatementDates);
  try {
    progress('Opening Chase Statements & Documents…');
    if (!location.hash.includes('/dashboard/documents/myDocs/')) location.hash = statementRoute();
    await waitFor(() => statementYearOptions().length, 'Chase Statements & Documents did not finish loading.', 30_000);

    const startYear = Number(benefitStartDate.slice(0, 4));
    const endYear = Number(activityEarliest.slice(0, 4));
    const years = statementYearOptions().map((item) => item.year)
      .filter((year) => year >= startYear && year <= endYear)
      .sort((left, right) => left - right);
    if (!years.length) throw new Error('No available statement years overlap the missing Hyatt history.');

    const documents = new Map();
    for (const year of years) {
      assertNotCancelled(signal);
      assertNoChaseStatementError();
      progress(`Finding ${year} statements for …${account.last4}…`);
      await selectStatementYear(year, signal);
      await expandStatementAccount(account.last4, year, signal);
      for (const item of extractStatementDocuments(document, account.last4)) {
        documents.set(item.statementDate, item);
      }
    }

    const wanted = [...documents.values()].filter((item) => {
      const closingDate = `${item.statementDate.slice(0, 4)}-${item.statementDate.slice(4, 6)}-${item.statementDate.slice(6, 8)}`;
      return closingDate >= benefitStartDate && !imported.has(closingDate);
    }).sort((left, right) => left.statementDate.localeCompare(right.statementDate));
    assertNoChaseStatementError();
    if (!documents.size) throw new Error(`No statements matched Hyatt card …${account.last4}.`);
    if (!wanted.length) return { results: [], failures: [], discovered: documents.size };

    const results = [];
    const failures = [];
    for (let index = 0; index < wanted.length; index += 1) {
      assertNotCancelled(signal);
      const item = wanted[index];
      const displayDate = `${item.statementDate.slice(0, 4)}-${item.statementDate.slice(4, 6)}-${item.statementDate.slice(6, 8)}`;
      progress(`Parsing statement ${index + 1} of ${wanted.length} (${displayDate})…`);
      try {
        const bytes = await fetchStatementPdfWithRetry(item, {
          signal,
          onRetry: ({ attempt, delay }) => progress(
            `Chase temporarily rejected ${displayDate}; retrying in ${Math.ceil(delay / 1_000)} seconds (attempt ${attempt} of 3)…`
          )
        });
        const result = await parseChaseStatementPdf(bytes, account, item.statementDate);
        results.push(result);
        imported.add(result.statementDate);
        await onResult(result, { completed: index + 1, total: wanted.length });
      } catch (error) {
        if ([401, 403].includes(error?.status)) {
          throw new Error(
            `${error?.message || `Chase rejected the statement request (HTTP ${error.status}).`} The scan stopped after the first authorization failure instead of requesting the remaining PDFs. Reload Chase, sign in again if prompted, and retry.`
          );
        }
        const failure = { statementDate: displayDate, message: error?.message || String(error) };
        failures.push(failure);
        await onFailure(failure, { completed: index + 1, total: wanted.length });
      }
      if (index < wanted.length - 1) {
        await waitWithCancellation(randomDelay(PDF_REQUEST_DELAY), signal);
      }
    }
    return { results, failures, discovered: documents.size };
  } finally {
    if (location.pathname + location.search === originalPath && location.hash !== originalHash) location.hash = originalHash;
  }
}

// end packages/chase-core/app/chase-statements.js

// ---- apps/hyatt/products.js ----
const HYATT_PRODUCT_RULES = Object.freeze([
  {
    id: 'hyatt-business',
    type: 'business',
    names: [/world\s+of\s+hyatt\s+business/i, /hyatt\s+business/i],
    label: 'World of Hyatt Business Credit Card',
    thresholdCents: 1_000_000,
    nightsPerThreshold: 5,
    baseNights: 0,
    counterWindow: 'calendar-year'
  },
  {
    id: 'hyatt-personal',
    type: 'personal',
    names: [/world\s+of\s+hyatt/i, /hyatt(?!\s+business)/i],
    label: 'World of Hyatt Credit Card',
    thresholdCents: 500_000,
    nightsPerThreshold: 2,
    baseNights: 5,
    counterWindow: 'lifetime',
    annualFreeNightThresholdCents: 1_500_000
  }
]);

function identifyHyattProduct(accountOrName) {
  const text = typeof accountOrName === 'string'
    ? accountOrName
    : `${accountOrName?.name ?? ''} ${accountOrName?.productName ?? ''}`;
  return HYATT_PRODUCT_RULES.find((rule) => rule.names.some((pattern) => pattern.test(text))) ?? null;
}

function getHyattProductRule(productId, fallbackName = '') {
  return HYATT_PRODUCT_RULES.find((rule) => rule.id === productId) ?? identifyHyattProduct(fallbackName);
}

function isHyattAccount(account) {
  return Boolean(identifyHyattProduct(account));
}

// end apps/hyatt/products.js

// ---- apps/hyatt/calculations.js ----
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

function hyattTransactionQualifies(transaction) {
  if (!transaction || isPending(transaction)) return false;
  if (['payment', 'non_purchase'].includes(transaction.kind)) return false;
  if (EXCLUDED_PURCHASE.test(transaction.description ?? '')) return false;
  return Number.isFinite(transaction.spendCents) && transaction.spendCents !== 0;
}

function coverageFor(state, account) {
  const activity = state.coverage?.[account.id]?.activity ?? null;
  const statements = state.coverage?.[account.id]?.statements ?? null;
  const ownTransactions = (state.transactions ?? []).filter((transaction) => belongsToAccount(transaction, account));
  const dates = ownTransactions.map((transaction) => transaction.date).filter(Boolean).sort();
  return {
    activity,
    statements,
    listEndVerified: Boolean(activity?.complete),
    earliest: activity?.earliest ?? dates[0] ?? null,
    latest: activity?.latest ?? dates.at(-1) ?? null,
    rowCount: activity?.rowCount ?? ownTransactions.length
  };
}

function calendarHistoryVerified(config, coverage, year, benefitStartDate = '') {
  const yearStart = `${year}-01-01`;
  if (Number(config.yearHistoryConfirmed) === year) return true;
  if (benefitStartDate && benefitStartDate >= yearStart) return Boolean(config.historyConfirmed);
  if (coverage.listEndVerified) return true;
  return Boolean(coverage.earliest && coverage.earliest <= yearStart);
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

function calculateHyattCardMetrics(account, transactions, config = {}, coverage = {}, asOf = new Date()) {
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

function calculateAllHyattCards(state, asOf = new Date()) {
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

// end apps/hyatt/calculations.js

// ---- apps/hyatt/setup.js ----
function normalizeHyattSetup(account, input, existing = {}, asOf = new Date(), coverage = {}) {
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

// end apps/hyatt/setup.js

// ---- apps/hyatt/ui.js ----
const DISCORD_ICON = '<svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83A97.68 97.68 0 0 0 49 6.83 72.37 72.37 0 0 0 45.64 0 105.89 105.89 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15A77.7 77.7 0 0 0 39.6 87a68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2 20.89 9.77 43.56 9.77 64.2 0 .87.71 1.76 1.39 2.66 2A70.17 70.17 0 0 1 87.4 87a77.48 77.48 0 0 0 6.89 9.34 105.25 105.25 0 0 0 32.17-16.16C129.1 52.84 122 29.1 107.7 8.07ZM42.45 65.69c-9.95 0-18.11-9.11-18.11-20.35S32.3 25 42.45 25s18.27 9.19 18.1 20.34c0 11.24-8.04 20.35-18.1 20.35Zm42.24 0c-10 0-18.11-9.11-18.11-20.35S74.54 25 84.69 25 103 34.17 102.8 45.34c0 11.24-8.05 20.35-18.11 20.35Z"/></svg>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function money(cents, digits = 0) {
  if (!Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(cents / 100);
}

function formatUpdated(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.valueOf()) || !value ? 'Never' : date.toLocaleString();
}

function displayAccountName(name) {
  return String(name ?? 'World of Hyatt card').replace(/\s*\((?:\.{3}|…)[\s-]*\d{4}\)\s*$/u, '').trim();
}

function statusBadge(metric) {
  const status = metric.setupStatus;
  if (status === 'verified-full') return '<span class="badge good">✓ full history</span>';
  if (status === 'verified-baseline') return '<span class="badge good">✓ Chase baseline</span>';
  if (status === 'estimated-award-date') return '<span class="badge warn">estimated from last award</span>';
  if (status === 'setup-needed') return '<span class="badge warn">setup needed</span>';
  return metric.yearHistoryVerified
    ? '<span class="badge good">✓ calendar-year history</span>'
    : '<span class="badge warn">year coverage unverified</span>';
}

function progressBar(current, threshold) {
  const percent = threshold ? Math.max(0, Math.min(100, (Number(current) || 0) / threshold * 100)) : 0;
  return `<div class="progress" aria-label="${percent.toFixed(0)} percent"><span style="width:${percent}%"></span></div>`;
}

function personalCard(metric) {
  const ready = metric.progressCents !== null;
  const nextSpend = ready ? metric.rule.thresholdCents - metric.progressCents : null;
  const year = metric.yearWindow.start.slice(0, 4);
  const freeProgress = Math.min(metric.currentYearSpendCents, metric.annualFreeNightThresholdCents);
  const nights = metric.cardNightsYtd === null ? '—' : metric.cardNightsYtd.toLocaleString();
  const countLabel = metric.cardNightsYtd === null
    ? 'YTD night count needs verified current-year history'
    : `${metric.baseNights} base + ${metric.spendNightsYtd} from spend`;
  return `<article class="card">
    <div class="card-title-row">
      <div><h3>${escapeHtml(displayAccountName(metric.account.name))} <span class="last4">(…${escapeHtml(metric.account.last4)})</span></h3><p>Personal card · rolling lifetime counter</p></div>
      <div class="nights"><strong>${nights}</strong><span>card nights in ${year}</span></div>
    </div>
    <div class="rule-row"><strong>2 elite nights per $5,000</strong>${statusBadge(metric)}${ready ? `<button class="inline-link" data-setup="${escapeHtml(metric.account.id)}">Edit setup</button>` : ''}</div>
    ${ready ? `${progressBar(metric.progressCents, metric.rule.thresholdCents)}
      <div class="spend-line"><strong>${money(metric.progressCents)}</strong> / ${money(metric.rule.thresholdCents)} toward the next 2 nights · <span class="muted">${money(nextSpend)} remaining</span></div>`
      : `<div class="setup-callout"><span>Choose how to initialize the rolling $5,000 counter before relying on this total.</span><button class="primary" data-setup="${escapeHtml(metric.account.id)}">Set up card</button></div>`}
    <div class="breakdown"><span>${escapeHtml(countLabel)}</span><strong>${metric.qualifyingTransactionCount} qualifying transactions</strong></div>
    <div class="certificate">
      <div><strong>Extra Category 1–4 free night${metric.yearHistoryVerified ? '' : ' <em>(coverage unverified)</em>'}</strong><span>${money(freeProgress)} / ${money(metric.annualFreeNightThresholdCents)} calendar-year spend</span></div>
      ${progressBar(freeProgress, metric.annualFreeNightThresholdCents)}
    </div>
  </article>`;
}

function businessCard(metric) {
  const year = metric.yearWindow.start.slice(0, 4);
  const nextSpend = metric.rule.thresholdCents - metric.progressCents;
  return `<article class="card">
    <div class="card-title-row">
      <div><h3>${escapeHtml(displayAccountName(metric.account.name))} <span class="last4">(…${escapeHtml(metric.account.last4)})</span></h3><p>Business card · counter resets January 1</p></div>
      <div class="nights"><strong>${metric.cardNightsYtd.toLocaleString()}</strong><span>card nights in ${year}</span></div>
    </div>
    <div class="rule-row"><strong>5 elite nights per $10,000</strong>${statusBadge(metric)}</div>
    ${progressBar(metric.progressCents, metric.rule.thresholdCents)}
    <div class="spend-line"><strong>${money(metric.progressCents)}</strong> / ${money(metric.rule.thresholdCents)} toward the next 5 nights · <span class="muted">${money(nextSpend)} remaining</span></div>
    <div class="breakdown"><span>${money(metric.currentYearSpendCents)} qualifying spend in ${year}</span><strong>${metric.qualifyingTransactionCount} qualifying transactions</strong></div>
    ${metric.yearHistoryVerified ? '' : `<div class="coverage-note"><span>This imported or partial history may omit ${year} purchases. Confirm it includes every posted transaction since January 1.</span><button class="primary" data-confirm-year="${escapeHtml(metric.account.id)}">Confirm ${year} complete</button></div>`}
  </article>`;
}

function emptySummary() {
  return `<section class="empty"><div class="empty-icon">◆</div><h2>Ready to find your Hyatt cards</h2>
    <p>Start on Chase’s Accounts dashboard, then choose <strong>Refresh</strong>. The tracker will visit each supported World of Hyatt card and load every transaction Chase exposes.</p>
    <button class="primary large" data-action="sync">Refresh Hyatt cards</button>
    <p class="small">You can also open Debug and import Chase transaction CSV files.</p></section>`;
}

function summaryView(metrics) {
  return `<section class="summary-intro"><p>Elite-night totals are calculated from posted qualifying purchases minus returns. Chase and Hyatt remain authoritative.</p></section>
    <section class="cards">${metrics.map((metric) => metric.rule.type === 'personal' ? personalCard(metric) : businessCard(metric)).join('')}</section>`;
}

function findHyattSetupTarget(metrics) {
  return metrics.find((metric) => metric.setupStatus === 'setup-needed') ?? null;
}

function buildHyattDetailRows(metrics, filters = { cardId: 'all', mode: 'eligible' }) {
  return metrics.flatMap((metric) => metric.periodTransactions.map((transaction) => ({
    metric,
    transaction,
    eligible: hyattTransactionQualifies(transaction)
  }))).filter((row) => {
    if (filters.cardId !== 'all' && String(row.metric.account.id) !== String(filters.cardId)) return false;
    if (filters.mode === 'eligible') return row.eligible;
    if (filters.mode === 'excluded') return !row.eligible;
    if (filters.mode === 'refunds') return row.eligible && row.transaction.spendCents < 0;
    return true;
  }).sort((left, right) => right.transaction.date.localeCompare(left.transaction.date));
}

function detailView(metrics, filters) {
  const allRows = buildHyattDetailRows(metrics, { cardId: filters.cardId, mode: 'all' });
  const rows = buildHyattDetailRows(metrics, filters);
  const count = (mode) => buildHyattDetailRows(metrics, { cardId: filters.cardId, mode }).length;
  const cardButtons = [{ id: 'all', label: 'All cards', count: buildHyattDetailRows(metrics, { cardId: 'all', mode: filters.mode }).length }]
    .concat(metrics.map((metric) => ({
      id: String(metric.account.id), label: `…${metric.account.last4}`,
      count: buildHyattDetailRows(metrics, { cardId: String(metric.account.id), mode: filters.mode }).length
    })));
  const modes = [
    { id: 'eligible', label: 'Qualifying', count: count('eligible') },
    { id: 'excluded', label: 'Excluded/other', count: count('excluded') },
    { id: 'refunds', label: 'Refunds', count: count('refunds') },
    { id: 'all', label: 'All activity', count: allRows.length }
  ];
  const table = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Card</th><th>Merchant</th><th class="right">Spend</th><th>Hyatt threshold</th></tr></thead><tbody>${rows.map(({ metric, transaction, eligible }) => `<tr>
    <td>${escapeHtml(transaction.date)}</td><td class="card-pill">…${escapeHtml(metric.account.last4)}</td><td class="merchant">${escapeHtml(transaction.description)}</td>
    <td class="right ${transaction.spendCents < 0 ? 'credit' : ''}">${money(transaction.spendCents, 2)}</td>
    <td><span class="verify ${eligible ? 'good' : 'neutral'}">${eligible ? transaction.spendCents < 0 ? 'Subtracts' : 'Counts' : 'Excluded'}</span></td>
  </tr>`).join('')}</tbody></table></div>` : '<div class="detail-empty">No transactions match this filter.</div>';
  return `<section class="detail-review">
    <div class="detail-heading"><div><h2>Transaction review</h2><p>Current calendar year; pending transactions are excluded.</p></div><strong>${rows.length} shown</strong></div>
    <div class="filter-group">${cardButtons.map((item) => `<button class="filter-chip ${filters.cardId === item.id ? 'active' : ''}" data-detail-card="${escapeHtml(item.id)}">${escapeHtml(item.label)} <span>${item.count}</span></button>`).join('')}</div>
    <div class="filter-group modes">${modes.map((item) => `<button class="filter-chip ${filters.mode === item.id ? 'active' : ''}" data-detail-mode="${item.id}">${item.label} <span>${item.count}</span></button>`).join('')}</div>
    <p class="detail-note">The export identifies payments, credits, fees, and common cash-like transactions. Review unusual transactions because Chase makes the final eligibility determination.</p>
    ${table}
  </section>`;
}

function setupNarrative(metric) {
  const earliest = metric.coverage.earliest;
  const gap = metric.openingGapDays;
  if (!earliest) return 'No posted transaction was captured yet. A card can still have complete history with zero purchases.';
  if (!Number.isFinite(gap)) return `The oldest captured transaction is ${escapeHtml(earliest)}. Enter when this card began earning the current Hyatt benefits.`;
  if (gap < 0) return `Captured activity begins before the entered Hyatt benefit date. Transactions before that date will be ignored.`;
  if (gap <= 60) return `The first captured transaction is ${gap} day${gap === 1 ? '' : 's'} after the current Hyatt benefits began. That is within the normal first-purchase setup window.`;
  return `The first captured transaction is ${gap} days after the current Hyatt benefits began. Confirm there really were no earlier qualifying purchases, or use a Chase baseline.`;
}

function statementCoverageSummary(metric) {
  const coverage = metric.coverage.statements;
  if (!coverage?.statementCount) {
    return '<span>No older statements imported yet.</span>';
  }
  const range = coverage.earliest && coverage.latest
    ? `${formatMonthYear(coverage.earliest)} – ${formatMonthYear(coverage.latest)}`
    : 'date range unavailable';
  const issue = coverage.gaps?.length
    ? ` · ${coverage.gaps.length} gap${coverage.gaps.length === 1 ? '' : 's'} remaining`
    : '';
  return `<span><strong>${coverage.statementCount} verified statement${coverage.statementCount === 1 ? '' : 's'}</strong> · ${escapeHtml(range)}${issue}</span>`;
}

function personalSetup(metric, options = {}) {
  const config = metric.config ?? {};
  const mode = config.historyMode ?? 'full';
  const baselineDollars = Number.isFinite(config.baselineProgressCents) ? (config.baselineProgressCents / 100).toFixed(2) : '';
  const benefitStartDate = options.benefitStartDate ?? config.benefitStartDate ?? '';
  const statementCoverage = metric.coverage.statements ?? {};
  const activityEarliest = metric.coverage.activity?.earliest ?? statementCoverage.activityEarliest ?? '';
  const statementHistoryComplete = Boolean(
    statementCoverage.earliest
    && benefitStartDate
    && statementCoverage.earliest <= benefitStartDate
    && activityEarliest
    && statementCoverage.latest >= activityEarliest
    && !statementCoverage.gaps?.length
  );
  return `<section class="setup-view"><button class="back-link" data-action="setup-back">← Back to summary</button>
    <h2>Set up …${escapeHtml(metric.account.last4)}</h2>
    <p class="setup-lead">The personal card’s $5,000 counter rolls forward for the life of the card. Choose the strongest starting information you have.</p>
    <form data-setup-form data-account-id="${escapeHtml(metric.account.id)}" data-product-type="personal">
      <label><span>Current Hyatt benefits began</span><small class="field-help">Usually the date you opened this Hyatt card. If you product-changed or converted into it, use the effective change date instead—not the first-purchase or anniversary date.</small><input type="date" name="benefitStartDate" value="${escapeHtml(benefitStartDate)}" required></label>
      <p class="coverage-summary" data-opening-summary data-earliest="${escapeHtml(metric.coverage.earliest ?? '')}">${setupNarrative(metric)}</p>
      <label><span>Initialization method</span><select name="historyMode">
        <option value="full" ${mode === 'full' ? 'selected' : ''}>Complete transaction history</option>
        <option value="baseline" ${mode === 'baseline' ? 'selected' : ''}>Exact Chase baseline</option>
        <option value="estimate" ${mode === 'estimate' ? 'selected' : ''}>Last 2-night award date (estimate)</option>
      </select></label>
      <div class="mode-panel" data-for-mode="full">
        <div class="method-note"><strong>Full history</strong><span>We calculate lifetime qualifying spend modulo $5,000.</span></div>
        <div class="statement-backfill ${statementHistoryComplete ? 'complete' : ''}">
          <div><strong>${statementHistoryComplete ? '✓ Full history verified from Chase statements' : 'Older history from monthly statements'}</strong>
          <p>Run this after the normal Refresh. The optional one-time scan opens Chase Statements &amp; Documents, selects every needed year, expands this card, and reads the monthly PDFs Chase still provides (normally up to seven years). It fetches each PDF directly in your signed-in Chase session, so it will not open PDF viewer windows.</p>
          <div class="statement-coverage">${statementCoverageSummary(metric)}</div></div>
          <div class="statement-actions">${options.statementBusy
            ? '<button type="button" data-action="cancel-statements">Cancel scan</button>'
            : '<button type="button" class="primary" data-action="backfill-statements">Scan older Chase statements</button><button type="button" data-action="import-statements">Import downloaded PDFs</button>'}</div>
        </div>
        <label class="check"><input type="checkbox" name="historyConfirmed" ${(config.historyConfirmed || statementHistoryComplete) ? 'checked' : ''} ${statementHistoryComplete ? 'disabled' : ''}><span>${statementHistoryComplete ? 'The statement scan and recent activity form a continuous history from the Hyatt benefit start date.' : 'I confirm there were no qualifying purchases before the oldest captured transaction.'}</span></label>
      </div>
      <div class="mode-panel" data-for-mode="baseline">
        <div class="method-note"><strong>Chase baseline</strong><span>Use a Chase secure message to ask how much spend remains before the next two qualifying nights.</span></div>
        <label><span>Baseline is accurate through</span><input type="date" name="baselineDate" value="${escapeHtml(config.baselineDate ?? '')}"></label>
        <div class="inline-fields"><label><span>Amount represents</span><select name="baselineAmountType"><option value="progress">Progress already accumulated</option><option value="remaining">Remaining until next 2 nights</option></select></label>
        <label><span>Amount</span><input type="number" name="baselineAmount" min="0" max="5000" step="0.01" value="${escapeHtml(baselineDollars)}" placeholder="0.00"></label></div>
        <label class="check"><input type="checkbox" name="baselineHistoryConfirmed" ${config.baselineHistoryConfirmed ? 'checked' : ''}><span>I confirm every posted transaction after the baseline date is included in the tracker.</span></label>
        <label class="check"><input type="checkbox" name="yearHistoryConfirmed" ${Number(config.yearHistoryConfirmed) === new Date().getFullYear() ? 'checked' : ''}><span>I confirm the captured activity covers January 1 through the baseline date, so this year’s earned-night total can also be calculated.</span></label>
      </div>
      <div class="mode-panel" data-for-mode="estimate">
        <div class="method-note warn"><strong>Estimated initialization</strong><span>The threshold-crossing purchase may have left unmeasured rollover, so progress will remain labeled estimated.</span></div>
        <label><span>Date of last 2-night award or threshold transaction</span><input type="date" name="lastAwardDate" value="${escapeHtml(config.lastAwardDate ?? '')}"></label>
      </div>
      <div class="setup-actions"><button type="submit" class="primary">Save setup</button><button type="button" data-action="setup-back">Cancel</button></div>
    </form>
  </section>`;
}

function setupView(metric, options) {
  return personalSetup(metric, options);
}

function itemDateRange(items) {
  const dates = items.map((item) => item.date).filter(Boolean).sort();
  return dates.length ? `${formatMonthYear(dates[0])} – ${formatMonthYear(dates.at(-1))}` : 'No rows';
}

function debugView(state, captureStatus) {
  const rows = (state.accounts ?? []).map((account) => {
    const coverage = state.coverage?.[account.id]?.activity ?? {};
    const statements = state.coverage?.[account.id]?.statements ?? {};
    const transactions = (state.transactions ?? []).filter((transaction) => String(transaction.accountId) === String(account.id));
    const statementText = statements.statementCount
      ? `${statements.statementCount} verified statement${statements.statementCount === 1 ? '' : 's'} (${formatMonthYear(statements.earliest)} – ${formatMonthYear(statements.latest)})${statements.complete ? ' · continuous to recent activity' : ''}`
      : 'No statement backfill';
    return `<div><dt>${escapeHtml(displayAccountName(account.name))} …${escapeHtml(account.last4)}</dt><dd>${coverage.complete ? 'List end verified' : 'Unverified'} · ${itemDateRange(transactions)}<br>${escapeHtml(statementText)}</dd></div>`;
  }).join('');
  return `<div class="debug-grid">
    <section><h2>Local data</h2><dl>
      <div><dt>Hyatt cards</dt><dd>${state.accounts?.length ?? 0}</dd></div><div><dt>Transactions</dt><dd>${state.transactions?.length ?? 0}</dd></div>
      <div><dt>Activity coverage</dt><dd>${itemDateRange(state.transactions ?? [])}</dd></div><div><dt>Captured payloads</dt><dd>${state.captureStats?.payloads ?? 0}</dd></div>
      <div><dt>Network listener</dt><dd>${captureStatus?.installed ? 'Active' : 'Fallback only'}</dd></div>
    </dl></section>
    <section><h2>Data controls</h2><p>CSV imports cover recent activity. Personal-card setup can optionally scan older monthly statement PDFs.</p><div class="action-stack">
      <button data-action="import">Import Chase CSV</button><button data-action="export">Export tracker JSON</button><button class="danger" data-action="clear">Clear Hyatt tracker data</button>
    </div></section>
    <section class="wide"><h2>Coverage by card</h2><dl class="coverage-list">${rows || '<div><dt>No cards</dt><dd>None</dd></div>'}</dl></section>
    <section class="wide"><h2>Privacy boundary</h2><p>Only normalized card identifiers, dates, descriptions, amounts, categories, statement coverage dates, and setup values are stored locally through Tampermonkey. Raw Chase responses, statement PDFs, document keys, full account numbers, and authentication data are never persisted.</p></section>
  </div>`;
}

function syncingView() {
  return '<section class="syncing-view"><div class="spinner"></div><h2>Refreshing Hyatt cards</h2><p>The current tab will briefly visit each card’s activity page. Totals are committed only after every card finishes.</p></section>';
}

const STYLES = `
  :host { all: initial; color-scheme: light; } *, *::before, *::after { box-sizing: border-box; }
  button, input, select { font: inherit; } h2, h3, p { margin: 0; }
  .launcher { position: fixed; right: 22px; bottom: 74px; z-index: 2147483645; border: 0; border-radius: 999px; padding: 11px 16px; background: #0b5363; color: #fff; font: 700 14px/1.2 system-ui,sans-serif; box-shadow: 0 6px 24px #001b3c55; cursor: pointer; }
  .launcher:hover { background: #073e4b; transform: translateY(-1px); }
  .backdrop { position: fixed; inset: 0; z-index: 2147483646; display: none; align-items: flex-start; justify-content: center; padding: min(4vh,34px) 18px; background: #07192f4d; font: 13px/1.42 Inter,"Open Sans",system-ui,sans-serif; color: #24282d; }
  .backdrop.open { display: flex; } .modal { width: min(960px,calc(100vw - 24px)); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #aab4c0; border-radius: 10px; background: #fff; box-shadow: 0 18px 55px #00142f55; }
  .header { min-height: 64px; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: linear-gradient(135deg,#0f5664,#123e72); color:#fff; }
  .brand { display:flex; align-items:baseline; gap:9px; margin-right:auto; min-width:250px; } .brand strong { font-size:14px; white-space:nowrap; } .version { font-size:10px; opacity:.65; }
  .creator { display:inline-flex; align-items:center; gap:3px; color:#fff; font-size:10px; opacity:.68; text-decoration:none; white-space:nowrap; } .creator:hover { opacity:1; text-decoration:underline; } .creator svg { width:11px; height:11px; fill:currentColor; }
  .controls { display:flex; gap:8px; align-items:center; } button { border:1px solid #c5ccd4; border-radius:6px; padding:7px 12px; background:#fff; color:#173e62; cursor:pointer; } button:hover { background:#eff6f7; }
  .header button { border-color:#ffffff26; background:#ffffff19; color:#fff; } .header button:hover { background:#ffffff2b; } .header button.active { background:#fff; color:#16455e; } .header .icon { width:32px; padding:7px; font-weight:800; }
  .primary { border-color:#0d6374; background:#0d6374; color:#fff; font-weight:700; } .primary:hover { background:#084c5a; } .large { padding:10px 16px; }
  .updated { padding:10px 14px 6px; color:#505861; background:#fff; } .status { display:none; margin:0 14px 10px; padding:9px 11px; border-radius:6px; background:#e7f3f5; color:#155162; } .status.show { display:block; } .status.error { background:#fbe9e9; color:#8e2424; }
  .body { min-height:220px; overflow:auto; padding:0 14px 14px; background:#fff; } .summary-intro { margin-bottom:10px; color:#65717c; } .cards { display:grid; gap:11px; }
  .card { border:1px solid #dce3e7; border-radius:10px; padding:14px; background:#fff; box-shadow:0 1px 3px #0b223810; } .card-title-row { display:flex; justify-content:space-between; gap:18px; } h3 { color:#25292e; font-size:16px; } .card-title-row p { margin-top:2px; color:#747b82; font-style:italic; } .last4 { font-weight:500; color:#5b626a; }
  .nights { min-width:140px; text-align:right; color:#123e72; } .nights strong,.nights span { display:block; } .nights strong { font-size:22px; } .nights span { color:#72777e; font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
  .rule-row { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-top:10px; color:#3f4449; font-size:14px; } .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; } .badge.good { background:#e0f1e5; color:#246c3a; } .badge.warn { background:#fff0d7; color:#895000; } .inline-link { padding:1px 3px; border:0; background:transparent; color:#0d6374; font-size:11px; text-decoration:underline; text-underline-offset:2px; } .inline-link:hover { background:transparent; color:#084a57; }
  .progress { height:8px; margin:6px 0 4px; overflow:hidden; border-radius:99px; background:#eceeef; } .progress span { display:block; min-width:3px; height:100%; border-radius:inherit; background:linear-gradient(90deg,#32a59c,#cf9c2d); }
  .spend-line { padding-bottom:7px; border-bottom:1px dashed #d6dce1; color:#3d4247; } .spend-line strong { color:#123e72; } .muted { color:#7b8086; }
  .breakdown { display:flex; justify-content:space-between; gap:12px; padding-top:7px; color:#65707b; } .breakdown strong { color:#123e72; } .certificate { margin-top:10px; padding:9px 11px; border-radius:8px; background:#f5f8fa; } .certificate > div:first-child { display:flex; justify-content:space-between; gap:12px; } .certificate span { color:#68737f; } .certificate em { color:#895000; font-size:10px; font-weight:500; }
  .setup-callout,.coverage-note { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-top:8px; padding:9px 11px; border-radius:7px; background:#fff6e6; color:#805000; } .setup-callout button,.coverage-note button { flex:none; border-color:#9b680e; background:#9b680e; color:#fff; } .setup-callout button:hover,.coverage-note button:hover { background:#7f5205; }
  .empty { max-width:580px; margin:24px auto; padding:24px; text-align:center; } .empty-icon { margin-bottom:8px; color:#27a2a2; font-size:28px; } .empty h2 { color:#123e72; font-size:20px; } .empty p { margin:8px 0 16px; } .small { color:#747d85; font-size:11px; }
  .syncing-view { max-width:540px; margin:38px auto; padding:28px; text-align:center; } .syncing-view h2 { margin:12px 0 7px; color:#123e72; font-size:20px; } .spinner { width:34px; height:34px; margin:auto; border:4px solid #dbe5ef; border-top-color:#0d6374; border-radius:50%; animation:spin .8s linear infinite; } @keyframes spin { to { transform:rotate(360deg); } }
  .detail-review { padding-top:8px; } .detail-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-bottom:10px; } .detail-heading h2,.setup-view h2,.debug-grid h2 { color:#123e72; } .detail-heading p,.detail-note { color:#68737f; }
  .filter-group { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:7px; } .filter-group.modes { padding-bottom:8px; border-bottom:1px solid #e4e8ec; } .filter-chip { padding:5px 9px; border-radius:999px; } .filter-chip span { display:inline-block; min-width:18px; margin-left:3px; padding:0 5px; border-radius:999px; background:#edf2f7; color:#586674; font-size:10px; } .filter-chip.active { border-color:#0d6374; background:#0d6374; color:#fff; } .filter-chip.active span { background:#ffffff2e; color:#fff; }
  .detail-note { margin:7px 0 9px; font-size:11px; } .detail-empty { padding:30px 16px; border:1px dashed #ccd5df; border-radius:8px; color:#65717c; text-align:center; } .table-wrap { overflow:auto; border:1px solid #dfe3e7; border-radius:8px; } table { width:100%; border-collapse:collapse; font-size:12px; } th { position:sticky; top:0; z-index:1; padding:8px; background:#f1f4f7; color:#44505d; text-align:left; } td { max-width:300px; padding:8px; overflow:hidden; border-top:1px solid #edf0f2; text-overflow:ellipsis; white-space:nowrap; } td.merchant { min-width:200px; } .right { text-align:right; } .credit { color:#28713d; } .card-pill { color:#123e72; font-weight:700; } .verify { display:inline-block; padding:2px 7px; border-radius:999px; font-size:10px; font-weight:700; } .verify.good { background:#e1f1e4; color:#28673a; } .verify.neutral { background:#edf0f2; color:#616970; }
  .setup-view { max-width:760px; margin:0 auto; padding:8px 0 18px; } .back-link { margin-bottom:10px; padding-left:0; border:0; background:none; color:#0d6374; } .setup-lead { margin:5px 0 16px; color:#626d77; } form { display:grid; gap:12px; } label { display:grid; gap:4px; color:#3f4a54; } label > span:first-child { font-weight:700; } .field-help { margin-bottom:3px; color:#68737f; font-size:11px; font-weight:400; line-height:1.4; } input,select { width:100%; padding:8px 9px; border:1px solid #bec8d2; border-radius:6px; background:#fff; color:#26323d; } .coverage-summary { padding:10px 12px; border-radius:7px; background:#eef6f7; color:#315b63; }
  .mode-panel { display:none; gap:10px; padding:12px; border:1px solid #dce3e7; border-radius:8px; } .mode-panel.active { display:grid; } .method-note { display:flex; justify-content:space-between; gap:15px; padding:9px 11px; border-radius:7px; background:#f1f6f7; } .method-note span { color:#65717c; text-align:right; } .method-note.warn { background:#fff6e6; } .check { grid-template-columns:auto 1fr; align-items:start; gap:8px; } .check input { width:auto; margin-top:3px; } .check span { font-weight:400; } .inline-fields { display:grid; grid-template-columns:1fr 1fr; gap:10px; } .setup-actions { display:flex; gap:8px; justify-content:flex-end; }
  .statement-backfill { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:11px; border:1px solid #ead3a5; border-radius:8px; background:#fff9ee; } .statement-backfill.complete { border-color:#bfdcc7; background:#f1f8f3; } .statement-backfill p { max-width:560px; margin-top:3px; color:#65717c; font-size:11px; } .statement-coverage { margin-top:6px; color:#6f5730; font-size:11px; } .statement-backfill.complete .statement-coverage { color:#2f6d41; } .statement-actions { display:grid; flex:none; gap:6px; min-width:170px; }
  .debug-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:8px; } .debug-grid section { padding:14px; border:1px solid #e0e4e8; border-radius:8px; } .debug-grid h2 { margin-bottom:8px; font-size:15px; } dl { margin:0; } dl div { display:flex; justify-content:space-between; gap:12px; padding:4px 0; border-bottom:1px solid #edf0f2; } dd { margin:0; font-weight:700; text-align:right; } .action-stack { display:grid; gap:7px; margin-top:10px; } .danger { border-color:#b44; color:#a22; } .wide { grid-column:1/-1; }
  @media (max-width:720px) { .backdrop { padding:8px; } .header { align-items:flex-start; flex-wrap:wrap; } .brand { width:100%; } .controls { width:100%; overflow-x:auto; } .card-title-row,.breakdown,.certificate > div:first-child,.method-note,.detail-heading,.setup-callout,.coverage-note,.statement-backfill { align-items:flex-start; flex-direction:column; } .statement-actions { width:100%; } .nights { text-align:left; } .inline-fields,.debug-grid { grid-template-columns:1fr; } .wide { grid-column:auto; } }
`;

function createHyattTrackerUi(handlers) {
  const host = document.createElement('div');
  host.id = 'hyatt-tracker-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLES}</style><button class="launcher" data-action="open">◆ Hyatt Tracker</button>
    <div class="backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-label="Hyatt Card Tracker">
      <header class="header"><div class="brand"><strong>World of Hyatt Card Tracker</strong><span class="version">v1.1.7</span><a class="creator" href="https://discord.com/app" target="_blank" rel="noopener noreferrer" title="@robo77 on Discord"><span>by Robo</span>${DISCORD_ICON}</a></div>
      <nav class="controls"><button data-view="summary" class="active">Summary</button><button data-view="detail">Detailed</button><button data-action="sync">Refresh</button><button data-view="debug">Debug</button><button class="icon" data-action="close" aria-label="Close">×</button></nav></header>
      <div class="updated"></div><div class="status" role="status"></div><main class="body"></main>
    </section></div><input type="file" accept=".csv,text/csv" multiple hidden data-file-input="csv"><input type="file" accept=".pdf,application/pdf" multiple hidden data-file-input="statements">`;
  document.documentElement.append(host);

  let state = { accounts: [], transactions: [], cardConfig: {}, coverage: {} };
  let view = 'summary';
  let setupAccountId = null;
  let detailFilters = { cardId: 'all', mode: 'eligible' };
  let captureStatus = null;
  let busy = false;
  let statementBackfillController = null;
  let statementImportContext = null;
  const setupDraftDates = new Map();
  const backdrop = root.querySelector('.backdrop');
  const status = root.querySelector('.status');
  const fileInput = root.querySelector('[data-file-input="csv"]');
  const statementFileInput = root.querySelector('[data-file-input="statements"]');

  function metrics() { return calculateAllHyattCards(state); }
  function activateModePanels() {
    const select = root.querySelector('select[name="historyMode"]');
    root.querySelectorAll('[data-for-mode]').forEach((panel) => panel.classList.toggle('active', panel.dataset.forMode === select?.value));
  }
  function render() {
    const allMetrics = busy ? [] : metrics();
    root.querySelector('.updated').textContent = `Updated ${formatUpdated(state.updatedAt)}`;
    const setupMetric = setupAccountId ? allMetrics.find((metric) => String(metric.account.id) === String(setupAccountId)) : null;
    root.querySelector('.body').innerHTML = busy ? syncingView() : setupMetric ? setupView(setupMetric, {
      benefitStartDate: setupDraftDates.get(String(setupMetric.account.id)),
      statementBusy: Boolean(statementBackfillController)
    })
      : view === 'summary' ? allMetrics.length ? summaryView(allMetrics) : emptySummary()
      : view === 'detail' ? detailView(allMetrics, detailFilters) : debugView(state, captureStatus);
    root.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', !setupAccountId && button.dataset.view === view));
    activateModePanels();
  }
  function showStatus(message, error = false) { status.textContent = message; status.classList.toggle('error', error); status.classList.add('show'); }
  function hideStatus() { status.classList.remove('show', 'error'); }
  async function run(action, startMessage) {
    showStatus(startMessage);
    try { await action((message) => showStatus(message)); hideStatus(); return true; }
    catch (error) {
      const cancelled = error?.name === 'AbortError';
      showStatus(cancelled ? 'Statement scan cancelled. Statements already completed were kept.' : error?.message || String(error), !cancelled);
      return false;
    }
  }

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.setup) { setupAccountId = target.dataset.setup; render(); return; }
    if (target.dataset.confirmYear) {
      const accountId = target.dataset.confirmYear;
      const metric = metrics().find((item) => String(item.account.id) === String(accountId));
      const year = metric?.yearWindow.start.slice(0, 4) ?? new Date().getFullYear();
      if (confirm(`Confirm that the tracker includes every posted transaction for this card since January 1, ${year}?`)) {
        await run((progress) => handlers.saveSetup(accountId, { yearHistoryConfirmed: true }, progress), `Confirming ${year} coverage…`);
      }
      return;
    }
    if (target.dataset.detailCard) { detailFilters = { ...detailFilters, cardId: target.dataset.detailCard }; render(); return; }
    if (target.dataset.detailMode) { detailFilters = { ...detailFilters, mode: target.dataset.detailMode }; render(); return; }
    if (target.dataset.view) { setupAccountId = null; view = target.dataset.view; render(); return; }
    const action = target.dataset.action;
    if (action === 'open') { backdrop.classList.add('open'); render(); }
    if (action === 'close') backdrop.classList.remove('open');
    if (action === 'setup-back') { setupAccountId = null; view = 'summary'; render(); }
    if (action === 'sync') {
      busy = true;
      render();
      const succeeded = await run(handlers.sync, 'Discovering Hyatt cards…');
      busy = false;
      if (succeeded) {
        const target = findHyattSetupTarget(metrics());
        setupAccountId = target?.account.id ?? null;
        view = 'summary';
      }
      render();
    }
    if (action === 'import') fileInput.click();
    if (action === 'backfill-statements') {
      const form = root.querySelector('[data-setup-form]');
      const benefitStartDate = form?.elements?.benefitStartDate?.value;
      if (!benefitStartDate) { showStatus('Enter when the current Hyatt benefits began first.', true); return; }
      if (!confirm('Scan Chase monthly statements for this card? The current tab will briefly visit Statements & Documents and fetch each needed PDF directly. No PDF viewer windows will open, and raw PDFs will not be saved.')) return;
      statementBackfillController = new AbortController();
      render();
      await run(
        (progress) => handlers.backfillStatements(form.dataset.accountId, benefitStartDate, progress, statementBackfillController.signal),
        'Finding older Chase statements…'
      );
      statementBackfillController = null;
      render();
    }
    if (action === 'cancel-statements') statementBackfillController?.abort();
    if (action === 'import-statements') {
      const form = root.querySelector('[data-setup-form]');
      const benefitStartDate = form?.elements?.benefitStartDate?.value;
      if (!benefitStartDate) { showStatus('Enter when the current Hyatt benefits began first.', true); return; }
      statementImportContext = { accountId: form.dataset.accountId, benefitStartDate };
      statementFileInput.click();
    }
    if (action === 'export') handlers.exportData();
    if (action === 'clear' && confirm('Clear all locally stored Hyatt Tracker data?')) await run(handlers.clear, 'Clearing local data…');
  });

  root.addEventListener('change', (event) => {
    if (event.target.matches('select[name="historyMode"]')) activateModePanels();
  });
  root.addEventListener('input', (event) => {
    if (!event.target.matches('input[name="benefitStartDate"]')) return;
    const form = event.target.closest('[data-setup-form]');
    if (form) setupDraftDates.set(String(form.dataset.accountId), event.target.value);
    const summary = root.querySelector('[data-opening-summary]');
    const earliest = summary?.dataset.earliest;
    const start = new Date(`${event.target.value}T00:00:00Z`);
    const first = new Date(`${earliest}T00:00:00Z`);
    if (!summary || !event.target.value || !earliest || Number.isNaN(start.valueOf()) || Number.isNaN(first.valueOf())) return;
    const days = Math.round((first - start) / 86_400_000);
    summary.textContent = days < 0 ? 'Captured activity begins before the current Hyatt benefits began; earlier transactions will be ignored.'
      : days <= 60 ? `The first captured transaction is ${days} day${days === 1 ? '' : 's'} after the current Hyatt benefits began—within the normal setup window. Confirm no earlier purchases were made.`
      : `The first captured transaction is ${days} days after the current Hyatt benefits began. Consider using a Chase baseline unless you are sure there was no earlier spend.`;
  });
  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-setup-form]');
    if (!form) return;
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.productType = form.dataset.productType;
    payload.historyConfirmed = form.querySelector('[name="historyConfirmed"]')?.checked ?? false;
    payload.baselineHistoryConfirmed = form.querySelector('[name="baselineHistoryConfirmed"]')?.checked ?? false;
    payload.yearHistoryConfirmed = form.querySelector('[name="yearHistoryConfirmed"]')?.checked ?? false;
    const saved = await run((progress) => handlers.saveSetup(form.dataset.accountId, payload, progress), 'Saving setup…');
    if (!saved) return;
    setupDraftDates.delete(String(form.dataset.accountId));
    setupAccountId = null;
    view = 'summary';
    render();
  });
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) backdrop.classList.remove('open'); });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && backdrop.classList.contains('open')) backdrop.classList.remove('open'); });
  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files ?? []) await run((progress) => handlers.importCsv(file, progress), `Importing ${file.name}…`);
    fileInput.value = '';
  });
  statementFileInput.addEventListener('change', async () => {
    const files = [...(statementFileInput.files ?? [])];
    const context = statementImportContext;
    statementFileInput.value = '';
    statementImportContext = null;
    if (!files.length || !context) return;
    await run(
      (progress) => handlers.importStatementPdfs(files, context.accountId, context.benefitStartDate, progress),
      `Verifying ${files.length} statement PDF${files.length === 1 ? '' : 's'}…`
    );
    render();
  });

  return {
    setState(next) { state = next; render(); }, setCaptureStatus(next) { captureStatus = next; render(); },
    setProgress(message) { showStatus(message); }, setBusy(next) { busy = Boolean(next); render(); }, open() { backdrop.classList.add('open'); render(); }
  };
}

// end apps/hyatt/ui.js

// ---- apps/hyatt/main.js ----
const HYATT_CHASE_OPTIONS = Object.freeze({
  identifyProduct: identifyHyattProduct,
  acceptsAccount: isHyattAccount,
  cardLabel: 'World of Hyatt cards'
});

void (async function startHyattTracker() {
  const storage = createStorage({ storageKey: 'hyatt-tracker-state-v1', label: 'Hyatt Tracker' });
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
      console.warn('[Hyatt Tracker] Save failed.', error);
    });
    return saveChain;
  }

  function acceptCapture(data) {
    if (!state) {
      pendingCapture.push(data);
      return;
    }
    if (batchingCapture) {
      batchedCaptures.push(data);
      return;
    }
    const next = mergeState(state, { ...data, transactions: [], payloadCount: 1 }, 'network');
    next.transactions = mergeSupplementalTransactions(next.transactions, data.transactions ?? []);
    void save(next);
  }

  function accountActivityEarliest(account) {
    const covered = state.coverage?.[account.id]?.activity?.earliest;
    if (covered) return covered;
    const retained = state.coverage?.[account.id]?.statements?.activityEarliest;
    if (retained) return retained;
    return (state.transactions ?? []).filter((transaction) =>
      String(transaction.accountId) === String(account.id) || transaction.last4 === account.last4
    ).map((transaction) => transaction.date).filter(Boolean).sort()[0] ?? '';
  }

  async function saveStatementResult(account, result, benefitStartDate) {
    const statements = mergeStatementCoverage(
      state.coverage?.[account.id]?.statements ?? {},
      [result],
      { benefitStartDate, activityEarliest: accountActivityEarliest(account) }
    );
    await save(mergeState(state, {
      accounts: [account],
      transactions: result.transactions,
      coverage: { [account.id]: { statements } }
    }, 'chase-statement'));
    return statements;
  }

  const captureStatus = installChaseNetworkCapture(acceptCapture, {
    marker: '__hyattTrackerCaptureV1',
    label: 'Hyatt Tracker',
    normalizePayload: (payload, url) => extractNormalizedData(payload, url, HYATT_CHASE_OPTIONS)
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

  const handlers = {
    async sync(progress) {
      batchingCapture = true;
      batchedCaptures = [];
      try {
        const data = await syncAllCards(progress, HYATT_CHASE_OPTIONS);
        await new Promise((resolve) => setTimeout(resolve, 250));
        let draft = mergeState(emptyState(), data, 'chase-dom');
        for (const captured of batchedCaptures) {
          draft = mergeState(draft, { ...captured, transactions: [], payloadCount: 1 }, 'network');
          draft.transactions = mergeSupplementalTransactions(draft.transactions, captured.transactions ?? []);
        }
        await save(commitFullSync(state, draft));
        progress(`Synced ${data.accounts.length} Hyatt card${data.accounts.length === 1 ? '' : 's'} and ${data.transactions.length} activity rows.`);
        await new Promise((resolve) => setTimeout(resolve, 700));
      } finally {
        batchingCapture = false;
        batchedCaptures = [];
      }
    },

    async saveSetup(accountId, input, progress) {
      const account = state.accounts.find((item) => String(item.id) === String(accountId));
      if (!account) throw new Error('That Hyatt card is no longer available. Refresh and try again.');
      const config = normalizeHyattSetup(
        account,
        input,
        state.cardConfig?.[accountId] ?? {},
        new Date(),
        state.coverage?.[accountId] ?? {}
      );

      await save({
        ...state,
        cardConfig: { ...(state.cardConfig ?? {}), [accountId]: config }
      });
      progress('Card setup saved.');
      await new Promise((resolve) => setTimeout(resolve, 450));
    },

    async backfillStatements(accountId, benefitStartDate, progress, signal) {
      const account = state.accounts.find((item) => String(item.id) === String(accountId));
      if (!account) throw new Error('That Hyatt card is no longer available. Refresh and try again.');
      if (identifyHyattProduct(account.name)?.type !== 'personal') {
        throw new Error('The multi-year statement backfill is only needed for the personal Hyatt card.');
      }
      const activityEarliest = accountActivityEarliest(account);
      const existing = mergeStatementCoverage(
        state.coverage?.[account.id]?.statements ?? {},
        [],
        { benefitStartDate, activityEarliest }
      );
      await save(mergeState(state, { coverage: { [account.id]: { statements: existing } } }, 'chase-statement'));
      const importedStatementDates = (existing.periods ?? []).map((period) => period.statementDate).filter(Boolean);
      let savedCount = 0;
      const result = await collectChaseStatementBackfill({
        account,
        benefitStartDate,
        activityEarliest,
        importedStatementDates,
        progress,
        signal,
        onResult: async (statement, itemProgress) => {
          savedCount += 1;
          await saveStatementResult(account, statement, benefitStartDate);
          progress(`Saved statement ${itemProgress.completed} of ${itemProgress.total}; ${savedCount} added this run.`);
        }
      });
      if (result.failures.length) {
        const first = result.failures[0];
        throw new Error(`${savedCount} statement${savedCount === 1 ? '' : 's'} saved; ${result.failures.length} could not be verified. First failure (${first.statementDate}): ${first.message} Retry or import that PDF manually.`);
      }
      progress(savedCount
        ? `${savedCount} verified statement${savedCount === 1 ? '' : 's'} added. Completed months were saved locally.`
        : 'No new statements were needed; all discovered months were already imported.');
      await new Promise((resolve) => setTimeout(resolve, 650));
    },

    async importStatementPdfs(files, accountId, benefitStartDate, progress) {
      const account = state.accounts.find((item) => String(item.id) === String(accountId));
      if (!account) throw new Error('That Hyatt card is no longer available. Refresh and try again.');
      let savedCount = 0;
      const failures = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        progress(`Verifying PDF ${index + 1} of ${files.length} (${file.name})…`);
        try {
          const compactDate = file.name.match(/(?:^|\D)(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:\D|$)/);
          const fallbackDate = compactDate ? `${compactDate[1]}${compactDate[2]}${compactDate[3]}` : '';
          const result = await parseChaseStatementPdf(await file.arrayBuffer(), account, fallbackDate);
          await saveStatementResult(account, result, benefitStartDate);
          savedCount += 1;
        } catch (error) {
          failures.push(`${file.name}: ${error?.message || String(error)}`);
        }
      }
      if (failures.length) {
        throw new Error(`${savedCount} PDF${savedCount === 1 ? '' : 's'} saved; ${failures.length} failed verification. ${failures[0]}`);
      }
      progress(`${savedCount} verified statement PDF${savedCount === 1 ? '' : 's'} added.`);
      await new Promise((resolve) => setTimeout(resolve, 650));
    },

    async importCsv(file, progress) {
      const text = await file.text();
      let account = null;
      const filenameLast4 = normalizeLast4(file.name);
      if (filenameLast4) account = state.accounts.find((item) => item.last4 === filenameLast4) ?? null;
      if (!account && state.accounts.length === 1) account = state.accounts[0];
      if (!account && state.accounts.length > 1) {
        const last4 = normalizeLast4(prompt('Which Hyatt card is this CSV for? Enter its last four digits:') ?? '');
        account = state.accounts.find((item) => item.last4 === last4) ?? null;
        if (!account) throw new Error('No tracked Hyatt card matched those last four digits.');
      }
      if (!account) {
        const type = prompt('Enter “personal” or “business” for this World of Hyatt card:', 'personal')?.trim().toLowerCase();
        const last4 = normalizeLast4(prompt('Last four digits for this card:') ?? '');
        const name = type === 'business' ? 'World of Hyatt Business' : type === 'personal' ? 'World of Hyatt' : '';
        const product = identifyHyattProduct(name);
        if (!product || last4.length !== 4) throw new Error('Choose personal or business and enter a four-digit card ending.');
        account = { id: `manual-${last4}`, name: `${product.label} (…${last4})`, last4, productId: product.id, source: 'csv' };
      }
      const transactions = normalizeChaseCsv(text, account);
      if (!transactions.length) throw new Error('No Chase transactions were found. The CSV must include Date, Description, Type, Amount, and Category columns.');
      const dates = transactions.map((transaction) => transaction.date).filter(Boolean).sort();
      await save(mergeState(state, {
        accounts: [account],
        transactions,
        coverage: {
          [account.id]: {
            activity: {
              complete: false,
              rowCount: transactions.length,
              earliest: dates[0] ?? null,
              latest: dates.at(-1) ?? null,
              source: 'chase-csv',
              capturedAt: new Date().toISOString()
            }
          }
        }
      }, 'chase-csv'));
      progress(`Imported ${transactions.length} transactions for …${account.last4}.`);
      await new Promise((resolve) => setTimeout(resolve, 650));
    },

    exportData() {
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `hyatt-tracker-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },

    async clear(progress) {
      await storage.clear();
      publish(emptyState());
      progress('Local Hyatt tracker data cleared.');
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
  };

  ui = createHyattTrackerUi(handlers);
  ui.setCaptureStatus(captureStatus);
  ui.setState(state);

  let scanTimer = null;
  let foundAccountMetadata = false;
  async function scanCurrentPage() {
    if (batchingCapture || foundAccountMetadata) return;
    const accounts = extractChaseAccounts(document.documentElement?.innerHTML ?? '', HYATT_CHASE_OPTIONS);
    const activity = extractChaseActivity(document, null, HYATT_CHASE_OPTIONS);
    if (!accounts.length && !activity.accounts.length) return;
    foundAccountMetadata = true;
    await save(mergeState(state, { accounts: [...accounts, ...activity.accounts], transactions: [] }, 'chase-dom'));
  }

  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scanCurrentPage(), 800);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => {
    foundAccountMetadata = false;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scanCurrentPage(), 600);
  });
  void scanCurrentPage();
})();

// end apps/hyatt/main.js
})();
