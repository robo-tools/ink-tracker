// ==UserScript==
// @name         Capital One Shopping Pending Rewards Dashboard
// @namespace    https://capitaloneshopping.com/
// @version      1.2.3
// @description  Totals pending Shopping Rewards and charts their estimated payout schedule. Shopping Savings are excluded.
// @author       Robo (@robo77 on Discord)
// @homepageURL  https://github.com/robo-tools/ink-tracker
// @supportURL   https://github.com/robo-tools/ink-tracker/issues
// @updateURL    https://robo-tools.github.io/ink-tracker/capital-one-pending-rewards.meta.js
// @downloadURL  https://robo-tools.github.io/ink-tracker/capital-one-pending-rewards.user.js
// @match        https://capitaloneshopping.com/my-rewards/lifetime-savings*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const ROUTE_ID = 'routes/__app/my-rewards.lifetime-savings';
  const DASHBOARD_ID = 'c1pd-dashboard';
  const PAGE_LIMIT = 100;

  /**
   * Capital One Shopping serializes React Router loader data as a flattened
   * array. Object keys and values point to other indexes in that array.
   */
  function decodeFlattened(flat) {
    const memo = new Map();

    function decode(index) {
      // Negative references are serialization sentinels such as null/undefined.
      if (!Number.isInteger(index) || index < 0) return null;
      if (memo.has(index)) return memo.get(index);

      const value = flat[index];
      if (Array.isArray(value)) {
        const result = [];
        memo.set(index, result);
        for (const item of value) result.push(decode(item));
        return result;
      }

      if (value && typeof value === 'object') {
        const result = {};
        memo.set(index, result);
        for (const [encodedKey, encodedValue] of Object.entries(value)) {
          const keyIndex = encodedKey.startsWith('_')
            ? Number(encodedKey.slice(1))
            : NaN;
          const key = Number.isInteger(keyIndex) ? decode(keyIndex) : encodedKey;
          result[String(key)] = decode(encodedValue);
        }
        return result;
      }

      return value;
    }

    return decode(0);
  }

  function parseRouteDataFromSource(source) {
    if (!source || !source.includes('streamController.enqueue')) return null;

    // Capture one complete JavaScript string argument without evaluating code.
    const payloadPattern = /streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g;
    let match;

    while ((match = payloadPattern.exec(source)) !== null) {
      try {
        const serializedArray = JSON.parse(match[1]);
        const flat = JSON.parse(serializedArray);
        const decoded = decodeFlattened(flat);
        const route = decoded?.loaderData?.[ROUTE_ID];

        if (route && Array.isArray(route.lifetimeSavingsRows)) {
          return {
            page: Number.parseInt(route.page, 10) || 0,
            rows: route.lifetimeSavingsRows,
          };
        }
      } catch {
        // A page can contain unrelated stream chunks; keep looking.
      }
    }

    return null;
  }

  function parseRouteDataFromDocument(doc) {
    for (const script of doc.scripts) {
      const route = parseRouteDataFromSource(script.textContent || '');
      if (route) return route;
    }
    return null;
  }

  // Makes the data decoder testable with Node without affecting Tampermonkey.
  if (
    typeof process !== 'undefined' &&
    process.versions?.node &&
    typeof module !== 'undefined' &&
    module.exports
  ) {
    module.exports = { decodeFlattened, parseRouteDataFromSource, summarize };
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const currencyFormatterCache = new Map();

  function formatCurrency(amount, currency = 'USD') {
    const code = currency || 'USD';
    if (!currencyFormatterCache.has(code)) {
      currencyFormatterCache.set(
        code,
        new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: code,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      );
    }
    return currencyFormatterCache.get(code).format(Number(amount) || 0);
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  }

  function monthDetails(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return { key: 'unknown', label: 'Date unavailable', sort: Infinity };
    }

    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: new Intl.DateTimeFormat(undefined, {
        month: 'short',
        year: 'numeric',
      }).format(date),
      sort: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
    };
  }

  function rewardKey(row) {
    return [
      row.id || row.orderId || row.tripId || '',
      row.createdAt || '',
      row.rewardsAmount || 0,
      row.creditCurrency || '',
    ].join('|');
  }

  function addUniqueRows(target, rows) {
    for (const row of rows) target.set(rewardKey(row), row);
  }

  async function fetchRoutePage(page) {
    const url = new URL('/my-rewards/lifetime-savings', window.location.origin);
    url.searchParams.set('page', String(page));
    url.searchParams.set('sortOrder', 'descending');

    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    });

    if (!response.ok) {
      throw new Error(`Page ${page + 1} returned HTTP ${response.status}.`);
    }

    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const route = parseRouteDataFromDocument(parsed);

    if (!route) {
      const signedOut = /sign[ -]?in|log[ -]?in/i.test(parsed.title || '');
      throw new Error(
        signedOut
          ? 'Capital One Shopping appears to have signed you out.'
          : `Could not read rewards data from page ${page + 1}.`,
      );
    }

    return route;
  }

  async function collectAllRows({ fresh = false, onProgress = () => {} } = {}) {
    let firstRoute = fresh ? null : parseRouteDataFromDocument(document);
    if (!firstRoute || firstRoute.page !== 0) {
      onProgress('Loading rewards page 1…');
      firstRoute = await fetchRoutePage(0);
    }

    const uniqueRows = new Map();
    addUniqueRows(uniqueRows, firstRoute.rows);

    const pageSize = firstRoute.rows.length;
    if (pageSize === 0) return [];

    let previousRows = firstRoute.rows;
    for (let page = 1; page < PAGE_LIMIT && previousRows.length === pageSize; page += 1) {
      onProgress(`Loading rewards page ${page + 1}…`);
      const route = await fetchRoutePage(page);
      previousRows = route.rows;
      addUniqueRows(uniqueRows, previousRows);
    }

    return [...uniqueRows.values()];
  }

  function summarize(rows) {
    // This is the key exclusion: only pending rewardsAmount is used.
    // couponsSavings and the page's combined savings total are never summed.
    const pending = rows
      .filter(
        (row) =>
          String(row.status || '').toLowerCase() === 'pending' &&
          Number(row.rewardsAmount) > 0,
      )
      .sort((a, b) => {
        const aTime = new Date(a.payoutAt).getTime();
        const bTime = new Date(b.payoutAt).getTime();
        if (Number.isNaN(aTime)) return Number.isNaN(bTime) ? 0 : 1;
        if (Number.isNaN(bTime)) return -1;
        return aTime - bTime;
      });

    const currencies = new Map();
    const months = new Map();

    for (const row of pending) {
      const currency = row.creditCurrency || 'USD';
      currencies.set(currency, (currencies.get(currency) || 0) + Number(row.rewardsAmount));

      const month = monthDetails(row.payoutAt);
      const key = `${month.key}|${currency}`;
      const existing = months.get(key) || {
        ...month,
        currency,
        amount: 0,
        count: 0,
      };
      existing.amount += Number(row.rewardsAmount);
      existing.count += 1;
      months.set(key, existing);
    }

    return {
      pending,
      totals: [...currencies.entries()].map(([currency, amount]) => ({ currency, amount })),
      months: [...months.values()].sort((a, b) => a.sort - b.sort),
      nextPayout: pending.find((row) => !Number.isNaN(new Date(row.payoutAt).getTime())) || null,
    };
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createStat(label, value, note) {
    const stat = createElement('div', 'c1pd-stat');
    stat.append(
      createElement('div', 'c1pd-stat-label', label),
      createElement('div', 'c1pd-stat-value', value),
      createElement('div', 'c1pd-stat-note', note),
    );
    return stat;
  }

  function renderDashboard(root, summary, loadedCount) {
    const { pending, totals, months, nextPayout } = summary;
    const totalText = totals.length
      ? totals.map(({ currency, amount }) => formatCurrency(amount, currency)).join(' + ')
      : formatCurrency(0);

    root.querySelector('.c1pd-content').replaceChildren();
    const content = root.querySelector('.c1pd-content');

    const stats = createElement('div', 'c1pd-stats');
    stats.append(
      createStat(
        'Total pending',
        totalText,
        'Shopping Rewards only',
      ),
      createStat(
        'Pending rewards',
        String(pending.length),
        `Across ${new Set(pending.map((row) => row.vendor || row.domain)).size} merchant${
          new Set(pending.map((row) => row.vendor || row.domain)).size === 1 ? '' : 's'
        }`,
      ),
      createStat(
        'Next estimated payout',
        nextPayout ? formatDate(nextPayout.payoutAt) : '—',
        nextPayout
          ? `${nextPayout.vendor || nextPayout.domain}: ${formatCurrency(
              nextPayout.rewardsAmount,
              nextPayout.creditCurrency,
            )}`
          : 'No pending payout date',
      ),
    );
    content.append(stats);

    if (!pending.length) {
      content.append(
        createElement(
          'p',
          'c1pd-empty',
          'No pending Shopping Rewards were found. Shopping Savings were excluded.',
        ),
      );
      updateStatus(root, `Checked ${loadedCount} reward and savings records.`, false);
      return;
    }

    const chart = createElement('section', 'c1pd-chart');
    chart.setAttribute('aria-labelledby', 'c1pd-chart-heading');
    const chartHeading = createElement('h3', '', 'Estimated payouts by month');
    chartHeading.id = 'c1pd-chart-heading';
    chart.append(chartHeading);

    const maxByCurrency = new Map();
    for (const month of months) {
      maxByCurrency.set(
        month.currency,
        Math.max(maxByCurrency.get(month.currency) || 0, month.amount),
      );
    }

    const bars = createElement('div', 'c1pd-bars');
    for (const month of months) {
      const row = createElement('div', 'c1pd-bar-row');
      row.setAttribute(
        'aria-label',
        `${month.label}: ${formatCurrency(month.amount, month.currency)} from ${month.count} pending rewards`,
      );

      const label = createElement('div', 'c1pd-bar-label', month.label);
      const track = createElement('div', 'c1pd-bar-track');
      const fill = createElement('div', 'c1pd-bar-fill');
      fill.style.width = `${Math.max(
        2,
        (month.amount / maxByCurrency.get(month.currency)) * 100,
      )}%`;
      track.append(fill);

      const value = createElement('div', 'c1pd-bar-value');
      value.append(
        createElement('strong', '', formatCurrency(month.amount, month.currency)),
        createElement(
          'span',
          '',
          `${month.count} reward${month.count === 1 ? '' : 's'}`,
        ),
      );
      row.append(label, track, value);
      bars.append(row);
    }
    chart.append(bars);
    content.append(chart);

    const details = createElement('details', 'c1pd-details');
    const detailsSummary = createElement(
      'summary',
      '',
      `View ${pending.length} pending reward${pending.length === 1 ? '' : 's'}`,
    );
    details.append(detailsSummary);

    const tableWrap = createElement('div', 'c1pd-table-wrap');
    const table = createElement('table', 'c1pd-table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const heading of ['Estimated payout', 'Merchant', 'Purchase date', 'Pending rewards']) {
      headerRow.append(createElement('th', '', heading));
    }
    thead.append(headerRow);

    const tbody = document.createElement('tbody');
    for (const reward of pending) {
      const row = document.createElement('tr');
      row.append(
        createElement('td', '', formatDate(reward.payoutAt)),
        createElement('td', '', reward.vendor || reward.domain || 'Unknown merchant'),
        createElement('td', '', formatDate(reward.createdAt)),
        createElement(
          'td',
          'c1pd-money',
          formatCurrency(reward.rewardsAmount, reward.creditCurrency),
        ),
      );
      tbody.append(row);
    }

    table.append(thead, tbody);
    tableWrap.append(table);
    details.append(tableWrap);
    content.append(details);

    updateStatus(
      root,
      `Checked ${loadedCount} reward and savings records. Updated ${new Intl.DateTimeFormat(
        undefined,
        { hour: 'numeric', minute: '2-digit' },
      ).format(new Date())}.`,
      false,
    );
  }

  function updateStatus(root, message, loading) {
    const status = root.querySelector('.c1pd-status');
    status.textContent = message;
    status.classList.toggle('c1pd-loading', Boolean(loading));
    root.querySelector('.c1pd-refresh').disabled = Boolean(loading);
  }

  function showError(root, error) {
    const content = root.querySelector('.c1pd-content');
    content.replaceChildren();
    const message = createElement('div', 'c1pd-error');
    message.setAttribute('role', 'alert');
    message.append(
      createElement('strong', '', 'Could not build the pending rewards dashboard.'),
      createElement('span', '', error instanceof Error ? error.message : String(error)),
    );
    content.append(message);
    updateStatus(root, 'Refresh to try again.', false);
  }

  function installStyles() {
    if (document.getElementById('c1pd-styles')) return;
    const style = document.createElement('style');
    style.id = 'c1pd-styles';
    style.textContent = `
      #${DASHBOARD_ID} {
        --c1pd-blue: #0276b1;
        --c1pd-blue-dark: #005b87;
        --c1pd-green: #22845b;
        --c1pd-ink: #141414;
        --c1pd-muted: #5f6368;
        --c1pd-line: #dfe3e7;
        --c1pd-soft: #f4f7f9;
        box-sizing: border-box;
        width: 100%;
        margin: 0 0 28px;
        padding: 22px;
        color: var(--c1pd-ink);
        background: #fff;
        border: 1px solid var(--c1pd-line);
        border-radius: 12px;
        box-shadow: 0 5px 18px rgba(17, 37, 52, 0.08);
        font-family: Arial, Helvetica, sans-serif;
      }
      #${DASHBOARD_ID}, #${DASHBOARD_ID} * { box-sizing: border-box; }
      #${DASHBOARD_ID} .c1pd-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 18px;
      }
      #${DASHBOARD_ID} .c1pd-eyebrow {
        margin: 0 0 4px;
        color: var(--c1pd-blue-dark);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }
      #${DASHBOARD_ID} h2,
      #${DASHBOARD_ID} h3 { margin: 0; color: var(--c1pd-ink); }
      #${DASHBOARD_ID} h2 { font-size: 24px; line-height: 1.25; }
      #${DASHBOARD_ID} h3 { margin-bottom: 16px; font-size: 17px; }
      #${DASHBOARD_ID} .c1pd-status {
        min-height: 20px;
        margin: 5px 0 0;
        color: var(--c1pd-muted);
        font-size: 13px;
      }
      #${DASHBOARD_ID} .c1pd-status.c1pd-loading::before {
        content: '';
        display: inline-block;
        width: 10px;
        height: 10px;
        margin-right: 7px;
        border: 2px solid var(--c1pd-line);
        border-top-color: var(--c1pd-blue);
        border-radius: 50%;
        animation: c1pd-spin 0.8s linear infinite;
      }
      @keyframes c1pd-spin { to { transform: rotate(360deg); } }
      #${DASHBOARD_ID} .c1pd-refresh {
        flex: 0 0 auto;
        min-width: 90px;
        padding: 9px 14px;
        color: #fff;
        background: var(--c1pd-blue);
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }
      #${DASHBOARD_ID} .c1pd-refresh:hover { background: var(--c1pd-blue-dark); }
      #${DASHBOARD_ID} .c1pd-refresh:disabled { cursor: wait; opacity: 0.6; }
      #${DASHBOARD_ID} .c1pd-creator {
        flex: 0 0 auto;
        color: var(--c1pd-muted);
        font-size: 11px;
        text-decoration: none;
      }
      #${DASHBOARD_ID} .c1pd-creator:hover {
        color: var(--c1pd-blue-dark);
        text-decoration: underline;
      }
      #${DASHBOARD_ID} .c1pd-stats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      #${DASHBOARD_ID} .c1pd-stat {
        min-width: 0;
        padding: 15px;
        background: var(--c1pd-soft);
        border-radius: 8px;
      }
      #${DASHBOARD_ID} .c1pd-stat-label {
        margin-bottom: 5px;
        color: var(--c1pd-muted);
        font-size: 13px;
      }
      #${DASHBOARD_ID} .c1pd-stat-value {
        overflow-wrap: anywhere;
        color: var(--c1pd-ink);
        font-size: 23px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #${DASHBOARD_ID} .c1pd-stat-note {
        margin-top: 4px;
        overflow-wrap: anywhere;
        color: var(--c1pd-muted);
        font-size: 12px;
      }
      #${DASHBOARD_ID} .c1pd-chart {
        margin-top: 24px;
        padding-top: 21px;
        border-top: 1px solid var(--c1pd-line);
      }
      #${DASHBOARD_ID} .c1pd-bars { display: grid; gap: 12px; }
      #${DASHBOARD_ID} .c1pd-bar-row {
        display: grid;
        grid-template-columns: 88px minmax(90px, 1fr) minmax(110px, auto);
        align-items: center;
        gap: 12px;
      }
      #${DASHBOARD_ID} .c1pd-bar-label {
        color: var(--c1pd-ink);
        font-size: 13px;
        font-weight: 700;
      }
      #${DASHBOARD_ID} .c1pd-bar-track {
        height: 15px;
        overflow: hidden;
        background: #e7edf1;
        border-radius: 999px;
      }
      #${DASHBOARD_ID} .c1pd-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--c1pd-blue), var(--c1pd-green));
        border-radius: inherit;
      }
      #${DASHBOARD_ID} .c1pd-bar-value {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      #${DASHBOARD_ID} .c1pd-bar-value span {
        color: var(--c1pd-muted);
        font-size: 11px;
      }
      #${DASHBOARD_ID} .c1pd-details {
        margin-top: 23px;
        padding-top: 18px;
        border-top: 1px solid var(--c1pd-line);
      }
      #${DASHBOARD_ID} .c1pd-details summary {
        width: fit-content;
        color: var(--c1pd-blue-dark);
        cursor: pointer;
        font-weight: 700;
      }
      #${DASHBOARD_ID} .c1pd-table-wrap {
        max-height: 390px;
        margin-top: 14px;
        overflow: auto;
        border: 1px solid var(--c1pd-line);
        border-radius: 8px;
      }
      #${DASHBOARD_ID} .c1pd-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      #${DASHBOARD_ID} .c1pd-table th,
      #${DASHBOARD_ID} .c1pd-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--c1pd-line);
        white-space: nowrap;
      }
      #${DASHBOARD_ID} .c1pd-table th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--c1pd-soft);
        font-weight: 700;
      }
      #${DASHBOARD_ID} .c1pd-table tr:last-child td { border-bottom: 0; }
      #${DASHBOARD_ID} .c1pd-table th:last-child,
      #${DASHBOARD_ID} .c1pd-table td:last-child { text-align: right; }
      #${DASHBOARD_ID} .c1pd-money {
        color: var(--c1pd-green);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #${DASHBOARD_ID} .c1pd-footer {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        margin-top: 16px;
      }
      #${DASHBOARD_ID} .c1pd-footnote {
        margin: 0;
        color: var(--c1pd-muted);
        font-size: 12px;
      }
      #${DASHBOARD_ID} .c1pd-empty,
      #${DASHBOARD_ID} .c1pd-error {
        margin: 18px 0 0;
        padding: 14px;
        background: var(--c1pd-soft);
        border-radius: 8px;
      }
      #${DASHBOARD_ID} .c1pd-error {
        display: grid;
        gap: 4px;
        color: #8a1c1c;
        background: #fff3f3;
      }
      @media (max-width: 760px) {
        #${DASHBOARD_ID} { padding: 17px; }
        #${DASHBOARD_ID} .c1pd-stats { grid-template-columns: 1fr; }
        #${DASHBOARD_ID} .c1pd-bar-row {
          grid-template-columns: 76px minmax(70px, 1fr) minmax(96px, auto);
          gap: 9px;
        }
        #${DASHBOARD_ID} .c1pd-stat-value { font-size: 21px; }
      }
      @media (prefers-reduced-motion: reduce) {
        #${DASHBOARD_ID} .c1pd-status.c1pd-loading::before { animation: none; }
      }
    `;
    document.head.append(style);
  }

  function createDashboard() {
    const root = createElement('section');
    root.id = DASHBOARD_ID;
    root.setAttribute('aria-labelledby', 'c1pd-heading');

    const header = createElement('div', 'c1pd-header');
    const titleWrap = document.createElement('div');
    titleWrap.append(
      createElement('p', 'c1pd-eyebrow', 'Shopping Rewards only'),
      createElement('h2', '', 'Pending rewards outlook'),
      createElement('p', 'c1pd-status c1pd-loading', 'Reading pending rewards…'),
    );
    titleWrap.querySelector('h2').id = 'c1pd-heading';

    const refresh = createElement('button', 'c1pd-refresh', 'Refresh');
    refresh.type = 'button';
    refresh.disabled = true;

    const creator = createElement('a', 'c1pd-creator', 'by Robo');
    creator.href = 'https://discord.com/app';
    creator.target = '_blank';
    creator.rel = 'noopener noreferrer';
    creator.title = '@robo77 on Discord';
    creator.setAttribute('aria-label', 'Created by Robo, @robo77 on Discord');

    header.append(titleWrap, refresh);

    const content = createElement('div', 'c1pd-content');
    const footnote = createElement(
      'p',
      'c1pd-footnote',
      'Payout dates are estimates supplied by Capital One Shopping. Shopping Savings are excluded from every total.',
    );

    const footer = createElement('div', 'c1pd-footer');
    footer.append(footnote, creator);
    root.append(header, content, footer);
    return root;
  }

  async function loadAndRender(root, fresh) {
    try {
      updateStatus(root, fresh ? 'Refreshing all rewards pages…' : 'Reading pending rewards…', true);
      const rows = await collectAllRows({
        fresh,
        onProgress: (message) => {
          if (root.isConnected) updateStatus(root, message, true);
        },
      });
      // Capital One may replace its server-rendered markup while this request
      // is running. The mount observer will create a fresh dashboard instead.
      if (!root.isConnected) return;
      renderDashboard(root, summarize(rows), rows.length);
    } catch (error) {
      console.error('[Pending Rewards Dashboard]', error);
      if (root.isConnected) showError(root, error);
    }
  }

  function findAnchor() {
    return document.querySelector('.savings-trips-container');
  }

  function isReactManaged(element) {
    let current = element;
    while (current && current !== document.documentElement) {
      if (
        Object.keys(current).some(
          (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$'),
        )
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function initialize() {
    if (document.getElementById(DASHBOARD_ID)) return true;
    const anchor = findAnchor();
    if (!anchor?.parentNode) return false;

    installStyles();
    const root = createDashboard();
    anchor.parentNode.insertBefore(root, anchor);
    root.querySelector('.c1pd-refresh').addEventListener('click', () => loadAndRender(root, true));
    loadAndRender(root, false);
    return true;
  }

  const mountStartedAt = Date.now();
  let mountTimer = 0;

  function isTargetPage() {
    return window.location.pathname.replace(/\/+$/, '') === '/my-rewards/lifetime-savings';
  }

  function scheduleMount(delay = 350) {
    window.clearTimeout(mountTimer);
    mountTimer = window.setTimeout(() => {
      if (!isTargetPage() || document.getElementById(DASHBOARD_ID)) return;

      const anchor = findAnchor();
      if (!anchor) {
        scheduleMount(500);
        return;
      }

      // The initial HTML arrives before React hydration. Inserting at that
      // point makes the dashboard flash and then disappear when React takes
      // over. Wait for React's marker, with a timed fallback for site changes.
      const hydrationTimedOut = Date.now() - mountStartedAt > 12000;
      if (!isReactManaged(anchor) && !hydrationTimedOut) {
        scheduleMount(300);
        return;
      }

      initialize();
    }, delay);
  }

  // Keep watching: route transitions and Capital One component updates can
  // replace this part of the page after the initial hydration as well.
  const mountObserver = new MutationObserver(() => {
    if (!isTargetPage()) {
      document.getElementById(DASHBOARD_ID)?.remove();
      return;
    }
    if (!document.getElementById(DASHBOARD_ID)) scheduleMount();
  });
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });
  scheduleMount(document.readyState === 'complete' ? 350 : 0);
})();
