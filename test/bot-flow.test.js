'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /[\\/]candidate[\\/]bot\.js$/.test(parent.filename) && request === './clob-feed') return () => () => {};
  if (parent && /[\\/]candidate[\\/]bot\.js$/.test(parent.filename) && request === './polymarket-market') {
    return { currentWindowOpenTs: () => 0, slugForTs: () => 'test-window', WINDOW_SECONDS: 300, getActiveWindow: async () => ({ window: null }), fetchResolution: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const Bot = require('../bot');
Module._load = originalLoad;

function fixture() {
  const state = { tpStatus: 'LIVE', canceled: false };
  const book = { bids: [{ price: '0.74', size: '100' }], asks: [{ price: '0.75', size: '100' }] };
  const trader = {
    address: 'mock', depositWallet: null,
    async getOrderBook() { return book; },
    async placeFakMarketOrder(tokenId, side, amount) {
      if (side === 'BUY') { state.entryAmount = amount; return { id: 'entry-1', status: 'matched', isFilled: true, avgPrice: 0.75, raw: { status: 'matched', makingAmount: '37.5', takingAmount: '50' } }; }
      return { id: 'exit-1', status: 'matched', isFilled: true, avgPrice: 0.60, raw: { status: 'matched', makingAmount: '50', takingAmount: '30' } };
    },
    async placeGtcOrder(tokenId, side, price, size) { return { id: 'tp-1', status: 'LIVE' }; },
    async getOrder(id) {
      if (state.tpStatus === 'MATCHED') return { id, status: 'MATCHED', original_size: '50', size_matched: '50', price: '0.99' };
      return { id, status: state.tpStatus, original_size: '50', size_matched: '0', price: '0.99' };
    },
    async cancelOrder() { state.tpStatus = 'CANCELED'; state.canceled = true; return { canceled: ['tp-1'] }; },
    async cancelMarketOrders() { state.tpStatus = 'CANCELED'; return { canceled: true }; },
    async getOpenOrders() { return state.tpStatus === 'LIVE' ? [{ id: 'tp-1', asset_id: 'up-token', side: 'SELL', price: '0.99', original_size: '50', size_matched: '0' }] : []; },
    async getTokenBalance() { return 0; },
    async getBalance() { return null; },
  };
  const bot = new Bot(trader, { live: false });
  const openTs = Math.floor(Date.now() / 300000) * 300;
  const w = { slug: 'btc-updown-5m-' + openTs, openTs, window: { closeTs: openTs + 300, tokenUp: 'up-token', tokenDown: 'down-token' },
    tradeTaken: false, entryInFlight: false, status: 'entry_ready', position: null, lastOpenAttemptAt: 0 };
  bot.w = w;
  bot.prices = { slug: w.slug, ts: Date.now(), up: { bid: 0.74, ask: 0.75, mid: 0.745 }, down: { bid: 0.24, ask: 0.25, mid: 0.245 } };
  return { bot, w, trader, state, book };
}

test('entry uses the live-book market notional, then rests a maker-only TP', async () => {
  const { bot, w } = fixture();
  const filled = await bot._fire(w, 'UP', 'up-token');
  assert.equal(filled, true);
  assert.equal(w.tradeTaken, true);
  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].shares, 50);
  assert.equal(bot.pending[0].tpOrderId, 'tp-1');
  assert.equal(bot.pending[0].cost > 37.5, true);
  assert.equal(bot.cash < 1000, true);
  assert.equal(await bot._fire(w, 'UP', 'up-token'), false);
});

test('an upward midpoint crossing submits a FAK buy when ask is above 75 cents', async () => {
  const { bot, w, book, state } = fixture();
  await bot._entryStep(w, 1);
  assert.equal(w.tradeTaken, false);
  bot.prices.up = { bid: 0.75, ask: 0.77, mid: 0.76 };
  book.asks = [{ price: '0.77', size: '100' }];
  await bot._entryStep(w, 2);
  assert.equal(w.tradeTaken, true);
  assert.equal(w.entrySignal.direction, 'up');
  assert.equal(state.entryAmount, 38.5);
  assert.equal(bot.pending.length, 1);
});

test('a complete maker TP closes as a win using actual 99-cent proceeds', async () => {
  const { bot, w, state } = fixture();
  await bot._fire(w, 'UP', 'up-token');
  state.tpStatus = 'MATCHED';
  bot.prices.up.bid = 0.99;
  bot.prices.up.ask = 0.99;
  await bot._managePosition(w.position);
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].outcome, 'WIN');
  assert.equal(bot.trades[0].reason, 'TAKE_PROFIT');
  assert.equal(bot.trades[0].proceeds, 49.5);
  assert.equal(bot.trades[0].outcomeValuePerShare, 1);
});

test('a stop cancels the maker order, sells as taker, and adds 50 to the next size', async () => {
  const { bot, w, state } = fixture();
  await bot._fire(w, 'UP', 'up-token');
  bot.prices.up.bid = 0.52;
  bot.prices.up.ask = 0.53;
  await bot._managePosition(w.position);
  assert.equal(state.canceled, true);
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].reason, 'STOP_LOSS');
  assert.equal(bot.trades[0].outcome, 'LOSS');
  assert.equal(bot.baseShares, 100);
  assert.equal(bot.shareAdditions, 1);
});
