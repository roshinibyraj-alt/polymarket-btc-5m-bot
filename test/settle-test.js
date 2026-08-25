'use strict';

const { BtcBreakoutEngine } = require('../engine');

// Mock fetch that returns fake CLOB quotes
function mockFetch(url, opts) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  });
}

function createEngine() {
  return new BtcBreakoutEngine({
    fetchImpl: mockFetch,
    onTick: () => {},
    onLog: (line) => { if (process.env.DEBUG) console.log(line); },
  });
}

function assert(condition, msg) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// Test 1: Entry + single flip + resolution
console.log('\n=== Test 1: Entry → Flip → Resolution ===');
{
  const eng = createEngine();
  eng.currentStart = Math.floor(Date.now() / 300) * 300;
  const slug = `btc-updown-5m-${eng.currentStart}`;
  
  // Mock market
  const upToken = eng.makeToken('up-1', slug, 'UP');
  const downToken = eng.makeToken('down-1', slug, 'DOWN');
  eng.markets.set(slug, {
    slug, title: 'BTC Test', windowStart: eng.currentStart, windowEnd: eng.currentStart + 300,
    settled: false, winner: null, up: upToken, down: downToken,
    finalUpMax: null, finalDownMax: null, resolutionSource: null,
  });

  // Entry: buy UP at 0.60
  upToken.ask = 0.60;
  upToken.bid = 0.58;
  upToken.mid = 0.59;
  eng.enterPosition(eng.markets.get(slug), upToken, 0.60);
  
  assert(eng.accumUpShares === 25, `accumUp = ${eng.accumUpShares} (expected 25)`);
  assert(eng.accumDownShares === 0, `accumDown = ${eng.accumDownShares} (expected 0)`);
  const sunkAfterEntry = eng.windowSunkCost;
  console.log(`  After entry: bankroll=$${eng.bankroll.toFixed(2)}, sunk=$${sunkAfterEntry.toFixed(2)}`);

  // Flip to DOWN at 0.60
  upToken.ask = 0.60;
  downToken.ask = 0.60;
  eng.flipPosition(eng.markets.get(slug), downToken);
  
  assert(eng.accumUpShares === 25, `accumUp still 25 after flip = ${eng.accumUpShares}`);
  assert(eng.accumDownShares === 63, `accumDown = ${eng.accumDownShares} (expected 63)`);
  assert(eng.openPosition.outcome === 'DOWN', `openPosition is DOWN`);
  const sunkAfterFlip = eng.windowSunkCost;
  console.log(`  After flip: bankroll=$${eng.bankroll.toFixed(2)}, sunk=$${sunkAfterFlip.toFixed(2)}`);

  // Resolution: DOWN wins
  eng.markets.get(slug).finalUpMax = 0.10;
  eng.markets.get(slug).finalDownMax = 0.95;
  const bankrollBefore = eng.bankroll;
  eng.settleWindow(eng.markets.get(slug));
  
  const expectedPayout = 63; // accumDown × $1
  const expectedNet = expectedPayout - sunkAfterFlip;
  console.log(`  After settle: bankroll=$${eng.bankroll.toFixed(2)}, realizedPnl=$${eng.realizedPnl.toFixed(2)}`);
  assert(Math.abs(eng.bankroll - (bankrollBefore + expectedPayout)) < 0.01, 
    `bankroll = bankrollBefore + payout ($${expectedPayout})`);
  assert(Math.abs(eng.realizedPnl - expectedNet) < 0.01, 
    `realizedPnl = $${expectedNet.toFixed(2)} (payout - sunkCost)`);
}

// Test 2: Entry + flip back to original + resolution
console.log('\n=== Test 2: Entry → Flip → Flip Back → Resolution ===');
{
  const eng = createEngine();
  eng.currentStart = Math.floor(Date.now() / 300) * 300 + 300;
  const slug = `btc-updown-5m-${eng.currentStart}`;
  
  const upToken = eng.makeToken('up-2', slug, 'UP');
  const downToken = eng.makeToken('down-2', slug, 'DOWN');
  eng.markets.set(slug, {
    slug, title: 'BTC Test 2', windowStart: eng.currentStart, windowEnd: eng.currentStart + 300,
    settled: false, winner: null, up: upToken, down: downToken,
    finalUpMax: null, finalDownMax: null, resolutionSource: null,
  });

  // Entry: buy UP at 0.60
  upToken.ask = 0.60; upToken.bid = 0.58; upToken.mid = 0.59;
  eng.enterPosition(eng.markets.get(slug), upToken, 0.60);
  assert(eng.accumUpShares === 25, `accumUp = ${eng.accumUpShares}`);

  // Flip 1: to DOWN at 0.60
  downToken.ask = 0.60; downToken.bid = 0.58; downToken.mid = 0.59;
  eng.flipPosition(eng.markets.get(slug), downToken);
  assert(eng.accumDownShares === 63, `accumDown = ${eng.accumDownShares}`);
  assert(eng.accumUpShares === 25, `accumUp still = ${eng.accumUpShares}`);

  // Flip 2: back to UP at 0.60
  upToken.ask = 0.60; upToken.bid = 0.58; upToken.mid = 0.59;
  eng.flipPosition(eng.markets.get(slug), upToken);
  assert(eng.accumUpShares === 25 + 95, `accumUp = ${eng.accumUpShares} (expected 120)`);
  assert(eng.accumDownShares === 63, `accumDown still = ${eng.accumDownShares}`);

  const sunk = eng.windowSunkCost;
  const bankrollBefore = eng.bankroll;
  
  // Resolution: UP wins
  eng.markets.get(slug).finalUpMax = 0.95;
  eng.markets.get(slug).finalDownMax = 0.10;
  eng.settleWindow(eng.markets.get(slug));
  
  const expectedPayout = 120; // accumUp × $1
  const expectedNet = expectedPayout - sunk;
  console.log(`  Payout=$${expectedPayout}, Sunk=$${sunk.toFixed(2)}, Net=$${expectedNet.toFixed(2)}`);
  assert(Math.abs(eng.realizedPnl - expectedNet) < 0.01, 
    `realizedPnl = $${expectedNet.toFixed(2)}`);
  assert(Math.abs(eng.bankroll - (bankrollBefore + expectedPayout)) < 0.01,
    `bankroll updated correctly`);
}

// Test 3: Verify calculateShares returns 0 when already enough
console.log('\n=== Test 3: calculateShares returns 0 when accum covers target ===');
{
  const eng = createEngine();
  eng.windowSunkCost = 50;
  const shares = eng.calculateShares(0.60, 140); // accumThisSide=140
  // needed = 10 + 50 - 140 = -80 → 0
  assert(shares === 0, `shares = ${shares} (expected 0 when accum covers)`);
}

// Test 4: Verify net is always ~TARGET_PROFIT for a clean entry→win
console.log('\n=== Test 4: Clean entry → win nets ~$10 ===');
{
  const eng = createEngine();
  eng.currentStart = Math.floor(Date.now() / 300) * 300 + 600;
  const slug = `btc-updown-5m-${eng.currentStart}`;
  
  const upToken = eng.makeToken('up-4', slug, 'UP');
  const downToken = eng.makeToken('down-4', slug, 'DOWN');
  eng.markets.set(slug, {
    slug, title: 'BTC Test 4', windowStart: eng.currentStart, windowEnd: eng.currentStart + 300,
    settled: false, winner: null, up: upToken, down: downToken,
    finalUpMax: null, finalDownMax: null, resolutionSource: null,
  });

  upToken.ask = 0.60; upToken.bid = 0.58; upToken.mid = 0.59;
  eng.enterPosition(eng.markets.get(slug), upToken, 0.60);
  
  eng.markets.get(slug).finalUpMax = 0.95;
  eng.markets.get(slug).finalDownMax = 0.10;
  eng.settleWindow(eng.markets.get(slug));
  
  console.log(`  Net PnL = $${eng.realizedPnl.toFixed(2)}`);
  assert(Math.abs(eng.realizedPnl - 10) < 0.5, `net PnL ≈ $10 (got $${eng.realizedPnl.toFixed(2)})`);
}

console.log('\n=== ALL TESTS PASSED ===\n');
