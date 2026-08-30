'use strict';
// Internal smoke test — drives the flip bot through simulated windows.
// Strategy verification (v3):
//  1. Wait WAIT_SECONDS (7s) after window start — no fire before that.
//  2. First entry: ANY side's ask ticks >= ENTRY_PRICE (0.70), base = 1% of
//     capital in shares (1000 * 0.01 / 0.70 = 14). Held to resolution unless SL.
//  3. Stop loss: if held side mid <= SL_PRICE (0.50), sell immediately at 0.50.
//  4. Re-entry: after SL, wait for ANY side's ask >= REENTRY_PRICE (0.65) and
//     fire with DOUBLE the shares. Repeat per SL — doubling is unlimited.
//  5. Hold to resolution: winner pays 1.0, loser 0.
//  6. Base recalculated from updated capital for the next window.

const { FlipBotEngine } = require('./engine');

const WINDOW = 300;
const WAIT = 7;
const ENTRY = 0.70;
const SL = 0.50;
const REENTRY = 0.65;
const TOKEN_UP = 'token-up';
const TOKEN_DOWN = 'token-down';

let t = 1600000000000;
let step = 0;
let mode = null;
const failures = [];
function round2(v) { return Math.round(v * 100) / 100; }

// Price path over a window; DOWN = 1 - UP. The book is built from the observed
// up price: ask = observed + 0.005, mid = observed. Engine fires on ask and
// checks SL on mid.
function upPrice() {
  const d = step;
  if (mode === 'wait-gate') {
    // Before 7s the ask must NOT reach 0.70; right after it does.
    if (d < 6) return 0.50;                    // during wait (elapsed < 7)
    if (d < 250) return 0.72;                  // ask 0.725 >= 0.70 -> ENTRY UP
    return 0.82;                               // hold, UP wins
  }
  if (mode === 'any-down') {
    // DOWN is the first side to reach 0.70 (up stays low).
    if (d < 6) return 0.50;
    if (d < 250) return 0.28;                  // DOWN ask ~0.725 -> ENTRY DOWN
    return 0.26;                               // DOWN holds, DOWN wins
  }
  if (mode === 'up-hold') {
    if (d < 6) return 0.50;
    if (d < 250) return 0.75;                  // UP ask 0.755 -> ENTRY UP, never SL
    return 0.90;                               // UP wins
  }
  if (mode === 'down-hold') {
    if (d < 6) return 0.50;
    if (d < 250) return 0.25;                  // DOWN ask ~0.755 -> ENTRY DOWN, never SL
    return 0.22;                               // DOWN wins
  }
  // mode === 'reentry' (default): cycles through 0.70 entry, 0.50 SL, distinct
  // 0.65+ re-entry levels so each fill differs (avoids lastFireTick re-fire guard).
  if (d < 6) return 0.50;
  if (d < 49) return 0.72;              // ENTRY#1 UP @ 0.725 (14)
  if (d < 99) return 0.45;              // UP SL @ 0.50
  if (d < 149) return 0.66;             // RE-ENTRY @ 0.665 (28)
  if (d < 199) return 0.45;             // SL again
  if (d < 249) return 0.67;             // RE-ENTRY @ 0.675 (56)
  if (d < 269) return 0.45;             // SL again
  if (d < 299) return 0.68;             // RE-ENTRY @ 0.685 (112)
  return 0.90;                          // hold, UP wins
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

    const expectedBase = Math.max(1, Math.round(1000 * 0.01 / ENTRY));
    let preWaitBuys = 0;

    for (let s = 0; s < 300; s += 2) {
      advance(2);
      await engine.pollClob();
      engine.evaluate();
      const elapsed = Math.floor(t / 1000 - (w0 + WINDOW));
      if (elapsed === 6) {
        // Just before the wait gate passes: capture buys so far.
        preWaitBuys = engine.trades.filter(x => x.type === 'BUY').length;
      }
    }
    await engine.pollClob();
    engine.evaluate(); // final ticks
    // window being traded = w0 + WINDOW
    const openEnd = (w0 + WINDOW) + WINDOW;
    // resolution
    await engine.discoverWindow(engine.positions[0]?.market?.windowStart ?? w0);
    await engine.pollClob();
    t = (openEnd + 1) * 1000;
    await engine.pollClob();
    engine.evaluate();

    const buys = engine.trades.filter(x => x.type === 'BUY');
    const sells = engine.trades.filter(x => x.type === 'SELL');
    const shares = buys.map(b => b.shares);
    const fillPrices = buys.map(b => b.price);
    const outcomes = buys.map(b => b.outcome);
    const res = engine.results;
    console.log(`\n── ${label} ──`);
    console.log('base :', expectedBase);
    console.log('entries:', buys.length, '| shares:', shares.join(' -> '));
    console.log('fills :', fillPrices.map(p => p.toFixed(3)).join(' -> '));
    console.log('seq   :', outcomes.join(' -> '));
    const sls = sells.filter(s => s.reason === 'STOP_LOSS');
    const resSells = sells.filter(s => s.reason === 'RESOLUTION');
    console.log('SL@0.50:', sls.map(s => s.shares + 'sh').join(' -> ') || 'none', '| resolved:', resSells.map(s => s.outcome + '@' + s.sharePrice).join(' ') || 'none');
    console.log('bank  :', engine.bankroll.toFixed(2), '| wins:', engine.wins, '| losses:', engine.losses, '| realized:', engine.realizedPnl.toFixed(2));

    // ---- WAIT GATE (only for wait-gate mode) ----
    if (m === 'wait-gate') {
      if (preWaitBuys !== 0) failures.push(`${label}: fired before the ${WAIT}s wait gate (${preWaitBuys} buys at 6s)`);
      if (buys.length < 1) failures.push(`${label}: expected an entry after the wait gate`);
      else if (outcomes[0] !== 'UP') failures.push(`${label}: expected UP first, got ${outcomes[0]}`);
    }

    // ---- FIRST-FIRE SIDE-AGNOSTIC (only for any-down) ----
    if (m === 'any-down') {
      if (buys.length < 1) failures.push(`${label}: expected a first fire`);
      else if (outcomes[0] !== 'DOWN') failures.push(`${label}: expected DOWN first (side-agnostic), got ${outcomes[0]}`);
    }

    // ---- Base shares check ----
    if (buys.length && buys[0].shares !== expectedBase) failures.push(`${label}: base shares ${buys[0].shares} != expected ${expectedBase}`);

    // ---- Entry fill prices: first at/above 0.70, re-entries at/above 0.65 ----
    for (let i = 0; i < buys.length; i++) {
      const b = buys[i];
      const need = i === 0 ? ENTRY : REENTRY;
      if (b.price < need - 0.0001) failures.push(`${label}: entry#${i + 1} fill ${b.price} below target ${need}`);
    }

    // ---- Re-entry doubling (2x) ----
    for (let i = 1; i < shares.length; i++) {
      const expect = shares[i - 1] * 2;
      if (shares[i] !== expect) failures.push(`${label}: shares ${shares[i]} != 2x${shares[i - 1]}=${expect} at entry ${i + 1}`);
    }

    // ---- SL works: sells marked STOP_LOSS at 0.50 ----
    const slPrices = sls.map(s => s.price);
    for (const p of slPrices) { if (Math.abs(p - SL) > 0.0001) failures.push(`${label}: SL sold at ${p} != ${SL}`); }

    // ---- No unresolved positions remain ----
    if (engine.positions.filter(p => p.exitReason == null).length) failures.push(`${label}: position(s) not resolved`);
    if (res.filter(r => r.exitReason !== 'RESOLUTION' && r.exitReason !== 'STOP_LOSS').length) failures.push(`${label}: unexpected exit reason in results`);

    // ---- Re-entry count / entryTarget reflect the final state ----
    if (m === 'reentry') {
      const slCount = sls.length;
      if (engine.reentryCount !== slCount) failures.push(`${label}: reentryCount ${engine.reentryCount} != SL count ${slCount}`);
      if (engine.trades.filter(x => x.type === 'SELL' && x.reason === 'STOP_LOSS').length !== 3) failures.push(`${label}: expected 3 stop-losses, got ${sls.length}`);
    }

    // ---- Next window base recomputed from updated bankroll ----
    const bankrollAfter = engine.bankroll;
    const nextStart = Math.floor(t / 1000 / WINDOW) * WINDOW + WINDOW;
    await engine.discoverWindow(nextStart);
    t = nextStart * 1000; step = 0;
    engine.windowStartFor = null; // force prepareWindow on next evaluate
    await engine.pollClob();
    engine.evaluate();
    const expNextBase = Math.max(1, Math.round(bankrollAfter * 0.01 / ENTRY));
    if (engine.baseShares !== expNextBase) failures.push(`${label}: next base ${engine.baseShares} != expected ${expNextBase} from bankroll ${bankrollAfter.toFixed(2)}`);
  } catch (e) {
    failures.push(`${label}: exception ${e.message}`);
  } finally {
    Date.now = origNow;
  }
}

(async () => {
  await runScenario('reentry', 'Scenario RE-ENTRY — 0.70 entry -> SL@0.50 -> 0.65 re-entry x2 x4 x8 (unlimited doubling)');
  await runScenario('wait-gate', 'Scenario WAIT-GATE — no fire before 7s, entry right after');
  await runScenario('any-down', 'Scenario ANY-SIDE — first fire is DOWN (side-agnostic)');
  await runScenario('up-hold', 'Scenario UP-HOLD — enter UP, no SL, UP wins at resolution');
  await runScenario('down-hold', 'Scenario DOWN-HOLD — enter DOWN, no SL, DOWN wins at resolution');
  console.log('\n=== SMOKE RESULT ===');
  if (failures.length) {
    failures.forEach(f => console.log('  ✗', f));
    process.exit(1);
  }
  console.log('✔ All checks passed');
})().catch(e => { console.error(e); process.exit(1); });
