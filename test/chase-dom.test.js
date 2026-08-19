import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChaseAccounts, extractChaseActivity, findLoadMore } from '../packages/chase-core/app/chase-dom.js';
import { identifyProduct, isInkAccount } from '../apps/ink/products.js';
import { identifyHyattProduct, isHyattAccount } from '../apps/hyatt/products.js';

const inkOptions = { identifyProduct, acceptsAccount: isInkAccount };
const hyattOptions = { identifyProduct: identifyHyattProduct, acceptsAccount: isHyattAccount };

test('extracts Ink route metadata from Chase encoded page state', () => {
  const html = `data-props="[[{&quot;value&quot;:&quot;Ink Business Cash (...4321)&quot;},{&quot;value&quot;:&quot;$1,234.56&quot;},{&quot;value&quot;:&quot;Aug 19, 2026&quot;},{&quot;accountId&quot;:123456,&quot;accountType&quot;:&quot;CARD&quot;,&quot;accountDetailType&quot;:&quot;BCC&quot;,&quot;isBusinessAccount&quot;:true}]]"`;
  assert.deepEqual(extractChaseAccounts(html, inkOptions), [{
    id: '123456',
    name: 'Ink Business Cash (...4321)',
    last4: '4321',
    accountType: 'CARD',
    accountDetailType: 'BCC',
    productId: 'ink-cash',
    source: 'chase-dom'
  }]);
});

test('the shared Chase extractor selects Hyatt cards without admitting unrelated cards', () => {
  const html = [
    `data-props="[[{&quot;value&quot;:&quot;World of Hyatt Business (...9876)&quot;},{&quot;accountId&quot;:456789,&quot;accountType&quot;:&quot;CARD&quot;,&quot;accountDetailType&quot;:&quot;BCC&quot;}]]"`,
    `data-props="[[{&quot;value&quot;:&quot;Freedom Unlimited (...1111)&quot;},{&quot;accountId&quot;:111111,&quot;accountType&quot;:&quot;CARD&quot;,&quot;accountDetailType&quot;:&quot;CC&quot;}]]"`
  ].join('');
  assert.deepEqual(extractChaseAccounts(html, hyattOptions), [{
    id: '456789',
    name: 'World of Hyatt Business (...9876)',
    last4: '9876',
    accountType: 'CARD',
    accountDetailType: 'BCC',
    productId: 'hyatt-business',
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
