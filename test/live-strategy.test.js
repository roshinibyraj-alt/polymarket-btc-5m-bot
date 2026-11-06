'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  quoteFromBook,
  evaluateWindow,
  windowStartFor,
  STRATEGY_TIMEFRAMES,
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

test('a fresh midpoint at or above $0.80 triggers the higher-priced qualifying side', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.83, 1_299_000), DOWN: quote(0.86, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.qualifyingSides, ['DOWN', 'UP']);
  assert.equal(result.selectedSide, 'DOWN');
  assert.equal(result.triggeringPrice, 0.86);
});

test('equal qualifying midpoints choose UP deterministically', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.84, 1_299_000), DOWN: quote(0.84, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.selectedSide, 'UP');
  assert.equal(result.selectionReason, 'HIGHEST_QUALIFYING_MIDPOINT');
});

test('midpoints below $0.80 do not qualify', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.79, 1_299_000), DOWN: quote(0.20, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'watching_for_trigger');
});

test('the strategy waits until 120 seconds after window start', () => {
  const result = evaluateWindow({
    now: 1_119_999,
    market: market(),
    quotes: { UP: quote(0.90, 1_119_999), DOWN: quote(0.10, 1_119_999) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'waiting_for_delay');
});

test('the 120-second delay boundary is inclusive and stale quotes are rejected', () => {
  const atBoundary = evaluateWindow({
    now: 1_120_000,
    market: market(),
    quotes: { UP: quote(0.80, 1_120_000), DOWN: quote(0.20, 1_120_000) },
    startedAt: 900_000,
  });
  const stale = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.80, 1_293_999), DOWN: quote(0.20, 1_293_999) },
    startedAt: 900_000,
  });
  assert.equal(atBoundary.eligible, true);
  assert.equal(stale.eligible, false);
  assert.equal(stale.status, 'waiting_for_fresh_quotes');
});

test('one fresh qualifying outcome triggers even if the other quote is stale', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.82, 1_299_000), DOWN: quote(0.85, 1_293_999) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.freshSides, ['UP']);
  assert.deepEqual(result.qualifyingSides, ['UP']);
  assert.equal(result.selectedSide, 'UP');
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

test('entry ladder uses the requested prices and sizes with existing take-profit mapping', () => {
  assert.deepEqual(ENTRY_RUNGS.map(rung => [rung.price, rung.takeProfitPrice, rung.shares]), [
    [0.40, 0.75, 10],
    [0.60, 0.85, 20],
  ]);
});

test('window start is aligned independently for 5m and 15m', () => {
  assert.equal(windowStartFor(601_000, '5m'), 600_000);
  assert.equal(windowStartFor(901_000, '15m'), 900_000);
  assert.deepEqual(STRATEGY_TIMEFRAMES, ['5m']);
});
