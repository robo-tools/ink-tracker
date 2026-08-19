const DAY_MS = 86_400_000;

export function parseDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const text = String(value ?? '').trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return safeUtcDate(+match[1], +match[2], +match[3]);
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const year = +match[3] < 100 ? 2000 + +match[3] : +match[3];
    return safeUtcDate(year, +match[1], +match[2]);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf())
    ? null
    : new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

function safeUtcDate(year, month, day) {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day
    ? result
    : null;
}

function anniversaryInYear(year, month, day) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

export function formatDateOnly(value) {
  const date = parseDateOnly(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

export function formatMonthYear(value) {
  const date = parseDateOnly(value);
  return date
    ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'unknown';
}

export function getAnniversaryWindow(asOf, anniversaryMonth, anniversaryDay) {
  const current = parseDateOnly(asOf) ?? parseDateOnly(new Date());
  const month = Number(anniversaryMonth);
  const day = Number(anniversaryDay);
  if (!current || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;

  let start = anniversaryInYear(current.getUTCFullYear(), month, day);
  if (start > current) start = anniversaryInYear(current.getUTCFullYear() - 1, month, day);
  const nextReset = anniversaryInYear(start.getUTCFullYear() + 1, month, day);
  return {
    start: formatDateOnly(start),
    endExclusive: formatDateOnly(nextReset),
    nextReset: formatDateOnly(nextReset),
    daysRemaining: Math.max(0, Math.ceil((nextReset - current) / DAY_MS))
  };
}

export function getCalendarYearWindow(asOf) {
  const current = parseDateOnly(asOf) ?? parseDateOnly(new Date());
  const year = current.getUTCFullYear();
  return {
    start: `${year}-01-01`,
    endExclusive: `${year + 1}-01-01`,
    nextReset: `${year + 1}-01-01`,
    daysRemaining: Math.max(0, Math.ceil((Date.UTC(year + 1, 0, 1) - current) / DAY_MS))
  };
}

export function dateIsInWindow(dateValue, window) {
  const date = formatDateOnly(dateValue);
  return Boolean(date && window && date >= window.start && date < window.endExclusive);
}
