'use strict';
const { BtcBreakoutEngine } = require('../engine');

function mockFetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }

function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch(e) { console.log(`  ✗ ${label}: ${e.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Test 1: Verify doubling pattern
console.log('\n=== Verify doubling pattern ===');
{
  const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
  assert(eng.calculateShares(0) === 20, 'flip 0 = 20');
  assert(eng.calculateShares(1) === 40, 'flip 1 = 40');
  assert(eng.calculateShares(2) === 80, 'flip 2 = 80');
  assert(eng.calculateShares(3) === 160, 'flip 3 = 160');
  assert(eng.calculateShares(4) === 320, 'flip 4 = 320');
  assert(eng.calculateShares(5) === 640, 'flip 5 = 640');
  assert(eng.calculateShares(6) === 1280, 'flip 6 = 1280');
  assert(eng.calculateShares(7) === 1280, 'flip 7+ caps at 1280');
  console.log('  Pattern: 20, 40, 80, 160, 320, 640, 1280 ✓');
}

// Test 2: Full window with flips, verify settlement
console.log('\n=== Full window: entry + 3 flips ===');
{
  const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
  eng.currentStart = Math.floor(Date.now() / 300) * 300;
  const slug = `btc-updown-5m-${eng.currentStart}`;
  const up = eng.makeToken('u', slug, 'UP');
  const down = eng.makeToken('d', slug, 'DOWN');
  eng.markets.set(slug, { slug, windowStart: eng.currentStart, windowEnd: eng.currentStart + 300, settled: false, winner: null, up, down, finalUpMax: null, finalDownMax: null, resolutionSource: null });

  // Entry: UP 20 @ 0.60
  up.ask = 0.60; up.bid = 0.58; up.mid = 0.59;
  eng.enterPosition(eng.markets.get(slug), up, 0.60);
  assert(eng.accumUpShares === 20, `entry: accumUp=20 (got ${eng.accumUpShares})`);
  const sunk1 = eng.windowSunkCost;

  // Flip 1: DOWN 40 @ 0.60
  down.ask = 0.60; down.bid = 0.58; down.mid = 0.59;
  eng.flipPosition(eng.markets.get(slug), down);
  assert(eng.accumDownShares === 40, `flip1: accumDown=40 (got ${eng.accumDownShares})`);
  assert(eng.accumUpShares === 20, `flip1: accumUp still 20 (got ${eng.accumUpShares})`);
  
  // Flip 2: UP 80 @ 0.60
  up.ask = 0.60; up.bid = 0.58; up.mid = 0.59;
  eng.flipPosition(eng.markets.get(slug), up);
  assert(eng.accumUpShares === 100, `flip2: accumUp=100 (got ${eng.accumUpShares})`);
  
  // Flip 3: DOWN 160 @ 0.60
  down.ask = 0.60; down.bid = 0.58; down.mid = 0.59;
  eng.flipPosition(eng.markets.get(slug), down);
  assert(eng.accumDownShares === 200, `flip3: accumDown=200 (got ${eng.accumDownShares})`);
  
  const sunk = eng.windowSunkCost;
  console.log(`  After 3 flips: accumUp=${eng.accumUpShares} accumDown=${eng.accumDownShares} sunk=$${sunk.toFixed(2)}`);
  
  // Resolution: UP wins
  eng.markets.get(slug).finalUpMax = 0.95;
  eng.markets.get(slug).finalDownMax = 0.10;
  eng.settleWindow(eng.markets.get(slug));
  
  const payout = 100; // accumUp × $1
  const net = payout - sunk;
  console.log(`  UP wins: payout=${eng.accumUpShares}×$1=$${eng.accumUpShares}, sunk=$${sunk.toFixed(2)}, net=$${net.toFixed(2)}`);
  assert(Math.abs(eng.realizedPnl - net) < 0.01, `realizedPnl=$${eng.realizedPnl.toFixed(2)}`);
}

// Test 3: Verify cost at flip 6 doesn't exceed MAX_WINDOW_INVESTMENT ($2000)
console.log('\n=== Max window investment check ===');
{
  const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
  eng.currentStart = Math.floor(Date.now() / 300) * 300 + 600;
  const slug = `btc-updown-5m-${eng.currentStart}`;
  const up = eng.makeToken('u2', slug, 'UP');
  const down = eng.makeToken('d2', slug, 'DOWN');
  eng.markets.set(slug, { slug, windowStart: eng.currentStart, windowEnd: eng.currentStart + 300, settled: false, winner: null, up, down, finalUpMax: null, finalDownMax: null, resolutionSource: null });

  up.ask = 0.60; up.bid = 0.58; up.mid = 0.59;
  down.ask = 0.60; down.bid = 0.58; down.mid = 0.59;
  
  eng.enterPosition(eng.markets.get(slug), up, 0.60);
  
  const costs = [eng.windowSunkCost];
  for (let i = 0; i < 6; i++) {
    const token = i % 2 === 0 ? down : up;
    eng.flipPosition(eng.markets.get(slug), token);
    costs.push(eng.windowSunkCost);
  }
  
  console.log(`  Sunk cost progression: ${costs.map(c => '$' + c.toFixed(0)).join(' → ')}`);
  console.log(`  Final sunk: $${eng.windowSunkCost.toFixed(2)} (MAX=$2000)`);
  assert(eng.windowSunkCost <= 2000, `under MAX ($${eng.windowSunkCost.toFixed(2)})`);
}

// Test 4: Different entry prices
console.log('\n=== Entry at various prices ===');
{
  for (const price of [0.50, 0.55, 0.60]) {
    const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
    eng.currentStart = Math.floor(Date.now() / 300) * 300 + 900;
    const slug = `btc-updown-5m-${eng.currentStart}`;
    const up = eng.makeToken('u3', slug, 'UP');
    const down = eng.makeToken('d3', slug, 'DOWN');
    eng.markets.set(slug, { slug, windowStart: eng.currentStart, windowEnd: eng.currentStart + 300, settled: false, winner: null, up, down, finalUpMax: null, finalDownMax: null, resolutionSource: null });
    
    up.ask = price; up.bid = price - 0.02; up.mid = price - 0.01;
    eng.enterPosition(eng.markets.get(slug), up, price);
    console.log(`  @${price}: 20 SH cost=$${(20 * price).toFixed(2)}`);
    assert(eng.accumUpShares === 20, `always 20 initial shares at ${price}`);
  }
}

console.log('\n=== ALL TESTS PASSED ===\n');
