'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DecisionModelBot = require('../decision-model-bot');
const { sweep } = DecisionModelBot._test;

const START = 1_800_000_000_000;

function makeFeed(now, up = true) {
  return {
    status: 'CONNECTED',
    historyStatus: 'READY',
    error: null,
    price: up ? 101_000 : 99_000,
    tickAt: now,
    tickAgeMs: 100,
    currentCandle: {
      start: START,
      open: 100_000,
      high: 101_000,
      low: 99_000,
      close: up ? 101_000 : 99_000,
      openSource: 'BINANCE_KLINE',
    },
    candles: up
      ? [{ open: 99_000, close: 99_500 }, { open: 99_500, close: 100_000 }, { open: 100_000, close: 100_500 }]
      : [{ open: 101_000, close: 100_500 }, { open: 100_500, close: 100_000 }, { open: 100_000, close: 99_500 }],
    tradeFlow: { tradeCount: 25, buyCount: 17, sellCount: 8, imbalance: up ? 0.6 : -0.6 },
    reconnectCount: 0,
  };
}

function levels(bid, ask, size = 500) {
  return {
    bestBid: bid,
    bestAsk: ask,
    mid: (bid + ask) / 2,
    updatedAt: 1_800_000_000_000,
    receivedAt: 1_800_000_000_000,
    bids: [{ price: bid, size }],
    asks: [{ price: ask, size }],
  };
}

function makeBot({ now = START + 1_000, up = true } = {}) {
  let clock = now;
  let feedState = makeFeed(now, up);
  const marketData = {
    getAssetMarket: async (asset, start, windowMs) => ({
      id: 'btc-5m-market',
      slug: 'btc-updown-5m-test',
      title: 'Bitcoin Up or Down · test',
      asset: asset.toUpperCase(),
      timeframe: '5m',
      start,
      end: start + windowMs,
      tokens: { UP: 'btc-up-token', DOWN: 'btc-down-token' },
      feesEnabled: true,
      feeSchedule: { rate: 0.07 },
    }),
    connectMarketStream: () => ({ close() {} }),
    getMarket: async () => null,
    resolvedWinner: () => null,
  };
  const binanceFeed = {
    status: 'CONNECTED',
    start: async () => {},
    stop() {},
    snapshot: () => ({ ...feedState, tickAt: clock, tickAgeMs: 100 }),
  };
  const bot = new DecisionModelBot({
    marketData,
    binanceFeed,
    now: () => clock,
    initialCapital: 3000,
  });
  bot.running = true;
  const record = bot.records.get('BTC:5m');
  record.targetStart = START;
  record.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-test',
    title: 'Bitcoin Up or Down · test',
    asset: 'BTC',
    timeframe: '5m',
    start: START,
    end: START + 300_000,
    tokens: { UP: 'btc-up-token', DOWN: 'btc-down-token' },
    feesEnabled: true,
    feeSchedule: { rate: 0.07 },
  };
  record.marketStatus = 'OPEN';
  const updateQuotes = () => {
    record.quotes.UP = { ...levels(0.55, 0.56), updatedAt: clock, receivedAt: clock };
    record.quotes.DOWN = { ...levels(0.44, 0.45), updatedAt: clock, receivedAt: clock };
  };
  const updateSamples = (positive) => {
    bot.pressureSamples = Array.from({ length: 10 }, (_, index) => ({
      at: clock - (9 - index) * 1000,
      price: positive ? 100_000 + index * 100 : 100_000 - index * 100,
      score: positive ? 0.75 : -0.75,
      tradeCount: 15,
    }));
  };
  updateQuotes();
  updateSamples(up);

  return {
    bot,
    record,
    setNow(value) {
      clock = value;
      feedState = makeFeed(value, value === START + 1_000 || up);
      updateQuotes();
    },
    setFeed(value) {
      feedState = { ...value };
    },
    setPressure(positive) { updateSamples(positive); },
  };
}

test('only scans BTC 5-minute markets and keeps UP/DOWN independently', () => {
  const { bot } = makeBot();
  assert.deepEqual([...bot.records.keys()], ['BTC:5m']);
  const state = bot.snapshot();
  assert.deepEqual(state.scanner.assets, ['BTC']);
  assert.deepEqual(state.scanner.timeframes, ['5m']);
  assert.equal(state.strategy.execution, 'PAPER ONLY — no real orders or wallet signing.');
  bot.stop();
});

test('a qualifying 15-second review buys 50 shares and records all eight answers', () => {
  const { bot, record } = makeBot();
  bot.evaluateOnSchedule(START + 1_000);

  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].action, 'BUY_TAKER');
  assert.equal(bot.orders[0].requestedShares, 50);
  assert.equal(bot.orders[0].filledShares, 50);
  assert.equal(bot.positions[0].shares, 50);
  assert.equal(bot.positions[0].status, 'OPEN');
  assert.equal(bot.latestReview.actions[0].type, 'BUY');
  assert.equal(bot.latestReview.questions.buyUP.answer, 'YES');
  assert.equal(bot.latestReview.questions.avoidUP.answer, 'NO');
  assert.equal(bot.latestReview.questions.holdUP.answer, 'YES');
  assert.equal(bot.latestReview.questions.sellUP.answer, 'NO');
  assert.equal(Object.keys(bot.latestReview.questions).length, 8);
  assert.equal(record.triggeredSide, null, 'legacy one-side-only strategy stays disabled');
  bot.stop();
});

test('model review cadence prevents a second buy before 15 seconds', () => {
  const { bot, setNow, setPressure } = makeBot();
  bot.evaluateOnSchedule(START + 1_000);
  bot.evaluateOnSchedule(START + 10_000);
  assert.equal(bot.reviews.length, 1);
  setNow(START + 16_000);
  setPressure(true);
  bot.evaluateOnSchedule(START + 16_000);
  assert.equal(bot.reviews.length, 2);
  assert.equal(bot.orders.filter((order) => order.action === 'BUY_TAKER').length, 2);
  assert.equal(bot.positions.reduce((sum, position) => sum + position.shares, 0), 100);
  bot.stop();
});

test('a reversal review can sell UP while independently opening DOWN', () => {
  const { bot, record, setNow, setPressure, setFeed } = makeBot();
  bot.evaluateOnSchedule(START + 1_000);
  setNow(START + 16_000);
  setPressure(false);
  setFeed(makeFeed(START + 16_000, false));
  record.quotes.UP = { ...levels(0.79, 0.80), updatedAt: START + 16_000, receivedAt: START + 16_000 };
  record.quotes.DOWN = { ...levels(0.34, 0.35), updatedAt: START + 16_000, receivedAt: START + 16_000 };
  bot.evaluateOnSchedule(START + 16_000);

  assert.ok(bot.orders.some((order) => order.action === 'SELL_TAKER' && order.side === 'UP'));
  assert.ok(bot.orders.some((order) => order.action === 'BUY_TAKER' && order.side === 'DOWN'));
  assert.equal(bot.positions.find((position) => position.side === 'UP').status, 'MODEL_SOLD');
  assert.ok(bot.positions.find((position) => position.side === 'UP').realizedPnl > 0);
  assert.equal(bot.positions.find((position) => position.side === 'UP').exitPrice, 0.79);
  assert.equal(bot.positions.find((position) => position.side === 'DOWN').status, 'OPEN');
  assert.deepEqual(
    bot.latestReview.actions.map((action) => `${action.type}_${action.side}`).sort(),
    ['BUY_DOWN', 'SELL_UP'],
  );
  bot.stop();
});

test('a losing UP position stays open while a qualifying DOWN buy enters independently', () => {
  const { bot, record, setNow, setPressure, setFeed } = makeBot();
  bot.evaluateOnSchedule(START + 1_000);
  setNow(START + 16_000);
  setPressure(false);
  setFeed(makeFeed(START + 16_000, false));
  record.quotes.UP = { ...levels(0.45, 0.46), updatedAt: START + 16_000, receivedAt: START + 16_000 };
  record.quotes.DOWN = { ...levels(0.34, 0.35), updatedAt: START + 16_000, receivedAt: START + 16_000 };
  bot.evaluateOnSchedule(START + 16_000);

  assert.equal(bot.orders.some((order) => order.action === 'SELL_TAKER' && order.side === 'UP'), false);
  assert.ok(bot.orders.some((order) => order.action === 'BUY_TAKER' && order.side === 'DOWN'));
  assert.equal(bot.positions.find((position) => position.side === 'UP').status, 'OPEN');
  assert.equal(bot.positions.find((position) => position.side === 'DOWN').status, 'OPEN');
  assert.equal(bot.latestReview.questions.sellUP.answer, 'NO');
  assert.match(bot.latestReview.questions.sellUP.reason, /realize an estimated net loss/i);
  bot.stop();
});

test('partial model exits retain remaining shares and account for all fees through resolution', () => {
  const { bot, record } = makeBot();
  bot.evaluateOnSchedule(START + 1_000);
  const position = bot.positions.find((item) => item.side === 'UP');
  const entryCost = position.totalCost;
  const entryFees = position.fees;
  const sellResult = sweep([{ price: 0.79, size: 20 }], 50, 0.07, 'SELL');

  bot.sellPositions(record, 'UP', sellResult, START + 2_000, {
    feeRate: 0.07,
    feeSource: 'test',
    estimatedProbability: 0.1,
  }, -0.5);

  assert.equal(position.status, 'OPEN');
  assert.equal(position.shares, 30);
  assert.ok(position.partialRealizedPnl > 3);
  assert.ok(position.exitFees > 0);
  assert.ok(Math.abs(position.totalCost - entryCost * 0.6) < 1e-8);
  assert.ok(Math.abs(position.fees - entryFees * 0.6) < 1e-8);

  bot.expireMarket(record, START + 300_000);
  bot.settleMarket(position.marketId, 'UP', START + 301_000);
  assert.equal(position.status, 'RESOLVED_WIN');
  assert.ok(position.realizedPnl > 15);
  const completed = bot.snapshot().modelEngine.tradeHistory[0];
  assert.equal(completed.shares, 50);
  assert.equal(completed.entryPrice, 0.56);
  assert.ok(Math.abs(completed.exitPrice - 0.916) < 1e-8);
  assert.equal(completed.result, 'WIN');
  assert.ok(
    Math.abs(bot.accountSnapshot().totalFees - (entryFees + position.exitFees)) < 1e-4,
    `total ${bot.accountSnapshot().totalFees}; expected ${entryFees + position.exitFees}; exit ${position.exitFees}`,
  );
  bot.stop();
});

test('model strategy ledger round-trips without restoring old cross-pair strategy state', () => {
  const { bot } = makeBot();
  bot.evaluateOnSchedule(START + 1_000);
  const ledger = bot.exportLedger();
  assert.equal(ledger.strategyId, DecisionModelBot.STRATEGY.id);
  assert.equal(ledger.snapshot.strategy.id, DecisionModelBot.STRATEGY.id);
  assert.equal(ledger.snapshot.positions[0].shares, 50);

  const restored = makeBot().bot;
  restored.restoreLedger(ledger);
  assert.equal(restored.positions.length, 1);
  assert.equal(restored.positions[0].shares, 50);
  assert.equal(restored.reviews.length, 1);
  assert.equal(restored.lastDecisionAt, START + 1_000);
  bot.stop();
  restored.stop();
});
