import { calculateAllCards, estimateTransactionMultiplier, transactionQualifies } from './calculations.js';
import { formatMonthYear } from '../../packages/chase-core/lib/dates.js';

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

export function buildDetailRows(metrics, filters = {}) {
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

export function createInkTrackerUi(handlers) {
  const host = document.createElement('div');
  host.id = 'ink-tracker-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLES}</style>
    <button class="launcher" data-action="open">⚡ Ink Tracker</button>
    <div class="backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Ink Tracker">
        <header class="header">
          <div class="brand"><strong>Ways to Earn — All Ink Cards</strong><span class="version">v1.1.7</span><a class="creator" href="https://discord.com/app" target="_blank" rel="noopener noreferrer" aria-label="Created by Robo, @robo77 on Discord" title="@robo77 on Discord"><span>by Robo</span><svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83A97.68 97.68 0 0 0 49 6.83 72.37 72.37 0 0 0 45.64 0 105.89 105.89 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15A77.7 77.7 0 0 0 39.6 87a68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2 20.89 9.77 43.56 9.77 64.2 0 .87.71 1.76 1.39 2.66 2A70.17 70.17 0 0 1 87.4 87a77.48 77.48 0 0 0 6.89 9.34 105.25 105.25 0 0 0 32.17-16.16C129.1 52.84 122 29.1 107.7 8.07ZM42.45 65.69c-9.95 0-18.11-9.11-18.11-20.35S32.3 25 42.45 25s18.27 9.19 18.1 20.34c0 11.24-8.04 20.35-18.1 20.35Zm42.24 0c-10 0-18.11-9.11-18.11-20.35S74.54 25 84.69 25 103 34.17 102.8 45.34c0 11.24-8.05 20.35-18.11 20.35Z"/></svg></a></div>
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
