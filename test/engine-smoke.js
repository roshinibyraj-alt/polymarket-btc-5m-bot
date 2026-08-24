const assert = require('node:assert/strict');
const { MomentumLagEngine } = require('../engine');

class FakeWebSocket {
  constructor() { this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

async function fakeFetch(url) {
  const match = String(url).match(/slug=([a-z]+-updown-5m-\d+)/);
  if (!match) throw new Error('unexpected ' + url);
  const asset = match[1].split('-')[0];
  return { ok: true, json: async () => [{
    conditionId: '0x' + asset, question: asset.toUpperCase() + ' test',
    outcomes: '["Up","Down"]', clobTokenIds: `["${asset}-up","${asset}-down"]`, closed: false,
  }] };
}

(async () => {
  const ticks = [];
  const lines = [];
  const engine = new MomentumLagEngine({
    WebSocketImpl: FakeWebSocket, fetchImpl: fakeFetch,
    onTick: markets => ticks.push(markets), onLog: line => lines.push(line),
  });
  const start = Math.floor(Date.now() / 1000) - 100;
  await engine.discoverMarket('btc', start);
  await engine.discoverMarket('eth', start);
  assert.equal(engine.markets.size, 2);
  assert.equal(engine.tokens.size, 4);
  engine.activeWindowStart = start;
  engine.connect();
  engine.socket.onopen();
  assert.deepEqual(engine.socket.sent[0], JSON.stringify({ assets_ids: [...engine.subscribedTokens], type: 'market' }));

  engine.applyTop(engine.markets.get(slugFor('btc', start)).up, 0.50, 0.52);
  engine.applyTop(engine.markets.get(slugFor('eth', start)).up, 0.50, 0.51);
  engine.applyTop(engine.markets.get(slugFor('btc', start)).up, 0.56, 0.58);
  for (const series of engine.history.values()) if (series.length) series[0].t -= 2500;
  engine.evaluateSignals();

  assert.equal(engine.positions.length, 1);
  const position = engine.positions[0];
  assert.equal(position.asset, 'eth');
  assert.equal(position.outcome, 'UP');
  assert.equal(position.entryPrice, 0.51);
  assert.ok(position.shares > 50);
  assert.equal(round2(engine.bankroll), round2(5000 - position.cost));
  assert.equal(engine.trades[0].orderType, 'PAPER-FOK');

  engine.evaluateSignals();
  assert.equal(engine.positions.length, 1, 'cooldown must block immediate duplicate');

  const market = engine.markets.get(slugFor('eth', start));
  market.resolved = true; market.winner = 'UP'; market.tradingClosed = true;
  engine.settleMarket(market);
  const payout = round2(position.shares);
  assert.equal(round2(engine.realizedPnl), round2(payout - position.cost));
  assert.equal(engine.wins, 1);
  assert.equal(engine.losses, 0);
  assert.equal(engine.resolvedWindows[0].winner, 'UP');
  console.log(JSON.stringify({
    shares: position.shares, cost: position.cost, payout,
    realizedPnl: engine.realizedPnl, bankroll: engine.bankroll,
    logs: lines.filter(line => line.includes('BUY') || line.includes('🏁')),
  }, null, 2));
  console.log('ENGINE SMOKE PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });

function slugFor(asset, start) { return `${asset}-updown-5m-${start}`; }
function round2(value) { return Math.round(value * 100) / 100; }
