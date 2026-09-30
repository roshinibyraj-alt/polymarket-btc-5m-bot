'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DemoTrader = require('../demo-trader');

test('demo FAK buys spend USDC across asks and sells requested shares across bids', async () => {
  const originalFetch = global.fetch;
  let book = { asks: [{ price: '0.50', size: '10' }, { price: '0.60', size: '10' }], bids: [{ price: '0.61', size: '7' }, { price: '0.60', size: '20' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const buy = await trader.placeFakMarketOrder('token', 'BUY', 8);
    assert.equal(buy.status, 'matched');
    assert.equal(Number(buy.raw.makingAmount), 8);
    assert.equal(Number(buy.raw.takingAmount), 15);
    const sell = await trader.placeFakMarketOrder('token', 'SELL', 12);
    assert.equal(Number(sell.raw.makingAmount), 12);
    assert.equal(Number(Number(sell.raw.takingAmount).toFixed(2)), 7.27);
  } finally { global.fetch = originalFetch; }
});

test('demo maker TP rests post-only and accumulates only newly available crossing liquidity', async () => {
  const originalFetch = global.fetch;
  let book = { bids: [{ price: '0.98', size: '10' }], asks: [{ price: '0.99', size: '10' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeGtcOrder('token', 'SELL', 0.99, 5);
    book = { bids: [{ price: '0.99', size: '4' }], asks: [{ price: '1.00', size: '10' }] };
    let state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 4);
    assert.equal(state.status, 'LIVE');
    book = { bids: [{ price: '0.99', size: '5' }], asks: [{ price: '1.00', size: '10' }] };
    state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 5);
    assert.equal(state.status, 'MATCHED');
  } finally { global.fetch = originalFetch; }
});
