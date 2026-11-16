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

function makeBot({ now = NOW, price = 100.3, marketData = {} } = {}) {
  const bot = new PressureForecastBot({
    now: () => now,
    priceFeed: makeFeed(now, price),
    marketData,
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
  bot.pressureSamples = Array.from({ length: config.PRESSURE_SAMPLE_COUNT }, (_, index) => ({
    at: now - (config.PRESSURE_SAMPLE_COUNT - 1 - index) * 1000,
    score: direction * (0.2 + index * 0.07),
    price: direction > 0 ? 100 + index * 0.03 : 100 - index * 0.03,
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

test('adaptive shadow sample count steps down once per minute and floors at six', () => {
  for (const [elapsed, expected] of [
    [0, 10],
    [59_999, 10],
    [60_000, 9],
    [120_000, 8],
    [180_000, 7],
    [240_000, 6],
    [299_000, 6],
  ]) {
    assert.equal(
      PressureForecastBot._test.adaptiveShadowSampleCount(WINDOW_START, WINDOW_START + elapsed),
      expected,
    );
  }
});

test('taker sweep observes the buy ceiling, sell floor, and per-level fees', () => {
  const market = { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } };
  const buy = PressureForecastBot._test.sweepBook([
    { price: 0.89, size: 50 },
    { price: 0.90, size: 50 },
    { price: 0.91, size: 1000 },
  ], 100, 'BUY', market, { maximumPrice: 0.90 });
  assert.equal(buy.complete, true);
  assert.equal(buy.filledShares, 100);
  assert.ok(Math.abs(buy.gross - 89.5) < 1e-9);
  assert.ok(buy.fees > 0);
  assert.equal(buy.fills.some((fill) => fill.price > 0.90), false);

  const sell = PressureForecastBot._test.sweepBook([
    { price: 0.009, size: 1000 },
    { price: 0.01, size: 100 },
  ], 100, 'SELL', market, { minimumPrice: 0.01 });
  assert.equal(sell.complete, true);
  assert.equal(sell.averagePrice, 0.01);
  assert.equal(sell.filledShares, 100);
});

test('forecast waits for ten samples and qualifies only the cheap side with positive net edge', () => {
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

test('entry uses a 100-share taker sweep and records its fees and all-in cost', () => {
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
  assert.equal(position.shares, 100);
  assert.ok(position.fees > 0);
  assert.equal(bot.orders[0].orderType, 'PAPER_TAKER_MARKET');
  assert.equal(bot.orders[0].maxPrice, 0.90);
  assert.ok(bot.cash < 10_000);
  assert.ok(read.ready);
});

test('opposite qualifying signal adds a position without selling the existing one', () => {
  const bot = makeBot({ price: 99.7 });
  setQuote(bot, 'UP', 0.50, 0.52);
  setQuote(bot, 'DOWN', 0.34, 0.36);
  addSamples(bot, -1);
  bot.market.feesEnabled = false;
  bot.lastEntryAt = NOW - config.PRESSURE_ENTRY_COOLDOWN_MS;
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
  const openPositions = bot.positions.filter((position) => position.status === 'OPEN');
  assert.equal(openPositions.length, 2);
  assert.deepEqual(openPositions.map((position) => position.side).sort(), ['DOWN', 'UP']);
  assert.deepEqual(bot.orders.map((order) => order.kind), ['BUY_ENTRY']);
  assert.equal(bot.orders[0].maxPrice, 0.90);
});

test('same-side entries are blocked until the 15-second cooldown elapses', () => {
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
  bot.lastEntryAt = NOW - config.PRESSURE_ENTRY_COOLDOWN_MS + 1000;

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
});

test('shadow entries use separate fee-aware paper cash and never add main orders', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.30, 0.32);
  setQuote(bot, 'DOWN', 0.68, 0.70);
  addSamples(bot, 1);
  bot.market.feesEnabled = true;
  bot.market.feeSchedule = { rate: 0.07, exponent: 1 };

  const changed = bot.processPressureStrategy(WINDOW_START, NOW);

  assert.equal(changed, true);
  assert.equal(bot.forecast.requiredSamples, 10);
  assert.equal(bot.shadowForecast.requiredSamples, 10);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 1);
  assert.equal(bot.shadowPositions.filter((position) => position.status === 'OPEN').length, 1);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].kind, 'BUY_ENTRY');
  assert.ok(bot.positions[0].fees > 0);
  assert.ok(bot.shadowPositions[0].fees > 0);
  assert.equal(bot.cash, 10_000 - bot.positions[0].totalCost);
  assert.equal(bot.shadowCash, 10_000 - bot.shadowPositions[0].totalCost);
  assert.notStrictEqual(bot.positions, bot.shadowPositions);
});

test('shadow-only entry leaves the trading portfolio completely untouched', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.30, 0.32);
  setQuote(bot, 'DOWN', 0.68, 0.70);
  addSamples(bot, 1);
  const read = bot.buildPressureRead(NOW);
  const forecast = bot.createForecast(read, NOW, WINDOW_START);

  const simulated = bot.processShadowEntry(WINDOW_START, NOW, read, forecast);

  assert.equal(simulated, true);
  assert.equal(bot.cash, 10_000);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.shadowPositions.length, 1);
  assert.ok(bot.shadowCash < 10_000);
});

test('baseline and shadow P&L settle independently at the existing take-profit threshold', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.30, 0.32);
  setQuote(bot, 'DOWN', 0.68, 0.70);
  addSamples(bot, 1);
  bot.market.feesEnabled = false;

  bot.processPressureStrategy(WINDOW_START, NOW);
  setQuote(bot, 'UP', 0.99, 0.99, 1000, NOW + 1000);
  bot.processThresholdExits(WINDOW_START, NOW + 1000);

  assert.equal(bot.positions[0].status, 'SETTLED_EXIT');
  assert.equal(bot.shadowPositions[0].status, 'SETTLED_EXIT');
  const comparison = bot.snapshot().shadowComparison;
  assert.equal(comparison.baseline.entries, 1);
  assert.equal(comparison.adaptive.entries, 1);
  assert.equal(comparison.baseline.realizedPnl, comparison.adaptive.realizedPnl);
  assert.equal(bot.orders.filter((order) => order.kind === 'SELL_TAKE_PROFIT').length, 1);
});

test('shadow stop loss counts a $0.01 bid as a zero payout', () => {
  const bot = makeBot();
  setQuote(bot, 'UP', 0.01, 0.02, 1000);
  const position = {
    id: 'shadow-stop-up',
    shadowOnly: true,
    side: 'UP',
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    status: 'OPEN',
    markBid: 0.01,
  };
  bot.shadowPositions.push(position);
  bot.shadowCash = 9960;

  bot.processThresholdExits(WINDOW_START, NOW);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitPrice, 0);
  assert.equal(position.realizedPnl, -40);
  assert.equal(bot.shadowCash, 9960);
  assert.equal(bot.orders.length, 0);
});

test('shadow-only positions roll over and settle from official market resolution', async () => {
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
    id: 'shadow-pending-up',
    shadowOnly: true,
    side: 'UP',
    shares: 100,
    totalCost: 40,
    windowStart: WINDOW_START,
    marketId: 'condition',
    tokenId: 'up-token',
    slug: bot.market.slug,
    status: 'OPEN',
  };
  bot.shadowPositions.push(position);
  bot.shadowCash = 9960;

  await bot.closePreviousWindows(WINDOW_START + config.WINDOW_MS_5M, NOW + 1000);
  assert.equal(position.status, 'PENDING_CLOB_RESULT');
  assert.equal(bot.positions.length, 0);

  await bot.resolvePendingPositions(NOW + 60_000);
  assert.equal(position.status, 'SETTLED_WIN');
  assert.equal(position.realizedPnl, 60);
  assert.equal(bot.shadowCash, 10_060);
  assert.equal(bot.resolutions.length, 0);
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
  assert.equal(state.strategy.orders.entryCooldownMs, 15_000);
  assert.match(state.strategy.repeatEntryRule, /independent 100-share position/i);
  assert.equal(state.strategy.signalState.calibrated, false);
  assert.equal(state.strategy.priceFeed.source, 'Binance BTCUSDT aggregate trades');
  assert.equal(state.shadowComparison.mode, 'SHADOW_ONLY');
  assert.equal(state.shadowComparison.baseSampleCount, 10);
  assert.equal(state.shadowComparison.activeSampleCount, 10);
  assert.equal(state.shadowComparison.baseline.initialCapital, 10_000);
  assert.equal(state.shadowComparison.adaptive.initialCapital, 10_000);
  assert.equal(state.markets['5m'].forecast.calibrated, false);
});

test('0.99 take-profit counts as $1 and 0.01 stop-loss counts as $0', () => {
  for (const scenario of [
    { bid: 0.99, expectedPayout: 1, expectedStatus: 'SELL_TAKE_PROFIT', pnl: 60 },
    { bid: 0.01, expectedPayout: 0, expectedStatus: 'SELL_STOP_LOSS', pnl: -40 },
  ]) {
    const bot = makeBot();
    setQuote(bot, 'UP', scenario.bid, scenario.bid, 1000);
    const position = {
      id: `threshold-${scenario.bid}`,
      side: 'UP',
      shares: 100,
      initialShares: 100,
      totalCost: 40,
      cost: 40,
      fees: 0,
      windowStart: WINDOW_START,
      marketId: bot.market.id,
      tokenId: bot.market.tokens.UP,
      slug: bot.market.slug,
      status: 'OPEN',
    };
    bot.positions.unshift(position);

    bot.processThresholdExits(WINDOW_START, NOW);

    assert.equal(position.exitPrice, scenario.expectedPayout);
    assert.equal(position.realizedPnl, scenario.pnl);
    assert.equal(bot.orders[0].kind, scenario.expectedStatus);
    assert.equal(bot.orders[0].price, scenario.expectedPayout);
  }
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
