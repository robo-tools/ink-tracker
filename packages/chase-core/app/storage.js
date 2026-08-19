import { dedupeAccounts } from '../lib/normalize.js';
import { dateDistanceDays, merchantSimilarity } from '../lib/matching.js';

export function emptyState() {
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
  let score = transaction.source === 'network' ? 3 : transaction.source === 'chase-csv' ? 2 : 1;
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

export function mergeTransactions(existing, incoming) {
  return combineTransactions(existing, incoming, true);
}

export function mergeSupplementalTransactions(existing, incoming) {
  return combineTransactions(existing, incoming, false);
}

export function reconcileTransactions(transactions) {
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

export function mergeRewardRecords(existing, incoming) {
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

export function commitFullSync(current, draft, source = 'full-sync') {
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

export function mergeState(current, data, source = '') {
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

export function repairStateAccountMetadata(state) {
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

export function createStorage(options = {}) {
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
