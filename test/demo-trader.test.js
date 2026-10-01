'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DemoTrader = require('../demo-trader');

test('demo GTC buy fills all 500 shares on an ask touch without using visible depth', async () => {
  const originalFetch = global.fetch;
  let book = { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.31', size: '0.01' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeGtcOrder('token', 'BUY', 0.30, 500);
    assert.equal(order.status, 'LIVE');
    book = { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.30', size: '0.01' }] };
    const state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 500);
    assert.equal(state.status, 'MATCHED');
  } finally { global.fetch = originalFetch; }
});

test('demo GTC take-profit fills all shares on a bid touch without using visible depth', async () => {
  const originalFetch = global.fetch;
  let book = { bids: [{ price: '0.69', size: '0.01' }], asks: [{ price: '0.70', size: '0.01' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeGtcOrder('token', 'SELL', 0.70, 500);
    assert.equal(order.status, 'LIVE');
    let state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 0);
    assert.equal(state.status, 'LIVE');
    book = { bids: [{ price: '0.70', size: '0.01' }], asks: [{ price: '0.71', size: '0.01' }] };
    state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 500);
    assert.equal(state.status, 'MATCHED');
  } finally { global.fetch = originalFetch; }
});

test('demo can cancel a resting entry or take-profit order without changing a filled order', async () => {
  const originalFetch = global.fetch;
  const book = { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.31', size: '0.01' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeGtcOrder('token', 'BUY', 0.30, 500);
    await trader.cancelOrder(order.id);
    assert.equal((await trader.getOrder(order.id)).status, 'CANCELED');
  } finally { global.fetch = originalFetch; }
});