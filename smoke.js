'use strict';
const { CheapHunterEngine } = require('./engine');

const WINDOW = 300;
const CHEAP = 0.20;
const START = 300;

const FIRST_WINDOW = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

let step = 0, mode = null, nowMs = 0;

function askOf(p) { return Math.round((p + 0.005) * 100) / 100; }

// At entry time (step ≥ 29): bot sees DOWN ≤ 0.20, buys DOWN.
// cheap-win: DOWN WINS at resolution (DN price → high)
// cheap-lose: DOWN LOSES at resolution (DN price → low)
function upPrice() {
  const d = step;
  if (mode === 'no-cheap')   return d < 29 ? 0.50 : 0.55;
  if (mode === 'cheap-tp')   return d < 29 ? 0.50 : (d < 80 ? 0.85 : 0.45);
  // cheap-win or cheap-lose: UP starts at 0.80, then at resolution...
  const during = 0.80;
  const resUp = (mode === 'cheap-win') ? 0.10 : 0.90; // cheap-win → UP loses; cheap-lose → UP wins
  return d < 29 ? 0.50 : (d < 250 ? during : resUp);
}
function dnPrice() {
  const d = step;
  if (mode === 'no-cheap')   return d < 29 ? 0.50 : 0.48;
  if (mode === 'cheap-tp')   return d < 29 ? 0.50 : (d < 80 ? 0.15 : 0.55);
  // cheap-win or cheap-lose: DOWN starts at 0.15 (cheap), then at resolution...
  const during = 0.15;
  const resDn = (mode === 'cheap-win') ? 0.90 : 0.10; // cheap-win → DN wins; cheap-lose → DN loses
  return d < 29 ? 0.50 : (d < 250 ? during : resDn);
}

const windowTokens = {};

function fakeFetch(url) {
  if (url.includes('gamma-api')) {
    const slug = url.match(/slug=(btc-updown-5m-\d+)/)?.[1] || 'test';
    const wStart = parseInt(slug.split('-').pop()) || 0;
    const tokUp = `tok_up_${wStart}`;
    const tokDn = `tok_dn_${wStart}`;
    windowTokens[wStart] = { up: tokUp, dn: tokDn };
    return Promise.resolve({ ok: true, json: () => Promise.resolve([{
      id: `evt_${wStart}`, markets: [{
        id: `mkt_${wStart}`, question: `BTC ${wStart}`,
        tokens: [{ token_id: tokUp, outcome: 'Yes' }, { token_id: tokDn, outcome: 'No' }],
        clobTokenIds: [tokUp, tokDn]
      }]
    }]) });
  }
  const up = upPrice(), dn = dnPrice();
  const books = {};
  for (const wStart of Object.keys(windowTokens)) {
    const wt = windowTokens[wStart];
    books[wt.up] = { asks: [{ price: askOf(up) }], bids: [{ price: Math.max(0.01, askOf(up) - 0.01).toFixed(2) }] };
    books[wt.dn] = { asks: [{ price: askOf(dn) }], bids: [{ price: Math.max(0.01, askOf(dn) - 0.01).toFixed(2) }] };
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
}

async function runWindow(engine, wStart, m) {
  mode = m;
  step = 0;
  nowMs = wStart * 1000;
  Date.now = () => nowMs;
  await engine.discoverWindow(wStart);
  await engine.discoverWindow(wStart + WINDOW);
  for (let s = 0; s < WINDOW + 5; s++) {
    await engine.pollClob();
    engine.evaluate();
    nowMs += 1000;
    step += 1;
  }
}

const failures = [];
(async () => {
  // Test 1: cheap side available, wins at resolution
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    await runWindow(engine, FIRST_WINDOW, 'cheap-win');
    const buys = (engine.trades || []).filter(t => t.type === 'BUY');
    console.log('\n── CHEAP-WIN ──');
    console.log('  bank:', engine.bankroll.toFixed(2), '| W:', engine.wins, 'L:', engine.losses, '| buys:', buys.length);
    if (buys.length !== 1) failures.push('CHEAP-WIN: expected 1 buy, got ' + buys.length);
    if (buys[0] && buys[0].price > CHEAP) failures.push('CHEAP-WIN: entry price > 0.20');
    if (engine.wins !== 1) failures.push('CHEAP-WIN: should be 1 win');
    if (engine.bankroll <= START) failures.push('CHEAP-WIN: should profit after win');
  }

  // Test 2: cheap side available, loses at resolution
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    await runWindow(engine, FIRST_WINDOW + WINDOW, 'cheap-lose');
    const buys = (engine.trades || []).filter(t => t.type === 'BUY');
    const sells = (engine.trades || []).filter(t => t.type === 'SELL');
    console.log('\n── CHEAP-LOSE ──');
    console.log('  bank:', engine.bankroll.toFixed(2), '| W:', engine.wins, 'L:', engine.losses, '| buys:', buys.length, 'sells:', sells.length);
    if (buys.length !== 1) failures.push('CHEAP-LOSE: expected 1 buy');
    if (sells.length !== 1) failures.push('CHEAP-LOSE: expected 1 sell at resolution');
    if (engine.losses !== 1) failures.push('CHEAP-LOSE: should be 1 loss');
  }

  // Test 3: no cheap side → skip
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    await runWindow(engine, FIRST_WINDOW + WINDOW * 2, 'no-cheap');
    const buys = (engine.trades || []).filter(t => t.type === 'BUY');
    console.log('\n── NO-CHEAP (skip) ──');
    console.log('  bank:', engine.bankroll.toFixed(2), '| trades:', buys.length);
    if (buys.length !== 0) failures.push('NO-CHEAP: should have 0 trades');
    if (engine.bankroll !== START) failures.push('NO-CHEAP: bankroll should be unchanged');
  }

  // Test 4: multi-window compounding — win, win, skip
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    await runWindow(engine, FIRST_WINDOW + WINDOW * 3, 'cheap-win');
    const bank1 = engine.bankroll;
    await runWindow(engine, FIRST_WINDOW + WINDOW * 4, 'cheap-win');
    const bank2 = engine.bankroll;
    await runWindow(engine, FIRST_WINDOW + WINDOW * 5, 'no-cheap');
    const buys = (engine.trades || []).filter(t => t.type === 'BUY');
    console.log('\n── COMPOUND (2 wins + 1 skip) ──');
    console.log('  bank:', engine.bankroll.toFixed(2), '| W:', engine.wins, 'L:', engine.losses);
    console.log('  after win1: $' + bank1.toFixed(2) + ' | after win2: $' + bank2.toFixed(2) + ' | final: $' + engine.bankroll.toFixed(2));
    if (buys.length !== 2) failures.push('COMPOUND: expected 2 buys, got ' + buys.length);
    if (engine.wins !== 2) failures.push('COMPOUND: expected 2 wins, got ' + engine.wins);
    if (engine.bankroll <= START) failures.push('COMPOUND: should be profitable');
    if (bank2 <= bank1) failures.push('COMPOUND: second win should grow capital');
  }

  // Test 5: win+loss combo — verify P&L math
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    await runWindow(engine, FIRST_WINDOW + WINDOW * 6, 'cheap-win');
    const bankAfterWin = engine.bankroll;
    await runWindow(engine, FIRST_WINDOW + WINDOW * 7, 'cheap-lose');
    console.log('\n── WIN + LOSS ──');
    console.log('  after win: $' + bankAfterWin.toFixed(2) + ' | after loss: $' + engine.bankroll.toFixed(2) + ' | W:', engine.wins, 'L:', engine.losses);
    if (engine.wins !== 1 || engine.losses !== 1) failures.push('WIN+LOSS: should be 1W 1L');
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('✔ All checks passed');
  else failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
