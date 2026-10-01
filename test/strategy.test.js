'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const strategy = require('../strategy');

test('an upward midpoint crossing triggers even when the quote jumps over 75 cents', () => {
  const state = { tradeTaken: false };
  let result = strategy.observeEntry(state, { UP: 0.74, DOWN: 0.26 }, 0, cfg);
  assert.equal(result.shouldBuy, false);
  result = strategy.observeEntry(state, { UP: 0.76, DOWN: 0.24 }, 1, cfg);
  assert.equal(result.shouldBuy, true);
  assert.equal(result.side, 'UP');
  assert.equal(result.direction, 'up');
  assert.deepEqual(result.events, ['ENTRY_READY']);
  result = strategy.observeEntry(state, { UP: 0.77, DOWN: 0.23 }, 2, cfg);
  assert.equal(result.shouldBuy, false);
});

test('a downward midpoint crossing triggers for whichever side crosses first', () => {
  const state = { tradeTaken: false };
  let result = strategy.observeEntry(state, { UP: 0.24, DOWN: 0.76 }, 0, cfg);
  assert.equal(result.shouldBuy, false);
  result = strategy.observeEntry(state, { UP: 0.25, DOWN: 0.74 }, 1, cfg);
  assert.equal(result.shouldBuy, true);
  assert.equal(result.side, 'DOWN');
  assert.equal(result.direction, 'down');
  assert.deepEqual(result.events, ['ENTRY_READY']);
});

test('touching 75 cents triggers in either direction; taken trades never re-enter', () => {
  const upState = { tradeTaken: false };
  strategy.observeEntry(upState, { UP: 0.74, DOWN: 0.26 }, 0, cfg);
  const up = strategy.observeEntry(upState, { UP: 0.75, DOWN: 0.25 }, 1, cfg);
  assert.equal(up.shouldBuy, true);
  assert.equal(up.direction, 'up');
  const downState = { tradeTaken: false };
  strategy.observeEntry(downState, { UP: 0.24, DOWN: 0.76 }, 0, cfg);
  const down = strategy.observeEntry(downState, { UP: 0.25, DOWN: 0.75 }, 1, cfg);
  assert.equal(down.shouldBuy, true);
  assert.equal(down.direction, 'down');
  downState.tradeTaken = true;
  const result = strategy.observeEntry(downState, { UP: 0.30, DOWN: 0.70 }, 2, cfg);
  assert.equal(result.shouldBuy, false);
});

test('adaptive sizing adds only on stop, subtracts on a win, and respects 50/550 bounds', () => {
  let size = cfg.BASE_SHARES;
  assert.equal(size, 50);
  for (let i = 0; i < 10; i += 1) size = strategy.adjustBaseShares(size, 'STOP_LOSS', cfg);
  assert.equal(size, 550);
  assert.equal(strategy.additionCount(size, cfg), 10);
  assert.equal(strategy.adjustBaseShares(size, 'STOP_LOSS', cfg), 550);
  size = strategy.adjustBaseShares(size, 'WIN', cfg);
  assert.equal(size, 500);
  for (let i = 0; i < 20; i += 1) size = strategy.adjustBaseShares(size, 'WIN', cfg);
  assert.equal(size, 50);
  assert.equal(strategy.adjustBaseShares(size, 'LOSS', cfg), 50);
});

test('market-buy budget walks asks to target shares and reports partial visible liquidity', () => {
  const budget = strategy.estimateMarketBuyBudget({ asks: [
    { price: '0.60', size: '20' }, { price: '0.50', size: '10' }, { price: '0.70', size: '15' },
  ] }, 25);
  assert.equal(budget.shares, 25);
  assert.equal(Number(budget.amount.toFixed(2)), 14);
  assert.equal(Number(budget.averagePrice.toFixed(2)), 0.56);
  const partial = strategy.estimateMarketBuyBudget({ asks: [{ price: '0.50', size: '4' }] }, 10);
  assert.equal(partial.shares, 4);
  assert.equal(partial.remaining, 6);
  assert.equal(partial.amount, 2);
});

test('CLOB making/taking amounts normalize BUY and SELL fills correctly', () => {
  const buy = strategy.normalizeMarketFill({ raw: { makingAmount: '37.5', takingAmount: '50' } }, 'BUY');
  assert.deepEqual(buy, { shares: 50, notional: 37.5, averagePrice: 0.75 });
  const sell = strategy.normalizeMarketFill({ raw: { makingAmount: '50', takingAmount: '30.5' } }, 'SELL');
  assert.deepEqual(sell, { shares: 50, notional: 30.5, averagePrice: 0.61 });
});
