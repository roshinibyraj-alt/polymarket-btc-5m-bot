'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const strategy = require('../strategy');
const cfg = require('../config');

const marketState = { resolution: null, resolutionCalls: 0 };
const marketStub = {
  currentWindowOpenTs: () => Math.floor(Date.now() / 300000) * 300,
  slugForTs: (ts) => 'btc-updown-5m-' + ts,
  WINDOW_SECONDS: 300,
  getActiveWindow: async () => ({ window: null }),
  fetchResolution: async () => {
    marketState.resolutionCalls += 1;
    return marketState.resolution;
  },
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /[\\/]candidate[\\/]bot\.js$/.test(parent.filename) && request === './clob-feed') return () => () => {};
  if (parent && /[\\/]candidate[\\/]bot\.js$/.test(parent.filename) && request === './polymarket-market') return marketStub;
  return originalLoad.call(this, request, parent, isMain);
};
const Bot = require('../bot');
Module._load = originalLoad;

function fixture(options = {}) {
  const books = new Map([
    ['up-token', { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.31', size: '0.01' }] }],
    ['down-token', { bids: [{ price: '0.28', size: '0.01' }], asks: [{ price: '0.31', size: '0.01' }] }],
  ]);
  const orders = new Map();
  const calls = { placements: [], cancels: [], quoteUpdates: [], fak: 0 };
  let orderNumber = 0;
  const trader = {
    demoMode: true,
    address: 'demo test trader', depositWallet: null,
    async getOrderBook(tokenId) { return books.get(tokenId) || null; },
    async placeGtcOrder(tokenId, side, price, size) {
      orderNumber += 1;
      const id = 'order-' + orderNumber;
      const order = {
        id, tokenId, asset_id: tokenId, side, price: Number(price),
        original_size: Number(size), size_matched: 0, status: 'LIVE',
      };
      orders.set(id, order);
      calls.placements.push({ id, tokenId, side, price: Number(price), size: Number(size) });
      matchOrder(order);
      return { id, status: order.status };
    },
    async getOrder(id) {
      const order = orders.get(id);
      if (!order) return null;
      matchOrder(order);
      return { ...order };
    },
    async cancelOrder(id) {
      calls.cancels.push(id);
      const order = orders.get(id);
      if (order && order.status === 'LIVE') order.status = 'CANCELED';
      return { canceled: [id] };
    },
    async cancelMarketOrders(tokenId) {
      for (const order of orders.values()) {
        if (order.tokenId === tokenId && order.status === 'LIVE') order.status = 'CANCELED';
      }
      return { canceled: true };
    },
    updateQuote(tokenId, quote) {
      calls.quoteUpdates.push({ tokenId, ...quote });
      const book = {
        bids: quote.bid == null ? [] : [{ price: String(quote.bid), size: '1' }],
        asks: quote.ask == null ? [] : [{ price: String(quote.ask), size: '1' }],
      };
      books.set(tokenId, book);
      for (const order of orders.values()) {
        if (order.tokenId === tokenId) matchOrder(order);
      }
    },
    async getOpenOrders() { return [...orders.values()].filter((order) => order.status === 'LIVE'); },
    async getBalance() { return null; },
    async placeFakMarketOrder() { calls.fak += 1; throw new Error('unexpected FAK order'); },
  };
  const bot = new Bot(trader, { live: !!options.live });
  const openTs = Math.floor(Date.now() / 300000) * 300;
  const w = {
    slug: 'btc-updown-5m-' + openTs,
    openTs,
    status: 'starting',
    window: { closeTs: openTs + 300, tokenUp: 'up-token', tokenDown: 'down-token' },
    ordersStarted: false, closing: false, closed: false,
    sides: {
      UP: { side: 'UP', cycleNumber: 0, active: null, inFlight: false },
      DOWN: { side: 'DOWN', cycleNumber: 0, active: null, inFlight: false },
    },
  };
  bot.w = w;
  bot.prices = {
    slug: w.slug, ts: Date.now(),
    up: { bid: 0.29, ask: 0.31, mid: 0.30 },
    down: { bid: 0.28, ask: 0.31, mid: 0.295 },
  };

  function matchOrder(order) {
    if (!order || order.status !== 'LIVE') return;
    const book = books.get(order.tokenId);
    if (!book) return;
    const bids = (book.bids || []).map((x) => Number(x.price)).filter(Number.isFinite);
    const asks = (book.asks || []).map((x) => Number(x.price)).filter(Number.isFinite);
    const bestBid = bids.length ? Math.max(...bids) : null;
    const bestAsk = asks.length ? Math.min(...asks) : null;
    const touched = order.side === 'BUY'
      ? strategy.buyLimitTouched(bestAsk, order.price)
      : strategy.takeProfitTouched(bestBid, order.price);
    if (touched) {
      order.size_matched = order.original_size;
      order.status = 'MATCHED';
    }
  }

  function setBook(tokenId, book) {
    books.set(tokenId, book);
    for (const order of orders.values()) {
      if (order.tokenId === tokenId) matchOrder(order);
    }
  }
  return { bot, w, trader, books, orders, calls, setBook };
}

test('both independent 500-share buy limits are placed as soon as the market window is ready', async () => {
  const { bot, w, calls } = fixture();
  await bot._startWindowOrders(w);
  assert.deepEqual(calls.placements.map(({ tokenId, side, price, size }) => ({ tokenId, side, price, size })).sort((a, b) => a.tokenId.localeCompare(b.tokenId)), [
    { tokenId: 'down-token', side: 'BUY', price: 0.30, size: 500 },
    { tokenId: 'up-token', side: 'BUY', price: 0.30, size: 500 },
  ]);
  assert.equal(calls.placements.every((order) => order.side === 'BUY'), true);
});

test('an ask touch fills all 500 shares; TP closes and only that side re-arms', async () => {
  const { bot, w, orders, calls, setBook } = fixture();
  await bot._startWindowOrders(w);
  const downEntryId = w.sides.DOWN.active.entryOrderId;
  setBook('up-token', { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.30', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);

  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].side, 'UP');
  assert.equal(bot.pending[0].shares, 500);
  assert.equal(bot.pending[0].openShares, 500);
  assert.equal(bot.cash, cfg.DEMO_CAPITAL - 150);
  const upTp = calls.placements.find((order) => order.side === 'SELL' && order.tokenId === 'up-token');
  assert.ok(upTp);
  assert.equal(upTp.price, 0.70);
  assert.equal(upTp.size, 500);
  assert.equal(w.sides.DOWN.active.entryOrderId, downEntryId);

  setBook('up-token', { bids: [{ price: '0.70', size: '0.01' }], asks: [{ price: '0.71', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].reason, 'TAKE_PROFIT');
  assert.equal(bot.trades[0].proceeds, 350);
  assert.equal(bot.trades[0].pnl, 200);

  setBook('up-token', { bids: [{ price: '0.69', size: '0.01' }], asks: [{ price: '0.31', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  const newUpEntry = w.sides.UP.active.entryOrderId;
  assert.ok(newUpEntry);
  assert.notEqual(newUpEntry, calls.placements[0].id);
  assert.equal(w.sides.DOWN.active.entryOrderId, downEntryId);
  assert.equal(calls.placements.filter((order) => order.side === 'BUY' && order.tokenId === 'up-token').length, 2);
  assert.equal(calls.placements.filter((order) => order.side === 'BUY' && order.tokenId === 'down-token').length, 1);
  assert.equal(orders.get(newUpEntry).status, 'LIVE');
});

test('a low best bid never triggers a stop exit or FAK order', async () => {
  const { bot, w, calls, setBook } = fixture();
  await bot._startWindowOrders(w);
  setBook('down-token', { bids: [{ price: '0.01', size: '0.01' }], asks: [{ price: '0.30', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  setBook('down-token', { bids: [{ price: '0.01', size: '0.01' }], asks: [{ price: '0.02', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].side, 'DOWN');
  assert.equal(bot.pending[0].openShares, 500);
  assert.equal(bot.pending[0].status, 'tp_resting');
  assert.equal(calls.fak, 0);
  assert.equal(calls.placements.some((order) => order.side === 'SELL' && order.price !== 0.70), false);
  assert.equal(Object.hasOwn(bot.stats, 'stopLosses'), false);
});

test('window close cancels resting buy and TP orders, then holds unsold shares', async () => {
  const { bot, w, trader, orders, calls, setBook } = fixture();
  await bot._startWindowOrders(w);
  const downEntryId = w.sides.DOWN.active.entryOrderId;
  setBook('up-token', { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.30', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  const tpId = w.sides.UP.active.tpOrderId;
  assert.ok(tpId);

  await bot._closeWindowOrders(w);
  assert.equal(w.closed, true);
  assert.equal(orders.get(downEntryId).status, 'CANCELED');
  assert.equal(orders.get(tpId).status, 'CANCELED');
  assert.equal(calls.cancels.includes(downEntryId), true);
  assert.equal(calls.cancels.includes(tpId), true);
  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].openShares, 500);
  assert.equal(bot.pending[0].status, 'awaiting_resolution');
});

test('a price update at the window boundary cannot fill a resting entry', async () => {
  const { bot, w, orders, calls } = fixture();
  await bot._startWindowOrders(w);
  const entryId = w.sides.UP.active.entryOrderId;
  w.window.closeTs = Math.floor(Date.now() / 1000) - 1;
  const originalClose = bot._closeWindowOrders.bind(bot);
  let closePromise;
  bot._closeWindowOrders = async (windowState) => {
    closePromise = originalClose(windowState);
    await closePromise;
  };

  bot._onQuote(w.slug, 'up-token', { bid: 0.29, ask: 0.30 });
  await closePromise;
  assert.equal(calls.quoteUpdates.length, 0);
  assert.equal(orders.get(entryId).status, 'CANCELED');
  assert.equal(bot.pending.length, 0);
  assert.equal(w.closed, true);
});

test('unresolved windows stay open until the official resolver returns UP or DOWN', async () => {
  const { bot, w, setBook } = fixture();
  await bot._startWindowOrders(w);
  setBook('up-token', { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.30', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  await bot._closeWindowOrders(w);

  const position = bot.pending[0];
  position.closeTs = Math.floor(Date.now() / 1000) - 1;
  marketState.resolution = null;
  marketState.resolutionCalls = 0;
  bot._resolveTried.clear();
  await bot._settleClosedPositions(Date.now());
  assert.equal(marketState.resolutionCalls, 1);
  assert.equal(bot.pending.length, 1);
  assert.equal(position.openShares, 500);

  marketState.resolution = 'UP';
  bot._resolveTried.clear();
  await bot._settleClosedPositions(Date.now() + cfg.RESOLUTION_RETRY_MS);
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].reason, 'RESOLUTION');
  assert.equal(bot.trades[0].outcome, 'WIN');
  assert.equal(bot.trades[0].proceeds, 500);
});

test('live mode fails closed before starting loops or placing any orders', async () => {
  const { bot, orders, calls } = fixture({ live: true });
  bot.start();
  await bot._tick();
  assert.equal(bot.executionHalt, true);
  assert.match(bot.error, /demo-only/);
  assert.equal(bot._running, false);
  assert.equal(calls.placements.length, 0);
  assert.equal(orders.size, 0);
});