'use strict';

const assert = require('node:assert/strict');
const { BtcBreakoutEngine, config } = require('../engine');

function windowStartFor(timeMs) {
  return Math.floor(timeMs / 1000 / 300) * 300;
}

function quotes(upBid, upAsk, downBid, downAsk) {
  return { up: { bid: upBid, ask: upAsk }, down: { bid: downBid, ask: downAsk } };
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
  const start = windowStartFor(Date.now()) + 300;

  // --- TEST 1: Normal entry, no ask ≤0.30 history → 100 shares ---
  const engine = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await engine.discoverMarket(start);
  const market1 = engine.markets.get(`btc-updown-5m-${start}`);
  assert.ok(market1);

  global.bookPayload = clobPayload(market1, quotes(.25, .27, .88, .90));
  engine.processQuotes(market1, global.bookPayload, 1);
  assert.equal(engine.openPosition?.outcome, 'DOWN', 'DOWN triggers at ask 0.90');
  assert.equal(engine.openPosition?.shares, 100, 'no ask ≤0.30 history → 100 shares');
  engine.settleWindow(market1);
  assert.equal(engine.openPosition, null, 'window released');

  // --- TEST 2: Ask drops to 0.25 then recovers to 0.91 → 200 shares ---
  await engine.discoverMarket(start + 300);
  const market2 = engine.markets.get(`btc-updown-5m-${start + 300}`);
  assert.ok(market2);

  // Tick 1: UP ask drops to 0.25 — tracks askLow
  global.bookPayload = clobPayload(market2, quotes(.24, .25, .80, .82));
  engine.processQuotes(market2, global.bookPayload, 2);
  assert.equal(engine.askLow.get(market2.up.tokenId), 0.25, 'askLow tracks 0.25');

  // Tick 2: UP ask recovers to 0.42
  global.bookPayload = clobPayload(market2, quotes(.40, .42, .50, .52));
  engine.processQuotes(market2, global.bookPayload, 3);
  assert.equal(engine.askLow.get(market2.up.tokenId), 0.25, 'askLow stays at 0.25');

  // Tick 3: UP ask hits 0.91 — triggers entry with 200 shares
  global.bookPayload = clobPayload(market2, quotes(.90, .91, .08, .10));
  engine.processQuotes(market2, global.bookPayload, 4);
  assert.equal(engine.openPosition?.outcome, 'UP', 'UP triggers at ask 0.91');
  assert.equal(engine.openPosition?.shares, 200, 'askLow ≤0.30 history → 200 shares');
  engine.settleWindow(market2);
  assert.equal(engine.openPosition, null, 'window released');

  // --- TEST 3: askLow cleared after settlement → back to 100 ---
  await engine.discoverMarket(start + 600);
  const market3 = engine.markets.get(`btc-updown-5m-${start + 600}`);
  assert.ok(market3);
  assert.equal(engine.askLow.get(market3.up.tokenId), undefined, 'askLow cleared for new market');
  assert.equal(engine.askLow.get(market3.down.tokenId), undefined, 'askLow cleared for new market');

  global.bookPayload = clobPayload(market3, quotes(.20, .22, .88, .90));
  engine.processQuotes(market3, global.bookPayload, 5);
  assert.equal(engine.openPosition?.outcome, 'DOWN');
  assert.equal(engine.openPosition?.shares, 100, 'no prior ask ≤0.30 → 100 shares');
  engine.settleWindow(market3);

  // --- TEST 4: ask low at exactly 0.30 → 200 shares ---
  await engine.discoverMarket(start + 900);
  const market4 = engine.markets.get(`btc-updown-5m-${start + 900}`);
  assert.ok(market4);

  global.bookPayload = clobPayload(market4, quotes(.29, .30, .80, .82));
  engine.processQuotes(market4, global.bookPayload, 6);
  assert.equal(engine.askLow.get(market4.up.tokenId), 0.30, 'askLow tracks exactly 0.30');

  global.bookPayload = clobPayload(market4, quotes(.90, .91, .08, .10));
  engine.processQuotes(market4, global.bookPayload, 7);
  assert.equal(engine.openPosition?.outcome, 'UP');
  assert.equal(engine.openPosition?.shares, 200, 'askLow exactly 0.30 → 200 shares');
  engine.settleWindow(market4);

  // --- TEST 5: resolution ---
  const resolver = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await resolver.discoverMarket(start);
  const resolveMarket = resolver.markets.get(`btc-updown-5m-${start}`);
  resolver.applyQuote(resolveMarket.up, 0.91, 0.93);
  resolver.applyQuote(resolveMarket.down, 0.05, 0.07);
  resolveMarket.finalUpMax = 0.915;
  resolveMarket.finalDownMax = 0.06;
  resolver.settleWindow(resolveMarket);
  assert.equal(resolveMarket.winner, 'UP');
  assert.equal(resolveMarket.resolutionSource, 'CLOB_FINAL_2S');

  console.log(JSON.stringify({
    normalShares: 100,
    boostedShares: 200,
    threshold: 0.30,
  }));
  console.log('BTC BREAKOUT SMOKE PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
