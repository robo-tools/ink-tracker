import { formatDateOnly } from './dates.js';
import { normalizeLast4, normalizeTransaction, parseMoneyCents } from './normalize.js';

const PARSER_VERSION = 1;
const MONEY_AT_END = '(-?\\$?\\s*(?:[\\d,]+\\.\\d{2}|\\.\\d{2}))';
const ROW_PATTERN = new RegExp(`^(\\d{2}/\\d{2})(?!/\\d)\\s+(?:(\\d{2}/\\d{2})(?!/\\d)\\s+)?(.+?)\\s+${MONEY_AT_END}$`);

function cleanLine(value) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function dateFromMmDd(value, closingDate) {
  const match = String(value ?? '').match(/^(\d{2})\/(\d{2})$/);
  const closing = new Date(`${closingDate}T00:00:00Z`);
  if (!match || Number.isNaN(closing.valueOf())) return '';
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = closing.getUTCFullYear();
  if (month > closing.getUTCMonth() + 1) year -= 1;
  return formatDateOnly(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

function dateFromShort(value) {
  const match = String(value ?? '').match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (!match) return '';
  const year = match[3].length === 2 ? 2_000 + Number(match[3]) : Number(match[3]);
  return formatDateOnly(`${year}-${match[1]}-${match[2]}`);
}

function dateFromDocumentValue(value) {
  const match = String(value ?? '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? formatDateOnly(`${match[1]}-${match[2]}-${match[3]}`) : formatDateOnly(value);
}

function lineSection(line, current) {
  const normalized = line.toUpperCase().replace(/\s*\([^)]*CONTINUED[^)]*\)\s*/g, '').trim();
  if (/^(?:PAYMENTS?(?: AND OTHER CREDITS)?\s*){1,2}$/.test(normalized)) return 'credits';
  if (/^(?:PURCHASES?\s*){1,2}$/.test(normalized)) return 'purchases';
  if (/^(?:CASH ADVANCES?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  if (/^(?:BALANCE TRANSFERS?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  if (/^(?:FEES?(?: CHARGED)?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  if (/^(?:INTEREST(?: CHARGED| CHARGES)?\s*){1,2}$/.test(normalized)) return 'non_purchase';
  return current;
}

export function pdfTextItemsToLines(items, tolerance = 1.25) {
  const groups = [];
  for (const item of items ?? []) {
    const text = cleanLine(item?.str);
    const x = Number(item?.transform?.[4]);
    const y = Number(item?.transform?.[5]);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    let group = groups.find((candidate) => Math.abs(candidate.y - y) <= tolerance);
    if (!group) {
      group = { y, items: [] };
      groups.push(group);
    }
    group.items.push({ x, text });
  }
  return groups.sort((left, right) => right.y - left.y).map((group) => cleanLine(
    group.items.sort((left, right) => left.x - right.x).map((item) => item.text).join(' ')
  )).filter(Boolean);
}

export function parseChaseStatementPages(pages, account, fallbackStatementDate = '') {
  const lines = (pages ?? []).flat().map(cleanLine).filter(Boolean);
  const accountLine = lines.find((line) => /Account Number:/i.test(line));
  const statementLast4 = normalizeLast4(accountLine);
  if (account?.last4 && statementLast4 && statementLast4 !== account.last4) {
    throw new Error('This statement does not match the selected card ending.');
  }
  const cycleLine = lines.find((line) => /Opening\/Closing Date/i.test(line));
  const cycleMatch = cycleLine?.match(/Opening\/Closing Date\s+(\d{2}\/\d{2}\/\d{2,4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  const statementLine = lines.find((line) => /Statement Date:/i.test(line));
  const statementMatch = statementLine?.match(/Statement Date:\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  const openingDate = dateFromShort(cycleMatch?.[1]);
  const closingDate = dateFromShort(cycleMatch?.[2])
    || dateFromShort(statementMatch?.[1])
    || dateFromDocumentValue(fallbackStatementDate);
  if (!closingDate) throw new Error('This PDF did not contain a recognizable Chase statement date.');

  const summaryLine = lines.find((line) => /^Purchases\s+\+?\$[\d,]+\.\d{2}$/i.test(line));
  const purchaseTotalCents = parseMoneyCents(summaryLine?.match(/\+?(\$[\d,]+\.\d{2})$/)?.[1]);
  if (!Number.isFinite(purchaseTotalCents)) throw new Error('This PDF did not contain a recognizable Chase purchase total.');
  const creditSummaryLine = lines.find((line) => /^Payments?(?:\s*(?:,|&|and)\s*(?:Other\s+)?Credits?)?\s+-?\$[\d,]+\.\d{2}$/i.test(line));
  const creditTotalCents = parseMoneyCents(creditSummaryLine?.match(/(-?\$[\d,]+\.\d{2})$/)?.[1]);

  const transactions = [];
  const purchaseRows = [];
  const creditRows = [];
  let section = null;
  for (const line of lines) {
    section = lineSection(line, section);
    const match = line.match(ROW_PATTERN);
    if (!match || !section) continue;
    const amountCents = parseMoneyCents(match[4]);
    const description = cleanLine(match[3]);
    const date = dateFromMmDd(match[2] || match[1], closingDate);
    if (!date || !description || !Number.isFinite(amountCents)) continue;
    const transactionType = section === 'purchases' ? 'purchase'
      : section === 'non_purchase' ? 'fee'
      : '';
    const transaction = normalizeTransaction({
      transactionDate: date,
      description,
      amount: amountCents / 100,
      transactionType,
      accountId: account.id,
      last4: account.last4
    }, account, 'chase-statement');
    if (!transaction) continue;
    transaction.statementDate = closingDate;
    transactions.push(transaction);
    if (section === 'purchases' && amountCents > 0) purchaseRows.push(amountCents);
    if (section === 'credits') creditRows.push(amountCents);
  }

  const parsedPurchaseCents = purchaseRows.reduce((total, amount) => total + amount, 0);
  if (parsedPurchaseCents !== purchaseTotalCents) {
    throw new Error(`Statement purchase reconciliation failed: parsed ${parsedPurchaseCents} cents but Chase reports ${purchaseTotalCents} cents.`);
  }
  const parsedCreditCents = creditRows.reduce((total, amount) => total + amount, 0);
  if (Number.isFinite(creditTotalCents) && parsedCreditCents !== creditTotalCents) {
    throw new Error(`Statement payment/credit reconciliation failed: parsed ${parsedCreditCents} cents but Chase reports ${creditTotalCents} cents.`);
  }

  return {
    parserVersion: PARSER_VERSION,
    openingDate: openingDate || null,
    closingDate,
    statementDate: closingDate,
    purchaseTotalCents,
    parsedPurchaseCents,
    creditTotalCents: Number.isFinite(creditTotalCents) ? creditTotalCents : null,
    parsedCreditCents,
    transactionCount: transactions.length,
    transactions
  };
}
