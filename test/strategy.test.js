'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const strategy = require('../strategy');

test('strategy uses four 500-share paired entry rungs and a second-fill TP at 99 cents', () => {
  assert.equal(cfg.DEMO_CAPITAL, 10000);
  assert.equal(cfg.BASE_SHARES, 500);
  assert.deepEqual(cfg.ENTRY_RUNGS, [
    { entryPrice: 0.45, takeProfitPrice: 0.55 },
    { entryPrice: 0.40, takeProfitPrice: 0.60 },
    { entryPrice: 0.35, takeProfitPrice: 0.65 },
    { entryPrice: 0.30, takeProfitPrice: 0.70 },
  ]);
  assert.equal(cfg.SECOND_FILL_TAKE_PROFIT_PRICE, 0.99);
  assert.equal(Object.hasOwn(cfg, 'STOP_LOSS_PRICE'), false);
  assert.equal(Object.hasOwn(cfg, 'SHARE_STEP'), false);
});

test('buy limit touch requires an executable best ask at or below the limit', () => {
  assert.equal(strategy.buyLimitTouched(0.45, cfg.ENTRY_RUNGS[0].entryPrice), true);
  assert.equal(strategy.buyLimitTouched(0.27, cfg.ENTRY_RUNGS[3].entryPrice), true);
  assert.equal(strategy.buyLimitTouched(0.451, cfg.ENTRY_RUNGS[0].entryPrice), false);
  assert.equal(strategy.buyLimitTouched(null, cfg.ENTRY_RUNGS[0].entryPrice), false);
});

test('take-profit touch requires an executable best bid at or above the limit', () => {
  assert.equal(strategy.takeProfitTouched(0.55, cfg.ENTRY_RUNGS[0].takeProfitPrice), true);
  assert.equal(strategy.takeProfitTouched(0.99, cfg.SECOND_FILL_TAKE_PROFIT_PRICE), true);
  assert.equal(strategy.takeProfitTouched(0.549, cfg.ENTRY_RUNGS[0].takeProfitPrice), false);
  assert.equal(strategy.takeProfitTouched(null, cfg.ENTRY_RUNGS[0].takeProfitPrice), false);
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