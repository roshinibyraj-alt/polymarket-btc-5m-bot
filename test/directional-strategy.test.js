'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const { previousCloseSample, computeTenSecondProjection } = require('../directional-strategy');

function syntheticSamples(openMs, baseline, initialMove, futureRate, throughMs = 170_000, stepMs = 500) {
  const samples = [{ price: baseline, sampledAt: openMs - 500 }];
  for (let elapsed = 0; elapsed <= throughMs; elapsed += stepMs) {
    const price = elapsed < 150_000
      ? baseline + initialMove * elapsed / 150_000
      : baseline + initialMove + futureRate * (elapsed - 150_000) / 10_000;
    samples.push({ price, sampledAt: openMs + elapsed });
  }
  return samples;
}

function project(samples, openMs, baseline = 85000, nowMs = openMs + 170_000) {
  return computeTenSecondProjection(samples, {
    baselinePrice: baseline,
    windowOpenMs: openMs,
    windowCloseMs: openMs + 300_000,
    nowMs,
    blockMs: cfg.STRATEGY_BLOCK_MS,
    initialBlocks: cfg.STRATEGY_INITIAL_BLOCKS,
    minSamplesPerBlock: cfg.STRATEGY_MIN_SAMPLES_PER_BLOCK,
    maxSampleGapMs: cfg.STRATEGY_MAX_SAMPLE_GAP_MS,
  });
}

test('captures the freshest BTC sample at or before the previous candle close', () => {
  assert.deepEqual(previousCloseSample([
    { price: 84998, sampledAt: 9500 },
    { price: 84999, sampledAt: 9900 },
    { price: 85001, sampledAt: 10000 },
  ], 10000, 500), { price: 85001, sampledAt: 10000, ageMs: 0 });
  assert.equal(previousCloseSample([{ price: 84900, sampledAt: 1000 }], 10000, 500), null);
});

test('uses 15 initial 10-second blocks and projects DOWN from a declining rolling 20-second trend', () => {
  const openMs = 100_000;
  const result = project(syntheticSamples(openMs, 85000, 10, -1), openMs);
  assert.equal(result.phase, 'projection_ready');
  assert.ok(Math.abs(result.initialDriftUsdPer10s - (10 / 15)) < 0.01);
  assert.ok(Math.abs(result.recentRateUsdPer10s - (-1)) < 0.02);
  assert.equal(result.side, 'DOWN');
  assert.ok(result.projectedClose < 85000);
  assert.equal(result.remainingSeconds, 130);
});

test('uses the exact opposite projection for UP', () => {
  const openMs = 100_000;
  const result = project(syntheticSamples(openMs, 85000, -10, 1), openMs);
  assert.equal(result.side, 'UP');
  assert.ok(result.projectedClose > 85000);
});

test('waits until two complete future blocks are available', () => {
  const openMs = 100_000;
  const samples = syntheticSamples(openMs, 85000, 10, -1, 169_500);
  const result = project(samples, openMs, 85000, openMs + 169_500);
  assert.equal(result.phase, 'waiting_for_20_second_trend');
  assert.equal(result.side, null);
});

test('does not choose a side when the projected close is exactly the baseline', () => {
  const openMs = 100_000;
  const result = project(syntheticSamples(openMs, 85000, 0, 0), openMs);
  assert.equal(result.phase, 'projected_at_baseline');
  assert.equal(result.projectedClose, 85000);
  assert.equal(result.side, null);
});

test('skips projection when any initial 10-second block has insufficient samples', () => {
  const openMs = 100_000;
  const samples = syntheticSamples(openMs, 85000, 10, -1).filter((sample) => {
    const elapsed = sample.sampledAt - openMs;
    return elapsed < 50_000 || elapsed >= 60_000;
  });
  const result = project(samples, openMs);
  assert.equal(result.phase, 'insufficient_initial_block_data');
  assert.equal(result.side, null);
});

test('strategy configuration matches 150 seconds of baseline and 20 seconds of rolling trend', () => {
  assert.equal(cfg.CCXT_EXCHANGE, 'coinbase');
  assert.equal(cfg.CCXT_POLL_MS, 500);
  assert.equal(cfg.LOOP_MS, 500);
  assert.equal(cfg.STRATEGY_BLOCK_MS, 10_000);
  assert.equal(cfg.STRATEGY_INITIAL_BLOCKS, 15);
  assert.equal(cfg.BTC_PROJECTION_WARMUP_SECONDS, 150);
  assert.equal(cfg.BTC_PROJECTION_TREND_SECONDS, 20);
  assert.equal(cfg.MAX_ENTRY_PRICE, 0.45);
  assert.equal(cfg.BASE_SHARES, 500);
  assert.equal(cfg.SHARES_INCREMENT_AFTER_LOSS, 200);
});
