'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STRATEGY,
  candleSummary,
  directionalEstimate,
} = require('../model-decision-engine');
const { sweep } = require('../decision-model-bot')._test;

function candles(count, direction) {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index;
    return {
      open,
      close: direction === 'UP' ? open * 1.01 : direction === 'DOWN' ? open * 0.99 : open,
    };
  });
}

test('strategy uses the agreed 6/4/2 closed-candle lookbacks and 65/25/10 weights', () => {
  assert.deepEqual(STRATEGY.assets, ['BTC']);
  assert.deepEqual(STRATEGY.timeframes, ['5m']);
  assert.deepEqual(STRATEGY.candleLookbacks, { '5m': 6, '15m': 4, '1h': 2 });
  assert.deepEqual(STRATEGY.candleWeights, { '5m': 0.65, '15m': 0.25, '1h': 0.1 });
  assert.equal(STRATEGY.reviewIntervalMs, 15_000);
  assert.equal(STRATEGY.sharesPerBuyDecision, 50);
});

test('candle score uses only the requested most recent closed candles', () => {
  const recent = candleSummary(candles(8, 'UP'), 6, '5m');
  assert.equal(recent.count, 6);
  assert.equal(recent.required, 6);
  assert.equal(recent.bias, 'UP');
  assert.ok(recent.score > 0);
});

test('closed candles across all three timeframes determine UP or DOWN probability', () => {
  const up = directionalEstimate({
    candleSets: { '5m': candles(6, 'UP'), '15m': candles(4, 'UP'), '1h': candles(2, 'UP') },
  });
  const down = directionalEstimate({
    candleSets: { '5m': candles(6, 'DOWN'), '15m': candles(4, 'DOWN'), '1h': candles(2, 'DOWN') },
  });
  assert.equal(up.ready, true);
  assert.ok(up.probabilityUp > 0.75);
  assert.ok(up.probabilityDown < 0.25);
  assert.ok(down.probabilityDown > 0.75);
  assert.ok(down.probabilityUp < 0.25);
  assert.equal(up.components.length, 3);
});

test('missing timeframe history prevents a directional estimate', () => {
  const estimate = directionalEstimate({
    candleSets: { '5m': candles(6, 'UP'), '15m': candles(3, 'UP'), '1h': candles(2, 'UP') },
  });
  assert.equal(estimate.ready, false);
  assert.equal(estimate.probabilityUp, null);
  assert.equal(estimate.probabilityDown, null);
});

test('live ticks, order-flow samples, and Polymarket midpoints cannot change the candle estimate', () => {
  const candleSets = { '5m': candles(6, 'UP'), '15m': candles(4, 'DOWN'), '1h': candles(2, 'UP') };
  const first = directionalEstimate({ candleSets, price: 1, upMid: 0.99, downMid: 0.01 });
  const second = directionalEstimate({
    candleSets,
    price: 999_999,
    upMid: 0.01,
    downMid: 0.99,
    pressureSamples: Array(10).fill({ score: -1 }),
  });
  assert.equal(first.probabilityUp, second.probabilityUp);
  assert.deepEqual(first.components.map((component) => component.timeframe), ['5m', '15m', '1h']);
});

test('taker sweep accounts for per-level fees and does not invent missing depth', () => {
  const buy = sweep([
    { price: 0.4, size: 3 },
    { price: 0.5, size: 2 },
  ], 5, 0.07, 'BUY', 0.99);
  assert.equal(buy.complete, true);
  assert.equal(buy.filledShares, 5);
  assert.equal(buy.notional, 2.2);
  assert.ok(Math.abs(buy.fees - (3 * 0.07 * 0.4 * 0.6 + 2 * 0.07 * 0.5 * 0.5)) < 1e-9);
  const shallow = sweep([{ price: 0.4, size: 3 }], 5, 0.07, 'BUY', 0.99);
  assert.equal(shallow.complete, false);
  assert.equal(shallow.filledShares, 3);
  assert.equal(shallow.remainingShares, 2);
});
