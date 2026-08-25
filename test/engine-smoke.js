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
  engine.applyQuote(market.down, 0.39, 0.41);
  assert.equal(engine.evaluateEntry(market), false, 'no entry before 60s');
  market.windowStart = savedWs;
  market.windowEnd = savedWs + 300;

  // --- TEST 2: ask=0.06 must NOT trigger (too low, below 0.50) ---
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.05, 0.06);
  engine.applyQuote(market.down, 0.39, 0.41);
  assert.equal(engine.evaluateEntry(market), false, 'ask=0.06 below 0.50 must NOT trigger');

  // --- TEST 3: both sides above 0.60 must NOT trigger ---
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.79, 0.81);
  engine.applyQuote(market.down, 0.79, 0.81);
  assert.equal(engine.evaluateEntry(market), false, 'ask=0.81 above 0.60 must NOT trigger');

  // --- TEST 4: ask=0.60 triggers → 125 shares ---
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.39, 0.41);
  assert.equal(engine.evaluateEntry(market), true, 'fires at ask=0.60');
  assert.equal(engine.openPosition?.outcome, 'UP');
  assert.equal(engine.openPosition?.shares, 125, '125 shares');
  assert.equal(engine.accumUpShares, 125);

  // --- TEST 5: Flip — opposite ask=0.60 ---
  engine.applyQuote(market.up, 0.30, 0.32);
  engine.applyQuote(market.down, 0.59, 0.60);
  assert.equal(engine.evaluateFlip(market), true, 'flip at DOWN ask=0.60');
  assert.equal(engine.openPosition?.outcome, 'DOWN');
  assert.equal(engine.windowFlipCount, 1);

  // --- TEST 6: Opposite ask=0.91 must NOT flip ---
  engine.lastFlipKey = null;
  engine.applyQuote(market.up, 0.90, 0.91);
  engine.applyQuote(market.down, 0.30, 0.32);
  assert.equal(engine.evaluateFlip(market), false, 'no flip at ask=0.91');

  // --- TEST 7: Opposite ask=0.06 must NOT flip ---
  engine.lastFlipKey = null;
  engine.applyQuote(market.up, 0.05, 0.06);
  engine.applyQuote(market.down, 0.30, 0.32);
  assert.equal(engine.evaluateFlip(market), false, 'no flip at ask=0.06');

  // --- TEST 8: Second flip ---
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.30, 0.32);
  const flip1Shares = engine.openPosition.shares;
  assert.equal(engine.evaluateFlip(market), true, 'second flip');
  assert.equal(engine.windowFlipCount, 2);
  assert.ok(engine.openPosition.shares > flip1Shares);

  // --- TEST 9: Resolution ---
  engine.settleWindow(market);
  assert.equal(engine.openPosition, null);

  // --- TEST 10: Build state ---
  const state = engine.buildState();
  assert.equal(typeof state.accumUpShares, 'number');
  assert.equal(typeof state.windowFlipCount, 'number');
  assert.equal(typeof state.windowSunkCost, 'number');

  console.log(JSON.stringify({
    trigger: 'ask <= 0.60 && ask >= 0.50',
    entryShares: 125,
    maxInvestment: `$${config.MAX_WINDOW_INVESTMENT}`,
  }));
  console.log('BTC FLIP BOT SMOKE PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
