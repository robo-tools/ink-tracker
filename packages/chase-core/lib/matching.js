import { parseDateOnly } from './dates.js';

export function merchantKey(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\b(PP|BHN|STORE|PURCHASE|PAYMENT|ONLINE|COM)\b/g, '')
    .replace(/\d{3,}/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function merchantSimilarity(left, right) {
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

export function dateDistanceDays(left, right) {
  const a = parseDateOnly(left);
  const b = parseDateOnly(right);
  return a && b ? Math.abs(a - b) / 86_400_000 : Number.POSITIVE_INFINITY;
}

export function belongsToAccount(item, account) {
  if (item?.accountId && account?.id) return String(item.accountId) === String(account.id);
  return Boolean(item?.last4 && account?.last4 && item.last4 === account.last4);
}

export function isPending(transaction) {
  return transaction?.status === 'pending';
}
