'use strict';

const { BtcBreakoutEngine } = require('../engine');

const engine = new BtcBreakoutEngine({
  onTick: (state) => {
    const pos = state.position ? `${state.position.outcome} ${state.position.shares}SH @${state.position.entryPrice}` : 'none';
    const upP = state.market ? (state.market.up.mid ?? '—') : '—';
    const dnP = state.market ? (state.market.down.mid ?? '—') : '—';
    const elapsed = state.market ? state.market.elapsed : 0;
    const remaining = state.market ? state.market.remaining : 0;
    process.stdout.write(
      `\r[${new Date().toISOString().slice(11,19)}] ` +
      `ELAPSED ${elapsed}s REM ${remaining}s | ` +
      `UP=${upP} DN=${dnP} | ` +
      `POS=${pos} | ` +
      `ACCUM UP=${state.accumUpShares} DN=${state.accumDownShares} | ` +
      `SUNK=$${state.windowSunkCost.toFixed(2)} | ` +
      `BANK=$${state.bankroll.toFixed(2)} PnL=$${state.totalPnl.toFixed(2)} | ` +
      `FLIPS=${state.windowFlipCount}          `
    );
  },
  onLog: (line) => {
    console.log(`\n  LOG: ${line}`);
  },
});

engine.init();
console.log('Live smoke test started. Watching for 2 full windows (~10 min)...\n');

let windowsSeen = new Set();
const checkInterval = setInterval(() => {
  const state = engine.buildState();
  if (state.market && state.market.windowStart) {
    if (!windowsSeen.has(state.market.windowStart)) {
      windowsSeen.add(state.market.windowStart);
      console.log(`\n  NEW WINDOW: ${state.market.slug} (start=${state.market.windowStart})`);
    }
  }
}, 5000);

// Run for ~12 minutes (2+ windows)
setTimeout(() => {
  clearInterval(checkInterval);
  engine.close();
  console.log('\n\n=== SMOKE TEST COMPLETE ===');
  const finalState = engine.buildState();
  console.log(`Bankroll: $${finalState.bankroll.toFixed(2)}`);
  console.log(`Realized PnL: $${finalState.realizedPnl.toFixed(2)}`);
  console.log(`Wins: ${finalState.wins}, Losses: ${finalState.losses}`);
  console.log(`Total Fees: $${finalState.totalFees.toFixed(2)}`);
  console.log(`\nRecent Results:`);
  finalState.results.forEach(r => {
    console.log(`  ${r.slug}: ${r.result} winner=${r.winner} net=$${r.realizedPnl?.toFixed(2)} up=${r.accumUpShares} down=${r.accumDownShares}`);
  });
  console.log(`\nRecent Trades:`);
  finalState.trades.slice(0, 20).forEach(t => {
    console.log(`  ${t.action} ${t.outcome} ${t.shares}SH @${t.price} reason=${t.reason} pnl=${t.pnl?.toFixed(2)}`);
  });
  console.log(`\nLogs:`);
  finalState.logs.forEach(l => console.log(`  ${l}`));
  process.exit(0);
}, 12 * 60 * 1000);
