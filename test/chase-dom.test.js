import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChaseAccounts, extractChaseActivity, findLoadMore } from '../src/app/chase-dom.js';

test('extracts Ink route metadata from Chase encoded page state', () => {
  const html = `data-props="[[{&quot;value&quot;:&quot;Ink Business Cash (...4321)&quot;},{&quot;value&quot;:&quot;$1,234.56&quot;},{&quot;value&quot;:&quot;Aug 19, 2026&quot;},{&quot;accountId&quot;:123456,&quot;accountType&quot;:&quot;CARD&quot;,&quot;accountDetailType&quot;:&quot;BCC&quot;,&quot;isBusinessAccount&quot;:true}]]"`;
  assert.deepEqual(extractChaseAccounts(html), [{
    id: '123456',
    name: 'Ink Business Cash (...4321)',
    last4: '4321',
    accountType: 'CARD',
    accountDetailType: 'BCC',
    productId: 'ink-cash',
    source: 'chase-dom'
  }]);
});

test('activity extraction records Chase end-of-history evidence', () => {
  const result = extractChaseActivity({
    querySelectorAll: () => [],
    body: { innerText: "You've reached the end of your account activity" }
  }, { id: '123456', name: 'Ink Business Cash (...4321)', last4: '4321' });
  assert.equal(result.reachedEnd, true);
  assert.equal(result.validEmpty, false);
});

test('activity extraction recognizes Chase end marker by test id even when text is hidden', () => {
  const result = extractChaseActivity({
    querySelectorAll: () => [],
    querySelector: () => ({ id: 'end-marker' }),
    body: { innerText: '', textContent: '' }
  }, { id: '123456', name: 'Ink Business Cash (...4321)', last4: '4321' });
  assert.equal(result.reachedEnd, true);
});

test('load-more finder recognizes Chase custom button labels with trailing context', () => {
  const button = {
    id: '', disabled: false, textContent: '',
    getAttribute(name) { return name === 'text' ? 'Show more transactions' : null; },
    shadowRoot: { querySelectorAll: () => [] }
  };
  const found = findLoadMore({
    querySelector: () => null,
    querySelectorAll: () => [button]
  });
  assert.equal(found, button);
});
