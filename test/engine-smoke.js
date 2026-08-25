'use strict';

const assert = require('node:assert/strict');
const { BtcBreakoutEngine, config } = require('../engine');

function windowStartFor(timeMs) {
  return Math.floor(timeMs / 1000 / 300) * 300;
}

function clobPayload(market, book) {
  const result = {};
  for (const token of [market.up, market.down]) {
    result[token.tokenId] = {
      BUY: String(book[token.outcome.toLowerCase()].bid),
      SELL: String(book[token.outcome.toLowerCase()].ask),
    };
  }
  return result;
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
  // Use the actual current window so handleRollover works
  const currentWindow = windowStartFor(Date.now());
  const engine = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await engine.discoverMarket(currentWindow);
  const market = engine.markets.get(`btc-updown-5m-${currentWindow}`);
  assert.ok(market);

  // windowStart is already set by discovery to currentWindow, and elapsed > 60s in most cases.
  // But if we're early in the window, use applyQuote + evaluateEntry directly.

  // --- TEST 1: evaluateEntry blocks before 60s ---
  const savedWs = market.windowStart;
  market.windowStart = Math.floor(Date.now() / 1000) + 100;
  market.windowEnd = market.windowStart + 300;
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.89, 0.91);
  const result1 = engine.evaluateEntry(market);
  assert.equal(result1, false, 'must not enter before 60s wait');
  assert.equal(engine.openPosition, null, 'no position before wait');
  assert.equal(engine.monitoringActive, false, 'monitoring not active yet');
  market.windowStart = savedWs;
  market.windowEnd = savedWs + 300;

  // --- TEST 2: After 60s, UP ask=0.60 → 125 shares ---
  engine.tradedThisWindow = false;
  engine.openPosition = null;
  engine.monitoringActive = false;
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.89, 0.91);
  const result2 = engine.evaluateEntry(market);
  assert.equal(result2, true, 'entry fires at ask 0.60');
  assert.equal(engine.openPosition?.outcome, 'UP', 'UP triggers at ask 0.60');
  assert.equal(engine.openPosition?.shares, 125, '125 shares for $50 target');
  assert.equal(engine.accumUpShares, 125, 'accumulated UP = 125');
  assert.equal(engine.accumDownShares, 0, 'accumulated DOWN = 0');
  assert.ok(engine.windowSunkCost > 0, 'sunk cost tracks entry');

  // --- TEST 3: Flip — DOWN ask hits 0.60 ---
  const sunkBefore = engine.windowSunkCost;
  engine.applyQuote(market.up, 0.30, 0.32);
  engine.applyQuote(market.down, 0.59, 0.60);
  const result3 = engine.evaluateFlip(market);
  assert.equal(result3, true, 'flip fires');
  assert.equal(engine.openPosition?.outcome, 'DOWN', 'flipped to DOWN');
  assert.equal(engine.windowFlipCount, 1, 'flip count = 1');
  assert.ok(engine.openPosition.shares > 125, 'flip shares > 125 to cover sunk cost');
  assert.equal(engine.accumUpShares, 125, 'accumulated UP still 125');
  assert.equal(engine.accumDownShares, engine.openPosition.shares, 'accumulated DOWN matches');
  assert.ok(engine.windowSunkCost > sunkBefore, 'sunk cost increased');

  // --- TEST 4: Second flip — UP ask hits 0.60 again ---
  const flipShares = engine.openPosition.shares;
  engine.applyQuote(market.up, 0.59, 0.60);
  engine.applyQuote(market.down, 0.30, 0.32);
  const result4 = engine.evaluateFlip(market);
  assert.equal(result4, true, 'second flip fires');
  assert.equal(engine.openPosition?.outcome, 'UP', 'flipped back to UP');
  assert.equal(engine.windowFlipCount, 2, 'flip count = 2');
  assert.ok(engine.openPosition.shares > flipShares, 'second flip shares > first flip shares');
  assert.equal(engine.accumUpShares, 125 + engine.openPosition.shares, 'accumulated UP updated');
  assert.equal(engine.accumDownShares, flipShares, 'accumulated DOWN = first flip');

  // --- TEST 5: No flip if opposite side is above 0.60 ---
  engine.lastFlipKey = null; // reset so we can test
  engine.applyQuote(market.up, 0.30, 0.32);
  engine.applyQuote(market.down, 0.89, 0.91);
  const result5 = engine.evaluateFlip(market);
  assert.equal(result5, false, 'no flip when opposite ask > 0.60');

  // --- TEST 6: Resolution ---
  engine.settleWindow(market);
  assert.equal(engine.openPosition, null, 'position closed on settlement');
  const stats = engine.getWindowStats(currentWindow);
  assert.ok(stats.result === 'WIN' || stats.result === 'LOSS' || stats.result === 'FLAT', 'result set');

  // --- TEST 7: Build state has accumulators ---
  const state = engine.buildState();
  assert.equal(typeof state.accumUpShares, 'number');
  assert.equal(typeof state.accumDownShares, 'number');
  assert.equal(typeof state.windowFlipCount, 'number');
  assert.equal(typeof state.windowSunkCost, 'number');
  assert.equal(typeof state.monitoringActive, 'boolean');

  console.log(JSON.stringify({
    entryShares: 125,
    entryCost: '$75.00',
    targetProfit: '$50.00',
    flipSharesScale: 'increases with sunk cost',
    totalFlips: 2,
  }));
  console.log('BTC FLIP BOT SMOKE PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
