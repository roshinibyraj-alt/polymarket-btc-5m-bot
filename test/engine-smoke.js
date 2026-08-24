const assert = require('node:assert/strict');
const { MomentumLagEngine } = require('../engine');
function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / 300) * 300; }

class FakeWebSocket { constructor() { this.readyState = 1; this.sent = []; } send(data) { this.sent.push(data); } close() { this.readyState = 3; } }
async function fakeFetch(url) {
  const match = String(url).match(/slug=([a-z]+)-updown-5m-(\d+)/);
  assert.ok(match, 'unexpected discovery URL: ' + url);
  const [asset, start] = [match[1], match[2]];
  return { ok: true, json: async () => [{
    conditionId: '0x' + asset, question: asset.toUpperCase() + ' test', closed: false,
    outcomes: '["Up","Down"]', clobTokenIds: `["${asset}-${start}-up","${asset}-${start}-down"]`,
  }] };
}
function round2(value) { return Math.round(value * 100) / 100; }

(async () => {
  const logs = [];
  const engine = new MomentumLagEngine({ WebSocketImpl: FakeWebSocket, fetchImpl: fakeFetch, onLog: line => logs.push(line), onTick: () => {} });
  engine.connect();
  const start = windowStartFor(Date.now());
  for (const asset of ['btc', 'eth', 'sol', 'xrp']) await engine.discoverMarket(asset, start);
  await engine.discoverMarket('btc', start + 300);
  assert.equal(engine.publicMarkets().length, 4, 'dashboard must expose only current-window books');
  engine.activeWindowStart = start;
  const market = slug => engine.markets.get(`${slug}-updown-5m-${start}`);

  engine.applyTop(market('btc').up, 0.64, 0.66);
  engine.applyTop(market('btc').down, 0.19, 0.21);
  engine.applyTop(market('eth').up, 0.44, 0.46);
  engine.applyTop(market('sol').up, 0.44, 0.46);
  engine.evaluateSignals();

  assert.equal(engine.positions.length, 0, 'BTC midpoint at the threshold must not trigger');

  engine.applyTop(market('btc').up, 0.65, 0.67);
  engine.evaluateSignals();
  assert.equal(engine.positions.length, 2, 'ETH and SOL each get an independent fill');
  const eth = engine.positions.find(p => p.asset === 'eth');
  const sol = engine.positions.find(p => p.asset === 'sol');
  assert.equal(eth.outcome, 'UP');assert.equal(eth.cost, 46);
  assert.equal(sol.outcome, 'UP');assert.equal(sol.cost, 46);

  engine.evaluateSignals();
  assert.equal(engine.positions.length, 2, 'each pair is locked after its first fill');
  assert.ok(engine.firedMarketKeys.has(`${start}:eth-updown-5m-${start}`));

  engine.activeWindowStart = start + 300;
  engine.applyTop(market('eth').up, 0.43, 0.47);engine.evaluateSignals();
  assert.equal(engine.positions.length, 2, 'stale windows cannot trade after rotation');
  engine.activeWindowStart = start;

  engine.applyTop(market('eth').up, 0.48, 0.52);engine.updatePositionMarks();
  assert.equal(eth.markPrice, 0.50);assert.equal(engine.positionPnl(eth), 4);

  const originalNow = Date.now;Date.now = () => (start + 300) * 1000;
  engine.applyTop(market('xrp').up, 0.43, 0.47);engine.evaluateSignals();
  Date.now = originalNow;
  assert.equal(engine.positions.length, 2, 'expired windows never fire');

  market('eth').finalUpMax = 0.93;market('eth').finalDownMax = 0.07;market('eth').resolved = false;
  engine.resolveFromFinalPrices(market('eth'));
  assert.equal(market('eth').winner, 'UP');
  assert.equal(market('eth').resolutionSource, 'CLOB_FINAL_2S');
  assert.equal(round2(engine.realizedPnl), 54);
  assert.equal(round2(engine.bankroll), 5008);
  assert.equal(engine.wins, 1);assert.equal(engine.losses, 0);

  for (const asset of ['btc', 'eth', 'sol', 'xrp']) await engine.discoverMarket(asset, start + 300);
  assert.equal(engine.subscribedTokens.size, 16, 'current and next markets are armed');
  const expiredTokenId = market('eth').up.tokenId;
  const originalClock = Date.now;
  Date.now = () => (start + 303) * 1000;
  engine.pruneExpiredMarkets();
  Date.now = originalClock;
  assert.equal(engine.markets.size, 4, 'only the next live window remains');
  assert.equal(engine.subscribedTokens.size, 8, 'expired CLOB tokens are unsubscribed');
  const replacement = JSON.parse(engine.socket.sent.at(-1));
  assert.equal(replacement.assets_ids.length, 8, 'socket receives the compact token set');
  assert.equal(replacement.assets_ids.includes(expiredTokenId), false);

  console.log(JSON.stringify({
    pairsFilled: engine.positions.length,
    fills: engine.positions.map(p => `${p.asset}:${p.outcome}:${p.shares}sh@$${p.cost}`),
    floatingPnl: [engine.positionPnl(eth), engine.positionPnl(sol)],
    payout: eth.payout, realizedPnl: engine.realizedPnl, bankroll: engine.bankroll,
    triggerLogs: logs.filter(line => line.includes('BUY')),
  }, null, 2));
  console.log('ONE-FILL-PER-PAIR CLOB SMOKE PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
