'use strict';
const { BtcBreakoutEngine } = require('../engine');

function mockFetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }

// Test: what if price oscillates between 0.50 and 0.60 rapidly?
const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
eng.currentStart = Math.floor(Date.now() / 300) * 300;
const slug = `btc-updown-5m-${eng.currentStart}`;
const up = eng.makeToken('up', slug, 'UP');
const down = eng.makeToken('down', slug, 'DOWN');
eng.markets.set(slug, { slug, windowStart: eng.currentStart, windowEnd: eng.currentStart + 300, settled: false, winner: null, up, down, finalUpMax: null, finalDownMax: null, resolutionSource: null });

// Worst case: price at 0.50 each time (pps=0.50, maximum shares per dollar)
const scenario = [];
for (let i = 0; i < 10; i++) {
  scenario.push({ side: i % 2 === 0 ? 'UP' : 'DOWN', price: 0.50 });
}

console.log('=== WORST CASE: 10 rapid flips at 0.50 ===');
console.log('pps=0.50, each flip needs TARGET+sunkCost-accumThisSide / 0.50\n');

for (let i = 0; i < scenario.length; i++) {
  const f = scenario[i];
  const token = f.side === 'UP' ? up : down;
  token.ask = f.price; token.bid = f.price - 0.02; token.mid = f.price - 0.01;
  
  if (i === 0) eng.enterPosition(eng.markets.get(slug), token, f.price);
  else eng.flipPosition(eng.markets.get(slug), token);
  
  const net = f.side === 'UP' ? eng.accumUpShares - eng.windowSunkCost : eng.accumDownShares - eng.windowSunkCost;
  console.log(`Flip ${i+1}: ${f.side} @${f.price} → accumUp=${eng.accumUpShares} accumDown=${eng.accumDownShares} sunk=$${eng.windowSunkCost.toFixed(2)} bankroll=$${eng.bankroll.toFixed(2)} if_${f.side}_wins_net=$${net.toFixed(2)}`);
}

console.log(`\nMax window investment: $2000, final sunk: $${eng.windowSunkCost.toFixed(2)}`);

// Now test: what if entry at 0.60, flips at 0.50?
console.log('\n=== ENTRY @0.60, FLIPS @0.50 ===');
const eng2 = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
eng2.currentStart = Math.floor(Date.now() / 300) * 300 + 300;
const slug2 = `btc-updown-5m-${eng2.currentStart}`;
const up2 = eng2.makeToken('up2', slug2, 'UP');
const down2 = eng2.makeToken('down2', slug2, 'DOWN');
eng2.markets.set(slug2, { slug: slug2, windowStart: eng2.currentStart, windowEnd: eng2.currentStart + 300, settled: false, winner: null, up: up2, down: down2, finalUpMax: null, finalDownMax: null, resolutionSource: null });

const scenario2 = [
  { side: 'UP', price: 0.60 },
  { side: 'DOWN', price: 0.50 },
  { side: 'UP', price: 0.50 },
  { side: 'DOWN', price: 0.50 },
  { side: 'UP', price: 0.50 },
];
for (let i = 0; i < scenario2.length; i++) {
  const f = scenario2[i];
  const token = f.side === 'UP' ? up2 : down2;
  token.ask = f.price; token.bid = f.price - 0.02; token.mid = f.price - 0.01;
  
  if (i === 0) eng2.enterPosition(eng2.markets.get(slug2), token, f.price);
  else eng2.flipPosition(eng2.markets.get(slug2), token);
  
  console.log(`Flip ${i+1}: ${f.side} @${f.price} → accumUp=${eng2.accumUpShares} accumDown=${eng2.accumDownShares} sunk=$${eng2.windowSunkCost.toFixed(2)}`);
}
