'use strict';
// Internal smoke test — drives the flip bot through simulated windows.
// Strategy verification (v5):
//  1. Wait WAIT_SECONDS (45s) after window start — no fire before that.
//  2. First entry: ANY side's ask AT/BELOW ENTRY_PRICE (0.70) — the bot waits
//     for a pullback to 0.70 and never fires above it. Start size = base
//     (1% of capital) unless a carried martingale is active.
//  3. Stop loss: held side mid <= SL_PRICE (0.50) → sell immediately at 0.50.
//  4. Re-entry after SL: wait for ANY side's ask >= REENTRY_PRICE (0.65), fire
//     with DOUBLE shares; ceiling 0.99 is slippage-only there. Capped at
//     MAX_MARTINGALE (2) steps per window (so up to 3 entries: S -> 2S -> 4S).
//  5. Carry-over: if the LAST (max) martingale hits SL or loses at resolution,
//     that size carries to the next window (escalating: 14→28→56, lose ⇒
//     56→112→224, …). A clean win resets start back to base.

const { FlipBotEngine } = require('./engine');

const WINDOW = 300;
const WAIT = 45;
const ENTRY = 0.70;
const SL = 0.50;
const REENTRY = 0.65;
const MAX_M = 2;
const TOKEN_UP = 'token-up';
const TOKEN_DOWN = 'token-down';

let t = 1600000000000;
let step = 0;
let mode = null;
const failures = [];
function round2(v) { return Math.round(v * 100) / 100; }

// Window-relative price path (step resets to 0 each window). DOWN = 1 - UP.
function upPrice() {
  const d = step;
  if (mode === 'win') {
    // Single entry that holds and wins (never hits SL).
    if (d < 46) return 0.50;
    if (d < 250) return 0.695;                 // ENTRY @ ask 0.700 (start S)
    return 0.90;                               // hold, UP wins
  }
  if (mode === 'any-down') {
    if (d < 46) return 0.50;
    if (d < 250) return 0.70;                  // UP ask 0.705 > 0.70 ineligible; DOWN ask 0.305 <= 0.70 -> ENTRY DOWN
    return 0.26;                               // DOWN holds, DOWN wins
  }
  if (mode === 'wait-gate') {
    if (d < 46) return 0.50;
    if (d < 250) return 0.695;                 // ask 0.700 at/below after wait
    return 0.82;                               // UP wins
  }
  // mode === 'all-sl': start S @0.70 -> SL -> 2S @0.65 -> SL -> 4S @0.65 -> SL
  // (max martingale reached, carry 4S). Distinct re-entry levels avoid the
  // lastFireTick re-fire guard.
  if (d < 46) return 0.50;
  if (d < 96) return 0.695;             // ENTRY#1 (start S) @ ask 0.700
  if (d < 146) return 0.45;             // SL#1 @ 0.50
  if (d < 196) return 0.66;             // ENTRY#2 (2S) @ 0.665
  if (d < 246) return 0.45;             // SL#2
  if (d < 296) return 0.67;             // ENTRY#3 (4S) @ 0.675
  return 0.45;                          // SL#3 -> cap, carry 4S
}

function askOf(price) { return round2(price + 0.005); }

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
      { asset_id: TOKEN_UP, bids: [{ price: round2(up - 0.005), size: 5000 }], asks: [{ price: askOf(up), size: 5000 }] },
      { asset_id: TOKEN_DOWN, bids: [{ price: round2(down - 0.005), size: 5000 }], asks: [{ price: askOf(down), size: 5000 }] },
    ]) };
  }
  throw new Error('unexpected url ' + u);
};

function advance(sec) { for (let i = 0; i < sec; i++) { t += 1000; step += 1; } }

// Run a single 300s window from `startMs` with the given price mode. Returns
// { trades, buys, sells, res, bankroll, windowStartShares, carryShares,
//   startSharesPerWindow } snapshot captured BEFORE the window is overwritten.
async function runWindow(engine, startMs, m) {
  mode = m;
  t = startMs * 1000;
  const w0 = startMs;
  step = 0;
  engine.windowStartFor = null;          // force prepareWindow on next evaluate
  await engine.discoverWindow(w0);
  await engine.discoverWindow(w0 + WINDOW);
  let elapsedPreWait = 0;
  let startShares = null;
  let startCarry = null;
  for (let s = 0; s < 300; s += 2) {
    advance(2);
    await engine.pollClob();
    engine.evaluate();
    const elapsed = Math.floor(t / 1000 - w0);
    if (startShares === null) { startShares = engine.windowStartShares ?? engine.nextShares; startCarry = engine.carryShares || 0; }
    if (elapsed === 6) elapsedPreWait = engine.trades.filter(x => x.type === 'BUY').length;
  }
  await engine.pollClob();
  engine.evaluate();
  return { w0, elapsedPreWait, startShares, startCarry };
}

async function resolve(engine, openEnd) {
  await engine.pollClob();
  t = (openEnd + 1) * 1000;
  await engine.pollClob();
  engine.evaluate();
}

async function fullScenario(name, windows) {
  const engine = new FlipBotEngine({ fetchImpl: fakeFetch, bankroll: 1000, onTick: () => {}, onLog: () => {} });
  const origNow = Date.now;
  t = 1600000000000;
  mode = null;
  Date.now = () => t;
  try {
    engine.entryWindow = 0;
    const firstW = Math.floor(t / 1000 / WINDOW) * WINDOW;
    await engine.discoverWindow(firstW);
    await engine.discoverWindow(firstW + WINDOW);
    let wStart = firstW + WINDOW;         // first tradeable window
    const carried = [];
    for (const w of windows) {
      const rw = await runWindow(engine, wStart, w.mode);
      // resolve window (wStart)
      await engine.discoverWindow(wStart);
      await resolve(engine, wStart + WINDOW);
      carried.push({ start: rw.startShares, carry: engine.carryShares });
      if (w.expectCarry != null && engine.carryShares !== w.expectCarry) failures.push(`${name} W${w.i}: carry ${engine.carryShares} != expected ${w.expectCarry}`);
      if (w.expectStart != null && rw.startShares !== w.expectStart) failures.push(`${name} W${w.i}: start ${rw.startShares} != expected ${w.expectStart}`);
      if (w.preWait != null && rw.elapsedPreWait !== w.preWait) failures.push(`${name} W${w.i}: pre-wait buys ${rw.elapsedPreWait} != expected ${w.preWait}`);
      if (w.expectNoLostRes != null) {
        const lostRes = engine.results.filter(r => r.exitReason === 'RESOLUTION' && !r.won);
        if (w.expectNoLostRes && lostRes.length) failures.push(`${name} W${w.i}: expected no lost resolution, got ${lostRes.length}`);
      }
      wStart += WINDOW;
    }
    console.log(`\n── ${name} ──`);
    carried.forEach((c, i) => console.log(`  W${i + 1}: start ${c.start}sh · carry ${c.carry}sh`));
    console.log('  bank:', engine.bankroll.toFixed(2), '| wins:', engine.wins, '| losses:', engine.losses);
    return engine;
  } finally {
    Date.now = origNow;
  }
}

(async () => {
  // SCENARIO 1: all three entries SL -> cap -> carry 56 to next window; then
  // next window escalates 56->112->224 and SLs -> carry 224.
  {
    const e = await fullScenario('CAP-CARRY (all SL), escalation', [
      { i: 1, mode: 'all-sl', expectStart: 14, expectCarry: 56 },
      { i: 2, mode: 'all-sl', expectStart: 56, expectCarry: 224 },
    ]);
    const w1 = e.trades.filter(x => x.type === 'BUY' && x.timestamp < (e.trades[0]?.timestamp + 999999));
    // shares in window1: 14->28->56, window2: 56->112->224
    const w1Shares = [];
    const w2Shares = [];
    // Partition buys by entryNo reset — simpler: check overall pattern.
    const allShares = e.trades.filter(x => x.type === 'BUY').map(b => b.shares);
    const half = allShares.length / 2;
    for (let i = 0; i < half; i++) w1Shares.push(allShares[i]);
    for (let i = half; i < allShares.length; i++) w2Shares.push(allShares[i]);
    const expW1 = [14, 28, 56], expW2 = [56, 112, 224];
    if (JSON.stringify(w1Shares) !== JSON.stringify(expW1)) failures.push(`CAP-CARRY: window1 shares ${w1Shares} != ${expW1}`);
    if (JSON.stringify(w2Shares) !== JSON.stringify(expW2)) failures.push(`CAP-CARRY: window2 shares ${w2Shares} != ${expW2}`);
    if (e.trades.filter(x => x.type === 'SELL' && x.reason === 'STOP_LOSS').length !== 6) failures.push(`CAP-CARRY: expected 6 SLs, got ${e.trades.filter(x => x.type === 'SELL' && x.reason === 'STOP_LOSS').length}`);
  }

  // SCENARIO 2: after a carried win, reset to base.
  {
    const e = await fullScenario('CARRY-RESET (carried win)', [
      { i: 1, mode: 'all-sl', expectStart: 14, expectCarry: 56 },
      { i: 2, mode: 'win', expectStart: 56, expectCarry: 0 },
      { i: 3, mode: 'win', expectStart: null, expectCarry: 0 },
    ]);
    // W3 should start at BASE (~14 from current bankroll), not 56.
    const buys = e.trades.filter(x => x.type === 'BUY');
    if (buys[buys.length - 1].shares !== e.baseShares) failures.push(`CARRY-RESET: window3 start ${buys[buys.length-1].shares} != base ${e.baseShares} — carry not reset`);
  }

  // SCENARIO 3: wait gate + side-agnostic single windows routed through the
  // full harness so nothing regresses.
  {
    const e = await fullScenario('WAIT-GATE & ANY-SIDE', [
      { i: 1, mode: 'wait-gate', expectStart: 14, expectCarry: 0, preWait: 0 },
    ]);
    const buys = e.trades.filter(x => x.type === 'BUY');
    if (buys.length < 1) failures.push('WAIT-GATE: no entry');
    else if (buys[0].outcome !== 'UP') failures.push(`WAIT-GATE: expected UP, got ${buys[0].outcome}`);
  }
  {
    const e = await fullScenario('ANY-SIDE DOWN', [
      { i: 1, mode: 'any-down', expectStart: 14, expectCarry: 0 },
    ]);
    const buys = e.trades.filter(x => x.type === 'BUY');
    if (buys.length < 1) failures.push('ANY-SIDE: no entry');
    else if (buys[0].outcome !== 'DOWN') failures.push(`ANY-SIDE: expected DOWN, got ${buys[0].outcome}`);
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length) {
    failures.forEach(f => console.log('  ✗', f));
    process.exit(1);
  }
  console.log('✔ All checks passed');
})().catch(e => { console.error(e); process.exit(1); });
