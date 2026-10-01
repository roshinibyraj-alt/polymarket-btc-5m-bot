# Polymarket BTC 5-minute momentum strategy

The demo bot polls a public CCXT BTC spot ticker every **500 ms**. It compares the latest price with a sample about **1,000 ms earlier**; a move of **+$10 or more** targets UP, and **−$10 or less** targets DOWN. It buys 500 shares of the target Polymarket outcome. If it holds the opposite outcome, it first sells that position; it will not open the new side unless the old side is fully sold. Repeated signals in the held direction do not add entries.

Coinbase `BTC/USD` is the default feed: it is reachable from this runtime and its CCXT rate limit permits 500 ms polling. Set `CCXT_EXCHANGE` and, if needed, `CCXT_SYMBOL` to select another CCXT market; the feed honors an exchange's higher minimum interval if it requires one. Binance returned a location restriction from this runtime, so Binance connectivity is not assumed. The dashboard reports feed errors and staleness; a missing or stale feed cannot generate a signal.

Demo marketable orders use visible Polymarket book depth and are capped at the observed best ask for buys or best bid for sells. Fills can be partial or absent. Estimated crypto taker fees are included in demo cash and P&L. A partially sold position blocks entry on the opposite side. Any shares still open at the five-minute close wait for official Polymarket resolution; live prices are not used to guess the result.

This strategy is strictly demo-only. `LIVE_TRADING=true` is refused before wallet authentication, and the active bot uses only `DemoTrader`. The $10,000 paper balance and history reset when the process restarts. Simulated fills, estimated fees, and P&L are behavior checks—not evidence of live execution or profitability.

Run `npm test` from this directory to verify the feed, thresholds, order behavior, and live guard. For local startup and dashboard checks, follow `DEMO_RUNBOOK.md`.
