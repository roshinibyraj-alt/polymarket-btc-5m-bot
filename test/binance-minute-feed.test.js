'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceMinuteFeed = require('../binance-minute-feed');

test('Binance minute feed loads only closed candles for seeding and uses the kline WebSocket URL', async () => {
  const now = 1_800_000_120_000;
  const rows = [
    [1_800_000_000_000, '100', '102', '99', '101', '5', 1_800_000_059_999],
    [1_800_000_060_000, '101', '103', '100', '102', '6', 1_800_000_119_999],
    [1_800_000_120_000, '102', '104', '101', '103', '7', 1_800_000_179_999],
  ];
  const feed = new BinanceMinuteFeed({
    now: () => now,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('interval'), '1m');
      return { ok: true, json: async () => rows };
    },
  });
  await feed.refreshHistory();
  const snapshot = feed.snapshot();
  assert.equal(snapshot.historyStatus, 'READY');
  assert.equal(snapshot.closedCandles.length, 2);
  assert.equal(snapshot.currentCandle.start, 1_800_000_120_000);
  assert.equal(snapshot.currentCandle.closed, false);
  assert.match(BinanceMinuteFeed.STREAM_URL, /btcusdt@kline_1m$/);
});

test('closed WebSocket kline updates are deduplicated and exposed as one-minute candles', () => {
  let clock = 1_800_000_060_000;
  const feed = new BinanceMinuteFeed({ now: () => clock });
  feed.status = 'CONNECTED';
  const message = {
    E: clock,
    k: {
      s: 'BTCUSDT',
      i: '1m',
      t: 1_800_000_000_000,
      T: 1_800_000_059_999,
      o: '100',
      h: '102',
      l: '99',
      c: '101',
      x: true,
    },
  };
  feed.handleMessage(JSON.stringify(message));
  clock += 100;
  feed.handleMessage(JSON.stringify({ ...message, E: clock, k: { ...message.k, c: '101.5' } }));
  const snapshot = feed.snapshot();
  assert.equal(snapshot.closedCandles.length, 1);
  assert.equal(snapshot.closedCandles[0].close, 101.5);
  assert.equal(snapshot.status, 'CONNECTED');
  assert.equal(snapshot.messageAgeMs, 0);
});

test('other symbols, intervals, and invalid candles are ignored', () => {
  const feed = new BinanceMinuteFeed({ now: () => 1_800_000_000_000 });
  const base = {
    E: 1_800_000_000_000,
    k: { s: 'ETHUSDT', i: '1m', t: 1, T: 2, o: '1', h: '2', l: '1', c: '2', x: true },
  };
  feed.handleMessage(JSON.stringify(base));
  assert.equal(feed.closedCandles.length, 0);
});
