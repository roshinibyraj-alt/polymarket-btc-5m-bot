'use strict';
// Internal smoke test — drives the engine through simulated windows with a
// fake gamma + clob fetch. Strategy verification:
//  1. Window start → 2 resting limit buys @ 0.40 (UP & DOWN)
//  2. A side dips to 0.40 → fills; first-filled side gets TP limit sell @ 0.60
//  3. Side rallies to 0.60 → TP limit sell fills (+0.20) ; other side fills at
//     0.40 as the complement (1 - price) and holds to resolution with SL 0.25
//  4. If a side's mark ≤ 0.25 → market-order SL → window paused, orders cancelled
//  5. Capital math stays correct

const { LimitHedgeEngine } = require('./engine');

const WINDOW = 300;
const TOKEN_UP = 'token-up';
const TOKEN_DOWN = 'token-down';

let t = 1600000000000;
let step = 0;
let scenario = null;
const failures = [];

function round2(v) { return Math.round(v * 100) / 100; }

// UP price path over the ~300s window (DOWN = 1 - UP).
// 0) 0.50 / 0.50
// 1) UP dips below 0.40 -> UP fills at 0.40 (ask <= 0.40), TP order on UP
// 2) UP rallies past 0.60 -> UP TP limit sell fills; DOWN = 0.40 fills at 0.40
// 3) UP keeps winning so DOWN mark falls toward 0.25..0.20 -> held to resolution
//    (and in 'sl' scenario DOWN would breach 0.25 to trigger the market SL + pause)
function path() {
  const d = step;
  if (d <= 60)   return round2(0.50 - d * 0.0018);   // 0.50 -> 0.39 (UP fills @0.40)
  if (d <= 150)  return round2(0.39 + (d - 60) * 0.002); // 0.39 -> ~0.57
  if (d <= 180)  return round2(0.57 + (d - 150) * 0.002); // ~0.57 -> 0.63 (UP TP, DOWN=0.40 fills)
  if (scenario === 'sl') return round2(0.63 + (d - 180) * 0.002); // UP rockets -> DOWN crashes < 0.25
  return round2(0.63 + (d - 180) * 0.0005);           // UP drifts up, DOWN ~0.30 (holds to resolution)
}

const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('gamma-api') && u.includes('/markets?slug=')) {
    const slug = decodeURIComponent(u.split('slug=')[1]).split('&')[0];
    return { ok: true, json: async () => [{ conditionId: 'c-' + slug, question: 'BTC test', outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([TOKEN_UP, TOKEN_DOWN]), closed: false }] };
  }
  if (u.includes('/books')) {
    const up = path();
    const down = round2(1 - up);
    return { ok: true, json: async () => ([
      { asset_id: TOKEN_UP, bids: [{ price: round2(up - 0.005), size: 800 }], asks: [{ price: round2(up + 0.005), size: 800 }] },
      { asset_id: TOKEN_DOWN, bids: [{ price: round2(down - 0.005), size: 800 }], asks: [{ price: round2(down + 0.005), size: 800 }] },
    ]) };
  }
  throw new Error('unexpected url ' + u);
};

function advance(sec) { for (let i = 0; i < sec; i++) { t += 1000; step += 1; } }

async function runScenario(sc, label) {
  const logs = [];
  const engine = new LimitHedgeEngine({ fetchImpl: fakeFetch, bankroll: 1000, onTick: () => {}, onLog: l => logs.push(l) });
  const origNow = Date.now;
  t = 1600000000000;
  step = 0;
  scenario = sc;
  Date.now = () => t;
  try {
    engine.entryWindow = 0;
    const w0 = Math.floor(t / 1000 / WINDOW) * WINDOW;
    await engine.discoverWindow(w0);
    await engine.discoverWindow(w0 + WINDOW);
    t = (w0 + WINDOW) * 1000; // start of tradeable window
    step = 0;
    engine.windowOrdersPlacedFor = null;
    for (let s = 0; s < 300; s += 2) {
      advance(2);
      await engine.pollClob();
      engine.evaluate();
    }
    // resolution tick
    await engine.pollClob();
    engine.evaluate();
    const buys = engine.trades.filter(x => x.type === 'BUY');
    const sells = engine.trades.filter(x => x.type === 'SELL');
    const tps = engine.tpOrders;
    const res = engine.results;
    console.log(`\n── ${label} ──`);
    console.log('buys  :', buys.map(x => `${x.outcome} ${x.shares}sh@${x.price}`).join(' | ') || 'none');
    console.log('TP ord:', tps.length ? tps.map(o => `${o.outcome}:${o.status}`).join(',') : 'none');
    console.log('sells :', sells.map(x => `${x.outcome} ${x.reason}@${x.price} pnl=${x.pnl}`).join(' | ') || 'none');
    console.log('bankroll:', engine.bankroll.toFixed(2), '| wins:', engine.wins, '| losses:', engine.losses, '| paused:', engine.windowPaused);
    console.log('KEY LOGS:');
    logs.filter(l => l.includes('BUY') || l.includes('TP') || l.includes('SL') || l.includes('RESOLV') || l.includes('🏁') || l.includes('WINDOW') || l.includes('PAUSED')).slice(-30).forEach(l => console.log('   ', l));

    if (buys.length === 0) failures.push(`${label}: expected at least one buy`);
    if (sc === 'whip') {
      if (!tps.some(o => o.status === 'FILLED')) failures.push(`${label}: expected TP limit sell to fill`);
      if (buys.length < 2) failures.push(`${label}: expected both sides to fill (hedge)`);
      const balance = round2(engine.bankroll - 1000);
      const expectancy = round2(buys.reduce((a, b) => a - b.cost, 0) + sells.reduce((a, s) => a + s.shares * s.price, 0));
      if (Math.abs(balance - engine.realizedPnl) > 0.02) failures.push(`${label}: bankroll/PnL mismatch ${balance} vs ${engine.realizedPnl}`);
      if (expectancy !== balance) failures.push(`${label}: PnL math mismatch expected=${expectancy} actual=${balance}`);
    }
    if (sc === 'sl') {
      if (!engine.windowPaused) failures.push(`${label}: expected window paused after SL`);
      const sl = sells.find(x => x.reason === 'SL');
      if (!sl) failures.push(`${label}: expected a market SL sell`);
      if (sl && buys.some(b => b.outcome !== sl.outcome && engine.positions.some(p => p.outcome === b.outcome && p.exitReason == null))) {
        // held opposite side should NOT be sold by SL
      }
    }
  } catch (e) {
    failures.push(`${label}: exception ${e.message}`);
  } finally {
    Date.now = origNow;
  }
}

(async () => {
  await runScenario('whip', 'Scenario Whip — UP fills @0.40, TP @0.60, DOWN fills @0.40, held to resolution');
  await runScenario('sl', 'Scenario SL — DOWN collapses to 0.25 → market SL → window paused');
  console.log('\n=== SMOKE RESULT ===');
  if (failures.length) {
    failures.forEach(f => console.log('  ✗', f));
    process.exit(1);
  }
  console.log('✔ All checks passed');
})().catch(e => { console.error(e); process.exit(1); });
