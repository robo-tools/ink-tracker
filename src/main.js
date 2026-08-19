import { formatDateOnly } from './lib/dates.js';
import { identifyProduct } from './lib/products.js';
import { normalizeChaseCsv, normalizeLast4 } from './lib/normalize.js';
import { scoreRewardAccount } from './lib/calculations.js';
import { commitFullSync, createStorage, emptyState, mergeState, mergeSupplementalTransactions, repairStateAccountMetadata } from './app/storage.js';
import { extractChaseAccounts, extractChaseActivity, syncAllInkCards } from './app/chase-dom.js';
import { loadRewardsActivity } from './app/rewards-dom.js';
import { installChaseNetworkCapture } from './app/capture.js';
import { createInkTrackerUi } from './app/ui.js';

void (async function startInkTracker() {
  const storage = createStorage();
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

  const captureStatus = installChaseNetworkCapture(acceptCapture);
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
        const data = await syncAllInkCards(progress);
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
    const accounts = extractChaseAccounts();
    const activity = extractChaseActivity();
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
