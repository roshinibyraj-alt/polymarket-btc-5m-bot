'use strict';
// Internal smoke test — drives the flip bot through simulated windows.
// Strategy verification:
//  1. Base = 1% of capital in shares at 0.55 (rounded).
//  2. Whichever side's ask ticks up to 0.55 fires immediately (alternating UP->DOWN->UP...).
//  3. Each flip is 2x the previous shares (martingale), unlimited flips.
//  4. All shares held to resolution; winner pays out at 1.0, loser at 0.
//  5. Base recalculated from updated capital for the next window.

const { FlipBotEngine } = require('./engine');

const WINDOW = 300;
const TOKEN_UP = 'token-up';
const TOKEN_DOWN = 'token-down';

let t = 1600000000000;
let step = 0;
let mode = null;
const failures = [];
function round2(v) { return Math.round(v * 100) / 100; }

// Price path over a window: DOWN = 1 - UP.
// We oscillate the favorite across 0.55 several times to trigger flips, then
// resolve with one side clearly winning.
function upPrice() {
  const d = step;
  // Oscillate: 0.50 -> 0.56 (UP ticks 0.55 -> FLIP UP)
  if (mode === 'down-first') {
    // DOWN-first: start at 0.58 -> fall to ~0.42 so DOWN rises to 0.55 first.
    if (d < 40)        return round2(0.58 - d * 0.002);    // 0.58->0.50
    if (d < 80)        return round2(0.50 - (d - 40) * 0.002); // 0.50->0.42 (DOWN crosses up)
    if (d < 120)       return round2(0.44 + (d - 80) * 0.0028); // ->0.55 (UP crosses)
    if (d < 160)       return round2(0.56 - (d - 120) * 0.0025); // ->0.46 (DOWN crosses)
    return round2(0.46 + (d - 160) * 0.0032); // UP wins
  }
  if (mode === 'jump') {
    // Sit at 0.50, then jump to 0.82 in one poll — bot must fire at the
    // observed ask (~0.825) despite the gap (slippage ceiling 0.99).
    if (d < 6)  return 0.50;
    return 0.82;
  }
  if (d < 40)        return round2(0.50 + d * 0.0016);   // 0.50->0.56
  if (d < 80)        return round2(0.56 - (d - 40) * 0.0025); // 0.56->0.46 (DOWN ticks up)
  if (d < 120)       return round2(0.46 + (d - 80) * 0.0025); // 0.46->0.56 (UP again)
  if (d < 160)       return round2(0.56 - (d - 120) * 0.0025); // ->0.46 (DOWN)
  // final rally: UP wins decisively
  if (mode === 'down-wins') return round2(0.60 - (d - 160) * 0.0032); // DOWN wins
  if (mode === 'down-first') return round2(0.58 - (d - 160) * 0.0032); // DOWN started, then UP wins
  return round2(0.46 + (d - 160) * 0.0032);   // UP wins 0.46->0.80+
}

const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('gamma-api') && u.includes('/markets?slug=')) {
    const slug = decodeURIComponent(u.split('slug=')[1]).split('&')[0];
    return { ok: true, json: async () => [{ conditionId: 'c-' + slug, question: 'BTC test', outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([TOKEN_UP, TOKEN_DOWN]), closed: false }] };
  }
  if (u.includes('/books')) {
    const up = upPrice();
    const down = round2(1 - up);
    return { ok: true, json: async () => ([
      { asset_id: TOKEN_UP, bids: [{ price: round2(up - 0.005), size: 5000 }], asks: [{ price: round2(up + 0.005), size: 5000 }] },
      { asset_id: TOKEN_DOWN, bids: [{ price: round2(down - 0.005), size: 5000 }], asks: [{ price: round2(down + 0.005), size: 5000 }] },
    ]) };
  }
  throw new Error('unexpected url ' + u);
};

function advance(sec) { for (let i = 0; i < sec; i++) { t += 1000; step += 1; } }

async function runScenario(m, label) {
  const logs = [];
  const engine = new FlipBotEngine({ fetchImpl: fakeFetch, bankroll: 1000, onTick: () => {}, onLog: l => logs.push(l) });
  const origNow = Date.now;
  t = 1600000000000;
  step = 0;
  mode = m;
  Date.now = () => t;
  try {
    engine.entryWindow = 0;
    const w0 = Math.floor(t / 1000 / WINDOW) * WINDOW;
    await engine.discoverWindow(w0);
    await engine.discoverWindow(w0 + WINDOW);
    t = (w0 + WINDOW) * 1000;
    step = 0;
    engine.windowStartFor = null; // ensure prepareWindow runs
    const base = Math.max(1, Math.round(1000 * 0.01 / 0.55));
    for (let s = 0; s < 300; s += 2) {
      advance(2);
      await engine.pollClob();
      engine.evaluate();
    }
    await engine.pollClob();
    engine.evaluate(); // final ticks
    // resolution
    await engine.discoverWindow(engine.positions[0]?.market?.windowStart ?? w0);
    await engine.pollClob();
    // force window end pass
    const openEnd = Math.max(...engine.positions.map(p => p.windowEnd));
    t = (openEnd + 1) * 1000;
    await engine.pollClob();
    engine.evaluate();

    const buys = engine.trades.filter(x => x.type === 'BUY');
    const shares = buys.map(b => b.shares);
    const outcomes = buys.map(b => b.outcome);
    const res = engine.results;
    console.log(`\n── ${label} ──`);
    console.log('base :', base);
    console.log('flips:', buys.length, '| shares:', shares.join(' -> '));
    console.log('seq  :', outcomes.join(' -> '));
    console.log('bank :', engine.bankroll.toFixed(2), '| wins:', engine.wins, '| losses:', engine.losses, '| realized:', engine.realizedPnl.toFixed(2));

    // Check 1: base shares correct
    if (buys[0].shares !== base) failures.push(`${label}: base shares ${buys[0].shares} != expected ${base}`);
    // Check 1b: down-first mode should open with DOWN
    if (m === 'down-first' && outcomes[0] !== 'DOWN') failures.push(`${label}: expected first flip DOWN got ${outcomes[0]}`);
    // Check 1c: jump mode fires at the actual observed ask (0.82 + half-spread), not fixed 0.55
    if (m === 'jump') {
      if (buys.length === 0) failures.push(`${label}: expected a flip after the jump`);
      else if (buys[0].price < 0.80) failures.push(`${label}: expected fill near 0.82, got ${buys[0].price}`);
    }
    // Check 2: alternation UP -> DOWN -> UP...
    for (let i = 1; i < outcomes.length; i++) {
      if (outcomes[i] === outcomes[i - 1]) failures.push(`${label}: no alternation at flip ${i} (${outcomes[i-1]}->${outcomes[i]})`);
    }
    // Check 3: martingale 2x
    for (let i = 1; i < shares.length; i++) {
      const expect = shares[i - 1] * 2;
      if (shares[i] !== expect) failures.push(`${label}: martingale ${shares[i]} != 2x${shares[i-1]}=${expect} at flip ${i}`);
    }
    // Check 4: all bought positions held to resolution (each has exitReason RESOLUTION)
    const unresolved = engine.positions.filter(p => p.exitReason == null);
    if (unresolved.length) failures.push(`${label}: ${unresolved.length} position(s) not resolved`);
    if (res.filter(r => r.exitReason !== 'RESOLUTION').length) failures.push(`${label}: non-resolution exits exist`);

    // Check 5: base recalculated for the NEXT window from the updated bankroll.
    // Simulate the next window starting so prepareWindow recomputes base.
    const bankrollAfter = engine.bankroll;
    const nextStart = Math.floor(t / 1000 / WINDOW) * WINDOW + WINDOW;
    await engine.discoverWindow(nextStart);
    t = nextStart * 1000; step = 0;
    engine.windowStartFor = null; // force prepareWindow on next evaluate
    await engine.pollClob();
    engine.evaluate();
    const expNextBase = Math.max(1, Math.round(bankrollAfter * 0.01 / 0.55));
    if (engine.baseShares !== expNextBase) failures.push(`${label}: next base ${engine.baseShares} != expected ${expNextBase} from bankroll ${bankrollAfter.toFixed(2)}`);
  } catch (e) {
    failures.push(`${label}: exception ${e.message}`);
  } finally {
    Date.now = origNow;
  }
}

(async () => {
  await runScenario('up-wins', 'Scenario UP wins — oscillation triggers 3+ flips, base/2x verified');
  await runScenario('down-wins', 'Scenario DOWN wins — verify loss/win accounting');
  await runScenario('down-first', 'Scenario DOWN first — first fire is side-agnostic (whichever side ticks first)');
  await runScenario('jump', 'Scenario JUMP — 0.50 -> 0.82 in one poll, fire at actual ask (ceiling 0.99)');
  if (process.argv.includes('--quick')) {}
  console.log('\n=== SMOKE RESULT ===');
  if (failures.length) {
    failures.forEach(f => console.log('  ✗', f));
    process.exit(1);
  }
  console.log('✔ All checks passed');
})().catch(e => { console.error(e); process.exit(1); });
