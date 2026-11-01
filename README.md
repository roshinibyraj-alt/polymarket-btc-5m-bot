# Polymarket BTC + ETH market-confusion paper bot

Paper BTC and ETH UP/DOWN trading on 5-minute and 15-minute Polymarket markets. All four bot instances use the same market-confusion strategy. Real order submission remains paused.

For all four markets, during the final 60 seconds, require fresh UP and DOWN midpoint quotes between $0.30 and $0.71 inclusive. Place 500-share paper limit buys on both sides at $0.25 and $0.15. Their take-profits are $0.75 and $0.85 respectively. A filled rung exits at its take-profit and is not re-entered.

Each asset/timeframe bot has a separate $5,000 in-memory paper ledger, preserving the existing combined $20,000 paper starting capital. The dashboard shows paper state plus read-only real-account information. Real order submission remains paused. Paper ledgers reset when the process restarts.

Run `npm test` and `npm start`. The Railway `node index.js` start command remains valid.
