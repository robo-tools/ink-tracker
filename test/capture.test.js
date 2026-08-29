import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chasePageFetch,
  chaseRequestContext,
  extractChaseRequestContext,
  installChaseNetworkCapture,
  isChaseDocumentRequestUrl
} from '../packages/chase-core/app/capture.js';

const accessUrl = 'https://secure.chase.com/svc/rr/documents/secure/idal/v2/dockey/list';

function documentHeaders(label) {
  return {
    'X-Jpmc-Csrf-Token': `${label}-token`,
    'X-Jpmc-Channel': 'WEB',
    'X-Jpmc-Client-Request-Id': `${label}-request`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Jpmc-Unrelated-Internal-Header': 'must-not-be-copied'
  };
}

function response(ok = true, status = ok ? 200 : 403) {
  return {
    ok,
    status,
    url: accessUrl,
    headers: { get: () => '' },
    clone() { return this; },
    async json() { return {}; }
  };
}

function documentInit(label, overrides = {}) {
  return {
    method: 'POST',
    headers: documentHeaders(label),
    body: 'accountFilter=test&dateFilter.idalDateFilterType=CURRENT_YEAR&documentId=test',
    ...overrides
  };
}

test('Chase request context reads only the approved headers and native date-filter template', () => {
  const captured = extractChaseRequestContext(null, documentInit('native'), 1234);
  assert.deepEqual(captured, {
    csrfToken: 'native-token',
    channel: 'WEB',
    clientRequestId: 'native-request',
    requestedWith: 'XMLHttpRequest',
    dateFilterType: 'CURRENT_YEAR',
    capturedAt: 1234
  });
  assert.equal('requestHeaders' in captured, false);
});

test('explicit fetch-init headers replace rather than merge with Request headers', () => {
  const captured = extractChaseRequestContext(
    { headers: { 'X-Jpmc-Csrf-Token': 'input-token', 'X-Jpmc-Client-Request-Id': 'input-request' } },
    { headers: { 'X-Jpmc-Channel': 'WEB' } },
    4321
  );
  assert.deepEqual(captured, {
    csrfToken: '',
    channel: 'WEB',
    clientRequestId: '',
    requestedWith: '',
    dateFilterType: '',
    capturedAt: 4321
  });
});

test('Request headers are used when fetch init does not specify headers', () => {
  const captured = extractChaseRequestContext({ headers: documentHeaders('request') }, {}, 99);
  assert.equal(captured.csrfToken, 'request-token');
  assert.equal(captured.clientRequestId, 'request-request');
});

test('native Request bodies provide the captured date-filter template', async () => {
  const page = { async fetch() { return response(true); } };
  installChaseNetworkCapture(() => {}, { page, marker: '__captureRequestBody' });
  await page.fetch({
    url: accessUrl,
    method: 'POST',
    headers: documentHeaders('request-body'),
    clone() {
      return { async text() { return 'dateFilter.idalDateFilterType=ARCHIVE'; } };
    }
  });
  assert.equal(chaseRequestContext(page).dateFilterType, 'ARCHIVE');
});

test('cross-realm Headers proxies can be read without enumeration', () => {
  const values = new Map(Object.entries(documentHeaders('proxy')).map(([key, value]) => [key.toLowerCase(), value]));
  const proxy = {
    get(name) { return values.get(String(name).toLowerCase()) ?? null; },
    entries() { throw new Error('cross-realm iteration denied'); },
    [Symbol.iterator]() { throw new Error('cross-realm iteration denied'); }
  };
  const captured = extractChaseRequestContext(null, { headers: proxy }, 100);
  assert.equal(captured.csrfToken, 'proxy-token');
  assert.equal(captured.channel, 'WEB');
  assert.equal(captured.clientRequestId, 'proxy-request');
  assert.equal(captured.requestedWith, 'XMLHttpRequest');
});

test('document authorization capture accepts only the exact Chase POST endpoint', () => {
  assert.equal(isChaseDocumentRequestUrl(accessUrl, 'POST'), true);
  assert.equal(isChaseDocumentRequestUrl(accessUrl, 'GET'), false);
  assert.equal(isChaseDocumentRequestUrl('https://secure27ea.chase.com/svc/rr/documents/secure/idal/v2/dockey/list', 'POST'), true);
  assert.equal(isChaseDocumentRequestUrl('https://secure.chase.com/svc/rr/documents/secure/idal/v2/list', 'POST'), false);
  assert.equal(isChaseDocumentRequestUrl('https://secure.chase.com/svc/rr/documents/secure/idal/v5/pdfdoc/star/list', 'GET'), false);
  assert.equal(isChaseDocumentRequestUrl('https://example.com/svc/rr/documents/secure/idal/v2/dockey/list', 'POST'), false);
});

test('stored Chase request context exposes only normalized memory-only fields', () => {
  const page = {
    __chaseTrackerRequestContextV1: {
      csrfToken: 'token', channel: 'WEB', clientRequestId: 'request', capturedAt: 99, ignored: true
    }
  };
  assert.deepEqual(chaseRequestContext(page), {
    csrfToken: 'token',
    channel: 'WEB',
    clientRequestId: 'request',
    requestedWith: '',
    dateFilterType: '',
    requestOrigin: '',
    capturedAt: 99
  });
});

test('capture stores complete context only after a successful native document request', async () => {
  const replies = [response(true), response(false), response(true)];
  const page = {
    async fetch() { return replies.shift(); }
  };
  installChaseNetworkCapture(() => {}, { page, marker: '__captureTestA' });

  await page.fetch(accessUrl, documentInit('first'));
  assert.equal(chaseRequestContext(page).csrfToken, 'first-token');
  assert.equal(chaseRequestContext(page).dateFilterType, 'CURRENT_YEAR');
  assert.equal(chaseRequestContext(page).requestOrigin, 'https://secure.chase.com');

  await page.fetch(accessUrl, documentInit('failed'));
  assert.equal(chaseRequestContext(page).csrfToken, 'first-token');

  await page.fetch(accessUrl, documentInit('incomplete', {
    headers: { 'X-Jpmc-Csrf-Token': 'partial-token' }
  }));
  assert.equal(chaseRequestContext(page).csrfToken, 'first-token');
});

test('raw page fetch bypasses capture and cannot poison native context', async () => {
  const page = { async fetch() { return response(true); } };
  installChaseNetworkCapture(() => {}, { page, marker: '__captureTestB' });
  await page.fetch(accessUrl, documentInit('native'));
  const rawFetch = chasePageFetch(page);
  await rawFetch(accessUrl, documentInit('tracker'));
  assert.equal(chaseRequestContext(page).csrfToken, 'native-token');
});

test('sequential successful native requests replace complete contexts atomically', async () => {
  const page = { async fetch() { return response(true); } };
  installChaseNetworkCapture(() => {}, { page, marker: '__captureTestC' });
  await page.fetch(accessUrl, documentInit('first'));
  await page.fetch(accessUrl, documentInit('second'));
  const context = chaseRequestContext(page);
  assert.equal(context.csrfToken, 'second-token');
  assert.equal(context.clientRequestId, 'second-request');
});

test('Ink and Hyatt wrappers share one raw fetch while both observe native responses', async () => {
  let underlyingCalls = 0;
  const page = {
    async fetch() {
      underlyingCalls += 1;
      return response(true);
    }
  };
  installChaseNetworkCapture(() => {}, { page, marker: '__inkCapture' });
  installChaseNetworkCapture(() => {}, { page, marker: '__hyattCapture' });
  await page.fetch(accessUrl, documentInit('native'));
  assert.equal(underlyingCalls, 1);
  await chasePageFetch(page)(accessUrl, documentInit('tracker'));
  assert.equal(underlyingCalls, 2);
  assert.equal(chaseRequestContext(page).csrfToken, 'native-token');
  assert.equal(Object.keys(page).some((key) => key.includes('OriginalFetch') || key.includes('RequestContext')), false);
});

test('XHR capture commits on 2xx and preserves context after 403', () => {
  class FakeXHR {
    constructor() {
      this.status = FakeXHR.nextStatus;
      this.responseText = '{}';
      this.listeners = {};
    }
    open() {}
    setRequestHeader() {}
    addEventListener(name, listener) { this.listeners[name] = listener; }
    send() { this.listeners.load?.(); }
  }
  FakeXHR.nextStatus = 200;
  const page = { fetch: async () => response(true), XMLHttpRequest: FakeXHR };
  installChaseNetworkCapture(() => {}, { page, marker: '__captureTestXhr' });

  const first = new page.XMLHttpRequest();
  first.open('POST', accessUrl);
  for (const [name, value] of Object.entries(documentHeaders('xhr'))) first.setRequestHeader(name, value);
  first.send('dateFilter.idalDateFilterType=PAST_YEAR');
  assert.equal(chaseRequestContext(page).csrfToken, 'xhr-token');
  assert.equal(chaseRequestContext(page).dateFilterType, 'PAST_YEAR');

  FakeXHR.nextStatus = 403;
  const failed = new page.XMLHttpRequest();
  failed.open('POST', accessUrl);
  for (const [name, value] of Object.entries(documentHeaders('failed'))) failed.setRequestHeader(name, value);
  failed.send('dateFilter.idalDateFilterType=PAST_YEAR');
  assert.equal(chaseRequestContext(page).csrfToken, 'xhr-token');
});
