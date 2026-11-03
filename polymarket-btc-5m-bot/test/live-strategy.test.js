'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  quoteFromBook,
  evaluateWindow,
  windowStartFor,
  ENTRY_RUNGS,
} = require('../live-strategy');

function market(start = 1_000_000, duration = 300_000) {
  return { start, end: start + duration };
}

function quote(mid, updatedAt, status = 'LIVE') {
  return {
    status,
    bestBid: mid - 0.01,
    bestAsk: mid + 0.01,
    updatedAt,
    stale: false,
  };
}

test('either outcome midpoint inside the band qualifies the window', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.74, 1_299_000), DOWN: quote(0.30, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.qualifyingSides, ['DOWN']);
});

test('both midpoints outside the inclusive band do not qualify', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.80, 1_299_000), DOWN: quote(0.20, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'outside_midpoint_band');
});

test('the midpoint band includes both endpoints', () => {
  const low = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.30, 1_299_000), DOWN: quote(0.80, 1_299_000) },
    startedAt: 900_000,
  });
  const high = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.71, 1_299_000), DOWN: quote(0.80, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(low.eligible, true);
  assert.equal(high.eligible, true);
});

test('the trigger only runs during the final 60 seconds', () => {
  const result = evaluateWindow({
    now: 1_238_999,
    market: market(),
    quotes: { UP: quote(0.50, 1_238_999), DOWN: quote(0.50, 1_238_999) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'watching');
});

test('the final-minute boundary is inclusive and quotes older than five seconds are rejected', () => {
  const atBoundary = evaluateWindow({
    now: 1_240_000,
    market: market(),
    quotes: { UP: quote(0.50, 1_240_000), DOWN: quote(0.50, 1_240_000) },
    startedAt: 900_000,
  });
  const stale = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.50, 1_293_999), DOWN: quote(0.50, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(atBoundary.eligible, true);
  assert.equal(stale.eligible, false);
  assert.equal(stale.status, 'waiting_for_fresh_quotes');
});

test('windows that began before process startup are skipped after restart', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.50, 1_299_000), DOWN: quote(0.50, 1_299_000) },
    startedAt: 1_100_000,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'skipped_restart_window');
});

test('book quotes use the best prices and keep the timestamp', () => {
  const result = quoteFromBook({
    bids: [{ price: '0.31', size: '2' }, { price: '0.34', size: '3' }],
    asks: [{ price: '0.39', size: '4' }, { price: '0.36', size: '1' }],
  }, 123);
  assert.equal(result.bestBid, 0.34);
  assert.equal(result.bestAsk, 0.36);
  assert.equal(result.mid, 0.35);
  assert.equal(result.updatedAt, 123);
});

test('entry ladder maps 25-cent buys to 75-cent TP and 15-cent buys to 85-cent TP', () => {
  assert.deepEqual(ENTRY_RUNGS.map(rung => [rung.price, rung.takeProfitPrice, rung.shares]), [
    [0.25, 0.75, 10],
    [0.15, 0.85, 10],
  ]);
});

test('window start is aligned independently for 5m and 15m', () => {
  assert.equal(windowStartFor(601_000, '5m'), 600_000);
  assert.equal(windowStartFor(901_000, '15m'), 900_000);
});
