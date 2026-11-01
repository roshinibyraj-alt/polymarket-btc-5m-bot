# Polymarket BTC candle-pattern paper bot

Paper BTC UP/DOWN trading on 5-minute and 15-minute Polymarket markets. Real order submission remains paused.

For 5-minute markets, during the final 30 seconds, require fresh UP and DOWN midpoint quotes between $0.05 and $0.96 inclusive. Place 500-share paper limit buys on both sides at $0.30, $0.25, $0.20, $0.15, $0.10, and $0.05. Their respective take-profits are $0.70, $0.75, $0.80, $0.85, $0.90, and $0.95. Rearm each rung after its take-profit until window rollover.

The 15-minute paper strategy remains the Roulette random forest with its adaptive target and paper-only execution.

Each timeframe has an independent $10,000 in-memory paper ledger. The dashboard shows paper state plus read-only real-account information. The 5-minute strategy does not invoke the live-entry mirror. Paper ledgers reset when the process restarts.

Run `npm test` and `npm start`. The Railway `node index.js` start command remains valid.
