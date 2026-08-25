'use strict';
const { BtcBreakoutEngine } = require('../engine');

function mockFetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }

const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
eng.currentStart = Math.floor(Date.now() / 300) * 300;
const slug = `btc-updown-5m-${eng.currentStart}`;
const up = eng.makeToken('up', slug, 'UP');
const down = eng.makeToken('down', slug, 'DOWN');
eng.markets.set(slug, { slug, windowStart: eng.currentStart, windowEnd: eng.currentStart + 300, settled: false, winner: null, up, down, finalUpMax: null, finalDownMax: null, resolutionSource: null });

// Simulate rapid oscillation at 0.50-0.60 (like the smoke test scenario)
const flips = [
  { side: 'UP',   price: 0.55 },
  { side: 'DOWN', price: 0.58 },
  { side: 'UP',   price: 0.56 },
  { side: 'DOWN', price: 0.57 },
  { side: 'UP',   price: 0.51 },
  { side: 'DOWN', price: 0.50 },
  { side: 'UP',   price: 0.51 },
  { side: 'DOWN', price: 0.50 },
  { side: 'UP',   price: 0.50 },
];

console.log('=== TRACING SHARE MATH ===');
console.log(`Formula: shares = ceil((TARGET + sunkCost - accumThisSide) / pps)`);
console.log(`where pps = 1 - entryPrice\n`);

for (let i = 0; i < flips.length; i++) {
  const f = flips[i];
  const token = f.side === 'UP' ? up : down;
  token.ask = f.price;
  token.bid = f.price - 0.02;
  token.mid = f.price - 0.01;
  
  const pps = 1 - f.price;
  const accumThisSide = f.side === 'UP' ? eng.accumUpShares : eng.accumDownShares;
  const needed = 10 + eng.windowSunkCost - accumThisSide;
  const calcShares = Math.max(0, Math.ceil(needed / pps));
  
  if (i === 0) {
    eng.enterPosition(eng.markets.get(slug), token, f.price);
  } else {
    eng.flipPosition(eng.markets.get(slug), token);
  }
  
  const actualShares = i === 0 ? eng.accumUpShares : (f.side === 'UP' ? eng.accumUpShares - (eng.accumUpShares - calcShares) : eng.accumDownShares - (eng.accumDownShares - calcShares));
  
  console.log(`Step ${i+1}: ${f.side} @${f.price} pps=${pps.toFixed(2)}`);
  console.log(`  accumThisSide(before)=${accumThisSide}, sunkCost=${eng.windowSunkCost.toFixed(2)}`);
  console.log(`  needed = 10 + ${eng.windowSunkCost.toFixed(2)} - ${accumThisSide} = ${needed.toFixed(2)}`);
  console.log(`  shares = ceil(${needed.toFixed(2)} / ${pps.toFixed(2)}) = ${calcShares}`);
  console.log(`  cost = $${(calcShares * f.price).toFixed(2)}`);
  console.log(`  AFTER: accumUp=${eng.accumUpShares} accumDown=${eng.accumDownShares} sunk=$${eng.windowSunkCost.toFixed(2)} bankroll=$${eng.bankroll.toFixed(2)}`);
  
  // Check: if this side wins, what's the net?
  const winAccum = f.side === 'UP' ? eng.accumUpShares : eng.accumDownShares;
  const net = winAccum - eng.windowSunkCost;
  console.log(`  If ${f.side} wins: payout=${winAccum}×$1=$${winAccum}, net=$${net.toFixed(2)}`);
  console.log();
}

console.log('=== MATH VERIFICATION ===');
console.log(`Final: accumUp=${eng.accumUpShares} accumDown=${eng.accumDownShares} sunk=$${eng.windowSunkCost.toFixed(2)}`);
console.log(`If UP wins: net = ${eng.accumUpShares} - ${eng.windowSunkCost.toFixed(2)} = $${(eng.accumUpShares - eng.windowSunkCost).toFixed(2)}`);
console.log(`If DOWN wins: net = ${eng.accumDownShares} - ${eng.windowSunkCost.toFixed(2)} = $${(eng.accumDownShares - eng.windowSunkCost).toFixed(2)}`);
