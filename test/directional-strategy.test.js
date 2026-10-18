'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const { candleColor, calculateAtr, createRetestState, updateRetestState } = require('../directional-strategy');

test('candle colors use close versus open and treat dojis as neutral', () => {
  assert.equal(candleColor(100, 101), 'G');
  assert.equal(candleColor(101, 100), 'R');
  assert.equal(candleColor(100, 100), 'N');
  assert.equal(candleColor(null, 100), 'N');
});

test('ATR needs completed history and uses true range across gaps', () => {
  const bars = Array.from({ length: 15 }, (_, i) => ({
    high: 101, low: 99, close: i === 0 ? 100 : 102,
  }));
  bars[1] = { high: 105, low: 101, close: 103 };
  assert.ok(Math.abs(calculateAtr(bars, 14) - 3.2142857142857144) < 1e-9);
  assert.equal(calculateAtr(bars.slice(1), 14), null);
});

test('a below-reference volatility excursion followed by a retest buys UP', () => {
  const state = createRetestState(80000, 20, 0.5);
  assert.equal(updateRetestState(state, 79990.01).action, 'WAIT');
  assert.equal(state.phase, 'WAITING_FOR_MOVE');
  assert.equal(updateRetestState(state, 79989.99).action, 'WAIT');
  assert.equal(state.phase, 'WAITING_FOR_RETEST');
  assert.equal(updateRetestState(state, 80000).side, 'UP');
  assert.equal(updateRetestState(state, 80001).side, 'UP');
});

test('an above-reference volatility excursion followed by a retest buys DOWN', () => {
  const state = createRetestState(80000, 20, 0.5);
  updateRetestState(state, 80010);
  assert.equal(updateRetestState(state, 80010.01).action, 'WAIT');
  assert.equal(updateRetestState(state, 80000).side, 'DOWN');
});

test('ATR/retest is disabled until both a valid reference and ATR are available', () => {
  for (const state of [createRetestState(null, 20), createRetestState(80000, null)]) {
    assert.equal(updateRetestState(state, 81000).action, 'WAIT');
    assert.equal(state.phase, 'WAITING_FOR_ATR_OR_REFERENCE');
  }
});

test('strategy config is aligned to one-minute BTC candles and fixed sizing', () => {
  assert.equal(cfg.CCXT_EXCHANGE, 'coinbase');
  assert.equal(cfg.CCXT_POLL_MS, 500);
  assert.equal(cfg.LOOP_MS, 500);
  assert.equal(cfg.STRATEGY_MINUTE_MS, 60_000);
  assert.equal(cfg.STRATEGY_MIN_CANDLE_SAMPLES, 2);
  assert.equal(cfg.RETEST_ATR_PERIOD, 14);
  assert.equal(cfg.RETEST_ATR_MULTIPLIER, 0.5);
  assert.equal(cfg.BASE_SHARES, 500);
  assert.equal('STRATEGY_BLOCK_MS' in cfg, false);
  assert.equal('BTC_PROJECTION_WARMUP_SECONDS' in cfg, false);
  assert.equal('MIN_ENTRY_PRICE' in cfg, false);
  assert.equal('MAX_ENTRY_PRICE' in cfg, false);
});