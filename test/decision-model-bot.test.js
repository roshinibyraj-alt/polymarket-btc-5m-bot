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
  record.quotes.UP = { ...levels(0.43, 0.45, upAskSize), updatedAt: clock, receivedAt: clock };
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

test('only one buy is allowed and later opposite signals leave the position open', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const upPosition = bot.positions.find((position) => position.side === 'UP');
  assert.equal(upPosition.status, 'OPEN');

  setNow(START + 180_100);
  record.quotes.UP = { ...levels(0.60, 0.61), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  record.quotes.DOWN = { ...levels(0.43, 0.45), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'RED'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);

  assert.equal(upPosition.status, 'OPEN');
  assert.equal(bot.orders.length, 1);
  assert.match(bot.latestReview.signalReason, /one buy and the position is held to resolution/);
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

test('a valid color-change signal waits for a fresh CLOB quote instead of being lost immediately', () => {
  const { bot, record, setNow, setCandles } = setup();
  record.quotes.UP.updatedAt -= 3_000;
  record.quotes.UP.receivedAt -= 3_000;
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.pendingSignals.length, 1);
  assert.match(bot.latestReview.signalReason, /remains active until the next one-minute close/);

  setNow(START + 120_600);
  bot.processClosedCandles(START + 120_600);
  assert.equal(bot.pendingSignals.length, 0);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'UP');
  bot.stop();
});

test('a pending signal can enter if the ask drops below $0.50 before the next candle close', () => {
  const { bot, record, setNow, setCandles } = setup();
  record.quotes.UP = { ...levels(0.51, 0.52), updatedAt: START + 120_100, receivedAt: START + 120_100 };
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.pendingSignals.length, 1);

  setNow(START + 150_000);
  record.quotes.UP = { ...levels(0.48, 0.49), updatedAt: START + 150_000, receivedAt: START + 150_000 };
  bot.processClosedCandles(START + 150_000);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'UP');
  assert.equal(bot.pendingSignals.length, 0);
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

test('entry requires the signalled side best ask to be strictly below $0.50', () => {
  const atCap = setup();
  atCap.record.quotes.UP = {
    ...levels(0.49, 0.50),
    updatedAt: START + 120_100,
    receivedAt: START + 120_100,
  };
  atCap.setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  atCap.bot.processClosedCandles(START + 120_100);
  assert.equal(atCap.bot.orders.length, 0);
  assert.equal(atCap.bot.pendingSignals.length, 1);
  atCap.bot.stop();

  const belowCap = setup();
  belowCap.record.quotes.UP = {
    ...levels(0.47, 0.49),
    updatedAt: START + 120_100,
    receivedAt: START + 120_100,
  };
  belowCap.setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  belowCap.bot.processClosedCandles(START + 120_100);
  assert.equal(belowCap.bot.orders.length, 1);
  assert.equal(belowCap.bot.orders[0].side, 'UP');
  belowCap.bot.stop();
});

test('opposite signal is vetoed when held-side best bid is above $0.65', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const upPosition = bot.positions.find((position) => position.side === 'UP');
  assert.equal(upPosition.status, 'OPEN');

  setNow(START + 180_100);
  record.quotes.UP = { ...levels(0.66, 0.67), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  record.quotes.DOWN = { ...levels(0.43, 0.45), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'RED'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);

  assert.equal(upPosition.status, 'OPEN');
  assert.equal(bot.orders.length, 1);
  assert.ok(bot.events.some((event) => event.type === 'MINUTE_CANDLE_REVIEW' && /Opposite signal invalid/.test(event.message)));
  assert.match(bot.latestReview.signalReason, /held UP best bid is \$0\.660, above the \$0\.65 veto/);
  bot.stop();
});

test('a held-side best bid exactly at $0.65 does not trigger the veto, but one-entry hold remains', () => {
  const { bot, record, setNow, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);

  setNow(START + 180_100);
  record.quotes.UP = { ...levels(0.65, 0.66), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  record.quotes.DOWN = { ...levels(0.43, 0.45), updatedAt: START + 180_100, receivedAt: START + 180_100 };
  setCandles([candle(1, 'RED'), candle(2, 'GREEN'), candle(3, 'RED')]);
  bot.processClosedCandles(START + 180_100);
  assert.equal(bot.orders.length, 1);
  assert.match(bot.latestReview.signalReason, /one buy and the position is held to resolution/);
  bot.stop();
});

test('TP closes at a $0.99 midpoint and credits $1 per share', () => {
  const { bot, record, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const position = bot.positions.find((item) => item.side === 'UP');
  const quote = {
    ...levels(0.98, 1.00),
    mid: 0.99,
    updatedAt: START + 150_000,
    receivedAt: START + 150_000,
  };
  bot.checkTakeProfits(record, 'UP', quote, START + 150_000);
  assert.equal(position.status, 'TAKE_PROFIT');
  assert.equal(position.exitPrice, 0.99);
  assert.equal(position.exitPayout, 1);
  assert.equal(position.realizedPnl, 200 - position.totalCost - position.fees);
  const closed = bot.snapshot(START + 150_000).modelEngine.tradeHistory[0];
  assert.equal(closed.exitPrice, 0.99);
  assert.equal(closed.shares, 200);
  assert.equal(closed.realizedPnl, position.realizedPnl);
  bot.stop();
});

test('SL closes at a fresh $0.00 midpoint and credits zero payout', () => {
  const { bot, record, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const position = bot.positions.find((item) => item.side === 'UP');
  const quote = {
    ...levels(0, 0),
    mid: 0,
    updatedAt: START + 150_000,
    receivedAt: START + 150_000,
  };
  bot.checkStopLosses(record, 'UP', quote, START + 150_000);
  assert.equal(position.status, 'STOP_LOSS');
  assert.equal(position.exitPrice, 0);
  assert.equal(position.exitPayout, 0);
  assert.equal(position.realizedPnl, -position.totalCost - position.fees);
  bot.stop();
});

test('an unavailable midpoint does not trigger the zero stop', () => {
  const { bot, record, setCandles } = setup();
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  const position = bot.positions.find((item) => item.side === 'UP');
  const quote = { ...levels(0, 0.01), mid: null, updatedAt: START + 150_000, receivedAt: START + 150_000 };
  bot.checkStopLosses(record, 'UP', quote, START + 150_000);
  assert.equal(position.status, 'OPEN');
  bot.stop();
});

test('the 200-share sweep excludes ask levels at $0.50 and above', () => {
  const { bot, record, setCandles } = setup();
  record.quotes.UP = {
    ...levels(0.48, 0.49),
    asks: [{ price: 0.49, size: 100 }, { price: 0.50, size: 500 }],
    updatedAt: START + 120_100,
    receivedAt: START + 120_100,
  };
  setCandles([candle(1, 'RED'), candle(2, 'GREEN')]);
  bot.processClosedCandles(START + 120_100);
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.orders[0].filledShares, 100);
  assert.deepEqual(bot.orders[0].fills.map((fill) => fill.price), [0.49]);
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
  assert.deepEqual(ledger.snapshot.modelEngine.entryTakenWindowStarts, [START]);

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
