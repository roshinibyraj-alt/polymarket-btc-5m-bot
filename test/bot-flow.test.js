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
    ['up-token', { bids: [{ price: '0.49', size: '0.01' }], asks: [{ price: '0.50', size: '0.01' }] }],
    ['down-token', { bids: [{ price: '0.49', size: '0.01' }], asks: [{ price: '0.50', size: '0.01' }] }],
  ]);
  const orders = new Map();
  const calls = { placements: [], cancels: [], quoteUpdates: [], fak: 0, matchSequence: 0 };
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
        makerOnly: true, makerFee: 0, makerRebateEstimate: 0,
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
    rungs: cfg.ENTRY_RUNGS.map((rung) => ({
      id: 'rung-' + rung.entryPrice.toFixed(2),
      entryPrice: rung.entryPrice,
      takeProfitPrice: rung.takeProfitPrice,
      firstFillSide: null,
      fillCount: 0,
      inFlight: false,
      sides: {
        UP: makeSide('UP'),
        DOWN: makeSide('DOWN'),
      },
    })),
  };
  bot.w = w;
  bot.prices = {
    slug: w.slug, ts: Date.now(),
    up: { bid: 0.49, ask: 0.50, mid: 0.495 },
    down: { bid: 0.49, ask: 0.50, mid: 0.495 },
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
      order.matchedAt = Date.now() + ++calls.matchSequence;
      order.makerRebateEstimate = strategy.estimateMakerRebate(order.size_matched, order.price);
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

function makeSide(side) {
  return {
    side, status: 'buy_pending', entryOrderId: null, entryFilled: false,
    nextEntryAttemptAt: 0, entryLastPollAt: 0,
    position: null, tpOrderId: null, tpOrderShares: 0,
    tpMatched: 0, tpLastPollAt: 0,
  };
}

function getRung(w, price) {
  return w.rungs.find((rung) => rung.entryPrice === price);
}

function buyOrdersFor(calls, tokenId, price) {
  return calls.placements.filter((order) => order.side === 'BUY'
    && order.tokenId === tokenId && order.price === price);
}

test('each window places one 500-share buy for each side at all four rungs', async () => {
  const { bot, w, calls } = fixture();
  await bot._startWindowOrders(w);

  assert.equal(calls.placements.length, 8);
  for (const price of [0.45, 0.40, 0.35, 0.30]) {
    for (const tokenId of ['up-token', 'down-token']) {
      assert.equal(buyOrdersFor(calls, tokenId, price).length, 1);
      assert.equal(buyOrdersFor(calls, tokenId, price)[0].size, 500);
    }
  }
  assert.equal(calls.placements.every((order) => order.side === 'BUY'), true);
  assert.equal(w.rungs.every((rung) => rung.fillCount === 0), true);
  const snapshot = bot.snapshot();
  assert.equal(snapshot.cfg.entryRungs.length, 4);
  assert.equal(snapshot.strategy.secondFillTakeProfitPrice, 0.99);
  assert.equal(snapshot.window.sideCycles.UP.entriesResting, 4);
  assert.equal(snapshot.window.sideCycles.DOWN.entriesResting, 4);
});

test('each rung pairs one UP and one DOWN fill: first gets rung TP, second gets $0.99', async () => {
  const { bot, w, calls, setBook } = fixture();
  await bot._startWindowOrders(w);
  const rung = getRung(w, 0.45);

  setBook('up-token', { bids: [{ price: '0.44', size: '0.01' }], asks: [{ price: '0.45', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  assert.equal(rung.firstFillSide, 'UP');
  assert.equal(rung.fillCount, 1);
  assert.equal(rung.sides.UP.position.takeProfitPrice, 0.55);
  assert.ok(getRung(w, 0.40).sides.UP.entryOrderId);
  assert.ok(rung.sides.DOWN.entryOrderId);
  assert.equal(calls.cancels.length, 0);

  setBook('down-token', { bids: [{ price: '0.44', size: '0.01' }], asks: [{ price: '0.45', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  assert.equal(rung.fillCount, 2);
  assert.equal(rung.sides.DOWN.position.takeProfitPrice, 0.99);
  assert.equal(bot.pending.length, 2);
  assert.equal(calls.placements.find((order) => order.side === 'SELL' && order.tokenId === 'up-token').price, 0.55);
  assert.equal(calls.placements.find((order) => order.side === 'SELL' && order.tokenId === 'down-token').price, 0.99);

  setBook('up-token', { bids: [{ price: '0.55', size: '0.01' }], asks: [{ price: '0.56', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  const firstTrade = bot.trades.find((trade) => trade.rungPrice === 0.45 && trade.side === 'UP');
  assert.equal(firstTrade.proceeds, 275);
  assert.equal(firstTrade.takeProfitPrice, 0.55);

  setBook('down-token', { bids: [{ price: '0.99', size: '0.01' }], asks: [{ price: '1.00', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  const secondTrade = bot.trades.find((trade) => trade.rungPrice === 0.45 && trade.side === 'DOWN');
  assert.equal(secondTrade.proceeds, 495);
  assert.equal(secondTrade.takeProfitPrice, 0.99);
  assert.equal(secondTrade.pnl, 271.8);
  assert.ok(Math.abs(bot.cash - 10325.2668) < 1e-8);
  assert.equal(rung.fillCount, 2);
  assert.equal(buyOrdersFor(calls, 'up-token', 0.45).length, 1);
  assert.equal(buyOrdersFor(calls, 'down-token', 0.45).length, 1);
});

test('fill sequencing resets for each rung and one rung can close without re-arming', async () => {
  const { bot, w, calls, setBook } = fixture();
  await bot._startWindowOrders(w);

  setBook('up-token', { bids: [{ price: '0.44', size: '0.01' }], asks: [{ price: '0.45', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  setBook('up-token', { bids: [{ price: '0.39', size: '0.01' }], asks: [{ price: '0.40', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  const rung40 = getRung(w, 0.40);
  assert.equal(rung40.firstFillSide, 'UP');
  assert.equal(rung40.sides.UP.position.takeProfitPrice, 0.60);

  setBook('up-token', { bids: [{ price: '0.60', size: '0.01' }], asks: [{ price: '0.61', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  assert.equal(rung40.sides.UP.position, null);
  assert.equal(rung40.sides.UP.entryFilled, true);
  assert.equal(buyOrdersFor(calls, 'up-token', 0.40).length, 1);

  setBook('down-token', { bids: [{ price: '0.39', size: '0.01' }], asks: [{ price: '0.40', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  assert.equal(rung40.fillCount, 2);
  assert.equal(rung40.sides.DOWN.position.takeProfitPrice, 0.99);

  const rung35 = getRung(w, 0.35);
  assert.equal(rung35.fillCount, 0);
  assert.equal(buyOrdersFor(calls, 'up-token', 0.35).length, 1);
  assert.equal(buyOrdersFor(calls, 'down-token', 0.35).length, 1);
});

test('window close cancels every resting rung buy and TP, holding unsold shares', async () => {
  const { bot, w, trader, orders, calls, setBook } = fixture();
  await bot._startWindowOrders(w);
  setBook('up-token', { bids: [{ price: '0.44', size: '0.01' }], asks: [{ price: '0.45', size: '0.01' }] });
  await bot._manageCycles(w, Date.now(), true);
  const upPosition = getRung(w, 0.45).sides.UP.position;
  const tpId = upPosition.tpOrderId;
  assert.ok(tpId);

  await bot._closeWindowOrders(w);
  assert.equal(w.closed, true);
  assert.equal((await trader.getOpenOrders()).length, 0);
  assert.equal(calls.cancels.length, 8);
  assert.equal(orders.get(tpId).status, 'CANCELED');
  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].openShares, 500);
  assert.equal(bot.pending[0].status, 'awaiting_resolution');
});

test('a quote at the window boundary cannot fill any resting rung entry', async () => {
  const { bot, w, orders, calls } = fixture();
  await bot._startWindowOrders(w);
  const entryIds = [...orders.values()].filter((order) => order.side === 'BUY').map((order) => order.id);
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
  assert.equal(entryIds.every((id) => orders.get(id).status === 'CANCELED'), true);
  assert.equal(bot.pending.length, 0);
  assert.equal(w.closed, true);
});

test('unresolved rung positions wait for official UP or DOWN resolution', async () => {
  const { bot, w, setBook } = fixture();
  await bot._startWindowOrders(w);
  setBook('up-token', { bids: [{ price: '0.44', size: '0.01' }], asks: [{ price: '0.45', size: '0.01' }] });
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
  assert.equal(bot.trades[0].rungPrice, 0.45);
  assert.equal(bot.trades[0].pnl, 276.73);
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