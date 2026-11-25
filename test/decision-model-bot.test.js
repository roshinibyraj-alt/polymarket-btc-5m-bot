'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MinuteColorBot = require('../minute-color-bot');

const START = 1_800_000_000_000;

function candle(minute, color, windowStart = START) {
  const open = 100;
  const close = color === 'GREEN' ? 101 : color === 'RED' ? 99 : 100;
  const start = windowStart + (minute - 1) * 60_000;
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

test('minute 1 compares against the previous window final candle and buys the inverse side', () => {
  const { bot, setCandles } = setup();
  setCandles([
    candle(5, 'GREEN', START - 300_000),
    candle(1, 'GREEN'),
  ]);
  bot.processClosedCandles(START + 60_100);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'DOWN');
  assert.equal(bot.orders[0].signalCandleNumber, 1);
  assert.equal(bot.snapshot().modelEngine.previousWindowCandle.color, 'GREEN');
  bot.stop();
});

test('a minute 1 color change is detected against the previous window and does not buy', () => {
  const { bot, setCandles } = setup();
  setCandles([
    candle(5, 'GREEN', START - 300_000),
    candle(1, 'RED'),
  ]);
  bot.processClosedCandles(START + 60_100);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.latestReview.candleNumber, 1);
  assert.equal(bot.latestReview.signalSide, null);
  assert.match(bot.latestReview.signalReason, /changed from GREEN to RED/);
  bot.stop();
});

test('two consecutive green candles buy DOWN and the next green candle adds once more', () => {
  const { bot, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.deepEqual(closedColors(bot), ['BUY_TAKER:DOWN']);
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.positions[0].shares, 200);

  setNow(START + 180_100);
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'GREEN')]);
  bot.processClosedCandles(START + 180_100);
  assert.deepEqual(closedColors(bot), ['BUY_TAKER:DOWN', 'BUY_TAKER:DOWN']);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 2);
  assert.equal(bot.positions.reduce((sum, position) => sum + position.shares, 0), 400);
  bot.stop();
});

test('a changed candle sells the prior inverse side without entering the new inverse side', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const down = bot.positions[0];
  assert.equal(down.side, 'DOWN');
  assert.equal(down.status, 'OPEN');

  setNow(START + 180_100);
  record.quotes.DOWN = { ...levels(0.60, 0.61), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);

  assert.equal(down.status, 'SIGNAL_SOLD');
  assert.deepEqual(closedColors(bot), ['SELL_TAKER:DOWN', 'BUY_TAKER:DOWN']);
  assert.equal(bot.orders.some((order) => order.action.startsWith('BUY') && order.side === 'UP'), false);
  assert.equal(down.exitReason, 'CANDLE_COLOR_FLIP');
  assert.equal(down.exitPrice, 0.60);
  bot.stop();
});

test('a color change holds the old position when a visible-book sale would lose money', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const down = bot.positions.find((position) => position.side === 'DOWN');

  setNow(START + 180_100);
  record.quotes.DOWN = { ...levels(0.30, 0.31), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);

  assert.equal(down.status, 'OPEN');
  assert.equal(down.shares, 200);
  assert.equal(bot.orders.some((order) => order.action === 'SELL_TAKER'), false);
  assert.match(bot.latestReview.signalReason, /would realize a loss after fees/);
  bot.stop();
});

test('new inverse side can enter on the next candle if its color continues', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);

  setNow(START + 180_100);
  record.quotes.DOWN = { ...levels(0.60, 0.61), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);
  assert.equal(bot.orders[0].action, 'SELL_TAKER');
  assert.equal(bot.orders[0].side, 'DOWN');

  setNow(START + 240_100);
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED'), candle(4, 'RED')]);
  bot.processClosedCandles(START + 240_100);
  assert.deepEqual(closedColors(bot), ['BUY_TAKER:UP', 'SELL_TAKER:DOWN', 'BUY_TAKER:DOWN']);
  assert.equal(bot.positions.some((position) => position.side === 'UP' && position.status === 'OPEN'), true);
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

test('the reversed green signal buys DOWN without a $0.50 entry cap', () => {
  const { bot, setCandles } = setup({ upAsk: 0.74 });
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const { bot: redBot, setCandles: setRedCandles } = setup({ upAsk: 0.74 });
  setRedCandles([candle(1, 'RED'), candle(2, 'RED')]);
  redBot.processClosedCandles(START + 120_100);
  assert.equal(redBot.orders[0].side, 'UP');
  assert.equal(redBot.orders[0].fillPrice, 0.74);
  bot.stop();
  redBot.stop();
});

test('visible depth controls partial inverse-side fills at any valid price', () => {
  const { bot, setCandles } = setup({ upAsk: 0.72, upAskSize: 75 });
  setCandles([candle(1, 'RED'), candle(2, 'RED')]);
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
  const downPosition = bot.positions.find((position) => position.side === 'DOWN');

  setNow(START + 180_100);
  record.quotes.DOWN = { ...levels(0.60, 0.61, 50), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);
  assert.equal(downPosition.shares, 150);
  assert.equal(downPosition.status, 'OPEN');

  setNow(START + 240_100);
  record.quotes.DOWN = { ...levels(0.58, 0.59), updatedAt: START + 240_100, receivedAt: START + 240_100 };
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED'), candle(4, 'RED')]);
  bot.processClosedCandles(START + 240_100);
  assert.equal(downPosition.status, 'SIGNAL_SOLD');
  assert.equal(downPosition.shares, 0);
  assert.equal(bot.orders.filter((order) => order.action === 'SELL_TAKER').length, 2);
  bot.stop();
});

test('a valid consecutive-color signal waits for a fresh CLOB quote', () => {
  const { bot, record, setNow, setCandles } = setup();
  record.quotes.DOWN.updatedAt -= 3_000;
  record.quotes.DOWN.receivedAt -= 3_000;
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.pendingSignals.length, 1);

  setNow(START + 120_600);
  bot.processClosedCandles(START + 120_600);
  assert.equal(bot.pendingSignals.length, 0);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'DOWN');
  bot.stop();
});

test('TP closes only without a loss and no stop-loss closes positions', () => {
  const { bot, record, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const down = bot.positions.find((position) => position.side === 'DOWN');
  const takeProfit = {
    ...levels(0.98, 1.00),
    mid: 0.99,
    updatedAt: START + 150_000,
    receivedAt: START + 150_000,
  };
  bot.checkTakeProfits(record, 'DOWN', takeProfit, START + 150_000);
  assert.equal(down.status, 'TAKE_PROFIT');
  assert.equal(down.exitPrice, 0.99);
  assert.equal(down.exitPayout, 1);

  const { bot: lossTpBot, record: lossTpRecord, setCandles: setLossTpCandles } = setup();
  setLossTpCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  lossTpBot.processClosedCandles(START + 120_100);
  const lossTpPosition = lossTpBot.positions.find((position) => position.side === 'DOWN');
  lossTpPosition.totalCost = 201;
  lossTpPosition.fees = 0;
  lossTpBot.checkTakeProfits(lossTpRecord, 'DOWN', takeProfit, START + 150_000);
  assert.equal(lossTpPosition.status, 'OPEN');

  const { bot: stopBot, record: stopRecord, setCandles: setStopCandles } = setup();
  setStopCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  stopBot.processClosedCandles(START + 120_100);
  const stoppedSide = stopBot.positions.find((position) => position.side === 'DOWN');
  stopBot.checkStopLosses(stopRecord, 'DOWN', {
    ...levels(0, 0),
    mid: 0,
    updatedAt: START + 150_000,
    receivedAt: START + 150_000,
  }, START + 150_000);
  assert.equal(stoppedSide.status, 'OPEN');
  assert.equal(stoppedSide.shares, 200);
  assert.equal(stopBot.orders.some((order) => order.action === 'SELL_TAKER'), false);
  bot.stop();
  stopBot.stop();
  lossTpBot.stop();
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
