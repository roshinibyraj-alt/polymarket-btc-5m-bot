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

function addSamples(bot, direction, now = NOW) {
  const currentPrice = direction > 0 ? 100.5 : 99.5;
  bot.priceFeed.price = currentPrice;
  bot.priceFeed.currentCandle.close = currentPrice;
  bot.priceFeed.currentCandle.high = Math.max(bot.priceFeed.currentCandle.high, currentPrice);
  bot.priceFeed.currentCandle.low = Math.min(bot.priceFeed.currentCandle.low, currentPrice);
  bot.pressureSamples = Array.from({ length: config.PRESSURE_SAMPLE_COUNT }, (_, index) => ({
    at: now - (config.PRESSURE_SAMPLE_COUNT - 1 - index) * 1000,
    score: direction * (0.2 + index * 0.07),
    price: currentPrice - direction * (config.PRESSURE_SAMPLE_COUNT - 1 - index) * 0.01,
    windowOpenPrice: 100,
    marketImpliedUp: direction > 0 ? 0.32 : 0.65,
  }));
  bot.lastSampleAt = now - 1000;
}

test('ten one-second pressure samples expose direction, persistence, and acceleration', () => {
  const result = PressureForecastBot._test.pressureTrend(
    Array.from({ length: 10 }, (_, index) => ({ score: index / 10 })),
  );
  assert.equal(result.sampleCount, 10);
  assert.ok(result.pressureTrendSlope > 0);
  assert.equal(result.pressurePersistence, 0.9);
  assert.ok(result.pressureAcceleration > 0);
  assert.ok(result.pressureImpulse > 0);
});

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

test('entry requires probability above 50%, $0.02 net edge, and retains $0.10 sizing base', () => {
  const evaluate = PressureForecastBot._test.evaluateEntryCandidate;
  const probabilityFloor = evaluate(0.50, {
    bestAsk: 0.30,
    askLevels: [{ price: 0.30, size: 500 }],
  }, { feesEnabled: false });
  const exactEdge = evaluate(0.51, {
    bestAsk: 0.49,
    askLevels: [{ price: 0.49, size: 500 }],
  }, { feesEnabled: false });
  const oneCentAboveSizingBase = evaluate(0.71, {
    bestAsk: 0.60,
    askLevels: [{ price: 0.60, size: 500 }],
  }, { feesEnabled: false });
  const capped = evaluate(0.99, {
    bestAsk: 0.60,
    askLevels: [{ price: 0.60, size: 500 }],
  }, { feesEnabled: false });

  assert.equal(probabilityFloor.qualifies, false);
  assert.equal(exactEdge.qualifies, true);
  assert.ok(Math.abs(exactEdge.expectedNetEdgePerShare - 0.02) < 1e-12);
  assert.equal(exactEdge.requestedShares, 100);
  assert.equal(oneCentAboveSizingBase.qualifies, true);
  assert.equal(oneCentAboveSizingBase.requestedShares, 110);
  assert.equal(capped.requestedShares, 200);
  assert.equal(PressureForecastBot._test.sharesAllowedByEdge(0.10), 100);
  assert.equal(PressureForecastBot._test.sharesAllowedByEdge(0.11), 110);
  assert.equal(PressureForecastBot._test.sharesAllowedByEdge(0.20), 200);
});

test('forecast waits for ten samples and checks either side independently of the $0.50 level', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.30, 0.32);
  setQuote(bot, 'DOWN', 0.68, 0.70);
  const read = bot.buildPressureRead(NOW);
  const waiting = bot.createForecast(read, NOW, WINDOW_START);
  assert.equal(waiting.ready, false);
  assert.equal(waiting.sampleCount, 0);

  addSamples(bot, 1);
  const forecast = bot.createForecast(read, NOW, WINDOW_START);
  assert.equal(forecast.ready, true);
  assert.equal(forecast.laggingSide, 'UP');
  assert.equal(forecast.candidateBySide.UP.qualifies, true);
  assert.equal(forecast.candidateBySide.DOWN.qualifies, false);
  assert.equal(forecast.calibrated, false);

  setQuote(bot, 'UP', 0.48, 0.49);
  setQuote(bot, 'DOWN', 0.50, 0.51);
  const neutralFeed = makeFeed(NOW, 100);
  neutralFeed.tradeFlow.imbalance = 0;
  neutralFeed.tradeFlow.priceChangePct = 0;
  bot.priceFeed = neutralFeed;
  bot.pressureSamples = Array.from({ length: config.PRESSURE_SAMPLE_COUNT }, (_, index) => ({
    at: NOW - (config.PRESSURE_SAMPLE_COUNT - 1 - index) * 1000,
    score: 0,
    price: 100 + (index % 2 ? 0.01 : 0),
    windowOpenPrice: 100,
    marketImpliedUp: 0.49,
  }));
  const narrowEdge = bot.createForecast(bot.buildPressureRead(NOW), NOW, WINDOW_START);
  assert.equal(narrowEdge.candidateBySide.UP.qualifies, false);
  assert.ok(narrowEdge.candidateBySide.UP.expectedNetEdgePerShare < config.PRESSURE_MIN_NET_EDGE_PER_SHARE);
});

test('a signal-qualified side can enter above $0.50 while the other side is cheaper', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.64, 0.65);
  setQuote(bot, 'DOWN', 0.34, 0.35);
  addSamples(bot, 1);
  const forecast = bot.createForecast(bot.buildPressureRead(NOW), NOW, WINDOW_START);

  assert.equal(forecast.laggingSide, 'DOWN');
  assert.equal(forecast.candidateBySide.UP.qualifies, true);
  assert.equal(forecast.selectedSide, 'UP');
  assert.equal(forecast.candidateBySide.UP.bestAsk, 0.65);
});

test('entry uses edge-based share sizing and records modeled fees and all-in cost', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.30, 0.32);
  setQuote(bot, 'DOWN', 0.68, 0.70);
  addSamples(bot, 1);
  bot.market.feesEnabled = true;
  bot.market.feeSchedule = { rate: 0.07, exponent: 1 };
  const read = bot.buildPressureRead(NOW);

  const changed = bot.processPressureStrategy(WINDOW_START, NOW);

  assert.equal(changed, true);
  const position = bot.positions.find((item) => item.status === 'OPEN');
  assert.equal(position.side, 'UP');
  assert.equal(position.shares, 200);
  assert.equal(position.fillModel, 'VISIBLE_ASK_SWEEP_WITH_CONFIGURED_MAX_PRICE');
  assert.ok(position.fees > 0);
  assert.equal(bot.orders[0].orderType, 'PAPER_TAKER_MARKET');
  assert.equal(bot.orders[0].maxPrice, 0.95);
  assert.ok(bot.cash < 10_000);
  assert.ok(read.ready);
});

test('opposite qualifying signal adds a position without selling the existing one', () => {
  const bot = makeBot({ price: 99.7 });
  setQuote(bot, 'UP', 0.50, 0.52);
  setQuote(bot, 'DOWN', 0.34, 0.36);
  addSamples(bot, -1);
  bot.market.feesEnabled = false;
  bot.lastEntryAt = NOW - 1000;
  bot.lastEntryAtBySide.UP = NOW - 1000;
  const open = {
    id: 'open-up',
    side: 'UP',
    outcome: 'UP',
    shares: 100,
    initialShares: 100,
    totalCost: 60,
    fees: 0,
    windowStart: WINDOW_START,
    marketId: bot.market.id,
    tokenId: bot.market.tokens.UP,
    slug: bot.market.slug,
    status: 'OPEN',
    markBid: 0.50,
  };
  bot.positions.unshift(open);
  bot.cash = 9940;

  const added = bot.processPressureStrategy(WINDOW_START, NOW);

  assert.equal(added, true);
  assert.equal(open.status, 'OPEN');
  assert.equal(bot.lastEntryAtBySide.UP, NOW - 1000);
  assert.equal(bot.lastEntryAtBySide.DOWN, NOW);
  const openPositions = bot.positions.filter((position) => position.status === 'OPEN');
  assert.equal(openPositions.length, 2);
  assert.deepEqual(openPositions.map((position) => position.side).sort(), ['DOWN', 'UP']);
  assert.deepEqual(bot.orders.map((order) => order.kind), ['BUY_ENTRY']);
  assert.equal(bot.orders[0].maxPrice, 0.95);
});

test('same-side entries are blocked until the 5-second cooldown elapses', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.30, 0.32);
  setQuote(bot, 'DOWN', 0.68, 0.70);
  addSamples(bot, 1);
  bot.market.feesEnabled = false;
  const open = {
    id: 'existing-up',
    side: 'UP',
    outcome: 'UP',
    shares: 100,
    initialShares: 100,
    totalCost: 32,
    fees: 0,
    windowStart: WINDOW_START,
    marketId: bot.market.id,
    tokenId: bot.market.tokens.UP,
    slug: bot.market.slug,
    status: 'OPEN',
    markBid: 0.30,
  };
  bot.positions.unshift(open);
  bot.cash = 9968;
  bot.lastEntryAt = NOW - 1000;
  bot.lastEntryAtBySide.UP = NOW - config.PRESSURE_ENTRY_COOLDOWN_MS + 1000;

  const duringCooldown = bot.processPressureStrategy(WINDOW_START, NOW);
  assert.equal(duringCooldown, false);
  assert.equal(bot.forecast.status, 'ENTRY_COOLDOWN');
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 1);

  const afterCooldown = bot.processPressureStrategy(WINDOW_START, NOW + 1000);
  assert.equal(afterCooldown, true);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 2);
  assert.deepEqual(bot.positions.filter((position) => position.status === 'OPEN')
    .map((position) => position.side), ['UP', 'UP']);
  assert.equal(bot.orders[0].kind, 'BUY_ENTRY');
  assert.equal(bot.lastEntryAt, NOW + 1000);
  assert.equal(bot.lastEntryAtBySide.UP, NOW + 1000);
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
  assert.equal(bot.events.find((event) => event.event === 'PAPER_PRESSURE_WINDOW_ENDED')
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

test('paper snapshot identifies only the uncalibrated BTC 5-minute demo strategy', () => {
  const bot = makeBot();
  const state = bot.snapshot();
  assert.equal(state.strategy.name, 'BTC 5-minute pressure and price forecast paper bot');
  assert.deepEqual(state.strategy.markets, ['BTC 5m']);
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.liveTradingEnabled, false);
  assert.equal(state.strategy.realOrderModulesLoaded, false);
  assert.equal(state.strategy.orders.type, 'Visible-book taker-style paper sweeps');
  assert.equal(state.strategy.orders.entryCooldownMs, 5_000);
  assert.match(state.strategy.repeatEntryRule, /separate 5-second entry cooldowns/i);
  assert.match(state.strategy.repeatEntryRule, /increasing by 10 shares per \$0\.01 edge/i);
  assert.equal(state.strategy.minEstimatedProbability, 0.50);
  assert.equal(state.strategy.maxBuyPrice, 0.95);
  assert.equal(state.strategy.minNetEdgePerShare, 0.02);
  assert.equal(state.strategy.orders.edgeSizeBase, 0.10);
  assert.equal(state.strategy.maxEntryShares, 200);
  assert.match(state.strategy.exit, /take-profit.*official resolution/i);
  assert.equal(state.strategy.exits.takeProfit, true);
  assert.equal(state.strategy.exits.takeProfitTrigger, 0.99);
  assert.equal(state.strategy.exits.takeProfitPayout, 1);
  assert.equal(state.strategy.exits.stopLoss, false);
  assert.equal(state.strategy.signalState.calibrated, false);
  assert.equal(state.strategy.priceFeed.source, 'Binance BTCUSDT aggregate trades');
  assert.equal(Object.hasOwn(state, 'shadowComparison'), false);
  assert.equal(state.markets['5m'].forecast.calibrated, false);
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
  assert.equal(bot.pressureSamples.length, 0);
  assert.equal(bot.forecast.reason, 'restored forecast');

  assert.equal(Object.hasOwn(bot.snapshot(), 'shadowComparison'), false);

  const reloadedBot = makeBot();
  reloadedBot.restorePersistentState(bot.serializePersistentState());
  assert.equal(reloadedBot.positions[0].id, position.id);
  assert.equal(reloadedBot.cash, 9_952);
  assert.equal(Object.hasOwn(reloadedBot.serializePersistentState(), 'shadowPositions'), false);
});
