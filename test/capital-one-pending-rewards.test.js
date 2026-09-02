import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'apps/capital-one/pending-rewards.user.js'), 'utf8');
const userscriptModule = { exports: {} };
new Script(source, { filename: 'pending-rewards.user.js' }).runInNewContext({
  module: userscriptModule,
  process,
  console
});

const { parseRouteDataFromSource, summarize } = userscriptModule.exports;

test('includes unobtrusive linked Robo attribution in the footer', () => {
  const declaredVersion = source.match(/\/\/ @version\s+(\S+)/)?.[1];
  assert.ok(declaredVersion);
  assert.ok(source.includes(`const SCRIPT_VERSION = '${declaredVersion}';`));
  assert.match(source, /createElement\('a', 'c1pd-creator', 'by Robo'\)/);
  assert.match(source, /creator\.href = 'https:\/\/discord\.com\/app'/);
  assert.match(source, /Created by Robo, @robo77 on Discord/);
  assert.match(source, /const footer = createElement\('div', 'c1pd-footer'\)/);
  assert.match(source, /const credit = createElement\('div', 'c1pd-credit'\)/);
  assert.match(source, /createElement\('span', '', `v\$\{SCRIPT_VERSION\}`\)/);
  assert.match(source, /footer\.append\(footnote, credit\)/);
});

test('decodes Capital One React Router rewards data', () => {
  const flat = [
    { _1: 2 },
    'loaderData',
    { _3: 4 },
    'routes/__app/my-rewards.lifetime-savings',
    { _5: 6, _7: 8 },
    'page',
    '0',
    'lifetimeSavingsRows',
    [9],
    { _10: 11, _12: 13, _14: 15, _16: 17 },
    'status',
    'Pending',
    'rewardsAmount',
    12,
    'couponsSavings',
    100,
    'payoutAt',
    '2026-10-15T12:00:00.000Z'
  ];
  const streamArgument = JSON.stringify(JSON.stringify(flat));
  const route = parseRouteDataFromSource(
    `window.__reactRouterContext.streamController.enqueue(${streamArgument});`
  );

  assert.equal(route.page, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(route.rows[0])), {
    status: 'Pending',
    rewardsAmount: 12,
    couponsSavings: 100,
    payoutAt: '2026-10-15T12:00:00.000Z'
  });
});

test('totals pending Shopping Rewards without counting Shopping Savings', () => {
  const summary = summarize([
    {
      id: 'pending-with-savings',
      status: 'Pending',
      vendor: 'Example Store',
      rewardsAmount: 12,
      couponsSavings: 500,
      creditCurrency: 'USD',
      createdAt: '2026-07-01T12:00:00.000Z',
      payoutAt: '2026-10-01T12:00:00.000Z'
    },
    {
      id: 'credited',
      status: 'Credited',
      rewardsAmount: 80,
      couponsSavings: 0,
      creditCurrency: 'USD',
      payoutAt: '2026-10-01T12:00:00.000Z'
    },
    {
      id: 'savings-only',
      status: null,
      rewardsAmount: 0,
      couponsSavings: 900,
      creditCurrency: 'USD',
      payoutAt: null
    }
  ]);

  assert.equal(summary.pending.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.totals)), [{ currency: 'USD', amount: 12 }]);
  assert.equal(summary.months[0].amount, 12);
  assert.equal(summary.months[0].count, 1);
});
