'use strict';
const { BtcBreakoutEngine } = require('../engine');

function mockFetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n=== Martingale ladder 20→40→80→160 ===');
{
  const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {}, shareLadder: [20, 40, 80, 160], maxFlips: 3 });
  assert(eng.name === 'MARTINGALE' || eng.name === 'BTCFlip', 'name default');
  assert(eng.calculateShares(0) === 20, 'flip 0 = 20');
  assert(eng.calculateShares(1) === 40, 'flip 1 = 40');
  assert(eng.calculateShares(2) === 80, 'flip 2 = 80');
  assert(eng.calculateShares(3) === 160, 'flip 3 = 160');
  assert(eng.calculateShares(4) === 160, 'flip 4 caps at 160');
  console.log('  Pattern: 20, 40, 80, 160, capped ✓');
}

console.log('\n=== Anti-martingale ladder 160→80→40→20 ===');
{
  const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {}, shareLadder: [160, 80, 40, 20], maxFlips: 3 });
  assert(eng.calculateShares(0) === 160, 'flip 0 = 160');
  assert(eng.calculateShares(1) === 80, 'flip 1 = 80');
  assert(eng.calculateShares(2) === 40, 'flip 2 = 40');
  assert(eng.calculateShares(3) === 20, 'flip 3 = 20');
  assert(eng.calculateShares(4) === 20, 'flip 4 caps at 20');
  console.log('  Pattern: 160, 80, 40, 20, capped ✓');
}

console.log('\n=== Bankroll independence ===');
{
  const a = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {}, bankroll: 5000 });
  const b = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {}, bankroll: 300 });
  assert(a.bankroll === 5000, 'A bankroll 5000');
  assert(b.bankroll === 300, 'B bankroll 300');
  assert(a.initialBankroll === 5000 && a.peakEquity === 5000, 'A initial/peak');
  assert(b.initialBankroll === 300 && b.peakEquity === 300, 'B initial/peak');
  b.bankroll = 250;
  assert(a.bankroll === 5000, 'A unaffected by B');
  console.log('  Independent bankrolls ✓');
}

console.log('\n=== ALL TESTS PASSED ===\n');
