'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const { computeOneSecondMove, sideForMove } = require('../directional-strategy');

test('computes a move from the closest sample to one second earlier', () => {
  const move = computeOneSecondMove([
    { price: 80000, receivedAt: 1000 },
    { price: 80004, receivedAt: 1500 },
    { price: 80011, receivedAt: 2000 },
  ], { lookbackMs: 1000, toleranceMs: 250 });
  assert.deepEqual(move, {
    fromPrice: 80000, toPrice: 80011, changeUsd: 11, lookbackMs: 1000, receivedAt: 2000,
  });
});

test('does not signal when no sample falls within the one-second tolerance', () => {
  assert.equal(computeOneSecondMove([
    { price: 80000, receivedAt: 1000 },
    { price: 80020, receivedAt: 1600 },
  ], { lookbackMs: 1000, toleranceMs: 250 }), null);
});

test('uses inclusive positive and negative $10 thresholds', () => {
  assert.equal(sideForMove(10, 10), 'UP');
  assert.equal(sideForMove(9.99, 10), null);
  assert.equal(sideForMove(-10, 10), 'DOWN');
  assert.equal(sideForMove(-9.99, 10), null);
});

test('the configured execution cadence and rule match the requested timing', () => {
  assert.equal(cfg.CCXT_EXCHANGE, 'coinbase');
  assert.equal(cfg.CCXT_POLL_MS, 500);
  assert.equal(cfg.LOOP_MS, 500);
  assert.equal(cfg.SIGNAL_LOOKBACK_MS, 1000);
  assert.equal(cfg.BTC_MOVE_THRESHOLD_USD, 10);
});