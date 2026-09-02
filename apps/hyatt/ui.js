import { calculateAllHyattCards, hyattTransactionQualifies } from './calculations.js';
import { formatMonthYear } from '../../packages/chase-core/lib/dates.js';

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

export function displayAccountName(name) {
  return String(name ?? 'World of Hyatt card').replace(/\s*\((?:\.{3}|…)[\s-]*\d{4}\)\s*$/u, '').trim();
}

export function statementAliasConfirmationText(details = {}) {
  return `This statement is for card ending …${details.priorLast4 ?? ''}, but the selected Hyatt card currently ends …${details.selectedLast4 ?? ''}. Did Chase replace or reissue this same card account?`;
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

export function findHyattSetupTarget(metrics) {
  return metrics.find((metric) => metric.setupStatus === 'setup-needed') ?? null;
}

export function buildHyattDetailRows(metrics, filters = { cardId: 'all', mode: 'eligible' }) {
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

export function statementCoverageSummary(metric, benefitStartDate = '') {
  const coverage = metric.coverage.statements;
  const activityEarliest = metric.coverage.activity?.earliest ?? coverage?.activityEarliest ?? '';
  const targetStart = benefitStartDate || coverage?.benefitStartDate || '';
  const targetRange = targetStart && activityEarliest
    ? `${formatMonthYear(targetStart)} – ${formatMonthYear(activityEarliest)}`
    : targetStart
      ? `starting ${formatMonthYear(targetStart)}`
      : activityEarliest
        ? `through ${formatMonthYear(activityEarliest)}`
        : 'set the Hyatt benefit start date to see the needed range';
  if (!coverage?.statementCount) {
    return `<span><strong>Needed statement range:</strong> ${escapeHtml(targetRange)} · No older statements imported yet.</span>`;
  }
  const range = coverage.earliest && coverage.latest
    ? `${formatMonthYear(coverage.earliest)} – ${formatMonthYear(coverage.latest)}`
    : 'date range unavailable';
  const issues = [];
  if (targetStart && coverage.earliest && coverage.earliest > targetStart) issues.push('beginning months missing');
  if (coverage.gaps?.length) issues.push(`${coverage.gaps.length} internal gap${coverage.gaps.length === 1 ? '' : 's'}`);
  if (activityEarliest && coverage.latest && coverage.latest < activityEarliest) issues.push('ending months missing');
  const issue = issues.length ? ` · ${issues.join(' · ')}` : '';
  return `<span><strong>Needed:</strong> ${escapeHtml(targetRange)}<br><strong>${coverage.statementCount} verified statement${coverage.statementCount === 1 ? '' : 's'}</strong> · Imported coverage ${escapeHtml(range)}${issue}</span>`;
}

function personalSetup(metric, options = {}) {
  const config = metric.config ?? {};
  const mode = config.historyMode ?? 'full';
  const baselineDollars = Number.isFinite(config.baselineProgressCents) ? (config.baselineProgressCents / 100).toFixed(2) : '';
  const benefitStartDate = options.benefitStartDate ?? config.benefitStartDate ?? '';
  const statementCoverage = metric.coverage.statements ?? {};
  const statementAliases = (config.statementLast4Aliases ?? []).filter(Boolean);
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
        <option value="full" ${mode === 'full' ? 'selected' : ''}>Full history from downloaded statements</option>
        <option value="baseline" ${mode === 'baseline' ? 'selected' : ''}>Exact Chase baseline (easiest)</option>
        <option value="estimate" ${mode === 'estimate' ? 'selected' : ''}>Last 2-night award date (estimate)</option>
      </select></label>
      <div class="mode-panel" data-for-mode="full">
        <div class="method-note"><strong>Full history</strong><span>We calculate lifetime qualifying spend modulo $5,000.</span></div>
        <div class="statement-backfill ${statementHistoryComplete ? 'complete' : ''}">
          <div><strong>${statementHistoryComplete ? '✓ Full history verified from Chase statements' : 'Older history from monthly statements'}</strong>
          <p>Chase only serves these PDFs through its own viewer. Download the monthly statements normally from Chase, then select all of the PDFs together here. They are verified and parsed locally; the tracker never saves the raw PDFs.</p>
          <div class="statement-coverage">${statementCoverageSummary(metric, benefitStartDate)}${statementAliases.length ? `<br><span><strong>Confirmed prior card ending${statementAliases.length === 1 ? '' : 's'}:</strong> ${statementAliases.map((last4) => `…${escapeHtml(last4)}`).join(', ')}</span>` : ''}</div></div>
          <div class="statement-actions"><button type="button" class="primary" data-action="import-statements">Import statement PDFs</button><button type="button" data-action="open-statements">Open Chase statements</button></div>
        </div>
        <label class="check"><input type="checkbox" name="historyConfirmed" ${(config.historyConfirmed || statementHistoryComplete) ? 'checked' : ''} ${statementHistoryComplete ? 'disabled' : ''}><span>${statementHistoryComplete ? 'The imported statements and recent activity form a continuous history from the Hyatt benefit start date.' : 'I confirm there were no qualifying purchases before the oldest captured transaction.'}</span></label>
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
      : 'No older statement PDFs imported';
    return `<div><dt>${escapeHtml(displayAccountName(account.name))} …${escapeHtml(account.last4)}</dt><dd>${coverage.complete ? 'List end verified' : 'Unverified'} · ${itemDateRange(transactions)}<br>${escapeHtml(statementText)}</dd></div>`;
  }).join('');
  return `<div class="debug-grid">
    <section><h2>Local data</h2><dl>
      <div><dt>Hyatt cards</dt><dd>${state.accounts?.length ?? 0}</dd></div><div><dt>Transactions</dt><dd>${state.transactions?.length ?? 0}</dd></div>
      <div><dt>Activity coverage</dt><dd>${itemDateRange(state.transactions ?? [])}</dd></div><div><dt>Captured payloads</dt><dd>${state.captureStats?.payloads ?? 0}</dd></div>
      <div><dt>Network listener</dt><dd>${captureStatus?.installed ? 'Active' : 'Fallback only'}</dd></div>
    </dl></section>
    <section><h2>Data controls</h2><p>CSV imports cover recent activity. Personal-card setup can locally import older monthly statement PDFs downloaded from Chase.</p><div class="action-stack">
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
  .backdrop.open { display: flex; } .modal { position:relative; width: min(960px,calc(100vw - 24px)); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #aab4c0; border-radius: 10px; background: #fff; box-shadow: 0 18px 55px #00142f55; }
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
  .decision-layer { position:absolute; inset:0; z-index:5; display:none; align-items:center; justify-content:center; padding:18px; background:#07192f80; } .decision-layer.show { display:flex; }
  .decision-card { width:min(520px,100%); padding:18px; border:1px solid #bdc8d2; border-radius:10px; background:#fff; box-shadow:0 16px 40px #00142f55; } .decision-card h2 { color:#123e72; font-size:18px; } .decision-card p { margin-top:8px; color:#46535f; } .decision-note { padding:9px 10px; border-radius:7px; background:#fff6e6; color:#805000 !important; font-size:11px; } .decision-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:15px; }
  .debug-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:8px; } .debug-grid section { padding:14px; border:1px solid #e0e4e8; border-radius:8px; } .debug-grid h2 { margin-bottom:8px; font-size:15px; } dl { margin:0; } dl div { display:flex; justify-content:space-between; gap:12px; padding:4px 0; border-bottom:1px solid #edf0f2; } dd { margin:0; font-weight:700; text-align:right; } .action-stack { display:grid; gap:7px; margin-top:10px; } .danger { border-color:#b44; color:#a22; } .wide { grid-column:1/-1; }
  @media (max-width:720px) { .backdrop { padding:8px; } .header { align-items:flex-start; flex-wrap:wrap; } .brand { width:100%; } .controls { width:100%; overflow-x:auto; } .card-title-row,.breakdown,.certificate > div:first-child,.method-note,.detail-heading,.setup-callout,.coverage-note,.statement-backfill { align-items:flex-start; flex-direction:column; } .statement-actions { width:100%; } .nights { text-align:left; } .inline-fields,.debug-grid { grid-template-columns:1fr; } .wide { grid-column:auto; } }
`;

export function createHyattTrackerUi(handlers) {
  const host = document.createElement('div');
  host.id = 'hyatt-tracker-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLES}</style><button class="launcher" data-action="open">◆ Hyatt Tracker</button>
    <div class="backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-label="Hyatt Card Tracker">
      <header class="header"><div class="brand"><strong>World of Hyatt Card Tracker</strong><span class="version">v1.2.0</span><a class="creator" href="https://discord.com/app" target="_blank" rel="noopener noreferrer" title="@robo77 on Discord"><span>by Robo</span>${DISCORD_ICON}</a></div>
      <nav class="controls"><button data-view="summary" class="active">Summary</button><button data-view="detail">Detailed</button><button data-action="sync">Refresh</button><button data-view="debug">Debug</button><button class="icon" data-action="close" aria-label="Close">×</button></nav></header>
      <div class="updated"></div><div class="status" role="status"></div><main class="body"></main>
      <div class="decision-layer" data-alias-confirmation><section class="decision-card" role="alertdialog" aria-modal="true" aria-labelledby="hyatt-alias-title">
        <h2 id="hyatt-alias-title">Confirm an earlier card number</h2><p data-alias-message></p>
        <p class="decision-note">Choose Yes only if both endings belong to the same card account. The tracker will remember the earlier ending locally and continue the selected PDF batch.</p>
        <div class="decision-actions"><button type="button" data-alias-choice="cancel">No, keep it rejected</button><button type="button" class="primary" data-alias-choice="accept">Yes, same card</button></div>
      </section></div>
    </section></div><input type="file" accept=".csv,text/csv" multiple hidden data-file-input="csv"><input type="file" accept=".pdf,application/pdf" multiple hidden data-file-input="statements">`;
  document.documentElement.append(host);

  let state = { accounts: [], transactions: [], cardConfig: {}, coverage: {} };
  let view = 'summary';
  let setupAccountId = null;
  let detailFilters = { cardId: 'all', mode: 'eligible' };
  let captureStatus = null;
  let busy = false;
  let statementImportContext = null;
  let pendingAliasConfirmation = null;
  const setupDraftDates = new Map();
  const backdrop = root.querySelector('.backdrop');
  const status = root.querySelector('.status');
  const fileInput = root.querySelector('[data-file-input="csv"]');
  const statementFileInput = root.querySelector('[data-file-input="statements"]');
  const aliasConfirmation = root.querySelector('[data-alias-confirmation]');
  const aliasMessage = root.querySelector('[data-alias-message]');

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
      benefitStartDate: setupDraftDates.get(String(setupMetric.account.id))
    })
      : view === 'summary' ? allMetrics.length ? summaryView(allMetrics) : emptySummary()
      : view === 'detail' ? detailView(allMetrics, detailFilters) : debugView(state, captureStatus);
    root.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', !setupAccountId && button.dataset.view === view));
    activateModePanels();
  }
  function showStatus(message, error = false) { status.textContent = message; status.classList.toggle('error', error); status.classList.add('show'); }
  function hideStatus() { status.classList.remove('show', 'error'); }
  function settleAliasConfirmation(accepted) {
    if (!pendingAliasConfirmation) return false;
    const resolve = pendingAliasConfirmation;
    pendingAliasConfirmation = null;
    aliasConfirmation.classList.remove('show');
    aliasMessage.textContent = '';
    resolve(Boolean(accepted));
    return true;
  }
  function requestAliasConfirmation(details) {
    if (pendingAliasConfirmation) settleAliasConfirmation(false);
    return new Promise((resolve) => {
      pendingAliasConfirmation = resolve;
      aliasMessage.textContent = statementAliasConfirmationText(details);
      aliasConfirmation.classList.add('show');
      aliasConfirmation.querySelector('[data-alias-choice="accept"]')?.focus();
    });
  }
  async function run(action, startMessage) {
    showStatus(startMessage);
    try { await action((message) => showStatus(message)); hideStatus(); return true; }
    catch (error) {
      const cancelled = error?.name === 'AbortError';
      showStatus(cancelled ? 'Operation cancelled. Completed imports were kept.' : error?.message || String(error), !cancelled && !error?.informational);
      return false;
    }
  }

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.aliasChoice) {
      settleAliasConfirmation(target.dataset.aliasChoice === 'accept');
      return;
    }
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
    if (action === 'close') {
      if (settleAliasConfirmation(false)) return;
      backdrop.classList.remove('open');
    }
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
    if (action === 'open-statements') {
      const form = root.querySelector('[data-setup-form]');
      const benefitStartDate = form?.elements?.benefitStartDate?.value;
      if (!benefitStartDate) { showStatus('Enter when the current Hyatt benefits began first.', true); return; }
      window.open('https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents', '_blank', 'noopener,noreferrer');
      showStatus('Chase Statements & Documents opened. Download the needed monthly PDFs there, then return and choose Import statement PDFs.');
    }
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
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop && !pendingAliasConfirmation) backdrop.classList.remove('open'); });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !backdrop.classList.contains('open')) return;
    if (!settleAliasConfirmation(false)) backdrop.classList.remove('open');
  });
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
      (progress) => handlers.importStatementPdfs(files, context.accountId, context.benefitStartDate, progress, requestAliasConfirmation),
      `Verifying ${files.length} statement PDF${files.length === 1 ? '' : 's'}…`
    );
    render();
  });

  return {
    setState(next) { state = next; render(); }, setCaptureStatus(next) { captureStatus = next; render(); },
    setProgress(message) { showStatus(message); }, setBusy(next) { busy = Boolean(next); render(); }, open() { backdrop.classList.add('open'); render(); }
  };
}
