'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceTickFeed = require('../binance-tick-feed');

function klineRows(now, intervalMs, closedCount) {
  const currentStart = Math.floor(now / intervalMs) * intervalMs;
  return Array.from({ length: closedCount + 1 }, (_, index) => {
    const start = currentStart - (closedCount - index) * intervalMs;
    const open = 60_000 + index * 10;
    return [
      start,
      String(open),
      String(open + 20),
      String(open - 20),
      String(open + 5),
      '100',
      start + intervalMs - 1,
    ];
  });
}

test('loads only the configured number of fully closed 5m, 15m, and 1h candles', async () => {
  const now = 1_800_000_100_000;
  const intervalMs = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 };
  const count = { '5m': 6, '15m': 4, '1h': 2 };
  const requested = [];
  const feed = new BinanceTickFeed({
    now: () => now,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const timeframe = parsed.searchParams.get('interval');
      requested.push({ timeframe, limit: parsed.searchParams.get('limit') });
      return {
        ok: true,
        json: async () => klineRows(now, intervalMs[timeframe], count[timeframe]),
      };
    },
  });

  await feed.refreshHistory();
  const snapshot = feed.snapshot();
  assert.equal(snapshot.historyStatus, 'READY');
  assert.deepEqual(snapshot.candleCounts, count);
  assert.deepEqual(requested.sort((a, b) => a.timeframe.localeCompare(b.timeframe)), [
    { timeframe: '15m', limit: '5' },
    { timeframe: '1h', limit: '3' },
    { timeframe: '5m', limit: '7' },
  ]);
  for (const candles of Object.values(snapshot.candleSets)) {
    assert.ok(candles.every((candle) => candle.closeAt < now));
  }
});

test('insufficient timeframe history does not report candle history ready', async () => {
  const now = 1_800_000_100_000;
  const feed = new BinanceTickFeed({
    now: () => now,
    fetchImpl: async (url) => {
      const timeframe = new URL(url).searchParams.get('interval');
      const intervalMs = timeframe === '5m' ? 300_000 : timeframe === '15m' ? 900_000 : 3_600_000;
      return {
        ok: true,
        json: async () => klineRows(now, intervalMs, timeframe === '15m' ? 3 : timeframe === '1h' ? 2 : 6),
      };
    },
  });
  await feed.refreshHistory();
  assert.equal(feed.historyStatus, 'WAITING');
  assert.equal(feed.snapshot().candleCounts['15m'], 3);
});

test('the decision-model feed keeps live price ticks but skips all buy/sell flow collection', () => {
  const feed = new BinanceTickFeed({
    now: () => 1_800_000_000_000,
    includeTradeFlow: false,
  });
  feed.handleMessage(JSON.stringify({
    e: 'aggTrade', p: '62000.5', q: '1000', m: false, T: 1_800_000_000_000,
  }));
  const snapshot = feed.snapshot();
  assert.equal(snapshot.price, 62_000.5);
  assert.equal(Object.hasOwn(snapshot, 'tradeFlow'), false);
  assert.equal(feed.recentTrades, null);
});
