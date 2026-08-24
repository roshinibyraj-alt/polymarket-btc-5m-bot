const assert = require('node:assert/strict');
const { MomentumLagEngine } = require('../engine');

class FakeWebSocket { constructor() { this.readyState = 1; this.sent = []; } send(data) { this.sent.push(data); } close() { this.readyState = 3; } }
async function fakeFetch(url) {
  const match = String(url).match(/slug=([a-z]+)-updown-5m-\d+/);
  assert.ok(match, 'unexpected Gamma URL: ' + url);
  const asset = match[1];
  return { ok: true, json: async () => [{
    conditionId: '0x' + asset, question: asset.toUpperCase() + ' test', closed: false,
    outcomes: '["Up","Down"]', clobTokenIds: `["${asset}-up","${asset}-down"]`,
  }] };
}
function round2(value) { return Math.round(value * 100) / 100; }

(async () => {
  const logs = [];
  const engine = new MomentumLagEngine({ WebSocketImpl: FakeWebSocket, fetchImpl: fakeFetch, onLog: line => logs.push(line), onTick: () => {} });
  const start = Math.floor(Date.now() / 1000) - 100;
  for (const asset of ['btc', 'eth', 'sol', 'xrp']) await engine.discoverMarket(asset, start);
  engine.activeWindowStart = start;
  const market = slug => engine.markets.get(`${slug}-updown-5m-${start}`);

  engine.applyTop(market('btc').up, 0.79, 0.81);
  engine.applyTop(market('btc').down, 0.19, 0.21);
  engine.applyTop(market('eth').up, 0.44, 0.46);
  engine.applyTop(market('eth').down, 0.54, 0.56);
  engine.applyTop(market('sol').up, 0.44, 0.46);
  engine.applyTop(market('xrp').up, 0.58, 0.60);
  engine.evaluateSignals();

  assert.equal(engine.positions.length, 1, 'only the first cheap ETH side should fire');
  let position = engine.positions[0];
  assert.equal(position.asset, 'eth');assert.equal(position.outcome, 'UP');
  assert.equal(position.shares, 100);assert.equal(position.cost, 46);

  engine.applyTop(market('sol').up, 0.43, 0.47);
  engine.evaluateSignals();
  assert.equal(engine.positions.length, 1, 'UP is locked for the whole window');
  assert.equal(position.shares, 100);assert.equal(position.cost, 46);

  engine.applyTop(market('eth').up, 0.48, 0.52);
  engine.updatePositionMarks();
  assert.equal(position.markPrice, 0.50);
  assert.equal(engine.positionPnl(position), 4);

  market('eth').finalUpMax = 0.93;
  market('eth').finalDownMax = 0.07;
  market('eth').resolved = false;
  engine.resolveFromFinalPrices(market('eth'));
  assert.equal(market('eth').winner, 'UP');
  assert.equal(market('eth').resolutionSource, 'CLOB_FINAL_2S');
  assert.equal(round2(engine.realizedPnl), 54);
  assert.equal(round2(engine.bankroll), 5054);
  assert.equal(engine.wins, 1);assert.equal(engine.losses, 0);

  console.log(JSON.stringify({
    positions: engine.positions.length, shares: position.shares, cost: position.cost,
    floatingBeforeSettlement: engine.positionPnl({ ...position, status: 'open', markPrice: 0.5 }),
    payout: position.payout, realizedPnl: engine.realizedPnl, bankroll: engine.bankroll,
    triggerLogs: logs.filter(line => line.includes('BUY')),
  }, null, 2));
  console.log('ONE-FILL-PER-SIDE SMOKE PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
