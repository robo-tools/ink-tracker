export const HYATT_PRODUCT_RULES = Object.freeze([
  {
    id: 'hyatt-business',
    type: 'business',
    names: [
      /world\s+of\s+hyatt\s+(?:business|biz)\b/i,
      /hyatt\s+(?:business|biz)(?:\s+visa)?\b/i
    ],
    label: 'World of Hyatt Business Credit Card',
    thresholdCents: 1_000_000,
    nightsPerThreshold: 5,
    baseNights: 0,
    counterWindow: 'calendar-year'
  },
  {
    id: 'hyatt-personal',
    type: 'personal',
    names: [/world\s+of\s+hyatt/i, /hyatt(?!\s+(?:business|biz)\b)/i],
    label: 'World of Hyatt Credit Card',
    thresholdCents: 500_000,
    nightsPerThreshold: 2,
    baseNights: 5,
    counterWindow: 'lifetime',
    annualFreeNightThresholdCents: 1_500_000
  }
]);

export function identifyHyattProduct(accountOrName) {
  const text = typeof accountOrName === 'string'
    ? accountOrName
    : `${accountOrName?.name ?? ''} ${accountOrName?.productName ?? ''}`;
  return HYATT_PRODUCT_RULES.find((rule) => rule.names.some((pattern) => pattern.test(text))) ?? null;
}

export function getHyattProductRule(productId, fallbackName = '') {
  // Chase's current display name is more authoritative than a product ID saved by
  // an older tracker version. This lets corrected matchers repair existing state.
  return identifyHyattProduct(fallbackName)
    ?? HYATT_PRODUCT_RULES.find((rule) => rule.id === productId)
    ?? null;
}

export function isHyattAccount(account) {
  return Boolean(identifyHyattProduct(account));
}
