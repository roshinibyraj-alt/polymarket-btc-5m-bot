'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MinuteColorBot = require('../minute-color-bot');

const START = 1_800_000_000_000;
const INTERVAL = 60_000;

function candleAt(start, color) {
  const open = 100;
  const close = color === 'GREEN' ? 101 : color === 'RED' ? 99 : 100;
  return {
    start,
    closeAt: start + INTERVAL - 1,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    closed: true,
    source: 'BINANCE_1M_WEBSOCKET',
  };
}

function candle(minute, color) {
  return candleAt(START + (minute - 1) * INTERVAL, color);
}

function previousWindowCandle(color) {
  return candleAt(START - INTERVAL, color);
}

function levels(bid, ask, bidSize = 1_000, askSize = 1_000) {
  return {
    bestBid: bid,
    bestAsk: ask,
    mid: (bid + ask) / 2,
    updatedAt: START + 100,
    receivedAt: START + 100,
    bids: bid > 0 ? [{ price: bid, size: bidSize }] : [],
    asks: ask > 0 && ask < 1 ? [{ price: ask, size: askSize }] : [],
  };
}

function setup({
  now = START + 100,
  upAsk = 0.45,
  downAsk = 0.45,
  upAskSize = 1_000,
} = {}) {
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

function orderedByMinute(bot) {
  return [...bot.orders]
    .filter((order) => order.action === 'BUY_TAKER')
    .sort((a, b) => a.signalCandleNumber - b.signalCandleNumber);
}

test('minute 1 buys from the previous window final candle, regardless of the new candle color', () => {
  const { bot, setCandles } = setup();
  setCandles([previousWindowCandle('RED')]);
  bot.processClosedCandles(START + 100);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'UP');
  assert.equal(bot.orders[0].signalCandleNumber, 1);
  assert.equal(bot.orders[0].signalCandleStart, START);
  assert.equal(bot.orders[0].referenceColor, 'RED');
  bot.stop();
});

test('green previous candle buys DOWN at the next minute start', () => {
  const { bot, setNow, setCandles } = setup();
  setCandles([previousWindowCandle('GREEN')]);
  bot.processClosedCandles(START + 100);
  setNow(START + INTERVAL + 100);
  setCandles([previousWindowCandle('GREEN'), candle(1, 'RED')]);
  bot.processClosedCandles(START + INTERVAL + 100);
  assert.deepEqual(orderedByMinute(bot).map((order) => order.side), ['DOWN', 'UP']);
  assert.equal(orderedByMinute(bot)[1].referenceColor, 'RED');
  bot.stop();
});

test('every minute 1 through 5 gets one buy from the immediately previous closed candle', () => {
  const { bot, setNow, setCandles } = setup();
  const previous = previousWindowCandle('RED');
  const colors = ['GREEN', 'RED', 'GREEN', 'GREEN'];
  setCandles([previous]);
  bot.processClosedCandles(START + 100);

  for (let minute = 2; minute <= 5; minute += 1) {
    const now = START + (minute - 1) * INTERVAL + 100;
    setNow(now);
    setCandles([previous, ...colors.slice(0, minute - 1).map((color, index) => candle(index + 1, color))]);
    bot.processClosedCandles(now);
  }

  const orders = orderedByMinute(bot);
  assert.equal(orders.length, 5);
  assert.deepEqual(orders.map((order) => order.signalCandleNumber), [1, 2, 3, 4, 5]);
  assert.deepEqual(orders.map((order) => order.side), ['UP', 'DOWN', 'UP', 'DOWN', 'DOWN']);
  assert.ok(orders.every((order) => order.requestedShares === 200));

  const duplicateTime = START + 4 * INTERVAL + 200;
  setNow(duplicateTime);
  bot.processClosedCandles(duplicateTime);
  assert.equal(orderedByMinute(bot).length, 5);
  bot.stop();
});

test('opposite candle signals add on the new side without selling existing positions', () => {
  const { bot, setNow, setCandles } = setup();
  const previous = previousWindowCandle('GREEN');
  setCandles([previous]);
  bot.processClosedCandles(START + 100);
  const downPosition = bot.positions.find((position) => position.side === 'DOWN');

  const minuteTwo = START + INTERVAL + 100;
  setNow(minuteTwo);
  setCandles([previous, candle(1, 'RED')]);
  bot.processClosedCandles(minuteTwo);

  assert.equal(downPosition.status, 'OPEN');
  assert.equal(downPosition.shares, 200);
  assert.equal(bot.positions.some((position) => position.side === 'UP' && position.status === 'OPEN'), true);
  assert.equal(bot.orders.some((order) => order.action === 'SELL_TAKER'), false);
  bot.stop();
});

test('market buys have no $0.50 entry-price cap and sweep visible depth', () => {
  const { bot, setCandles } = setup({ upAsk: 0.74 });
  setCandles([previousWindowCandle('RED')]);
  bot.processClosedCandles(START + 100);
  assert.equal(bot.orders[0].side, 'UP');
  assert.equal(bot.orders[0].fillPrice, 0.74);
  bot.stop();
});

test('visible ask depth controls partial fills at the scheduled minute', () => {
  const { bot, setCandles } = setup({ upAsk: 0.72, upAskSize: 75 });
  setCandles([previousWindowCandle('RED')]);
  bot.processClosedCandles(START + 100);
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.orders[0].filledShares, 75);
  assert.equal(bot.orders[0].status, 'PARTIALLY_FILLED');
  bot.stop();
});

test('a minute signal waits for a fresh CLOB quote until the next minute starts', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([previousWindowCandle('GREEN')]);
  record.quotes.DOWN.updatedAt -= 3_000;
  record.quotes.DOWN.receivedAt -= 3_000;
  bot.processClosedCandles(START + 100);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.pendingSignals.length, 1);

  setNow(START + 600);
  bot.processClosedCandles(START + 600);
  assert.equal(bot.pendingSignals.length, 0);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'DOWN');
  bot.stop();
});

test('TP closes only without a loss and there is no signal stop-loss', () => {
  const { bot, record, setCandles } = setup();
  setCandles([previousWindowCandle('RED')]);
  bot.processClosedCandles(START + 100);
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

  const { bot: lossTpBot, record: lossTpRecord, setCandles: setLossTpCandles } = setup();
  setLossTpCandles([previousWindowCandle('RED')]);
  lossTpBot.processClosedCandles(START + 100);
  const lossTpPosition = lossTpBot.positions.find((position) => position.side === 'UP');
  lossTpPosition.totalCost = 201;
  lossTpPosition.fees = 0;
  lossTpBot.checkTakeProfits(lossTpRecord, 'UP', takeProfit, START + 150_000);
  assert.equal(lossTpPosition.status, 'OPEN');

  bot.checkStopLosses(record, 'UP', { ...levels(0, 0), mid: 0 }, START + 150_000);
  assert.equal(up.status, 'TAKE_PROFIT');
  assert.equal(bot.orders.some((order) => order.action === 'SELL_TAKER'), false);
  bot.stop();
  lossTpBot.stop();
});

test('ledger persists one-entry-per-minute tracking under the new strategy id', () => {
  const { bot, setCandles } = setup();
  setCandles([previousWindowCandle('RED')]);
  bot.processClosedCandles(START + 100);
  const ledger = bot.exportLedger();
  assert.equal(ledger.strategyId, MinuteColorBot.STRATEGY.id);
  assert.deepEqual(ledger.snapshot.modelEngine.entryTakenCandleKeys, [`${START}:${START}`]);
  assert.equal(ledger.snapshot.positions[0].shares, 200);

  const restored = setup().bot;
  restored.restoreLedger(ledger);
  assert.deepEqual([...restored.entryTakenCandleKeys], [`${START}:${START}`]);
  bot.stop();
  restored.stop();
});
