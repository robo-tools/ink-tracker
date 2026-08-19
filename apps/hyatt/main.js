import { extractNormalizedData, normalizeChaseCsv, normalizeLast4 } from '../../packages/chase-core/lib/normalize.js';
import { commitFullSync, createStorage, emptyState, mergeState, mergeSupplementalTransactions, repairStateAccountMetadata } from '../../packages/chase-core/app/storage.js';
import { extractChaseAccounts, extractChaseActivity, syncAllCards } from '../../packages/chase-core/app/chase-dom.js';
import { installChaseNetworkCapture } from '../../packages/chase-core/app/capture.js';
import { createHyattTrackerUi } from './ui.js';
import { identifyHyattProduct, isHyattAccount } from './products.js';
import { normalizeHyattSetup } from './setup.js';

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
      const config = normalizeHyattSetup(account, input, state.cardConfig?.[accountId] ?? {});

      await save({
        ...state,
        cardConfig: { ...(state.cardConfig ?? {}), [accountId]: config }
      });
      progress('Card setup saved.');
      await new Promise((resolve) => setTimeout(resolve, 450));
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
