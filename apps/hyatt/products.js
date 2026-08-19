export const HYATT_PRODUCT_RULES = Object.freeze([
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

export function identifyHyattProduct(accountOrName) {
  const text = typeof accountOrName === 'string'
    ? accountOrName
    : `${accountOrName?.name ?? ''} ${accountOrName?.productName ?? ''}`;
  return HYATT_PRODUCT_RULES.find((rule) => rule.names.some((pattern) => pattern.test(text))) ?? null;
}

export function getHyattProductRule(productId, fallbackName = '') {
  return HYATT_PRODUCT_RULES.find((rule) => rule.id === productId) ?? identifyHyattProduct(fallbackName);
}

export function isHyattAccount(account) {
  return Boolean(identifyHyattProduct(account));
}
