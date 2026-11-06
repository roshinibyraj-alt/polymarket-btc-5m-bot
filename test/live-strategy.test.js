'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  quoteFromBook,
  evaluateWindow: evaluateWindowRaw,
  previousCandleFilter,
  evaluateSourceExit,
  resolvedMarketPayout,
  windowStartFor,
  STRATEGY_TIMEFRAMES,
  ENTRY_RUNGS,
  ENTRY_TRIGGER_MIDPOINT,
  WINDOW_OPEN_CANDLE_ENTRY,
  STRATEGY_VERSION,
} = require('../live-strategy');

function evaluateWindow(options = {}) {
  return evaluateWindowRaw({
    candleFilter: { status: 'ready', color: 'DOJI', allowedSide: null },
    ...options,
  });
}

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

test('a fresh midpoint at or above $0.70 triggers the higher-priced qualifying side', () => {
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

test('midpoints below $0.70 do not qualify', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.69, 1_299_000), DOWN: quote(0.20, 1_299_000) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'watching_for_trigger');
});

test('the midpoint trigger is active from the moment the window opens', () => {
  const result = evaluateWindow({
    now: 1_000_000,
    market: market(),
    quotes: { UP: quote(0.90, 1_000_000), DOWN: quote(0.10, 1_000_000) },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.elapsedMs, 0);
  assert.equal(result.selectedSide, 'UP');
});

test('the $0.70 trigger threshold is inclusive and stale quotes are rejected', () => {
  const atBoundary = evaluateWindow({
    now: 1_120_000,
    market: market(),
    quotes: { UP: quote(0.70, 1_120_000), DOWN: quote(0.20, 1_120_000) },
    startedAt: 900_000,
  });
  const stale = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.70, 1_293_999), DOWN: quote(0.20, 1_293_999) },
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

test('a green previous candle permits only UP even when DOWN has the higher midpoint', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.82, 1_299_000), DOWN: quote(0.91, 1_299_000) },
    candleFilter: { status: 'ready', color: 'GREEN', allowedSide: 'UP' },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.selectedSide, 'UP');
  assert.equal(result.selectionReason, 'PREVIOUS_CANDLE_DIRECTION');
});

test('a red previous candle blocks a qualifying UP trigger until DOWN qualifies', () => {
  const blocked = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.90, 1_299_000), DOWN: quote(0.20, 1_299_000) },
    candleFilter: { status: 'ready', color: 'RED', allowedSide: 'DOWN' },
    startedAt: 900_000,
  });
  const allowed = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.20, 1_299_000), DOWN: quote(0.82, 1_299_000) },
    candleFilter: { status: 'ready', color: 'RED', allowedSide: 'DOWN' },
    startedAt: 900_000,
  });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.status, 'waiting_for_candle_side_trigger');
  assert.equal(allowed.eligible, true);
  assert.equal(allowed.selectedSide, 'DOWN');
});

test('missing previous candle data fails closed instead of bypassing the direction filter', () => {
  const result = evaluateWindow({
    now: 1_299_000,
    market: market(),
    quotes: { UP: quote(0.90, 1_299_000), DOWN: quote(0.20, 1_299_000) },
    candleFilter: { status: 'unavailable', reason: 'Waiting for closed bars' },
    startedAt: 900_000,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'waiting_for_previous_candle');
});

test('previousCandleFilter aggregates only the immediately previous five complete minute bars', () => {
  const windowStart = 1_200_000;
  const bars = Array.from({ length: 5 }, (_, index) => ({
    t: windowStart - 300_000 + index * 60_000,
    o: 100 + index,
    h: 102 + index,
    l: 99 + index,
    c: 101 + index,
  }));
  const green = previousCandleFilter(bars, windowStart);
  assert.equal(green.status, 'ready');
  assert.equal(green.color, 'GREEN');
  assert.equal(green.allowedSide, 'UP');
  assert.equal(green.previous.start, 900_000);
  assert.equal(green.previous.end, windowStart);

  const incomplete = previousCandleFilter(bars.slice(1), windowStart);
  assert.equal(incomplete.status, 'unavailable');
  assert.equal(incomplete.allowedSide, null);
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

test('entry ladder and candle-only opening rung use their requested prices and sizes', () => {
  assert.equal(ENTRY_TRIGGER_MIDPOINT, 0.70);
  assert.equal(STRATEGY_VERSION, 'btc-candle-open-midpoint-trigger-ladder-v4');
  assert.deepEqual(WINDOW_OPEN_CANDLE_ENTRY, { price: 0.30, shares: 10 });
  assert.deepEqual(ENTRY_RUNGS.map(rung => [rung.price, rung.shares]), [
    [0.40, 10],
    [0.45, 20],
  ]);
});

test('source TP and SL exit signals are disabled', () => {
  assert.equal(evaluateSourceExit({
    now: 250_000,
    windowStart: 0,
    windowEnd: 300_000,
    filledAt: 249_000,
    quote: { status: 'LIVE', bestBid: 0.99, updatedAt: 250_000, stale: false },
  }), null);
  assert.equal(evaluateSourceExit({
    now: 295_000,
    windowStart: 0,
    windowEnd: 300_000,
    filledAt: 1_000,
    quote: { status: 'LIVE', bestBid: 0.01, updatedAt: 295_000, stale: false },
  }), null);
});

test('confirmed original-market resolution maps the exact token payout', () => {
  const market = {
    id: 'original-market',
    closed: true,
    umaResolutionStatus: 'resolved',
    outcomes: '["Up","Down"]',
    positionIds: '["up-token","down-token"]',
    outcomePrices: '["1","0"]',
  };
  assert.equal(resolvedMarketPayout(market, {
    marketId: 'original-market', tokenId: 'up-token', outcome: 'UP',
  }), 1);
  assert.equal(resolvedMarketPayout(market, {
    marketId: 'original-market', tokenId: 'down-token', outcome: 'DOWN',
  }), 0);
  assert.equal(resolvedMarketPayout(market, {
    marketId: 'next-market', tokenId: 'up-token', outcome: 'UP',
  }), null);
});

test('window start is aligned independently for 5m and 15m', () => {
  assert.equal(windowStartFor(601_000, '5m'), 600_000);
  assert.equal(windowStartFor(901_000, '15m'), 900_000);
  assert.deepEqual(STRATEGY_TIMEFRAMES, ['5m']);
});
