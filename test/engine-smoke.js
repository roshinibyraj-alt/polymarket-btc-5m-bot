'use strict';

const assert = require('node:assert/strict');
const { BtcBreakoutEngine, config } = require('../engine');

function windowStartFor(timeMs) {
  return Math.floor(timeMs / 1000 / 300) * 300;
}

async function fakeFetch(url) {
  const text = String(url);
  if (text.endsWith('/prices')) return { ok: true, json: async () => global.bookPayload || {} };
  const match = text.match(/slug=btc-updown-5m-(\d+)/);
  assert.ok(match, `unexpected URL: ${text}`);
  const start = Number(match[1]);
  return {
    ok: true,
    json: async () => [{
      conditionId: `0xbtc${start}`,
      question: `BTC test ${start}`,
      closed: false,
      outcomes: '["Up","Down"]',
      clobTokenIds: `["btc:${start}:up","btc:${start}:down"]`,
    }],
  };
}

(async () => {
  const currentWindow = windowStartFor(Date.now());
  const engine = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await engine.discoverMarket(currentWindow);
  const market = engine.markets.get(`btc-updown-5m-${currentWindow}`);
  assert.ok(market);

  // --- TEST 1: Before 60s wait, no entry ---
  const savedWs = market.windowStart;
  market.windowStart = Math.floor(Date.now() / 1000) + 100;
  market.windowEnd = market.windowStart + 300;
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.89, 0.91);
  assert.equal(engine.evaluateEntry(market), false, 'no entry before 60s');
  market.windowStart = savedWs;
  market.windowEnd = savedWs + 300;

  // --- TEST 2: ask=0.06 (way below 0.60) must NOT trigger ---
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.05, 0.06);
  engine.applyQuote(market.down, 0.89, 0.91);
  assert.equal(engine.evaluateEntry(market), false, 'ask=0.06 must NOT trigger');

  // --- TEST 3: ask=0.80 (above 0.60) must NOT trigger ---
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.79, 0.80);
  engine.applyQuote(market.down, 0.89, 0.91);
  assert.equal(engine.evaluateEntry(market), false, 'ask=0.80 must NOT trigger');

  // --- TEST 4: ask=0.60 triggers → 125 shares ---
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.89, 0.91);
  assert.equal(engine.evaluateEntry(market), true, 'entry fires at ask=0.60');
  assert.equal(engine.openPosition?.outcome, 'UP');
  assert.equal(engine.openPosition?.shares, 125, '125 shares');
  assert.equal(engine.accumUpShares, 125);
  assert.equal(engine.accumDownShares, 0);
  const sunkAfterEntry = engine.windowSunkCost;

  // --- TEST 5: Flip — opposite (DOWN) ask=0.60 ---
  engine.applyQuote(market.up, 0.30, 0.32);
  engine.applyQuote(market.down, 0.59, 0.60);
  assert.equal(engine.evaluateFlip(market), true, 'flip fires at DOWN ask=0.60');
  assert.equal(engine.openPosition?.outcome, 'DOWN');
  assert.equal(engine.windowFlipCount, 1);
  assert.ok(engine.openPosition.shares > 125, 'flip shares > 125');
  assert.equal(engine.accumUpShares, 125);
  assert.equal(engine.accumDownShares, engine.openPosition.shares);

  // --- TEST 6: Opposite (UP) ask=0.91 must NOT flip ---
  engine.lastFlipKey = null;
  engine.applyQuote(market.up, 0.90, 0.91);
  engine.applyQuote(market.down, 0.30, 0.32);
  assert.equal(engine.evaluateFlip(market), false, 'no flip at UP ask=0.91');

  // --- TEST 7: Opposite (UP) ask=0.06 must NOT flip ---
  engine.lastFlipKey = null;
  engine.applyQuote(market.up, 0.05, 0.06);
  engine.applyQuote(market.down, 0.30, 0.32);
  assert.equal(engine.evaluateFlip(market), false, 'no flip at UP ask=0.06');

  // --- TEST 8: Second flip — opposite (UP) ask=0.60 ---
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.30, 0.32);
  const flip1Shares = engine.openPosition.shares;
  assert.equal(engine.evaluateFlip(market), true, 'second flip fires');
  assert.equal(engine.windowFlipCount, 2);
  assert.ok(engine.openPosition.shares > flip1Shares, 'second flip > first flip');
  assert.equal(engine.accumUpShares, 125 + engine.openPosition.shares);

  // --- TEST 9: Resolution ---
  engine.settleWindow(market);
  assert.equal(engine.openPosition, null);

  // --- TEST 10: Build state ---
  const state = engine.buildState();
  assert.equal(typeof state.accumUpShares, 'number');
  assert.equal(typeof state.accumDownShares, 'number');
  assert.equal(typeof state.windowFlipCount, 'number');
  assert.equal(typeof state.windowSunkCost, 'number');
  assert.equal(typeof state.monitoringActive, 'boolean');
  assert.equal(state.config.priceTolerance, config.PRICE_TOLERANCE);
  assert.equal(state.config.maxWindowInvestment, config.MAX_WINDOW_INVESTMENT);

  console.log(JSON.stringify({
    entryShares: 125,
    trigger: `±${config.PRICE_TOLERANCE} of ${config.ENTRY_PRICE}`,
    maxInvestment: `$${config.MAX_WINDOW_INVESTMENT}`,
  }));
  console.log('BTC FLIP BOT SMOKE PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
