import { extractNormalizedData } from '../lib/normalize.js';

const INTERESTING_URL = /(account|activity|transaction|reward|earn|spend|card)/i;

export function installChaseNetworkCapture(onNormalizedData) {
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const marker = '__inkTrackerCaptureV1';
  if (page[marker]) return { installed: true, reused: true };

  const inspect = async (response, url) => {
    try {
      if (!INTERESTING_URL.test(String(url))) return;
      const contentType = response.headers?.get?.('content-type') ?? '';
      if (!/json/i.test(contentType)) return;
      const payload = await response.clone().json();
      const normalized = extractNormalizedData(payload, String(url));
      if (normalized.accounts.length || normalized.transactions.length) onNormalizedData(normalized);
    } catch {
      // Chase responses that cannot be cloned or parsed are intentionally ignored.
    }
  };

  try {
    if (typeof page.fetch === 'function') {
      const originalFetch = page.fetch;
      page.fetch = async function inkTrackerFetch(...args) {
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
      xhrPrototype.open = function inkTrackerOpen(method, url, ...rest) {
        this.__inkTrackerUrl = String(url);
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrPrototype.send = function inkTrackerSend(...args) {
        this.addEventListener('load', () => {
          try {
            if (!INTERESTING_URL.test(this.__inkTrackerUrl) || this.status < 200 || this.status >= 300) return;
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            const normalized = extractNormalizedData(payload, this.__inkTrackerUrl);
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
    console.warn('[Ink Tracker] Network capture was unavailable; DOM sync and CSV import still work.', error);
    return { installed: false, error: String(error) };
  }
}
