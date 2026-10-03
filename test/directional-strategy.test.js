'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const { candleColor, matchMinutePattern } = require('../directional-strategy');

test('candle colors use close versus open and treat dojis as neutral', () => {
  assert.equal(candleColor(100, 101), 'G');
  assert.equal(candleColor(101, 100), 'R');
  assert.equal(candleColor(100, 100), 'N');
  assert.equal(candleColor(null, 100), 'N');
});

test('entry patterns are exact and map only to their specified side', () => {
  assert.deepEqual(matchMinutePattern('RG'), { action: 'BUY', side: 'UP', pattern: 'RG', sequence: 'RG' });
  assert.deepEqual(matchMinutePattern('RRG'), { action: 'BUY', side: 'UP', pattern: 'RRG', sequence: 'RRG' });
  assert.deepEqual(matchMinutePattern('GR'), { action: 'BUY', side: 'DOWN', pattern: 'GR', sequence: 'GR' });
  assert.deepEqual(matchMinutePattern('GGR'), { action: 'BUY', side: 'DOWN', pattern: 'GGR', sequence: 'GGR' });
});

test('RR alone and unrelated sequences never trigger an entry', () => {
  assert.equal(matchMinutePattern('RR').action, 'WAIT');
  assert.equal(matchMinutePattern('GG').action, 'WAIT');
  assert.equal(matchMinutePattern('RNG').action, 'WAIT');
});

test('exit patterns only signal SELL for their matching side', () => {
  assert.deepEqual(matchMinutePattern('RGR'), { action: 'SELL', side: 'UP', pattern: 'RGR', sequence: 'RGR' });
  assert.deepEqual(matchMinutePattern('RRGR'), { action: 'SELL', side: 'UP', pattern: 'RRGR', sequence: 'RRGR' });
  assert.deepEqual(matchMinutePattern('GRG'), { action: 'SELL', side: 'DOWN', pattern: 'GRG', sequence: 'GRG' });
  assert.deepEqual(matchMinutePattern('GGRG'), { action: 'SELL', side: 'DOWN', pattern: 'GGRG', sequence: 'GGRG' });
});

test('strategy config is aligned to one-minute BTC candles and fixed sizing', () => {
  assert.equal(cfg.CCXT_EXCHANGE, 'coinbase');
  assert.equal(cfg.CCXT_POLL_MS, 500);
  assert.equal(cfg.LOOP_MS, 500);
  assert.equal(cfg.STRATEGY_MINUTE_MS, 60_000);
  assert.equal(cfg.STRATEGY_MIN_CANDLE_SAMPLES, 2);
  assert.equal(cfg.BASE_SHARES, 500);
  assert.equal('STRATEGY_BLOCK_MS' in cfg, false);
  assert.equal('BTC_PROJECTION_WARMUP_SECONDS' in cfg, false);
  assert.equal('MIN_ENTRY_PRICE' in cfg, false);
  assert.equal('MAX_ENTRY_PRICE' in cfg, false);
});