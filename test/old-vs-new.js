'use strict';

console.log('=== OLD CODE (abandon on flip, no accumThisSide) ===');
console.log('Formula: shares = ceil((TARGET + sunkCost) / pps)\n');

let sunkCost = 0;
let accumUp = 0, accumDown = 0;

function oldCalc(pps) { return Math.ceil((10 + sunkCost) / pps); }

const steps = [
  { side: 'UP', price: 0.60 },
  { side: 'DOWN', price: 0.50 },
  { side: 'UP', price: 0.50 },
  { side: 'DOWN', price: 0.50 },
  { side: 'UP', price: 0.50 },
];

for (const s of steps) {
  const pps = 1 - s.price;
  const shares = oldCalc(pps);
  const cost = shares * s.price;
  if (s.side === 'UP') accumUp += shares; else accumDown += shares;
  sunkCost += cost;
  console.log(`BUY ${s.side} ${shares} SH @${s.price} cost=$${cost.toFixed(2)} sunk=$${sunkCost.toFixed(2)} accumUp=${accumUp} accumDown=${accumDown}`);
}

console.log(`\n→ Flip 4 buys ${steps[3].side === 'DOWN' ? accumDown - (accumDown - Math.ceil((10 + (sunkCost - steps[4].cost - steps[3].cost)) / 0.50)) : 'N/A'} shares`);
console.log(`→ Sunk cost after 5 steps: $${sunkCost.toFixed(2)}`);

console.log('\n=== NEW CODE (hold shares, subtract accumThisSide) ===');
console.log('Formula: shares = ceil((TARGET + sunkCost - accumThisSide) / pps)\n');

let sunkCost2 = 0;
let accumUp2 = 0, accumDown2 = 0;

for (const s of steps) {
  const pps = 1 - s.price;
  const accumSide = s.side === 'UP' ? accumUp2 : accumDown2;
  const needed = 10 + sunkCost2 - accumSide;
  const shares = needed <= 0 ? 0 : Math.ceil(needed / pps);
  const cost = shares * s.price;
  if (s.side === 'UP') accumUp2 += shares; else accumDown2 += shares;
  sunkCost2 += cost;
  console.log(`BUY ${s.side} ${shares} SH @${s.price} cost=$${cost.toFixed(2)} sunk=$${sunkCost2.toFixed(2)} accumUp=${accumUp2} accumDown=${accumDown2}`);
}

console.log(`\n→ Sunk cost after 5 steps: $${sunkCost2.toFixed(2)}`);
console.log(`\nOLD: sunk=$${sunkCost.toFixed(2)} | NEW: sunk=$${sunkCost2.toFixed(2)}`);
console.log(`OLD/NEW ratio: ${(sunkCost / sunkCost2).toFixed(1)}x`);
