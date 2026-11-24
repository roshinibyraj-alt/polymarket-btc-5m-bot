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

function levels(bid, ask, size = 500) {
  return {
    bestBid: bid,
    bestAsk: ask,
    mid: (bid + ask) / 2,
    updatedAt: START,
    receivedAt: START,
    bids: [{ price: bid, size }],
    asks: [{ price: ask, size }],
  };
}

function setup({ now = START + 120_100, upAskSize = 500, downAskSize = 500 } = {}) {
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
  record.quotes.UP = { ...levels(0.54, 0.56, upAskSize), updatedAt: clock, receivedAt: clock };
  record.quotes.DOWN = { ...levels(0.43, 0.45, downAskSize), updatedAt: clock, receivedAt: clock };
  bot.websocket.status = 'CONNECTED';

  return {
    bot,
    record,
    setNow(value) {
      clock = value;
      feedState = { ...feedState, tickAt: value, lastMessageAt: value };
      record.quotes.UP.updatedAt = value;
      record.quotes.UP.receivedAt = value;
      record.quotes.DOWN.updatedAt = value;
      record.quotes.DOWN.receivedAt = value;
    },
    setCandles(candles) {
      feedState = { ...feedState, closedCandles: candles, candleCounts: { '1m': candles.length } };
    },
    feedState: () => feedState,
  };
}

test('one closed minute-1 reference candle alone never buys', () => {
  const { bot, setCandles } = setup();
  setCandles([candle(1, 'RED')]);
  bot.processClosedCandles(START + 60_100);
  assert.equal(bot.orders.length, 0);
  bot.stop();
});

test('same-color minute 2 does not trade; a color change buys 200 shares on the new color side', () => {
  const { bot, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].action, 'BUY_TAKER');
  assert.equal(bot.orders[0].side, 'UP');
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.orders[0].filledShares, 200);
  assert.equal(bot.positions[0].shares, 200);
  assert.equal(bot.latestReview.signalSide, 'UP');

  const duplicate = bot.orders.length;
  bot.processClosedCandles(START + 121_100);
  assert.equal(bot.orders.length, duplicate);
  bot.stop();
});

test('a color flip sells the existing side even at a loss and buys 200 on the new side', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const upPosition = bot.positions.find((position) => position.side === 'UP');
  assert.equal(upPosition.status, 'OPEN');

  setNow(START + 180_100);
  record.quotes.UP = { ...levels(0.40, 0.41), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  record.quotes.DOWN = { ...levels(0.43, 0.45), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'RED'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);

  assert.equal(upPosition.status, 'SIGNAL_SOLD');
  assert.ok(upPosition.realizedPnl < 0);
  assert.ok(bot.orders.some((order) => order.action === 'SELL_TAKER' && order.side === 'UP'));
  assert.ok(bot.orders.some((order) => order.action === 'BUY_TAKER' && order.side === 'DOWN'));
  assert.equal(bot.positions.find((position) => position.side === 'DOWN').shares, 200);
  assert.deepEqual(
    bot.latestReview.actions.map((action) => `${action.type}_${action.side}`).sort(),
    ['BUY_DOWN', 'SELL_UP'],
  );
  bot.stop();
});

test('buy sweep records only visible depth when fewer than 200 shares are available', () => {
  const { bot, setCandles } = setup({ upAskSize: 75 });
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.orders[0].filledShares, 75);
  assert.equal(bot.orders[0].status, 'PARTIALLY_FILLED');
  assert.equal(bot.positions[0].shares, 75);
  bot.stop();
});

test('a valid color-change signal waits briefly for a fresh CLOB quote instead of being lost immediately', () => {
  const { bot, record, setNow, setCandles } = setup();
  record.quotes.UP.updatedAt -= 3_000;
  record.quotes.UP.receivedAt -= 3_000;
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.pendingSignals.length, 1);
  assert.match(bot.latestReview.signalReason, /Waiting briefly/);

  setNow(START + 120_600);
  bot.processClosedCandles(START + 120_600);
  assert.equal(bot.pendingSignals.length, 0);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'UP');
  bot.stop();
});

test('a failed flip sale does not block the opposite-side buy', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  bot.sellPositions = () => { throw new Error('simulated sell error'); };

  setNow(START + 180_100);
  setCandles([candle(1, 'RED'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);
  assert.ok(bot.orders.some((order) => order.action === 'BUY_TAKER' && order.side === 'DOWN'));
  assert.ok(bot.events.some((event) => event.type === 'FLIP_SELL_FAILED'));
  bot.stop();
});

test('same-color and minute-5 closes do not add orders', () => {
  const { bot, setNow, setCandles } = setup();
  setCandles([candle(1, 'GREEN'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders.length, 0);

  setNow(START + 300_000);
  setCandles([
    candle(1, 'GREEN'), candle(2, 'GREEN'), candle(3, 'RED'),
    candle(4, 'RED'), candle(5, 'GREEN'),
  ]);
  bot.processClosedCandles(START + 299_999);
  assert.equal(bot.orders.length, 0);
  bot.stop();
});

test('ledger stores the new strategy and processed candles to prevent duplicate entries after restart', () => {
  const { bot, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const ledger = bot.exportLedger();
  assert.equal(ledger.strategyId, MinuteColorBot.STRATEGY.id);
  assert.equal(ledger.snapshot.strategy.id, MinuteColorBot.STRATEGY.id);
  assert.equal(ledger.snapshot.positions[0].shares, 200);

  const restored = setup().bot;
  restored.restoreLedger(ledger);
  restored.running = true;
  const restoredRecord = restored.records.get('BTC:5m');
  restoredRecord.targetStart = START;
  restoredRecord.market = { ...bot.records.get('BTC:5m').market };
  restoredRecord.marketStatus = 'OPEN';
  restored.binanceFeed.snapshot = () => ({
    status: 'CONNECTED',
    historyStatus: 'READY',
    messageAgeMs: 0,
    closedCandles: [candle(1, 'RED'), candle(2, 'GREEN')],
    candleCounts: { '1m': 2 },
  });
  restored.websocket.status = 'CONNECTED';
  restored.processClosedCandles(START + 120_200);
  assert.equal(restored.orders.filter((order) => order.action === 'BUY_TAKER').length, 1);
  bot.stop();
  restored.stop();
});
