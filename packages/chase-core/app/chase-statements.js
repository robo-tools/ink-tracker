import { parseChaseStatementPages, pdfTextItemsToLines } from '../lib/statements.js';
import { normalizeLast4 } from '../lib/normalize.js';

const PDF_RESOURCE = 'CHASE_TRACKER_PDFJS';
const PDF_WORKER_RESOURCE = 'CHASE_TRACKER_PDFJS_WORKER';
const STATEMENTS_ROUTE = '#/dashboard/documents/myDocs/index;mode=documents';
const YEAR_SETTLE_DELAY = Object.freeze({ min: 1_000, max: 1_500 });
const PDF_REQUEST_DELAY = Object.freeze({ min: 600, max: 900 });
const PDF_RETRY_DELAYS = Object.freeze([2_000, 5_000]);
let pdfJsPromise = null;

function waitForStatementUi(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomDelay({ min, max }) {
  return Math.round(min + (Math.random() * (max - min)));
}

function waitWithCancellation(milliseconds, signal) {
  assertNotCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Statement backfill cancelled.', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitFor(predicate, message, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await waitForStatementUi(200);
  }
  throw new Error(message);
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Statement backfill cancelled.', 'AbortError');
}

function dashboardPath() {
  return `${location.pathname}${location.search}`;
}

function statementRoute() {
  return STATEMENTS_ROUTE;
}

export function statementYearOptions(root = document) {
  const options = [...root.querySelectorAll([
    '#ul-list-container-filterstyledselect-0 a.option',
    '#ul-list-container-filterstyledselect-0 [role="option"]'
  ].join(','))];
  return [...new Set(options)].map((option) => ({
    option,
    year: Number(option.querySelector('.primary')?.textContent?.trim() || option.textContent?.trim())
  })).filter((item) => Number.isInteger(item.year));
}

export function selectedStatementYear(root = document) {
  const control = root.querySelector('#header-filterstyledselect-0');
  const controlText = String(control?.value ?? control?.getAttribute?.('value') ?? control?.textContent ?? control?.getAttribute?.('aria-label') ?? '');
  const controlYear = Number(controlText.match(/\b(20\d{2})\b/)?.[1]);
  if (Number.isInteger(controlYear)) return controlYear;
  return statementYearOptions(root).find((item) => (
    item.option.classList?.contains('active') || item.option.getAttribute?.('aria-selected') === 'true'
  ))?.year ?? null;
}

function compactStatementDate(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  let match = text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (match) return `${match[1]}${match[2]}${match[3]}`;
  match = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return `${match[1]}${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`;
  match = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}${match[1].padStart(2, '0')}${match[2].padStart(2, '0')}`;
  }
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  match = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(20\d{2})\b/i);
  return match ? `${match[3]}${months[match[1].slice(0, 3).toLowerCase()]}${match[2].padStart(2, '0')}` : '';
}

function statementDateForAnchor(anchor) {
  const direct = compactStatementDate(anchor.dataset?.date);
  if (direct) return direct;
  const row = anchor.closest?.('tr,[id^="accountsTable-"][id*="-row"]');
  const dateCell = row?.querySelector?.('[id$="-cell0"],td:first-child');
  return compactStatementDate(dateCell?.textContent ?? row?.textContent ?? anchor.textContent);
}

function statementAccountLabel(root, index) {
  return root.querySelector(`#header-documentsAccordion-${index}`)?.textContent
    || root.querySelector(`#button-documentsAccordion-${index}`)?.textContent
    || '';
}

export function extractStatementDocuments(root = document, wantedLast4 = '') {
  const documents = new Map();
  for (const anchor of root.querySelectorAll('a[data-documentid]')) {
    if (!/requestThisDocumentAnchor-(?:pdf|download)$/i.test(anchor.id ?? '')) continue;
    const match = anchor.id.match(/accountsTable-(\d+)-/);
    const heading = match ? statementAccountLabel(root, match[1]) : '';
    const last4 = normalizeLast4(heading);
    if (wantedLast4 && last4 !== wantedLast4) continue;
    const documentId = String(anchor.dataset.documentid ?? '').trim();
    const statementDate = statementDateForAnchor(anchor);
    if (!documentId || !/^\d{8}$/.test(statementDate)) continue;
    documents.set(`${last4}|${statementDate}`, {
      documentId,
      statementDate,
      last4,
      accountDocumentId: String(anchor.dataset.accountid ?? ''),
      accountLabel: String(heading ?? '').replace(/\s+/g, ' ').trim()
    });
  }
  return [...documents.values()].sort((left, right) => left.statementDate.localeCompare(right.statementDate));
}

export function statementAccountButton(root = document, wantedLast4 = '') {
  return [...root.querySelectorAll('button[id^="button-documentsAccordion-"]')]
    .find((button) => normalizeLast4(button.textContent) === wantedLast4) ?? null;
}

export function elementIsVisible(element) {
  if (!element) return false;
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.classList?.contains('hide')) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
  }
  return true;
}

export function chaseStatementErrorMessage(root = document) {
  const pattern = /site isn['’]t working|having trouble|unable to (?:complete|load)|please try again/i;
  const candidates = root.querySelectorAll([
    '#serviceErrorModal',
    '#globalErrorContainer',
    '[role="dialog"]'
  ].join(','));
  for (const element of candidates) {
    const text = String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text && pattern.test(text) && elementIsVisible(element)) return text;
  }
  return '';
}

function assertNoChaseStatementError() {
  const message = chaseStatementErrorMessage(document);
  if (message) {
    throw new Error('Chase reported that Statements & Documents is temporarily unavailable. Close Chase’s error message, refresh the page, and retry the statement scan.');
  }
}

function statementUiIsLoading(root = document) {
  return [...root.querySelectorAll('#content-spinner-overlay,[id^="spinner-payments-"]')]
    .some(elementIsVisible);
}

function statementPanelIsEmpty(block) {
  const text = String(block?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return /(?:no|don['’]t have any) (?:statements|documents)|nothing to (?:display|show)/i.test(text);
}

async function expandStatementAccount(wantedLast4, year, signal) {
  assertNotCancelled(signal);
  assertNoChaseStatementError();
  let button = await waitFor(
    () => statementAccountButton(document, wantedLast4),
    `Chase did not list the card ending …${wantedLast4} on Statements & Documents.`
  );
  if (button.getAttribute('aria-expanded') !== 'true') button.click();
  await waitFor(() => {
    assertNotCancelled(signal);
    assertNoChaseStatementError();
    button = statementAccountButton(document, wantedLast4);
    if (!button) return false;
    const blockId = button.getAttribute('aria-controls');
    const block = blockId ? document.getElementById(blockId) : null;
    if (!block) return false;
    const documents = extractStatementDocuments(document, wantedLast4);
    if (documents.length) return documents.every((item) => item.statementDate.startsWith(String(year)));
    if (button.getAttribute('aria-expanded') !== 'true') return false;
    return !statementUiIsLoading(block) && statementPanelIsEmpty(block);
  }, `Chase did not finish loading statements for card …${wantedLast4}.`, 30_000);
}

async function selectStatementYear(year, signal) {
  assertNotCancelled(signal);
  assertNoChaseStatementError();
  let item = statementYearOptions().find((candidate) => candidate.year === year);
  if (!item) return false;
  if (selectedStatementYear() !== year) {
    const control = document.querySelector('#header-filterstyledselect-0');
    if (control?.getAttribute('aria-expanded') !== 'true') control?.click();
    item = statementYearOptions().find((candidate) => candidate.year === year) ?? item;
    item.option.click();
  }
  await waitFor(() => {
    assertNotCancelled(signal);
    assertNoChaseStatementError();
    if (selectedStatementYear() !== year) return false;
    if (statementUiIsLoading()) return false;
    const documents = extractStatementDocuments(document);
    return !documents.length || documents.every((item) => item.statementDate.startsWith(String(year)));
  }, `Chase did not finish loading ${year} statements.`);
  await waitWithCancellation(randomDelay(YEAR_SETTLE_DELAY), signal);
  assertNoChaseStatementError();
  return true;
}

async function loadPdfJs() {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = (async () => {
    if (typeof GM === 'undefined' || typeof GM.getResourceText !== 'function') {
      throw new Error('Tampermonkey did not provide the bundled statement parser. Reinstall or update the userscript.');
    }
    const [moduleSource, workerSource] = await Promise.all([
      GM.getResourceText(PDF_RESOURCE),
      GM.getResourceText(PDF_WORKER_RESOURCE)
    ]);
    if (!moduleSource || !workerSource) throw new Error('The bundled statement parser resources are unavailable.');
    const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    try {
      const pdfjs = await import(moduleUrl);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    } catch (error) {
      URL.revokeObjectURL(moduleUrl);
      URL.revokeObjectURL(workerUrl);
      pdfJsPromise = null;
      throw error;
    }
  })();
  return pdfJsPromise;
}

export async function parseChaseStatementPdf(bytes, account, fallbackStatementDate = '') {
  const pdfjs = await loadPdfJs();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(pdfTextItemsToLines(content.items));
    }
    return parseChaseStatementPages(pages, account, fallbackStatementDate);
  } finally {
    await pdf.destroy();
  }
}

function secureChaseOrigin(value) {
  if (!String(value ?? '').trim()) return '';
  try {
    const url = new URL(String(value ?? ''), 'https://secure.chase.com/');
    return url.protocol === 'https:' && /^secure(?:[0-9a-z-]+)?\.chase\.com$/i.test(url.hostname)
      ? url.origin
      : '';
  } catch {
    return '';
  }
}

export function statementRequestOriginCandidates(context = {}) {
  const pageOrigin = secureChaseOrigin(context.pageOrigin
    ?? (typeof location !== 'undefined' ? location.origin : ''));
  const sources = context.sources ?? (() => {
    const entries = typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
      ? performance.getEntriesByType('resource').map((entry) => entry.name)
      : [];
    const elementUrls = typeof document !== 'undefined'
      ? [...document.querySelectorAll('iframe[src],script[src],link[href]')]
        .map((element) => element.src || element.href)
      : [];
    return [
      typeof location !== 'undefined' ? location.href : '',
      typeof document !== 'undefined' ? document.referrer : '',
      ...entries,
      ...elementUrls
    ];
  })();
  const explicit = new Set();
  const detected = new Set();
  for (const source of sources) {
    try {
      const url = new URL(String(source ?? ''), pageOrigin || 'https://secure.chase.com/');
      const nestedOrigin = secureChaseOrigin(url.searchParams.get('fromOrigin'));
      if (nestedOrigin) explicit.add(nestedOrigin);
      const origin = secureChaseOrigin(url.origin);
      if (origin) detected.add(origin);
    } catch {
      // Ignore unrelated or malformed page resources.
    }
  }
  if (pageOrigin) detected.add(pageOrigin);
  const canonical = 'https://secure.chase.com';
  const nonCanonical = [...detected].filter((origin) => origin !== canonical);
  return [...new Set([
    ...explicit,
    ...(pageOrigin && pageOrigin !== canonical ? [pageOrigin] : []),
    ...nonCanonical,
    ...(pageOrigin === canonical ? [pageOrigin] : []),
    canonical
  ])];
}

function statementHttpError(status) {
  const error = new Error(`Chase returned HTTP ${status} for this statement.`);
  error.status = status;
  error.retryable = status === 408 || status === 429 || status >= 500;
  return error;
}

function validateStatementPdfBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  if (signature !== '%PDF') {
    const error = new Error('Chase did not return a PDF. The session may have expired.');
    error.retryable = true;
    throw error;
  }
  return bytes;
}

function requestStatementPdfWithTampermonkey(url, signal) {
  assertNotCancelled(signal);
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      request?.abort?.();
      reject(new DOMException('Statement backfill cancelled.', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      request = GM.xmlHttpRequest({
        method: 'GET',
        url: url.href,
        responseType: 'arraybuffer',
        anonymous: false,
        headers: { Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8' },
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            finish(reject, statementHttpError(response.status));
            return;
          }
          try {
            finish(resolve, validateStatementPdfBytes(response.response));
          } catch (error) {
            finish(reject, error);
          }
        },
        onerror: () => {
          const error = new Error('Chase statement request failed at the browser network layer.');
          error.name = 'NetworkError';
          finish(reject, error);
        },
        ontimeout: () => {
          const error = new Error('Chase statement request timed out.');
          error.name = 'TimeoutError';
          finish(reject, error);
        },
        onabort: onAbort
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function fetchStatementPdfForOrigin(documentId, signal, fromOrigin) {
  const url = new URL('/svc/rr/documents/secure/idal/v5/pdfdoc/star/list', 'https://secure.chase.com');
  url.searchParams.set('docKey', documentId);
  url.searchParams.set('download', 'false');
  url.searchParams.set('adaVersion', 'false');
  url.searchParams.set('fromOrigin', fromOrigin);
  if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') {
    return requestStatementPdfWithTampermonkey(url, signal);
  }
  const pageFetch = typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.fetch === 'function'
    ? unsafeWindow.fetch.bind(unsafeWindow)
    : fetch.bind(globalThis);
  const response = await pageFetch(url.href, { credentials: 'include', signal });
  if (!response.ok) throw statementHttpError(response.status);
  return validateStatementPdfBytes(await response.arrayBuffer());
}

async function fetchStatementPdfAcrossOrigins(documentId, signal) {
  const origins = statementRequestOriginCandidates();
  let lastError = null;
  for (let index = 0; index < origins.length; index += 1) {
    try {
      return await fetchStatementPdfForOrigin(documentId, signal, origins[index]);
    } catch (error) {
      lastError = error;
      if (![401, 403].includes(error?.status) || index === origins.length - 1) break;
    }
  }
  if (lastError) {
    lastError.attemptedOrigins = origins;
    throw lastError;
  }
  throw new Error('Chase did not provide a usable statement request origin.');
}

export function isRetryableStatementFetchError(error) {
  if (!error || error.name === 'AbortError') return false;
  return error.retryable === true || ['TypeError', 'NetworkError', 'TimeoutError'].includes(error.name);
}

async function fetchStatementPdfWithRetry(documentId, options = {}) {
  const { signal, onRetry = () => {} } = options;
  for (let attempt = 0; ; attempt += 1) {
    assertNotCancelled(signal);
    try {
      return await fetchStatementPdfAcrossOrigins(documentId, signal);
    } catch (error) {
      const baseDelay = PDF_RETRY_DELAYS[attempt];
      if (baseDelay == null || !isRetryableStatementFetchError(error)) throw error;
      const delay = Math.round(baseDelay * (0.9 + (Math.random() * 0.2)));
      onRetry({ attempt: attempt + 2, delay, error });
      await waitWithCancellation(delay, signal);
    }
  }
}

function daysBetween(left, right) {
  const start = new Date(`${left}T00:00:00Z`);
  const end = new Date(`${right}T00:00:00Z`);
  return Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) ? Infinity : Math.round((end - start) / 86_400_000);
}

export function mergeStatementCoverage(existing = {}, results = [], context = {}) {
  const periodMap = new Map((existing.periods ?? []).map((period) => [period.statementDate, period]));
  for (const result of results) periodMap.set(result.statementDate, {
    parserVersion: result.parserVersion,
    openingDate: result.openingDate,
    closingDate: result.closingDate,
    statementDate: result.statementDate,
    purchaseTotalCents: result.purchaseTotalCents,
    transactionCount: result.transactionCount
  });
  const periods = [...periodMap.values()].filter((period) => period.openingDate && period.closingDate)
    .sort((left, right) => left.openingDate.localeCompare(right.openingDate));
  const gaps = [];
  for (let index = 1; index < periods.length; index += 1) {
    const gapDays = daysBetween(periods[index - 1].closingDate, periods[index].openingDate);
    if (gapDays > 2) gaps.push({ after: periods[index - 1].closingDate, before: periods[index].openingDate });
  }
  const earliest = periods[0]?.openingDate ?? null;
  const latest = periods.at(-1)?.closingDate ?? null;
  const benefitStartDate = context.benefitStartDate || existing.benefitStartDate || '';
  const activityEarliest = context.activityEarliest || existing.activityEarliest || '';
  const startCovered = Boolean(benefitStartDate && earliest && earliest <= benefitStartDate);
  const endCovered = Boolean(activityEarliest && latest && latest >= activityEarliest);
  return {
    periods,
    statementCount: periods.length,
    earliest,
    latest,
    gaps,
    benefitStartDate,
    activityEarliest,
    complete: startCovered && endCovered && gaps.length === 0,
    updatedAt: new Date().toISOString()
  };
}

export async function collectChaseStatementBackfill(options) {
  const {
    account,
    benefitStartDate,
    activityEarliest,
    importedStatementDates = [],
    progress = () => {},
    onResult = async () => {},
    onFailure = async () => {},
    signal
  } = options;
  if (!account?.last4) throw new Error('The Hyatt card must have a last four before statements can be matched.');
  if (!benefitStartDate) throw new Error('Enter when the current Hyatt benefits began before starting a statement backfill.');
  if (!activityEarliest) throw new Error('Refresh or import the recent Chase activity before backfilling older statements.');

  const originalPath = dashboardPath();
  const originalHash = location.hash;
  const imported = new Set(importedStatementDates);
  try {
    progress('Opening Chase Statements & Documents…');
    if (!location.hash.includes('/dashboard/documents/myDocs/')) location.hash = statementRoute();
    await waitFor(() => statementYearOptions().length, 'Chase Statements & Documents did not finish loading.', 30_000);

    const startYear = Number(benefitStartDate.slice(0, 4));
    const endYear = Number(activityEarliest.slice(0, 4));
    const years = statementYearOptions().map((item) => item.year)
      .filter((year) => year >= startYear && year <= endYear)
      .sort((left, right) => left - right);
    if (!years.length) throw new Error('No available statement years overlap the missing Hyatt history.');

    const documents = new Map();
    for (const year of years) {
      assertNotCancelled(signal);
      assertNoChaseStatementError();
      progress(`Finding ${year} statements for …${account.last4}…`);
      await selectStatementYear(year, signal);
      await expandStatementAccount(account.last4, year, signal);
      for (const item of extractStatementDocuments(document, account.last4)) {
        documents.set(item.statementDate, item);
      }
    }

    const wanted = [...documents.values()].filter((item) => {
      const closingDate = `${item.statementDate.slice(0, 4)}-${item.statementDate.slice(4, 6)}-${item.statementDate.slice(6, 8)}`;
      return closingDate >= benefitStartDate && !imported.has(closingDate);
    }).sort((left, right) => left.statementDate.localeCompare(right.statementDate));
    assertNoChaseStatementError();
    if (!documents.size) throw new Error(`No statements matched Hyatt card …${account.last4}.`);
    if (!wanted.length) return { results: [], failures: [], discovered: documents.size };

    const results = [];
    const failures = [];
    for (let index = 0; index < wanted.length; index += 1) {
      assertNotCancelled(signal);
      const item = wanted[index];
      const displayDate = `${item.statementDate.slice(0, 4)}-${item.statementDate.slice(4, 6)}-${item.statementDate.slice(6, 8)}`;
      progress(`Parsing statement ${index + 1} of ${wanted.length} (${displayDate})…`);
      try {
        const bytes = await fetchStatementPdfWithRetry(item.documentId, {
          signal,
          onRetry: ({ attempt, delay }) => progress(
            `Chase temporarily rejected ${displayDate}; retrying in ${Math.ceil(delay / 1_000)} seconds (attempt ${attempt} of 3)…`
          )
        });
        const result = await parseChaseStatementPdf(bytes, account, item.statementDate);
        results.push(result);
        imported.add(result.statementDate);
        await onResult(result, { completed: index + 1, total: wanted.length });
      } catch (error) {
        if ([401, 403].includes(error?.status)) {
          const checked = (error.attemptedOrigins ?? []).map((origin) => {
            try { return new URL(origin).hostname; } catch { return origin; }
          }).filter(Boolean).join(', ');
          throw new Error(
            `Chase rejected the statement request (HTTP ${error.status}). The scan stopped after the first authorization failure instead of requesting the remaining PDFs. Reload Chase, sign in again if prompted, and retry.${checked ? ` Document origins checked: ${checked}.` : ''}`
          );
        }
        const failure = { statementDate: displayDate, message: error?.message || String(error) };
        failures.push(failure);
        await onFailure(failure, { completed: index + 1, total: wanted.length });
      }
      if (index < wanted.length - 1) {
        await waitWithCancellation(randomDelay(PDF_REQUEST_DELAY), signal);
      }
    }
    return { results, failures, discovered: documents.size };
  } finally {
    if (location.pathname + location.search === originalPath && location.hash !== originalHash) location.hash = originalHash;
  }
}
