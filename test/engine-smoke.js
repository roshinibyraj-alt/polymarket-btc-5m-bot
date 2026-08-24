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
  const start = windowStartFor(Date.now()) + 3000;
  const nextStart = start + 300;
  const engine = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await engine.discoverMarket(start);
  await engine.discoverMarket(nextStart);
  const firstMarket = engine.markets.get(`btc-updown-5m-${start}`);
  const secondMarket = engine.markets.get(`btc-updown-5m-${nextStart}`);
  assert.ok(firstMarket && secondMarket);

  global.bookPayload = clobPayload(firstMarket, quotes(.89, .91, .07, .09));
  engine.processQuotes(firstMarket, global.bookPayload, 1);
  assert.equal(engine.openPosition?.outcome, 'UP', 'first qualifying tick must fire immediately');
  assert.equal(engine.openPosition?.shares, config.BASE_SHARES);
  assert.equal(engine.openPosition?.signal.triggerSource, 'ASK');

  engine.settleWindow(firstMarket);
  assert.equal(engine.openPosition, null, 'first window must release its lifecycle');
  assert.equal(engine.lossStreak, 1);
  assert.equal(engine.currentShares(), 210);

  global.bookPayload = clobPayload(secondMarket, quotes(.08, .10, .88, .90));
  engine.processQuotes(secondMarket, global.bookPayload, 2);
  assert.equal(engine.openPosition?.slug, secondMarket.slug, 'next window must be tradeable');
  assert.equal(engine.openPosition?.outcome, 'DOWN');
  assert.equal(engine.openPosition?.shares, 210);
  assert.equal(engine.tradedThisWindow, true);

  engine.applyQuote(secondMarket.down, .79, .81);
  engine.manageStop(engine.openPosition);
  assert.equal(engine.openPosition, null, 'stop loss must close immediately');
  engine.settleWindow(secondMarket);
  assert.equal(engine.getWindowStats(nextStart).result, 'LOSS');
  assert.ok(Math.abs(engine.getWindowStats(nextStart).realizedPnl + 23.1) < .001);
  assert.equal(engine.lossStreak, 2);
  assert.equal(engine.currentShares(), 441);

  const resolver = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await resolver.discoverMarket(start);
  const resolveMarket = resolver.markets.get(`btc-updown-5m-${start}`);
  resolver.applyQuote(resolveMarket.up, .91, .93);
  resolver.applyQuote(resolveMarket.down, .05, .07);
  resolveMarket.finalUpMax = .915;
  resolveMarket.finalDownMax = .06;
  resolver.settleWindow(resolveMarket);
  assert.equal(resolveMarket.winner, 'UP');
  assert.equal(resolveMarket.resolutionSource, 'CLOB_FINAL_2S');

  resolver.lossStreak = config.MAX_MARTINGALES;
  assert.equal(resolver.buildState().nextShares, config.BASE_SHARES);

  console.log(JSON.stringify({
    firstEntry: '100 SH @0.91',
    stopPnl: '-$12.00',
    nextWindowEntry: '210 DOWN SH @0.90',
    nextStopPnl: '-$23.10',
    sequence: [100, 210, 441, 926, 1945],
  }));
  console.log('BTC BREAKOUT ROLLOVER SMOKE PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
