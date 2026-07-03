// config.js — all tunable parameters live here so you can iterate without touching logic

module.exports = {
  // --- Data source ---
  symbol: 'btcusdt',              // Binance symbol (lowercase for WS streams)
  tradeStreamUrl: 'wss://stream.binance.us:9443/ws/btcusdt@trade',
  depthStreamUrl: 'wss://stream.binance.us:9443/ws/btcusdt@depth20@100ms',
  klineRestUrl: 'https://api.binance.us/api/v3/klines',

  // --- Window ---
  windowMinutes: 5,               // must match the Polymarket window you're targeting
  decisionOffsetSeconds: 3,       // wait this long into the window before locking in a decision
                                   // (lets order-book snapshot settle right after the boundary)

  // --- Feature buffers ---
  tradeBufferSeconds: 300,        // how much trade history to keep in memory (5 min)
  momentumLookbacks: [60, 300],   // seconds, for momentum predictor
  meanReversionPeriod: 20,        // number of 1-min klines for moving average
  volBreakoutLookback: 10,        // number of 1-min klines for range comparison

  // --- Predictor thresholds ---
  momentumThreshold: 0.0015,      // 0.15% move treated as "full confidence" cap input
  orderFlowWindowSeconds: 60,
  bookDepthLevels: 10,
  meanReversionZCap: 2.5,
  volBreakoutRatioCap: 3.0,

  // --- Polymarket price simulation (until wired to real CLOB API) ---
  simulatedSpread: 0.03,          // YES ask + NO ask = 1 + spread (round-trip cost)
  simulatedFee: 0.0,              // extra flat fee per trade, as fraction of stake (Polymarket ~0 taker fee currently, verify)

  // --- Paper trading ---
  startingBankrollPerStrategy: 1000,
  maxStakeFraction: 0.08,         // cap any single bet at 8% of that strategy's current bankroll
  minConfidenceToTrade: 0.55,     // strategies below this on their relevant signal(s) sit out

  // --- Persistence ---
  resultsFile: './results.json',
  logEveryWindow: true,
};
