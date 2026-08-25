'use strict';
const { BtcBreakoutEngine } = require('../engine');
function mockFetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }

const eng = new BtcBreakoutEngine({ fetchImpl: mockFetch, onTick: () => {}, onLog: () => {} });
eng.currentStart = Math.floor(Date.now() / 300) * 300;
const slug = `btc-updown-5m-${eng.currentStart}`;
const up = eng.makeToken('u', slug, 'UP');
const down = eng.makeToken('d', slug, 'DOWN');
eng.markets.set(slug, { slug, windowStart: eng.currentStart, windowEnd: eng.currentStart + 300, settled: false, winner: null, up, down, finalUpMax: null, finalDownMax: null, resolutionSource: null });

up.ask = 0.60; up.bid = 0.58; up.mid = 0.59;
down.ask = 0.60; down.bid = 0.58; down.mid = 0.59;

// Entry
eng.enterPosition(eng.markets.get(slug), up, 0.60);
console.log(`Entry: accumUp=${eng.accumUpShares} (expected 20)`);

// 4 flips
for (let i = 0; i < 4; i++) {
  const token = i % 2 === 0 ? down : up;
  eng.flipPosition(eng.markets.get(slug), token);
  console.log(`Flip ${i+1}: accumUp=${eng.accumUpShares} accumDown=${eng.accumDownShares} sunk=$${eng.windowSunkCost.toFixed(2)}`);
}

// 5th flip should be blocked
const result = eng.flipPosition(eng.markets.get(slug), up);
console.log(`Flip 5: returned ${result} (expected false, windowFlipCount=${eng.windowFlipCount})`);

// Verify drawdown
eng.peakEquity = 5100;
eng.recordEquity();
const state = eng.buildState();
console.log(`Drawdown: $${state.drawdown.toFixed(2)} (peak=$${state.peakEquity.toFixed(2)} mark=$${state.markValue.toFixed(2)})`);

console.log('\nDone');
