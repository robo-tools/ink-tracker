import { normalizeChaseActivityRow, normalizeLast4 } from '../lib/normalize.js';

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

export function extractChaseAccounts(html = document.documentElement?.innerHTML ?? '', options = {}) {
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

export function extractCurrentChaseAccount(doc = document, hash = location.hash, options = {}) {
  const route = String(hash).match(/#\/dashboard\/summary\/([^/]+)\/([^/]+)\/([^/?]+)/i);
  if (!route) return null;
  const bodyText = doc.body?.innerText ?? '';
  const name = supportedNameFromText(`${bodyText}\n${doc.title ?? ''}`, options);
  if (!name) return null;
  return accountFromRoute(name, route, options);
}

export function extractChaseActivity(doc = document, account = null, options = {}) {
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

export function findLoadMore(doc = document) {
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

export async function loadAllCurrentActivity(onProgress = () => {}, options = {}, account = null) {
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

export async function syncAllCards(onProgress = () => {}, options = {}) {
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
