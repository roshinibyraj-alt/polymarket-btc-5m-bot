'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STRATEGY,
  pressureSummary,
  directionalEstimate,
} = require('../model-decision-engine');
const { sweep } = require('../decision-model-bot')._test;

test('strategy uses BTC five-minute reviews and adds 50 shares per qualifying buy decision', () => {
  assert.deepEqual(STRATEGY.assets, ['BTC']);
  assert.deepEqual(STRATEGY.timeframes, ['5m']);
  assert.equal(STRATEGY.reviewIntervalMs, 15_000);
  assert.equal(STRATEGY.sharesPerBuyDecision, 50);
});

test('pressure summary scores recent direction, persistence, and acceleration', () => {
  const positive = pressureSummary([0.1, 0.2, 0.3, 0.4, 0.8].map((score, index) => ({ score, at: index })));
  const negative = pressureSummary([-0.1, -0.2, -0.3, -0.4, -0.8].map((score, index) => ({ score, at: index })));
  assert.ok(positive.score > 0);
  assert.ok(negative.score < 0);
  assert.equal(positive.count, 5);
});

test('direction estimate combines BTC move, pressure, candles, and market midpoints', () => {
  const start = 1_800_000_000_000;
  const candles = [
    { open: 100, close: 101 },
    { open: 101, close: 102 },
    { open: 102, close: 103 },
  ];
  const samples = Array.from({ length: 10 }, (_, index) => ({
    at: start + index * 1000,
    score: 0.8,
    price: 103 + index * 0.05,
  }));
  const estimate = directionalEstimate({
    price: 104,
    windowOpen: 100,
    secondsRemaining: 120,
    candles,
    pressureSamples: samples,
    upMid: 0.65,
    downMid: 0.34,
  });
  assert.ok(estimate.probabilityUp > 0.75);
  assert.ok(estimate.probabilityDown < 0.25);
  assert.equal(estimate.components.length, 5);
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
