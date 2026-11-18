'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PressureForecastBot = require('../pressure-forecast-bot');
const BinanceTickFeed = require('../binance-tick-feed');
const config = require('../config');

const WINDOW_START = 1_800_000_000_000;
const NOW = WINDOW_START + 12_000;

function makeFeed(now = NOW, price = 100.3) {
  return {
    source: 'Binance BTCUSDT aggregate trades',
    status: 'CONNECTED',
    tickAt: now,
    price,
    currentCandle: { start: WINDOW_START, open: 100, high: price, low: 99.7, close: price },
    tradeFlow: {
      tradeCount: 12,
      buyCount: 9,
      sellCount: 3,
      buyNotional: 900,
      sellNotional: 100,
      imbalance: 0.8,
      priceChangePct: 0.0003,
    },
    snapshot() { return { ...this, currentCandle: { ...this.currentCandle }, tradeFlow: { ...this.tradeFlow } }; },
    start() {},
    stop() {},
  };
}

function makeBot({ now = NOW, price = 100.3, marketData = {}, clobFeedFactory = null } = {}) {
  const bot = new PressureForecastBot({
    now: () => now,
    priceFeed: makeFeed(now, price),
    marketData,
    clobFeedFactory: clobFeedFactory || (() => ({
      start() {},
      stop() {},
      getQuote() { return null; },
      snapshot() {
        return {
          status: 'CONNECTED',
          connected: true,
          source: 'Polymarket CLOB market WebSocket',
          quoteAgesMs: {},
        };
      },
    })),
    initialCapital: 10_000,
  });
  bot.market = {
    id: 'condition',
    slug: `btc-updown-5m-${WINDOW_START / 1000}`,
    title: 'BTC Up or Down',
    start: WINDOW_START,
    end: WINDOW_START + config.WINDOW_MS_5M,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    feesEnabled: false,
  };
  bot.orderWindowStart = WINDOW_START;
  return bot;
}

function setQuote(bot, side, bid, ask, size = 1000, now = NOW) {
  bot.liveQuotes[side] = {
    status: 'LIVE',
    stale: false,
    bestBid: bid,
    bestAsk: ask,
    bidSize: size,
    askSize: size,
    mid: (bid + ask) / 2,
    updatedAt: now,
    bidLevels: [{ price: bid, size }],
    askLevels: [{ price: ask, size }],
  };
}

function addDipHistory(bot, side, { start = WINDOW_START, now = NOW, base = 0.50 } = {}) {
  const points = [
    [0, base],
    [2_000, base - 0.005],
    [4_000, base],
    [6_000, base - 0.01],
    [7_000, base - 0.02],
    [8_000, base - 0.06],
    [9_000, base - 0.055],
    [10_000, base - 0.05],
    [11_000, base - 0.045],
    [12_000, base - 0.04],
  ];
  bot.dipHistory[side] = points.map(([offset, mid]) => ({ at: start + offset, mid }));
  bot.lastHistoryQuoteAtBySide[side] = now;
  const mid = points.at(-1)[1];
  setQuote(bot, side, mid - 0.01, mid + 0.01, 500, now);
}

test('taker sweep observes the buy ceiling, sell floor, and per-level fees', () => {
  const market = { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } };
  const buy = PressureForecastBot._test.sweepBook([
    { price: 0.94, size: 50 },
    { price: 0.95, size: 50 },
    { price: 0.96, size: 1000 },
  ], 100, 'BUY', market, { maximumPrice: 0.95 });
  assert.equal(buy.complete, true);
  assert.equal(buy.filledShares, 100);
  assert.ok(Math.abs(buy.gross - 94.5) < 1e-9);
  assert.ok(buy.fees > 0);
  assert.equal(buy.fills.some((fill) => fill.price > 0.95), false);

  const sell = PressureForecastBot._test.sweepBook([
    { price: 0.009, size: 1000 },
    { price: 0.01, size: 100 },
  ], 100, 'SELL', market, { minimumPrice: 0.01 });
  assert.equal(sell.complete, true);
  assert.equal(sell.averagePrice, 0.01);
  assert.equal(sell.filledShares, 100);
});

test('dip analysis waits for a pullback, rebound, and two rising quote updates', () => {
  const bot = makeBot();
  addDipHistory(bot, 'UP');
  const candidate = bot.buildDipCandidate('UP', NOW, WINDOW_START, true);
  assert.equal(candidate.ready, true);
  assert.equal(candidate.qualifies, true);
  assert.ok(Math.abs(candidate.dipAmount - 0.06) < 1e-9);
  assert.ok(Math.abs(candidate.reboundAmount - 0.02) < 1e-9);
  assert.equal(candidate.requestedShares, 20);

  bot.dipHistory.UP[9].mid = bot.dipHistory.UP[8].mid - 0.001;
  const falling = bot.buildDipCandidate('UP', NOW, WINDOW_START, true);
  assert.equal(falling.qualifies, false);
});

test('UP and DOWN can enter independently with separate per-side limits', () => {
  const bot = makeBot();
  addDipHistory(bot, 'UP', { base: 0.50 });
  addDipHistory(bot, 'DOWN', { base: 0.52 });
  bot.market.feesEnabled = true;
  bot.market.feeSchedule = { rate: 0.07, exponent: 1 };

  assert.equal(bot.processDipStrategy(WINDOW_START, NOW), true);
  const open = bot.positions.filter((position) => position.status === 'OPEN');
  assert.equal(open.length, 2);
  assert.deepEqual(open.map((position) => position.side).sort(), ['DOWN', 'UP']);
  assert.ok(open.every((position) => position.shares === 20));
  assert.ok(open.every((position) => position.strategyVersion === 'DIP_REBOUND_V1'));
  assert.ok(open.every((position) => position.fees > 0));
  assert.deepEqual(bot.orders.map((order) => order.kind).sort(), ['BUY_DIP', 'BUY_DIP']);
  assert.ok(bot.orders.every((order) => order.maxPrice === 0.85));
  assert.equal(bot.dipEntryCountBySide.UP, 1);
  assert.equal(bot.dipEntryCountBySide.DOWN, 1);
  assert.equal(bot.dipArmedBySide.UP, false);
  assert.equal(bot.dipArmedBySide.DOWN, false);
});

test('one side can rearm only after recovery, cooldown, and another confirmed dip', () => {
  const bot = makeBot();
  addDipHistory(bot, 'UP');
  assert.equal(bot.processDipStrategy(WINDOW_START, NOW, 'UP'), true);
  assert.equal(bot.positions.length, 1);

  bot.dipHistory.UP = Array.from({ length: 10 }, (_, index) => ({
    at: NOW + index * 1000,
    mid: index < 5 ? 0.50 + index * 0.005 : 0.525 - (index - 5) * 0.01,
  }));
  bot.dipHistory.UP.push(
    { at: NOW + 10_000, mid: 0.47 },
    { at: NOW + 11_000, mid: 0.48 },
    { at: NOW + 12_000, mid: 0.49 },
  );
  setQuote(bot, 'UP', 0.485, 0.505, 500, NOW + 12_000);
  bot.recordDipQuote('UP', bot.liveQuotes.UP);
  assert.equal(bot.processDipStrategy(WINDOW_START, NOW + 12_000, 'UP'), true);
  assert.equal(bot.dipEntryCountBySide.UP, 2);
});

test('the strategy stops both entries and spike sales at second 240', () => {
  const bot = makeBot();
  addDipHistory(bot, 'UP', { now: WINDOW_START + 241_000, start: WINDOW_START + 229_000 });
  const now = WINDOW_START + 241_000;
  bot.processDipStrategy(WINDOW_START, now);
  assert.equal(bot.positions.length, 0);
  const position = {
    id: 'late-position',
    side: 'UP',
    strategyVersion: 'DIP_REBOUND_V1',
    shares: 20,
    cost: 8,
    totalCost: 8,
    avgEntry: 0.40,
    windowStart: WINDOW_START,
    status: 'OPEN',
  };
  bot.positions.push(position);
  setQuote(bot, 'UP', 0.50, 0.52, 100, now);
  assert.equal(bot.processSpikeExit('UP', now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(bot.forecast.status, 'TRADE_WINDOW_CLOSED');
});

test('a profitable spike sells all same-side shares together and leaves the other side alone', () => {
  const bot = makeBot();
  bot.market.feesEnabled = true;
  bot.market.feeSchedule = { rate: 0.07, exponent: 1 };
  bot.positions.push(
    { id: 'spike-up-a', side: 'UP', strategyVersion: 'DIP_REBOUND_V1', shares: 20, cost: 8, totalCost: 8.2, avgEntry: 0.40, windowStart: WINDOW_START, status: 'OPEN' },
    { id: 'spike-up-b', side: 'UP', strategyVersion: 'DIP_REBOUND_V1', shares: 20, cost: 8.4, totalCost: 8.6, avgEntry: 0.42, windowStart: WINDOW_START, status: 'OPEN' },
    { id: 'spike-down', side: 'DOWN', strategyVersion: 'DIP_REBOUND_V1', shares: 20, cost: 8, totalCost: 8.2, avgEntry: 0.40, windowStart: WINDOW_START, status: 'OPEN' },
  );
  setQuote(bot, 'UP', 0.50, 0.52, 100, NOW);
  bot.liveQuotes.UP.bidLevels = [{ price: 0.50, size: 40 }];

  assert.equal(bot.processSpikeExit('UP', NOW), true);
  assert.equal(bot.positions[0].status, 'SETTLED_EXIT');
  assert.equal(bot.positions[1].status, 'SETTLED_EXIT');
  assert.equal(bot.positions[2].status, 'OPEN');
  assert.equal(bot.orders[0].kind, 'SELL_SPIKE');
  assert.equal(bot.orders[0].shares, 40);
  assert.equal(bot.orders[0].matchedShares, 40);
  assert.ok(bot.orders[0].fee > 0);
  assert.ok(bot.positions[0].realizedPnl > 0);
  assert.ok(bot.positions[1].realizedPnl > 0);
});

test('missing quotes do not exit open positions', async () => {
  const bot = makeBot({
    marketData: {
      getBook: async (tokenId) => ({
        bids: [{ price: tokenId === 'up-token' ? 0.99 : 0.01, size: 1000 }],
        asks: [{ price: tokenId === 'up-token' ? 0.995 : 0.02, size: 1000 }],
      }),
    },
  });
  bot.lastMarketAt = NOW;
  bot.positions.push(
    { id: 'main-up', side: 'UP', shares: 100, totalCost: 40, windowStart: WINDOW_START, status: 'OPEN' },
    { id: 'main-down', side: 'DOWN', shares: 100, totalCost: 40, windowStart: WINDOW_START, status: 'OPEN' },
  );

  await bot.tick();

  assert.deepEqual(bot.positions.map((position) => position.status), ['OPEN', 'OPEN']);
  assert.equal(bot.orders.some((order) => order.action === 'SELL'), false);
  assert.equal(bot.snapshot().strategy.exits.takeProfit, true);
  assert.equal(bot.snapshot().strategy.exits.stopLoss, false);
});

test('current Polymarket prices come from the CLOB feed cache, not repeated REST book polling', async () => {
  const quoteByToken = new Map([
    ['up-token', {
      status: 'LIVE',
      source: 'POLYMARKET_CLOB_WEBSOCKET',
      bestBid: 0.40,
      bestAsk: 0.42,
      bidSize: 400,
      askSize: 300,
      mid: 0.41,
      bidLevels: [{ price: 0.40, size: 400 }],
      askLevels: [{ price: 0.42, size: 300 }],
      updatedAt: NOW,
    }],
    ['down-token', {
      status: 'LIVE',
      source: 'POLYMARKET_CLOB_WEBSOCKET',
      bestBid: 0.58,
      bestAsk: 0.60,
      bidSize: 300,
      askSize: 400,
      mid: 0.59,
      bidLevels: [{ price: 0.58, size: 300 }],
      askLevels: [{ price: 0.60, size: 400 }],
      updatedAt: NOW,
    }],
  ]);
  let restBookCalls = 0;
  let feedOptions;
  const bot = makeBot({
    marketData: {
      getBook: async () => {
        restBookCalls += 1;
        throw new Error('REST book polling should not run');
      },
    },
    clobFeedFactory: (options) => {
      feedOptions = options;
      return {
        start() {},
        stop() {},
        getQuote: (tokenId) => quoteByToken.get(String(tokenId)) || null,
        snapshot: () => ({
          status: 'CONNECTED',
          connected: true,
          source: 'Polymarket CLOB market WebSocket',
          quoteAgesMs: { 'up-token': 0, 'down-token': 0 },
        }),
      };
    },
  });
  bot.lastMarketAt = NOW;

  await bot.tick();

  assert.deepEqual(feedOptions.assetIds, ['up-token', 'down-token']);
  assert.equal(restBookCalls, 0);
  assert.equal(bot.liveQuotes.UP.bestAsk, 0.42);
  assert.equal(bot.liveQuotes.DOWN.bestBid, 0.58);
  assert.equal(bot.snapshot().clobFeed.connected, true);
});

test('fresh $0.99 best bid pays $1 per share with no stop-loss', async () => {
  const bot = makeBot();
  const position = {
    id: 'tp-up',
    side: 'UP',
    initialShares: 100,
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    marketId: 'condition',
    status: 'OPEN',
  };
  bot.positions.push(position);
  bot.cash = 9960;
  setQuote(bot, 'UP', 0.99, 1, 1000, NOW);

  await bot.refreshLiveQuotes(NOW);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitPrice, 1);
  assert.equal(position.exitFees, 0);
  assert.equal(position.realizedPnl, 60);
  assert.equal(bot.cash, 10_060);
  assert.equal(bot.orders[0].kind, 'SELL_TAKE_PROFIT');
  assert.equal(bot.orders[0].matchedShares, 100);

  const noStopLossBot = makeBot();
  const losingPosition = {
    id: 'no-stop-loss-up',
    side: 'UP',
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    marketId: 'condition',
    status: 'OPEN',
  };
  noStopLossBot.positions.push(losingPosition);
  setQuote(noStopLossBot, 'UP', 0.01, 0.02, 1000, NOW);
  await noStopLossBot.refreshLiveQuotes(NOW);
  assert.equal(losingPosition.status, 'OPEN');
});

test('a fresh CLOB update triggers take-profit immediately without waiting for a polling tick', () => {
  let onQuote;
  const bot = makeBot({
    clobFeedFactory: (options) => {
      onQuote = options.onQuote;
      return {
        start() {},
        stop() {},
        getQuote() { return null; },
        snapshot() { return { status: 'CONNECTED', connected: true, quoteAgesMs: {} }; },
      };
    },
  });
  const position = {
    id: 'websocket-tp-up',
    side: 'UP',
    initialShares: 100,
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    windowMs: config.WINDOW_MS_5M,
    status: 'OPEN',
  };
  bot.positions.push(position);
  bot.cash = 9960;
  bot.ensureClobFeed();

  onQuote('up-token', {
    status: 'LIVE',
    bestBid: 0.99,
    bestAsk: 1,
    bidSize: 1000,
    askSize: 1000,
    mid: 0.995,
    bidLevels: [{ price: 0.99, size: 1000 }],
    askLevels: [{ price: 1, size: 1000 }],
    updatedAt: NOW,
  });

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'TAKE_PROFIT_BID_AT_0.99');
  assert.equal(position.closedAt, NOW);
  assert.equal(bot.orders[0].kind, 'SELL_TAKE_PROFIT');
  assert.equal(bot.cash, 10_060);
});

test('the final fresh in-window bid triggers TP before rollover moves a position to resolution', async () => {
  const bot = makeBot();
  const windowEnd = WINDOW_START + config.WINDOW_MS_5M;
  const finalQuoteAt = windowEnd - 403;
  const position = {
    id: 'last-tick-tp-up',
    side: 'UP',
    initialShares: 100,
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    windowMs: config.WINDOW_MS_5M,
    status: 'OPEN',
  };
  bot.positions.push(position);
  bot.cash = 9960;
  setQuote(bot, 'UP', 0.999, 1, 1000, finalQuoteAt);

  await bot.completeWindow(WINDOW_START, null, 'WINDOW_ROLLOVER', windowEnd + 100);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'TAKE_PROFIT_BID_AT_0.99');
  assert.equal(position.closedAt, finalQuoteAt);
  assert.equal(bot.cash, 10_060);
  assert.equal(bot.snapshot().account.startingCapital, 10_000);
  assert.equal(bot.snapshot().account.currentCapital, 10_060);
  assert.equal(bot.events.find((event) => event.event === 'PAPER_DIP_WINDOW_ENDED')
    .pendingResolutionCount, 0);
});

test('a bid timestamped at the window end does not count as an in-window take-profit', async () => {
  const bot = makeBot();
  const windowEnd = WINDOW_START + config.WINDOW_MS_5M;
  const position = {
    id: 'after-window-tp-up',
    side: 'UP',
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    windowMs: config.WINDOW_MS_5M,
    status: 'OPEN',
  };
  bot.positions.push(position);
  setQuote(bot, 'UP', 0.999, 1, 1000, windowEnd);

  await bot.completeWindow(WINDOW_START, null, 'WINDOW_ROLLOVER', windowEnd + 100);

  assert.equal(position.status, 'PENDING_CLOB_RESULT');
  assert.equal(bot.orders.some((order) => order.kind === 'SELL_TAKE_PROFIT'), false);
});

test('paper snapshot identifies the independent dip-and-spike demo strategy', () => {
  const bot = makeBot();
  const state = bot.snapshot();
  assert.equal(state.strategy.name, 'BTC 5-minute independent dip-and-spike paper bot');
  assert.deepEqual(state.strategy.markets, ['BTC 5m']);
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.liveTradingEnabled, false);
  assert.equal(state.strategy.realOrderModulesLoaded, false);
  assert.equal(state.strategy.orders.type, 'Visible-book taker-style paper sweeps');
  assert.equal(state.strategy.orders.entryCooldownMs, 10_000);
  assert.match(state.strategy.repeatEntryRule, /10-second cooldown/i);
  assert.match(state.strategy.repeatEntryRule, /recover/i);
  assert.equal(state.strategy.maxBuyPrice, 0.85);
  assert.equal(state.strategy.entryShares, 20);
  assert.equal(state.strategy.maxEntriesPerSide, 4);
  assert.equal(state.strategy.tradeWindowMs, 240_000);
  assert.match(state.strategy.exit, /sell all.*official resolution/i);
  assert.equal(state.strategy.exits.takeProfit, true);
  assert.equal(state.strategy.exits.takeProfitTrigger, 0.05);
  assert.equal(state.strategy.exits.takeProfitPayout, null);
  assert.equal(state.strategy.exits.stopLoss, false);
  assert.equal(state.strategy.signalState.status, 'WAITING_FOR_DATA');
  assert.equal(state.strategy.priceFeed.source, 'Binance BTCUSDT aggregate trades');
  assert.equal(state.account.startingCapital, 10_000);
  assert.equal(state.account.currentCapital, state.account.equity);
  assert.equal(Object.hasOwn(state, 'shadowComparison'), false);
  assert.equal(state.markets['5m'].forecast.status, 'WAITING_FOR_DATA');
});

test('paper snapshot adds global analytics without dropping position history', () => {
  const bot = makeBot();
  bot.positions = [
    {
      id: 'up-win',
      side: 'UP',
      status: 'SETTLED_EXIT',
      windowStart: WINDOW_START,
      slug: 'first-window',
      shares: 100,
      totalCost: 40,
      openedAt: NOW - 10_000,
      settledAt: NOW - 1_000,
      realizedPnl: 10,
    },
    {
      id: 'down-loss',
      side: 'DOWN',
      status: 'SETTLED_LOSS',
      windowStart: WINDOW_START,
      slug: 'first-window',
      shares: 100,
      totalCost: 30,
      openedAt: NOW - 5_000,
      settledAt: NOW - 500,
      realizedPnl: -15,
    },
    {
      id: 'other-window-open',
      side: 'DOWN',
      status: 'OPEN',
      windowStart: WINDOW_START + config.WINDOW_MS_5M,
      slug: 'second-window',
      shares: 100,
      totalCost: 60,
      openedAt: NOW - 500,
      realizedPnl: null,
    },
  ];

  const state = bot.snapshot();

  assert.equal(state.positions.length, 3);
  assert.equal(state.account.positions.length, 3);
  assert.equal(state.portfolioAnalytics.combinedResults.settled, 2);
  assert.equal(state.portfolioAnalytics.combinedResults.wins, 1);
  assert.equal(state.portfolioAnalytics.combinedResults.losses, 1);
  assert.equal(state.portfolioAnalytics.maxWindowExposure.amount, 70);
  assert.equal(state.portfolioAnalytics.maxDrawdown, 15);
  assert.equal(state.portfolioAnalytics.equityCurve.at(-1).equity, 9_995);
});

test('ended paper positions wait for the original market resolution', async () => {
  const bot = makeBot({
    marketData: {
      getMarket: async () => ({
        closed: true,
        outcomes: '["Up","Down"]',
        outcomePrices: '["1","0"]',
        clobTokenIds: '["up-token","down-token"]',
      }),
    },
  });
  const position = {
    id: 'pending-up',
    side: 'UP',
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    marketId: 'condition',
    tokenId: 'up-token',
    slug: bot.market.slug,
    status: 'OPEN',
  };
  bot.positions.unshift(position);

  await bot.completeWindow(WINDOW_START, null, 'WINDOW_COMPLETE', NOW);
  assert.equal(position.status, 'PENDING_CLOB_RESULT');
  assert.equal(bot.cash, 10_000);

  await bot.resolvePendingPositions(NOW + config.RESOLUTION_POLL_MS);
  assert.equal(position.status, 'SETTLED_WIN');
  assert.equal(position.realizedPnl, 60);
  assert.equal(bot.cash, 10_100);
  assert.equal(bot.snapshot().account.currentCapital, 10_100);
  assert.equal(bot.resolutions[0].outcome, 'UP');
});

test('pending positions check official resolution no more often than every 10 seconds', async () => {
  let resolutionChecks = 0;
  const bot = makeBot({
    marketData: {
      getMarket: async () => {
        resolutionChecks += 1;
        return { closed: false, outcomes: '["Up","Down"]', outcomePrices: '["0.5","0.5"]' };
      },
    },
  });
  const position = {
    id: 'pending-resolution-poll',
    side: 'UP',
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    marketId: 'condition',
    tokenId: 'up-token',
    status: 'PENDING_CLOB_RESULT',
  };
  bot.positions.push(position);

  await bot.resolvePendingPositions(NOW);
  await bot.resolvePendingPositions(NOW + 9_999);
  assert.equal(resolutionChecks, 1);
  await bot.resolvePendingPositions(NOW + 10_000);
  assert.equal(resolutionChecks, 2);
  assert.equal(position.status, 'PENDING_CLOB_RESULT');
});

test('Binance public aggregate trades record direction and the current 5-minute candle', () => {
  const feed = new BinanceTickFeed({ now: () => NOW, WebSocketImpl: class FakeSocket {} });
  feed.handleMessage(JSON.stringify({
    stream: 'btcusdt@kline_5m',
    data: {
      E: NOW,
      k: { t: WINDOW_START, o: '100', h: '101', l: '99.5', c: '100.8', x: false },
    },
  }));
  feed.handleMessage(JSON.stringify({ p: '101', q: '2', T: NOW, m: false }));
  feed.handleMessage(JSON.stringify({ p: '100', q: '1', T: NOW + 1, m: true }));
  const snapshot = feed.snapshot();
  assert.equal(snapshot.source, 'Binance BTCUSDT aggregate trades');
  assert.equal(snapshot.currentCandle.start, WINDOW_START);
  assert.equal(snapshot.currentCandle.open, 100);
  assert.equal(snapshot.tradeFlow.buyCount, 1);
  assert.equal(snapshot.tradeFlow.sellCount, 1);
  assert.equal(snapshot.tradeFlow.tradeCount, 2);
  feed.handleMessage({ data: { p: '100.5', q: '3', T: NOW + 2, m: false } });
  assert.equal(feed.snapshot().tradeFlow.tradeCount, 3);
});

test('paper history migration restores positions, cash, and cooldowns', () => {
  const bot = makeBot();
  const position = {
    id: 'btc-5m-1800000000000-buy_entry-up-23',
    windowStart: WINDOW_START,
    side: 'UP',
    status: 'OPEN',
    shares: 100,
    totalCost: 48,
    filledAt: NOW - 5000,
    markBid: 0.49,
  };
  const snapshot = {
    mode: 'DEMO ONLY',
    now: NOW,
    account: {
      capital: 10_000,
      cash: 9_952,
      equityCurve: [{ ts: WINDOW_START - 60_000, equity: 10_000 }],
    },
    window: { start: WINDOW_START, end: WINDOW_START + config.WINDOW_MS_5M, slug: 'btc-window' },
    markets: { '5m': { quotes: { UP: { bestBid: 0.49, updatedAt: NOW } }, orders: [] } },
    quotes: {
      UP: { status: 'LIVE', bestBid: 0.49, updatedAt: NOW },
      DOWN: { status: 'LIVE', bestBid: 0.51, updatedAt: NOW },
    },
    positions: [position],
    orders: [{
      id: position.id,
      windowStart: WINDOW_START,
      side: 'UP',
      action: 'BUY',
      status: 'FILLED',
      filledAt: NOW - 5000,
    }],
    events: [{ at: NOW - 4000, type: 'BUY_FILLED', message: 'entry retained' }],
    resolutions: [{ slug: 'prior-window', outcome: 'DOWN', status: 'RESOLVED', pnl: 12 }],
    forecast: { ready: false, reason: 'restored forecast' },
  };

  bot.restoreFromSnapshot(snapshot);

  assert.equal(bot.cash, 9_952);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.resolutions[0].slug, 'prior-window');
  assert.equal(bot.lastEntryAtBySide.UP, NOW - 5000);
  assert.equal(bot.orderWindowStart, WINDOW_START);
  assert.equal(bot.forecast.status, 'COLLECTING_PRICE_HISTORY');
  assert.equal(bot.forecast.reason, 'Collecting fresh Polymarket quotes after restart.');

  assert.equal(Object.hasOwn(bot.snapshot(), 'shadowComparison'), false);

  const reloadedBot = makeBot();
  reloadedBot.restorePersistentState(bot.serializePersistentState());
  assert.equal(reloadedBot.positions[0].id, position.id);
  assert.equal(reloadedBot.cash, 9_952);
  assert.equal(Object.hasOwn(reloadedBot.serializePersistentState(), 'shadowPositions'), false);
});
