import test from 'node:test';
import assert from 'node:assert/strict';
import { chaseRequestContext, extractChaseRequestContext } from '../packages/chase-core/app/capture.js';

test('Chase request context reads JPMorgan headers case-insensitively', () => {
  const captured = extractChaseRequestContext(null, {
    headers: {
      'x-jpmc-channel': 'WEB',
      'X-JPMC-CLIENT-REQUEST-ID': 'request-id',
      'X-Jpmc-Csrf-Token': 'session-token'
    }
  }, 1234);
  assert.deepEqual(captured, {
    csrfToken: 'session-token',
    channel: 'WEB',
    clientRequestId: 'request-id',
    capturedAt: 1234
  });
});

test('Chase request context prefers explicit fetch-init headers over Request headers', () => {
  const captured = extractChaseRequestContext(
    { headers: new Headers({ 'X-Jpmc-Csrf-Token': 'old-token' }) },
    { headers: new Headers({ 'X-Jpmc-Csrf-Token': 'new-token', 'X-Jpmc-Channel': 'WEB' }) },
    4321
  );
  assert.equal(captured.csrfToken, 'new-token');
  assert.equal(captured.channel, 'WEB');
  assert.equal(captured.capturedAt, 4321);
});

test('stored Chase request context is returned without exposing page internals', () => {
  const page = {
    __chaseTrackerRequestContextV1: {
      csrfToken: 'token', channel: 'WEB', clientRequestId: 'request', capturedAt: 99, ignored: true
    }
  };
  assert.deepEqual(chaseRequestContext(page), {
    csrfToken: 'token', channel: 'WEB', clientRequestId: 'request', capturedAt: 99
  });
});
