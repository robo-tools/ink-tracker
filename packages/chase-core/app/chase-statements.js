import { parseChaseStatementPages, pdfTextItemsToLines } from '../lib/statements.js';

let pdfJsPromise = null;

async function loadPdfJs() {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = (async () => {
    if (typeof GM === 'undefined' || typeof GM.getResourceText !== 'function') {
      throw new Error('Tampermonkey PDF resources are unavailable. Reinstall the userscript and try again.');
    }
    const [moduleSource, workerSource] = await Promise.all([
      GM.getResourceText('CHASE_TRACKER_PDFJS'),
      GM.getResourceText('CHASE_TRACKER_PDFJS_WORKER')
    ]);
    if (!moduleSource || !workerSource) throw new Error('The bundled PDF parser could not be loaded.');
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

function daysBetween(left, right) {
  const start = new Date(`${left}T00:00:00Z`);
  const end = new Date(`${right}T00:00:00Z`);
  return Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) ? Infinity : Math.round((end - start) / 86_400_000);
}

function statementsConflict(existing, result) {
  if (!existing) return false;
  if (existing.openingDate && result.openingDate && existing.openingDate !== result.openingDate) return true;
  if (existing.closingDate && result.closingDate && existing.closingDate !== result.closingDate) return true;
  if (Number.isFinite(existing.purchaseTotalCents)
    && Number.isFinite(result.purchaseTotalCents)
    && existing.purchaseTotalCents !== result.purchaseTotalCents) return true;
  return Boolean(existing.statementAccountLast4
    && result.statementAccountLast4
    && existing.statementAccountLast4 !== result.statementAccountLast4);
}

export function mergeStatementCoverage(existing = {}, results = [], context = {}) {
  const periodMap = new Map((existing.periods ?? []).map((period) => [period.statementDate, period]));
  for (const result of results) {
    const previous = periodMap.get(result.statementDate);
    if (statementsConflict(previous, result)) {
      throw new Error(`A different statement is already saved for ${result.statementDate}.`);
    }
    periodMap.set(result.statementDate, {
      parserVersion: result.parserVersion,
      openingDate: result.openingDate,
      closingDate: result.closingDate,
      statementDate: result.statementDate,
      statementAccountLast4: result.statementAccountLast4 ?? previous?.statementAccountLast4 ?? null,
      purchaseTotalCents: result.purchaseTotalCents,
      transactionCount: result.transactionCount
    });
  }
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
