export const PRODUCT_RULES = Object.freeze([
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

export function identifyProduct(accountOrName) {
  const text = typeof accountOrName === 'string'
    ? accountOrName
    : `${accountOrName?.name ?? ''} ${accountOrName?.productName ?? ''}`;
  return PRODUCT_RULES.find((rule) => rule.names.some((pattern) => pattern.test(text))) ?? null;
}

export function getProductRule(productId, fallbackName = '') {
  return PRODUCT_RULES.find((rule) => rule.id === productId) ?? identifyProduct(fallbackName);
}

export function isInkAccount(account) {
  return Boolean(identifyProduct(account));
}
