// index.js — main loop.
// Flow: warm up on historical klines -> connect live feeds -> every 5-min window,
// run all predictors, let every strategy decide independently, paper-trade the result,
// resolve the previous window against the actual close, log + persist.

const config = require('./config');
const BinanceFeed = require('./src/binanceFeed');
const WindowManager = require('./src/windowManager');
const { runAllPredictors } = require('./src/predictors');
const { STRATEGIES } = require('./src/strategies');
const { PaperEngine } = require('./src/paperEngine');
const { startDashboard } = require('./src/dashboard');

async function main() {
  console.log('=== Polymarket-style BTC 5m Paper Trading Simulator ===');
  console.log('NOTE: Market pricing is simulated (fixed spread), not pulled from Polymarket live.');
  console.log(`Window: ${config.windowMinutes}m | Strategies: ${Object.keys(STRATEGIES).join(', ')}\n`);

  const feed = new BinanceFeed();
  await feed.backfillKlines(100);
  feed.connect();

  const engine = new PaperEngine(Object.keys(STRATEGIES));

  // Shared state the dashboard reads from — updated as the loop runs.
  const dashboardState = { signals: {}, recentTrades: [] };
  startDashboard(() => ({
    updatedAt: new Date().toISOString(),
    lastPrice: feed.lastPrice,
    signals: dashboardState.signals,
    strategies: engine.summary(),
    recentTrades: dashboardState.recentTrades.slice(-30),
  }));

  // Track window open price (from feed.lastPrice at decision time) so we can compute
  // the actual resolution direction when the window closes.
  const windowOpenPrices = {};

  const wm = new WindowManager(
    (windowStart) => {
      // --- WINDOW OPEN: run predictors, let each strategy decide, place paper trades ---
      const signals = runAllPredictors(feed);
      windowOpenPrices[windowStart] = feed.lastPrice;
      dashboardState.signals = signals;

      const decisions = {};
      for (const [name, strategyFn] of Object.entries(STRATEGIES)) {
        const decision = strategyFn(signals);
        decisions[name] = decision;
        if (decision.trade) {
          engine.placeTrade(name, decision.side, decision.confidence, windowStart);
        }
      }

      if (config.logEveryWindow) {
        console.log(`\n[Window ${new Date(windowStart).toISOString()}] open=${feed.lastPrice}`);
        console.log('  Signals:', Object.fromEntries(
          Object.entries(signals).map(([k, v]) => [k, `${v.direction}(${v.confidence.toFixed(2)})`])
        ));
        console.log('  Decisions:', Object.fromEntries(
          Object.entries(decisions).map(([k, v]) => [k, v.trade ? `${v.side}(${v.confidence.toFixed(2)})` : 'skip'])
        ));
      }
    },
    (windowStart, windowEnd) => {
      // --- WINDOW CLOSE: resolve previous window's paper trades against actual outcome ---
      const openPrice = windowOpenPrices[windowStart];
      const closePrice = feed.lastPrice;
      if (openPrice == null || closePrice == null) return;

      const actualDirection = closePrice >= openPrice ? 'up' : 'down';
      const results = engine.resolveAll(actualDirection, openPrice, closePrice);

      console.log(`[Resolve ${new Date(windowStart).toISOString()}] ${openPrice} -> ${closePrice} = ${actualDirection.toUpperCase()}`);
      for (const [name, rec] of Object.entries(results)) {
        console.log(`  ${name}: ${rec.side} | ${rec.won ? 'WIN' : 'LOSS'} | pnl=${rec.pnl.toFixed(2)} | bankroll=${rec.bankrollAfter.toFixed(2)}`);
        dashboardState.recentTrades.push({ strategy: name, windowStart, ...rec });
      }

      console.log('\n  --- Running totals ---');
      for (const s of engine.summary()) {
        console.log(`  ${s.name}: bankroll=${s.bankroll.toFixed(2)} | trades=${s.trades} | winRate=${(s.winRate * 100).toFixed(1)}% | ROI=${(s.roi * 100).toFixed(2)}%`);
      }

      engine.persist();
      delete windowOpenPrices[windowStart];
    }
  );

  wm.start();

  process.on('SIGINT', () => {
    console.log('\nShutting down, persisting final results...');
    engine.persist();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
