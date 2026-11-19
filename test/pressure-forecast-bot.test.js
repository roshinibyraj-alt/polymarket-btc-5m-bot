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
  const opposite = side === 'UP' ? 'DOWN' : 'UP';
  if (bot.liveQuotes[opposite]?.status !== 'LIVE') {
    setQuote(bot, opposite, 0.49, 0.51, 500, now);
  }
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

test('either entry trigger fills both paired legs and UP still sweeps through $0.99', () => {
  const bot = makeBot();
  bot.openStrategyWindow(WINDOW_START, NOW - 1);
  setQuote(bot, 'UP', 0.69, 0.70, 1000, NOW);
  setQuote(bot, 'DOWN', 0.49, 0.51, 1000, NOW);
  bot.processEngineTriggers(NOW);
  assert.equal(bot.positions.length, 0);

  setQuote(bot, 'UP', 0.70, 0.71, 1000, NOW + 1);
  bot.processEngineTriggers(NOW + 1);
  assert.equal(bot.positions.length, 2);
  const upPosition = bot.positions.find((position) => position.side === 'UP');
  const downPosition = bot.positions.find((position) => position.side === 'DOWN');
  assert.equal(upPosition.shares, 50);
  assert.equal(upPosition.avgEntry, 0.71);
  assert.equal(downPosition.shares, 50);
  assert.equal(downPosition.avgEntry, 0.30);
  assert.equal(upPosition.pairId, downPosition.pairId);
  assert.equal(upPosition.pairedTriggerSide, 'UP');
  assert.equal(downPosition.pairedTriggerSide, 'UP');
  assert.equal(bot.orders.find((order) => order.kind === 'BUY_UP_MARKET').maxPrice, 0.99);
  assert.equal(bot.upEngine.status, 'OPEN');
  assert.equal(bot.downEngine.status, 'OPEN');
  assert.equal(bot.upEngine.fillStatus, 'FILLED · PAIRED');
  assert.equal(bot.downEngine.fillStatus, 'FILLED · PAIRED');
  assert.equal(bot.orders.find((order) => order.kind === 'BUY_DOWN_LIMIT').status, 'FILLED');

  const state = bot.snapshot();
  assert.equal(state.markets['5m'].forecast.pairedEntry.active, true);
  assert.equal(state.markets['5m'].forecast.up.capitalCommitted, upPosition.totalCost);
  assert.equal(state.markets['5m'].forecast.down.capitalCommitted, downPosition.totalCost);
  assert.equal(state.markets['5m'].forecast.up.floatingPnl,
    upPosition.markBid * upPosition.shares - upPosition.totalCost);
  assert.equal(state.markets['5m'].forecast.down.floatingPnl,
    downPosition.markBid * downPosition.shares - downPosition.totalCost);
});

test('UP engine rejects the full entry if asks exceed its $0.99 sweep ceiling', () => {
  const bot = makeBot();
  bot.openStrategyWindow(WINDOW_START, NOW - 1);
  setQuote(bot, 'UP', 0.98, 0.995, 1000, NOW);
  setQuote(bot, 'DOWN', 0.49, 0.51, 1000, NOW);

  bot.processEngineTriggers(NOW);

  assert.equal(bot.positions.length, 0);
  assert.equal(bot.upEngine.status, 'NO_FILL');
  assert.equal(bot.orders.find((order) => order.kind === 'BUY_UP_MARKET').status, 'SKIPPED_SLIPPAGE_OR_DEPTH');
});

test('DOWN tick-through pairs both sides even if UP is below its normal trigger', () => {
  const bot = makeBot();
  bot.downProfitCarry = 3;
  bot.openStrategyWindow(WINDOW_START, NOW - 1);
  const order = bot.orders.find((item) => item.kind === 'BUY_DOWN_LIMIT');
  assert.equal(order.status, 'LIVE');
  assert.equal(order.limitPrice, 0.30);
  assert.equal(order.shares, 60);

  setQuote(bot, 'DOWN', 0.28, 0.30, 1000, NOW - 1);
  bot.processEngineTriggers(NOW - 1);
  assert.equal(order.status, 'LIVE');

  setQuote(bot, 'UP', 0.39, 0.41, 1000, NOW);
  setQuote(bot, 'DOWN', 0.28, 0.30, 1000, NOW);
  bot.processEngineTriggers(NOW);
  assert.equal(order.status, 'FILLED');
  assert.equal(order.matchedShares, 60);
  assert.equal(order.price, 0.30);
  const downPosition = bot.positions.find((position) => position.side === 'DOWN');
  const upPosition = bot.positions.find((position) => position.side === 'UP');
  assert.equal(downPosition.shares, 60);
  assert.equal(downPosition.fees, 0);
  assert.equal(upPosition.shares, 50);
  assert.equal(upPosition.avgEntry, 0.41);
  assert.equal(upPosition.pairedTriggerSide, 'DOWN');
  assert.equal(downPosition.pairedTriggerSide, 'DOWN');
  assert.equal(bot.upEngine.fillStatus, 'FILLED · PAIRED');
  assert.equal(bot.downEngine.fillStatus, 'FILLED · PAIRED');
});

test('UP take-profit carries realized net profit into next-window DOWN shares', () => {
  const bot = makeBot();
  const position = {
    id: 'up-tp',
    side: 'UP',
    engine: 'UP',
    shares: 50,
    totalCost: 20,
    windowStart: WINDOW_START,
    windowMs: config.WINDOW_MS_5M,
    status: 'OPEN',
  };
  bot.positions.push(position);
  bot.cash = 9_980;
  bot.upEngine = bot.emptyEngine('UP', { status: 'OPEN', positionId: position.id });
  setQuote(bot, 'UP', 0.99, 1, 1000, NOW);

  bot.applyTakeProfitExits(NOW);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitPrice, 1);
  assert.equal(position.realizedPnl, 30);
  assert.equal(bot.downProfitCarry, 30);
  assert.equal(bot.snapshot().strategy.downSharesNextWindow, 150);
  assert.equal(bot.upEngine.status, 'TAKE_PROFIT');
});

test('DOWN take-profit clears UP profit carry and restores both engines to base', () => {
  const bot = makeBot();
  const position = {
    id: 'down-tp',
    side: 'DOWN',
    engine: 'DOWN',
    shares: 50,
    totalCost: 15,
    windowStart: WINDOW_START,
    windowMs: config.WINDOW_MS_5M,
    status: 'OPEN',
  };
  bot.positions.push(position);
  bot.downProfitCarry = 24;
  bot.downEngine = bot.emptyEngine('DOWN', { status: 'OPEN', positionId: position.id });
  setQuote(bot, 'DOWN', 0.99, 1, 1000, NOW);

  bot.applyTakeProfitExits(NOW);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.realizedPnl, 35);
  assert.equal(bot.downProfitCarry, 0);
  assert.equal(bot.snapshot().strategy.downSharesNextWindow, 50);
  assert.equal(bot.downEngine.status, 'TAKE_PROFIT');
});

test('positions without take-profit remain open and move to official resolution at window end', async () => {
  const bot = makeBot();
  bot.openStrategyWindow(WINDOW_START, NOW - 1);
  const position = {
    id: 'open-up',
    side: 'UP',
    engine: 'UP',
    shares: 50,
    totalCost: 20,
    windowStart: WINDOW_START,
    windowMs: config.WINDOW_MS_5M,
    marketId: 'condition',
    status: 'OPEN',
  };
  bot.positions.push(position);
  setQuote(bot, 'UP', 0.01, 0.02, 1000, NOW);

  await bot.completeWindow(
    WINDOW_START,
    null,
    'WINDOW_ROLLOVER',
    WINDOW_START + config.WINDOW_MS_5M + 100,
  );

  assert.equal(position.status, 'PENDING_CLOB_RESULT');
  assert.equal(bot.orders.find((order) => order.kind === 'BUY_DOWN_LIMIT').status, 'EXPIRED_WINDOW_ROLLOVER');
  assert.equal(bot.orders.some((order) => order.action === 'SELL'), false);
  assert.equal(bot.snapshot().strategy.exits.stopLoss, false);
});

test('strategy snapshot exposes two paper engines and disables live trading', () => {
  const state = makeBot().snapshot();
  assert.equal(state.strategy.name, 'BTC 5-minute dual-engine paper bot');
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.liveTradingEnabled, false);
  assert.equal(state.strategy.realOrderModulesLoaded, false);
  assert.equal(state.strategy.baseShares, 50);
  assert.equal(state.strategy.upTriggerAsk, 0.71);
  assert.equal(state.strategy.upMaxSweepPrice, 0.99);
  assert.equal(state.strategy.downLimitPrice, 0.30);
  assert.equal(state.strategy.takeProfitBidTrigger, 0.99);
  assert.equal(state.strategy.takeProfitPayout, 1);
  assert.equal(state.strategy.exits.stopLoss, false);
  assert.equal(state.strategy.exits.timedExitAtSeconds, null);
});

test.skip('retired dip analysis is not part of the dual-engine strategy', () => {
  const bot = makeBot();
  addDipHistory(bot, 'UP');
  const candidate = bot.buildDipCandidate('UP', NOW, WINDOW_START, true);
  assert.equal(candidate.ready, true);
  assert.equal(candidate.qualifies, true);
  assert.equal(candidate.signalSide, 'UP');
  assert.equal(candidate.entrySide, 'DOWN');
  assert.ok(Math.abs(candidate.dipAmount - 0.06) < 1e-9);
  assert.ok(Math.abs(candidate.reboundAmount - 0.02) < 1e-9);
  assert.equal(candidate.requestedShares, 20);

  bot.dipHistory.UP[9].mid = bot.dipHistory.UP[8].mid - 0.001;
  const falling = bot.buildDipCandidate('UP', NOW, WINDOW_START, true);
  assert.equal(falling.qualifies, false);
});

test.skip('retired reverse-side buy ceiling is not part of the dual-engine strategy', () => {
  const bot = makeBot();
  addDipHistory(bot, 'UP');
  setQuote(bot, 'UP', 0.94, 0.96, 500, NOW);
  setQuote(bot, 'DOWN', 0.82, 0.84, 500, NOW);

  const eligible = bot.buildDipCandidate('UP', NOW, WINDOW_START, true);
  assert.equal(eligible.qualifies, true);
  assert.equal(eligible.signalBestAsk, 0.96);
  assert.equal(eligible.bestAsk, 0.84);

  setQuote(bot, 'DOWN', 0.86, 0.87, 500, NOW);
  const capped = bot.buildDipCandidate('UP', NOW, WINDOW_START, true);
  assert.equal(capped.qualifies, false);
  assert.match(capped.reason, /DOWN entry ask is above the \$0\.85 ceiling/);
});

test.skip('retired reverse-side signal strategy is not part of the dual-engine strategy', () => {
  const bot = makeBot();
  addDipHistory(bot, 'UP', { base: 0.50 });
  addDipHistory(bot, 'DOWN', { base: 0.52 });
  bot.market.feesEnabled = true;
  bot.market.feeSchedule = { rate: 0.07, exponent: 1 };

  assert.equal(bot.processDipStrategy(WINDOW_START, NOW), true);
  const open = bot.positions.filter((position) => position.status === 'OPEN');
  assert.equal(open.length, 2);
  assert.deepEqual(open.map((position) => position.side).sort(), ['DOWN', 'UP']);
  assert.equal(open.find((position) => position.signalSide === 'UP').side, 'DOWN');
  assert.equal(open.find((position) => position.signalSide === 'DOWN').side, 'UP');
  assert.equal(
    open.find((position) => position.signalSide === 'UP').avgEntry,
    bot.liveQuotes.DOWN.bestAsk,
  );
  assert.equal(bot.orders.find((order) => order.signalSide === 'UP').side, 'DOWN');
  assert.ok(open.every((position) => position.shares === 20));
  assert.ok(open.every((position) => position.strategyVersion === 'DIP_REBOUND_REVERSED_V1'));
  assert.ok(open.every((position) => position.fees > 0));
  assert.deepEqual(bot.orders.map((order) => order.kind).sort(), ['BUY_DIP', 'BUY_DIP']);
  assert.ok(bot.orders.every((order) => order.side !== order.signalSide));
  assert.ok(bot.orders.every((order) => order.maxPrice === 0.85));
  assert.equal(bot.dipEntryCountBySide.UP, 1);
  assert.equal(bot.dipEntryCountBySide.DOWN, 1);
  assert.equal(bot.dipArmedBySide.UP, false);
  assert.equal(bot.dipArmedBySide.DOWN, false);
});

test.skip('retired per-side rearm behavior is not part of the dual-engine strategy', () => {
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
  setQuote(bot, 'DOWN', 0.49, 0.51, 500, NOW + 12_000);
  bot.recordDipQuote('UP', bot.liveQuotes.UP);
  assert.equal(bot.processDipStrategy(WINDOW_START, NOW + 12_000, 'UP'), true);
  assert.equal(bot.dipEntryCountBySide.UP, 2);
});

test.skip('retired 240-second exit is not part of the dual-engine strategy', () => {
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
  bot.applyTakeProfitExits(now);
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'TRADE_WINDOW_CUTOFF_EXIT');
  assert.equal(bot.orders[0].kind, 'SELL_TIME_CUTOFF');
  assert.equal(bot.orders[0].matchedShares, 20);
  assert.equal(bot.forecast.status, 'TRADE_WINDOW_CLOSED');
});

test.skip('retired side loss stop is not part of the dual-engine strategy', () => {
  const bot = makeBot();
  const position = {
    id: 'loss-up',
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
  setQuote(bot, 'UP', 0.14, 0.16, 100, NOW);

  bot.applyTakeProfitExits(NOW);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'MAX_SIDE_LOSS_STOP');
  assert.equal(bot.orders[0].kind, 'SELL_RISK_STOP');
  assert.equal(bot.orders[0].matchedShares, 20);
  assert.equal(bot.dipEntryCountBySide.DOWN, config.DIP_MAX_ENTRIES_PER_SIDE);
  assert.equal(bot.dipArmedBySide.DOWN, false);
});

test.skip('retired spike exit is not part of the dual-engine strategy', () => {
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

test.skip('retired dip-history sampling is not used by the dual-engine strategy', () => {
  const bot = makeBot();
  const quote = {
    status: 'LIVE',
    stale: false,
    updatedAt: NOW,
    mid: 0.50,
  };

  assert.equal(bot.recordDipQuote('UP', quote), true);
  quote.updatedAt = NOW + 25;
  quote.mid = 0.51;
  assert.equal(bot.recordDipQuote('UP', quote), false);
  assert.equal(bot.dipHistory.UP.length, 1);

  quote.updatedAt = NOW + config.DIP_SAMPLE_INTERVAL_MS;
  quote.mid = 0.52;
  assert.equal(bot.recordDipQuote('UP', quote), true);
  assert.equal(bot.dipHistory.UP.length, 2);
  assert.equal(bot.dipHistory.UP.at(-1).mid, 0.52);
});

test('reuses the current-window market instead of re-fetching Gamma every refresh interval', async () => {
  let marketRefreshCalls = 0;
  const bot = makeBot({
    marketData: {
      getBtcMarket: async () => {
        marketRefreshCalls += 1;
        throw new Error('Gamma request timed out');
      },
    },
  });
  bot.lastMarketAt = NOW - config.MARKET_REFRESH_MS * 10;

  await bot.tick();

  assert.equal(marketRefreshCalls, 0);
  assert.equal(bot.market.start, WINDOW_START);
  assert.equal(bot.status, 'scanning');
  assert.equal(bot.error, null);
});

test('fresh $0.99 best bid pays $1 per share and no stop-loss is applied', async () => {
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
  assert.equal(bot.events.find((event) => event.event === 'PAPER_DUAL_ENGINE_WINDOW_ENDED')
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

test('paper snapshot describes the current dual-engine strategy and inactive live modules', () => {
  const bot = makeBot();
  const state = bot.snapshot();
  assert.equal(state.strategy.name, 'BTC 5-minute dual-engine paper bot');
  assert.equal(state.strategy.signalMapping, 'Either entry trigger records both UP and DOWN paper legs as filled.');
  assert.deepEqual(state.strategy.markets, ['BTC 5m']);
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.liveTradingEnabled, false);
  assert.equal(state.strategy.realOrderModulesLoaded, false);
  assert.equal(state.strategy.orders.type, 'UP taker sweep and DOWN resting limit; either trigger records both paper fills');
  assert.match(state.strategy.repeatEntryRule, /50 shares/);
  assert.match(state.strategy.repeatEntryRule, /profit \/ \$0\.30/);
  assert.equal(state.strategy.upMaxSweepPrice, 0.99);
  assert.equal(state.strategy.entryShares, 50);
  assert.equal(state.strategy.downLimitPrice, 0.30);
  assert.equal(state.strategy.exits.takeProfit, true);
  assert.equal(state.strategy.exits.takeProfitTrigger, 0.99);
  assert.equal(state.strategy.exits.takeProfitPayout, 1);
  assert.equal(state.strategy.exits.stopLoss, false);
  assert.equal(state.strategy.exits.timedExitAtSeconds, null);
  assert.equal(state.strategy.signalState.status, 'WAITING_FOR_DATA');
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
  assert.equal(bot.forecast.status, 'WAITING_FOR_CLOB');
  assert.equal(bot.forecast.reason, 'Collecting fresh Polymarket quotes after restart.');

  assert.equal(Object.hasOwn(bot.snapshot(), 'shadowComparison'), false);

  const reloadedBot = makeBot();
  reloadedBot.restorePersistentState(bot.serializePersistentState());
  assert.equal(reloadedBot.positions[0].id, position.id);
  assert.equal(reloadedBot.cash, 9_952);
  assert.equal(Object.hasOwn(reloadedBot.serializePersistentState(), 'shadowPositions'), false);
});
