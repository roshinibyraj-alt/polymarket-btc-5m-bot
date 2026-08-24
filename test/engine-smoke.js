const assert = require('node:assert/strict');
const { BtcBreakoutEngine, config } = require('../engine');

function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / 300) * 300; }
async function fakeFetch(url, options = {}) {
  const text = String(url);
  if (text.endsWith('/prices')) {
    const requests = JSON.parse(options.body);
    const quotes = global.bookQuotes || {};
    const result = {};
    for (const request of requests) {
      const sideQuotes = quotes[request.token_id.split(':').pop()];
      result[request.token_id] ||= {};
      result[request.token_id][request.side] = String((request.side === 'BUY' ? sideQuotes?.ask : sideQuotes?.bid)?.[0]?.price ?? 0);
    }
    return { ok: true, json: async () => result };
  }
  const match = text.match(/slug=btc-updown-5m-(\d+)/);
  assert.ok(match, 'unexpected URL: ' + text);
  const start = match[1];
  return { ok: true, json: async () => [{
    conditionId: '0xbtc' + start, question: 'BTC test', closed: false,
    outcomes: '["Up","Down"]', clobTokenIds: `["btc:${start}:up","btc:${start}:down"]`,
  }] };
}

(async () => {
  const start = windowStartFor(Date.now());
  const engine = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await engine.discoverMarket(start);
  engine.activeWindowStart = start;
  const market = engine.markets.get(`btc-updown-5m-${start}`);
  global.bookQuotes = {
    up: { bid: [{ price: .89, size: 100 }], ask: [{ price: .91, size: 100 }] },
    down: { bid: [{ price: .07, size: 100 }], ask: [{ price: .09, size: 100 }] },
  };
  engine.applyBook(market.up, global.bookQuotes.up.bid, global.bookQuotes.up.ask);
  engine.applyBook(market.down, global.bookQuotes.down.bid, global.bookQuotes.down.ask);
  engine.evaluateEntry();
  assert.equal(engine.openPosition.outcome, 'UP');
  assert.equal(engine.openPosition.shares, 100);
  assert.equal(engine.openPosition.cost, 91);

  global.bookQuotes.up = { bid: [{ price: .79, size: 100 }], ask: [{ price: .81, size: 100 }] };
  engine.applyBook(market.up, global.bookQuotes.up.bid, global.bookQuotes.up.ask);
  engine.managePosition();
  assert.equal(engine.openPosition, null);
  let stats = engine.getWindowStats(start);
  assert.equal(stats.result, 'STOPPED');
  assert.equal(stats.realizedPnl, -12);

  market.finalUpMax = .92; market.finalDownMax = .06; market.resolved = false;
  engine.resolveFromFinalPrices(market);
  stats = engine.getWindowStats(start);
  assert.equal(stats.result, 'LOSS');
  assert.equal(engine.lossStreak, 1);
  assert.equal(engine.currentShares(), 210);

  engine.lossStreak = 4;
  assert.equal(engine.buildState().nextShares, 100, 'fourth losing martingale resets next stake');
  engine.lossStreak = 1;

  for (let streak = 0; streak <= 4; streak++) {
    const expected = [100, 210, 441, 926, 1945][streak];
    assert.equal(sharesForStreakPublic(engine, streak), expected);
  }

  global.bookQuotes = {
    up: { bid: [{ price: .89, size: 100 }], ask: [{ price: .91, size: 100 }] },
    down: { bid: [{ price: .07, size: 100 }], ask: [{ price: .09, size: 100 }] },
  };
  const reactionEngine = new BtcBreakoutEngine({ fetchImpl: fakeFetch, onTick: () => {}, onLog: () => {} });
  await reactionEngine.discoverMarket(start);
  reactionEngine.activeWindowStart = start;
  const reactionMarket = reactionEngine.markets.get(`btc-updown-5m-${start}`);
  await reactionEngine.pollClobBooks();
  assert.equal(reactionEngine.openPosition?.outcome, 'UP', 'first qualifying CLOB snapshot must enter immediately');
  assert.equal(reactionEngine.pollCount, 1);

  console.log(JSON.stringify({
    entry: '100 SH @0.91', stop: '-$12', nextAfterLoss: engine.currentShares(),
    sequence: [config.BASE_SHARES, 210, 441, 926, 1945],
    resolutionSource: stats.resolutionSource,
  }, null, 2));
  console.log('BTC BREAKOUT CLOB POLLING SMOKE PASS');

  function sharesForStreakPublic(instance, streak) {
    instance.lossStreak = streak;
    return instance.currentShares();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
