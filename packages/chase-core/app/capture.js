import { extractNormalizedData } from '../lib/normalize.js';

const INTERESTING_URL = /(account|activity|transaction|reward|earn|spend|card)/i;
const REQUEST_CONTEXT_MARKER = '__chaseTrackerRequestContextV1';
const ORIGINAL_FETCH_MARKER = '__chaseTrackerOriginalFetchV1';
const DOCUMENT_AUTHORIZATION_PATH = '/svc/rr/documents/secure/idal/v2/dockey/list';

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

function pageTarget(page = null) {
  return page ?? (typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : (typeof window !== 'undefined' ? window : null));
}

function defineHidden(target, key, value, writable = true) {
  if (!target) return;
  try {
    Object.defineProperty(target, key, {
      value,
      configurable: false,
      enumerable: false,
      writable
    });
  } catch {
    try {
      target[key] = value;
    } catch {
      // A locked-down page realm may reject marker properties.
    }
  }
}

export function isChaseDocumentRequestUrl(value, method = 'POST') {
  const raw = value?.url ?? value;
  if (!raw) return false;
  try {
    const url = new URL(String(raw), typeof location !== 'undefined' ? location.href : 'https://secure.chase.com/');
    return url.protocol === 'https:'
      && /^secure(?:[0-9a-z-]+)?\.chase\.com$/i.test(url.hostname)
      && url.pathname.toLowerCase() === DOCUMENT_AUTHORIZATION_PATH
      && String(method || 'GET').toUpperCase() === 'POST';
  } catch {
    return false;
  }
}

function requestBodyValue(body, wantedName) {
  if (body == null) return '';
  try {
    if (typeof body.get === 'function') return String(body.get(wantedName) ?? '').trim();
  } catch {
    // Fall through to serialized form bodies.
  }
  if (typeof body !== 'string') return '';
  try {
    return String(new URLSearchParams(body).get(wantedName) ?? '').trim();
  } catch {
    return '';
  }
}

function fetchRequestBody(input, init = {}) {
  if (init && Object.prototype.hasOwnProperty.call(init, 'body') && init.body !== undefined) {
    return Promise.resolve(init.body);
  }
  try {
    const clone = input?.clone?.();
    if (clone && typeof clone.text === 'function') return Promise.resolve(clone.text()).catch(() => undefined);
  } catch {
    // Request bodies are optional; header capture still works without one.
  }
  return Promise.resolve(undefined);
}

export function extractChaseRequestContext(input, init = {}, capturedAt = Date.now(), body = undefined) {
  const hasInitHeaders = init && Object.prototype.hasOwnProperty.call(init, 'headers')
    && init.headers !== undefined;
  const headers = hasInitHeaders ? init.headers : input?.headers;
  const csrfToken = headerValue(headers, 'X-Jpmc-Csrf-Token');
  const channel = headerValue(headers, 'X-Jpmc-Channel');
  const clientRequestId = headerValue(headers, 'X-Jpmc-Client-Request-Id');
  if (!csrfToken && !channel && !clientRequestId) return null;
  return {
    csrfToken,
    channel,
    clientRequestId,
    requestedWith: headerValue(headers, 'X-Requested-With'),
    dateFilterType: requestBodyValue(
      body !== undefined ? body : init?.body,
      'dateFilter.idalDateFilterType'
    ),
    capturedAt
  };
}

function rememberChaseRequestContext(page, captured, requestUrl, method) {
  if (!isChaseDocumentRequestUrl(requestUrl, method)) return;
  if (!captured?.csrfToken || !captured.channel || !captured.clientRequestId) return;
  let requestOrigin = '';
  try {
    requestOrigin = new URL(String(requestUrl), typeof location !== 'undefined' ? location.href : 'https://secure.chase.com/').origin;
  } catch {
    // The URL was already validated; this is only defensive.
  }
  const context = { ...captured, requestOrigin };
  if (Object.prototype.hasOwnProperty.call(page, REQUEST_CONTEXT_MARKER)) {
    try {
      page[REQUEST_CONTEXT_MARKER] = context;
      return;
    } catch {
      // Fall through and try defining a hidden marker.
    }
  }
  defineHidden(page, REQUEST_CONTEXT_MARKER, context);
}

export function chaseRequestContext(page = null) {
  const target = pageTarget(page);
  const context = target?.[REQUEST_CONTEXT_MARKER];
  if (!context || typeof context !== 'object') return null;
  return {
    csrfToken: String(context.csrfToken ?? ''),
    channel: String(context.channel ?? ''),
    clientRequestId: String(context.clientRequestId ?? ''),
    requestedWith: String(context.requestedWith ?? ''),
    dateFilterType: String(context.dateFilterType ?? ''),
    requestOrigin: String(context.requestOrigin ?? ''),
    capturedAt: Number(context.capturedAt ?? 0)
  };
}

export function chasePageFetch(page = null) {
  const target = pageTarget(page);
  const rawFetch = target?.[ORIGINAL_FETCH_MARKER] ?? target?.fetch;
  return typeof rawFetch === 'function' ? rawFetch.bind(target) : null;
}

export function installChaseNetworkCapture(onNormalizedData, options = {}) {
  const page = pageTarget(options.page);
  if (!page) return { installed: false, error: 'Page context is unavailable.' };
  const marker = options.marker || '__chaseTrackerCaptureV1';
  const requestUrlKey = `${marker}Url`;
  const requestMethodKey = `${marker}Method`;
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
      if (!Object.prototype.hasOwnProperty.call(page, ORIGINAL_FETCH_MARKER)) {
        defineHidden(page, ORIGINAL_FETCH_MARKER, originalFetch, false);
      }
      page.fetch = async function chaseTrackerFetch(...args) {
        const requestUrl = args[0]?.url ?? args[0];
        const requestMethod = String(args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
        const capturedAt = Date.now();
        const requestBody = fetchRequestBody(args[0], args[1]);
        const response = await originalFetch.apply(this, args);
        const captured = extractChaseRequestContext(args[0], args[1], capturedAt, await requestBody);
        if (response?.ok) rememberChaseRequestContext(page, captured, requestUrl ?? response.url, requestMethod);
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
        this[requestMethodKey] = String(method ?? 'GET').toUpperCase();
        this[requestHeadersKey] = {};
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrPrototype.setRequestHeader = function chaseTrackerSetRequestHeader(name, value) {
        this[requestHeadersKey] ??= {};
        this[requestHeadersKey][String(name)] = String(value);
        return originalSetRequestHeader.call(this, name, value);
      };
      xhrPrototype.send = function chaseTrackerSend(...args) {
        const captured = extractChaseRequestContext(
          null,
          { headers: this[requestHeadersKey] },
          Date.now(),
          args[0]
        );
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            rememberChaseRequestContext(
              page,
              captured,
              this[requestUrlKey],
              this[requestMethodKey]
            );
            if (!INTERESTING_URL.test(this[requestUrlKey])) return;
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
    defineHidden(page, marker, true);
    return { installed: true, reused: false };
  } catch (error) {
    console.warn(`[${label}] Network capture was unavailable; DOM sync and CSV import still work.`, error);
    return { installed: false, error: String(error) };
  }
}
