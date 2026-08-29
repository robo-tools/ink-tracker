import { parseChaseStatementPages, pdfTextItemsToLines } from '../lib/statements.js';
import { normalizeLast4 } from '../lib/normalize.js';

const PDF_RESOURCE = 'CHASE_TRACKER_PDFJS';
const PDF_WORKER_RESOURCE = 'CHASE_TRACKER_PDFJS_WORKER';
const STATEMENTS_ROUTE = '#/dashboard/documents/myDocs/index;mode=documents';
let pdfJsPromise = null;

function waitForStatementUi(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

export function extractStatementDocuments(root = document, wantedLast4 = '') {
  const documents = new Map();
  for (const anchor of root.querySelectorAll('a[data-documentid]')) {
    if (!/requestThisDocumentAnchor-(?:pdf|download)$/i.test(anchor.id ?? '')) continue;
    const match = anchor.id.match(/accountsTable-(\d+)-/);
    const heading = match ? root.querySelector(`#header-documentsAccordion-${match[1]}`)?.textContent : '';
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

function elementIsVisible(element) {
  if (!element || element.hidden || element.classList?.contains('hide')) return false;
  if (typeof getComputedStyle !== 'function') return true;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

async function expandStatementAccount(wantedLast4, year, signal) {
  assertNotCancelled(signal);
  let button = await waitFor(
    () => statementAccountButton(document, wantedLast4),
    `Chase did not list the card ending …${wantedLast4} on Statements & Documents.`
  );
  if (button.getAttribute('aria-expanded') !== 'true') button.click();
  await waitFor(() => {
    assertNotCancelled(signal);
    button = statementAccountButton(document, wantedLast4);
    if (!button || button.getAttribute('aria-expanded') !== 'true') return false;
    const blockId = button.getAttribute('aria-controls');
    const block = blockId ? document.getElementById(blockId) : null;
    if (!block) return false;
    const documents = extractStatementDocuments(document, wantedLast4);
    if (documents.length) return documents.every((item) => item.statementDate.startsWith(String(year)));
    return ![...block.querySelectorAll('[id^="spinner-payments-"]')].some(elementIsVisible);
  }, `Chase did not finish loading statements for card …${wantedLast4}.`, 30_000);
}

async function selectStatementYear(year, signal) {
  assertNotCancelled(signal);
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
    if (selectedStatementYear() !== year) return false;
    const documents = extractStatementDocuments(document);
    return !documents.length || documents.every((item) => item.statementDate.startsWith(String(year)));
  }, `Chase did not finish loading ${year} statements.`);
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

async function fetchStatementPdf(documentId) {
  const url = new URL('/svc/rr/documents/secure/idal/v5/pdfdoc/star/list', 'https://secure.chase.com');
  url.searchParams.set('docKey', documentId);
  url.searchParams.set('download', 'false');
  url.searchParams.set('adaVersion', 'false');
  url.searchParams.set('fromOrigin', location.origin);
  const pageFetch = typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.fetch === 'function'
    ? unsafeWindow.fetch.bind(unsafeWindow)
    : fetch.bind(globalThis);
  const response = await pageFetch(url.href, { credentials: 'include' });
  if (!response.ok) throw new Error(`Chase returned HTTP ${response.status} for this statement.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  if (signature !== '%PDF') throw new Error('Chase did not return a PDF. The session may have expired.');
  return bytes;
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
        const bytes = await fetchStatementPdf(item.documentId);
        const result = await parseChaseStatementPdf(bytes, account, item.statementDate);
        results.push(result);
        imported.add(result.statementDate);
        await onResult(result, { completed: index + 1, total: wanted.length });
      } catch (error) {
        const failure = { statementDate: displayDate, message: error?.message || String(error) };
        failures.push(failure);
        await onFailure(failure, { completed: index + 1, total: wanted.length });
      }
    }
    return { results, failures, discovered: documents.size };
  } finally {
    if (location.pathname + location.search === originalPath && location.hash !== originalHash) location.hash = originalHash;
  }
}
