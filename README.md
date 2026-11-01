# Polymarket BTC + ETH market-confusion paper bot

Paper BTC and ETH UP/DOWN trading on 5-minute and 15-minute Polymarket markets. All four bot instances use the same market-confusion strategy. Real order submission remains paused.

For all four markets, during the final 30 seconds, require fresh UP and DOWN midpoint quotes between $0.05 and $0.96 inclusive. Place 500-share paper limit buys on both sides at $0.30, $0.25, $0.20, $0.15, $0.10, and $0.05. Their respective take-profits are $0.70, $0.75, $0.80, $0.85, $0.90, and $0.95. Rearm each rung after its take-profit until window rollover.

Each asset/timeframe bot has a separate $5,000 in-memory paper ledger, preserving the existing combined $20,000 paper starting capital. The dashboard shows paper state plus read-only real-account information. Real order submission remains paused. Paper ledgers reset when the process restarts.

Run `npm test` and `npm start`. The Railway `node index.js` start command remains valid.
