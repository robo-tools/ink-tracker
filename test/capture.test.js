import test from 'node:test';
import assert from 'node:assert/strict';
import { installChaseNetworkCapture } from '../packages/chase-core/app/capture.js';

function payloadNormalizer(payload) {
  return {
    accounts: payload.account ? [{ id: payload.account }] : [],
    transactions: payload.transaction ? [{ id: payload.transaction }] : []
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('fetch capture observes interesting Chase JSON without changing the response', async () => {
  const captured = [];
  const page = {
    fetch: async () => new Response(JSON.stringify({ account: 'card-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  };
  const status = installChaseNetworkCapture((value) => captured.push(value), {
    page,
    marker: '__testCapture',
    normalizePayload: payloadNormalizer
  });
  assert.equal(status.installed, true);
  const response = await page.fetch('https://secure.chase.com/api/account/activity');
  assert.deepEqual(await response.json(), { account: 'card-1' });
  await settle();
  assert.deepEqual(captured, [{ accounts: [{ id: 'card-1' }], transactions: [] }]);
});

test('capture ignores unrelated and non-JSON fetch responses', async () => {
  const captured = [];
  const page = {
    fetch: async () => new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' }
    })
  };
  installChaseNetworkCapture((value) => captured.push(value), {
    page,
    marker: '__testCapture',
    normalizePayload: payloadNormalizer
  });
  await page.fetch('https://secure.chase.com/api/account');
  await page.fetch('https://secure.chase.com/api/navigation');
  await settle();
  assert.deepEqual(captured, []);
});

test('two tracker wrappers share one underlying fetch while both observe the response', async () => {
  let rawCalls = 0;
  const first = [];
  const second = [];
  const page = {
    fetch: async () => {
      rawCalls += 1;
      return new Response(JSON.stringify({ transaction: 'row-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
  installChaseNetworkCapture((value) => first.push(value), {
    page,
    marker: '__firstCapture',
    normalizePayload: payloadNormalizer
  });
  installChaseNetworkCapture((value) => second.push(value), {
    page,
    marker: '__secondCapture',
    normalizePayload: payloadNormalizer
  });
  await page.fetch('https://secure.chase.com/api/transactions');
  await settle();
  assert.equal(rawCalls, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

test('XHR capture observes successful interesting JSON', () => {
  const captured = [];
  const listeners = new WeakMap();
  function MockXhr() {
    this.status = 200;
    this.responseType = 'json';
    this.response = { account: 'card-xhr' };
  }
  MockXhr.prototype.addEventListener = function addEventListener(name, listener) {
    if (name === 'load') listeners.set(this, listener);
  };
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() { listeners.get(this)?.(); };

  const page = { XMLHttpRequest: MockXhr };
  installChaseNetworkCapture((value) => captured.push(value), {
    page,
    marker: '__xhrCapture',
    normalizePayload: payloadNormalizer
  });
  const request = new page.XMLHttpRequest();
  request.open('GET', 'https://secure.chase.com/api/account');
  request.send();
  assert.deepEqual(captured, [{ accounts: [{ id: 'card-xhr' }], transactions: [] }]);
});
