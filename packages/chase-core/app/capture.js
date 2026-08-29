import { extractNormalizedData } from '../lib/normalize.js';

const INTERESTING_URL = /(account|activity|transaction|reward|earn|spend|card)/i;
const REQUEST_CONTEXT_MARKER = '__chaseTrackerRequestContextV1';

function headerValue(headers, wantedName) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get(wantedName) ?? '').trim();
  } catch {
    // Fall through to the iterable/plain-object readers.
  }
  const wanted = wantedName.toLowerCase();
  try {
    for (const [name, value] of headers) {
      if (String(name).toLowerCase() === wanted) return String(value ?? '').trim();
    }
  } catch {
    // Some page-realm Headers objects are not iterable through the userscript proxy.
  }
  try {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === wanted) return String(value ?? '').trim();
    }
  } catch {
    // Ignore header containers that cannot be enumerated.
  }
  return '';
}

export function extractChaseRequestContext(input, init = {}, capturedAt = Date.now()) {
  const sources = [input?.headers, init?.headers];
  const readLatest = (name) => {
    let value = '';
    for (const headers of sources) value = headerValue(headers, name) || value;
    return value;
  };
  const csrfToken = readLatest('X-Jpmc-Csrf-Token');
  const channel = readLatest('X-Jpmc-Channel');
  const clientRequestId = readLatest('X-Jpmc-Client-Request-Id');
  if (!csrfToken && !channel && !clientRequestId) return null;
  return { csrfToken, channel, clientRequestId, capturedAt };
}

function rememberChaseRequestContext(page, input, init) {
  const captured = extractChaseRequestContext(input, init);
  if (!captured) return;
  const previous = page[REQUEST_CONTEXT_MARKER] ?? {};
  page[REQUEST_CONTEXT_MARKER] = {
    csrfToken: captured.csrfToken || previous.csrfToken || '',
    channel: captured.channel || previous.channel || '',
    clientRequestId: captured.clientRequestId || previous.clientRequestId || '',
    capturedAt: captured.csrfToken ? captured.capturedAt : previous.capturedAt || captured.capturedAt
  };
}

export function chaseRequestContext(page = null) {
  const target = page ?? (typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : (typeof window !== 'undefined' ? window : null));
  const context = target?.[REQUEST_CONTEXT_MARKER];
  if (!context || typeof context !== 'object') return null;
  return {
    csrfToken: String(context.csrfToken ?? ''),
    channel: String(context.channel ?? ''),
    clientRequestId: String(context.clientRequestId ?? ''),
    capturedAt: Number(context.capturedAt ?? 0)
  };
}

export function installChaseNetworkCapture(onNormalizedData, options = {}) {
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const marker = options.marker || '__chaseTrackerCaptureV1';
  const requestUrlKey = `${marker}Url`;
  const requestHeadersKey = `${marker}Headers`;
  const label = options.label || 'Chase Tracker';
  const normalizePayload = options.normalizePayload
    || ((payload, url) => extractNormalizedData(payload, url, options.normalizerOptions));
  if (page[marker]) return { installed: true, reused: true };

  const inspect = async (response, url) => {
    try {
      if (!INTERESTING_URL.test(String(url))) return;
      const contentType = response.headers?.get?.('content-type') ?? '';
      if (!/json/i.test(contentType)) return;
      const payload = await response.clone().json();
      const normalized = normalizePayload(payload, String(url));
      if (normalized.accounts.length || normalized.transactions.length) onNormalizedData(normalized);
    } catch {
      // Chase responses that cannot be cloned or parsed are intentionally ignored.
    }
  };

  try {
    if (typeof page.fetch === 'function') {
      const originalFetch = page.fetch;
      page.fetch = async function chaseTrackerFetch(...args) {
        rememberChaseRequestContext(page, args[0], args[1]);
        const response = await originalFetch.apply(this, args);
        const url = args[0]?.url ?? args[0] ?? response.url;
        void inspect(response, url);
        return response;
      };
    }

    const xhrPrototype = page.XMLHttpRequest?.prototype;
    if (xhrPrototype) {
      const originalOpen = xhrPrototype.open;
      const originalSend = xhrPrototype.send;
      const originalSetRequestHeader = xhrPrototype.setRequestHeader;
      xhrPrototype.open = function chaseTrackerOpen(method, url, ...rest) {
        this[requestUrlKey] = String(url);
        this[requestHeadersKey] = {};
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrPrototype.setRequestHeader = function chaseTrackerSetRequestHeader(name, value) {
        this[requestHeadersKey] ??= {};
        this[requestHeadersKey][String(name)] = String(value);
        return originalSetRequestHeader.call(this, name, value);
      };
      xhrPrototype.send = function chaseTrackerSend(...args) {
        rememberChaseRequestContext(page, null, { headers: this[requestHeadersKey] });
        this.addEventListener('load', () => {
          try {
            if (!INTERESTING_URL.test(this[requestUrlKey]) || this.status < 200 || this.status >= 300) return;
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            const normalized = normalizePayload(payload, this[requestUrlKey]);
            if (normalized.accounts.length || normalized.transactions.length) onNormalizedData(normalized);
          } catch {
            // Non-JSON and protected responses are ignored.
          }
        }, { once: true });
        return originalSend.apply(this, args);
      };
    }
    page[marker] = true;
    return { installed: true, reused: false };
  } catch (error) {
    console.warn(`[${label}] Network capture was unavailable; DOM sync and CSV import still work.`, error);
    return { installed: false, error: String(error) };
  }
}
