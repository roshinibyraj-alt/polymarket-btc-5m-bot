'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const strategy = require('../strategy');

test('strategy uses fixed 500-share entries at 30 cents and TP at 70 cents', () => {
  assert.equal(cfg.DEMO_CAPITAL, 10000);
  assert.equal(cfg.BASE_SHARES, 500);
  assert.equal(cfg.ENTRY_LIMIT_PRICE, 0.30);
  assert.equal(cfg.TAKE_PROFIT_PRICE, 0.70);
  assert.equal(Object.hasOwn(cfg, 'STOP_LOSS_PRICE'), false);
  assert.equal(Object.hasOwn(cfg, 'SHARE_STEP'), false);
});

test('buy limit touch requires an executable best ask at or below the limit', () => {
  assert.equal(strategy.buyLimitTouched(0.30, cfg.ENTRY_LIMIT_PRICE), true);
  assert.equal(strategy.buyLimitTouched(0.27, cfg.ENTRY_LIMIT_PRICE), true);
  assert.equal(strategy.buyLimitTouched(0.301, cfg.ENTRY_LIMIT_PRICE), false);
  assert.equal(strategy.buyLimitTouched(null, cfg.ENTRY_LIMIT_PRICE), false);
});

test('take-profit touch requires an executable best bid at or above the limit', () => {
  assert.equal(strategy.takeProfitTouched(0.70, cfg.TAKE_PROFIT_PRICE), true);
  assert.equal(strategy.takeProfitTouched(0.75, cfg.TAKE_PROFIT_PRICE), true);
  assert.equal(strategy.takeProfitTouched(0.699, cfg.TAKE_PROFIT_PRICE), false);
  assert.equal(strategy.takeProfitTouched(null, cfg.TAKE_PROFIT_PRICE), false);
});

test('maker fills have zero maker fee and receive a fee-curve rebate estimate', () => {
  assert.equal(cfg.MAKER_FEE_RATE, 0);
  assert.equal(cfg.CRYPTO_TAKER_FEE_RATE, 0.07);
  assert.equal(cfg.CRYPTO_MAKER_REBATE_POOL_SHARE, 0.20);
  assert.equal(strategy.estimateMakerRebate(500, 0.30), 1.47);
  assert.equal(strategy.estimateMakerRebate(500, 0.70), 1.47);
  assert.equal(strategy.estimateMakerRebate(500, 1), 0);
  assert.equal(strategy.estimateMakerRebate(0, 0.30), 0);
});