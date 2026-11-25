'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MinuteColorBot = require('../minute-color-bot');

const START = 1_800_000_000_000;

function candle(minute, color) {
  const open = 100;
  const close = color === 'GREEN' ? 101 : color === 'RED' ? 99 : 100;
  const start = START + (minute - 1) * 60_000;
  return {
    start,
    closeAt: start + 59_999,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    closed: true,
    source: 'BINANCE_1M_WEBSOCKET',
  };
}

function levels(bid, ask, bidSize = 1_000, askSize = 1_000) {
  return {
    bestBid: bid,
    bestAsk: ask,
    mid: (bid + ask) / 2,
    updatedAt: START,
    receivedAt: START,
    bids: bid > 0 ? [{ price: bid, size: bidSize }] : [],
    asks: ask > 0 && ask < 1 ? [{ price: ask, size: askSize }] : [],
  };
}

function setup({ now = START + 120_100, upAsk = 0.45, downAsk = 0.45, upAskSize = 1_000 } = {}) {
  let clock = now;
  let feedState = {
    status: 'CONNECTED',
    historyStatus: 'READY',
    error: null,
    price: 101_000,
    tickAt: clock,
    lastMessageAt: clock,
    messageAgeMs: 0,
    currentCandle: null,
    closedCandles: [],
    candleCounts: { '1m': 0 },
    reconnectCount: 0,
  };
  const marketData = {
    getAssetMarket: async (asset, start, windowMs) => ({
      id: 'btc-five-minute-market',
      slug: 'btc-updown-5m-test',
      title: 'Bitcoin Up or Down · test',
      asset: asset.toUpperCase(),
      timeframe: '5m',
      start,
      end: start + windowMs,
      tokens: { UP: 'up-token', DOWN: 'down-token' },
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
    snapshot: () => ({ ...feedState, messageAgeMs: Math.max(0, clock - feedState.lastMessageAt) }),
  };
  const bot = new MinuteColorBot({
    marketData,
    binanceFeed,
    now: () => clock,
    initialCapital: 3_000,
  });
  bot.running = true;
  const record = bot.records.get('BTC:5m');
  record.targetStart = START;
  record.market = {
    id: 'btc-five-minute-market',
    slug: 'btc-updown-5m-test',
    title: 'Bitcoin Up or Down · test',
    asset: 'BTC',
    timeframe: '5m',
    start: START,
    end: START + 300_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    feesEnabled: true,
    feeSchedule: { rate: 0.07 },
  };
  record.marketStatus = 'OPEN';
  record.quotes.UP = { ...levels(0.43, upAsk, 1_000, upAskSize), updatedAt: clock, receivedAt: clock };
  record.quotes.DOWN = { ...levels(0.43, downAsk), updatedAt: clock, receivedAt: clock };
  bot.websocket.status = 'CONNECTED';

  return {
    bot,
    record,
    setNow(value) {
      clock = value;
      feedState = { ...feedState, tickAt: value, lastMessageAt: value };
      for (const side of ['UP', 'DOWN']) {
        record.quotes[side].updatedAt = value;
        record.quotes[side].receivedAt = value;
      }
    },
    setCandles(candles) {
      feedState = { ...feedState, closedCandles: candles, candleCounts: { '1m': candles.length } };
    },
  };
}

function closedColors(bot) {
  return bot.orders.map((order) => `${order.action}:${order.side}`);
}

test('minute 1 alone is reference-only', () => {
  const { bot, setCandles } = setup();
  setCandles([candle(1, 'GREEN')]);
  bot.processClosedCandles(START + 60_100);
  assert.equal(bot.orders.length, 0);
  bot.stop();
});

test('two consecutive green candles buy UP and the next green candle adds once more', () => {
  const { bot, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.deepEqual(closedColors(bot), ['BUY_TAKER:UP']);
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.positions[0].shares, 200);

  setNow(START + 180_100);
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'GREEN')]);
  bot.processClosedCandles(START + 180_100);
  assert.deepEqual(closedColors(bot), ['BUY_TAKER:UP', 'BUY_TAKER:UP']);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 2);
  assert.equal(bot.positions.reduce((sum, position) => sum + position.shares, 0), 400);
  bot.stop();
});

test('a changed candle sells the held side without buying the new side in that candle', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const up = bot.positions[0];
  assert.equal(up.status, 'OPEN');

  setNow(START + 180_100);
  record.quotes.UP = { ...levels(0.60, 0.61), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);

  assert.equal(up.status, 'SIGNAL_SOLD');
  assert.deepEqual(closedColors(bot), ['SELL_TAKER:UP', 'BUY_TAKER:UP']);
  assert.equal(bot.orders.some((order) => order.action.startsWith('BUY') && order.side === 'DOWN'), false);
  assert.equal(up.exitReason, 'CANDLE_COLOR_FLIP');
  assert.equal(up.exitPrice, 0.60);
  bot.stop();
});

test('new side can enter on the next candle if its color continues', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);

  setNow(START + 180_100);
  record.quotes.UP = { ...levels(0.60, 0.61), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);
  assert.equal(bot.orders[0].action, 'SELL_TAKER');
  assert.equal(bot.orders[0].side, 'UP');

  setNow(START + 240_100);
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED'), candle(4, 'RED')]);
  bot.processClosedCandles(START + 240_100);
  assert.deepEqual(closedColors(bot), ['BUY_TAKER:DOWN', 'SELL_TAKER:UP', 'BUY_TAKER:UP']);
  assert.equal(bot.positions.some((position) => position.side === 'DOWN' && position.status === 'OPEN'), true);
  bot.stop();
});

test('each eligible minute candle can enter, but the same candle cannot be processed twice', () => {
  const { bot, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  setNow(START + 180_100);
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'GREEN')]);
  bot.processClosedCandles(START + 180_100);
  setNow(START + 240_100);
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'GREEN'), candle(4, 'GREEN')]);
  bot.processClosedCandles(START + 240_100);
  assert.equal(bot.orders.filter((order) => order.action === 'BUY_TAKER').length, 3);
  assert.equal(bot.positions.reduce((sum, position) => sum + position.shares, 0), 600);
  bot.processClosedCandles(START + 241_100);
  assert.equal(bot.orders.filter((order) => order.action === 'BUY_TAKER').length, 3);
  bot.stop();
});

test('removing the entry cap allows buys above $0.50', () => {
  const { bot, setCandles } = setup({ upAsk: 0.74 });
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders[0].side, 'UP');
  assert.equal(bot.orders[0].fillPrice, 0.74);
  bot.stop();
});

test('visible depth controls partial buy fills at any valid price', () => {
  const { bot, setCandles } = setup({ upAsk: 0.72, upAskSize: 75 });
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.orders[0].filledShares, 75);
  assert.equal(bot.orders[0].status, 'PARTIALLY_FILLED');
  bot.stop();
});

test('a partial signal exit retries when a later candle continues the new color', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const upPosition = bot.positions.find((position) => position.side === 'UP');

  setNow(START + 180_100);
  record.quotes.UP = { ...levels(0.60, 0.61, 50), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);
  assert.equal(upPosition.shares, 150);
  assert.equal(upPosition.status, 'OPEN');

  setNow(START + 240_100);
  record.quotes.UP = { ...levels(0.58, 0.59), updatedAt: START + 240_100, receivedAt: START + 240_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED'), candle(4, 'RED')]);
  bot.processClosedCandles(START + 240_100);
  assert.equal(upPosition.status, 'SIGNAL_SOLD');
  assert.equal(upPosition.shares, 0);
  assert.equal(bot.orders.filter((order) => order.action === 'SELL_TAKER').length, 2);
  bot.stop();
});

test('a valid consecutive-color signal waits for a fresh CLOB quote', () => {
  const { bot, record, setNow, setCandles } = setup();
  record.quotes.UP.updatedAt -= 3_000;
  record.quotes.UP.receivedAt -= 3_000;
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.pendingSignals.length, 1);

  setNow(START + 120_600);
  bot.processClosedCandles(START + 120_600);
  assert.equal(bot.pendingSignals.length, 0);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'UP');
  bot.stop();
});

test('TP and SL retain their midpoint payout rules', () => {
  const { bot, record, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const up = bot.positions.find((position) => position.side === 'UP');
  const takeProfit = {
    ...levels(0.98, 1.00),
    mid: 0.99,
    updatedAt: START + 150_000,
    receivedAt: START + 150_000,
  };
  bot.checkTakeProfits(record, 'UP', takeProfit, START + 150_000);
  assert.equal(up.status, 'TAKE_PROFIT');
  assert.equal(up.exitPrice, 0.99);
  assert.equal(up.exitPayout, 1);

  const { bot: stopBot, record: stopRecord, setCandles: setStopCandles } = setup();
  setStopCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  stopBot.processClosedCandles(START + 120_100);
  const down = stopBot.positions.find((position) => position.side === 'UP');
  stopBot.checkStopLosses(stopRecord, 'UP', {
    ...levels(0, 0),
    mid: 0,
    updatedAt: START + 150_000,
    receivedAt: START + 150_000,
  }, START + 150_000);
  assert.equal(down.status, 'STOP_LOSS');
  assert.equal(down.exitPayout, 0);
  bot.stop();
  stopBot.stop();
});

test('ledger persists per-candle entry tracking and processed candles', () => {
  const { bot, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const ledger = bot.exportLedger();
  assert.equal(ledger.strategyId, MinuteColorBot.STRATEGY.id);
  assert.deepEqual(ledger.snapshot.modelEngine.entryTakenCandleKeys, [`${START}:${START + 60_000}`]);
  assert.equal(ledger.snapshot.positions[0].shares, 200);

  const restored = setup().bot;
  restored.restoreLedger(ledger);
  assert.deepEqual([...restored.entryTakenCandleKeys], [`${START}:${START + 60_000}`]);
  bot.stop();
  restored.stop();
});
