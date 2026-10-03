# Polymarket BTC 5-minute projection strategy

The demo bot reads a public CCXT BTC spot feed and the two Polymarket outcome books. At each five-minute window open it captures the most recent BTC sample at or immediately before the prior candle close. If no suitably fresh baseline sample is available, it skips that window rather than inventing one.

For the first 150 seconds, the bot calculates one average BTC price for each completed 10-second block. It also records the average drift from the prior close across those 15 blocks (for example, a $10 rise is about +$0.67 per block). After 150 seconds, each pair of adjacent future 10-second blocks provides a rolling 20-second trend. The bot applies that latest per-block change to the current BTC price for the seconds remaining until the five-minute window closes. A projected close above the previous candle close selects UP; a projected close below selects DOWN. If the projection is exactly at the baseline, it waits for the next block update. The earliest forecast can form after 170 seconds.

Only the forecasted Polymarket side may be bought, and each window permits at most one entry. The observed best ask must be between $0.20 and $0.45; BUY orders can sweep asks up to 50% above the observed best ask by default but cannot execute above $0.45. Entry size starts at 500 shares, each loss adds 200 shares to the next target, and a win resets the target to 500. Thin visible depth is completed with modeled liquidity at the order price limit in demo mode; the modeled portion is synthetic, not actual market depth. Positions are held for settlement.

Coinbase BTC/USD is the default feed. Set CCXT_EXCHANGE and, if needed, CCXT_SYMBOL to select another CCXT market; the feed honors an exchange's higher minimum interval if required. Binance returned a location restriction from this runtime, so Binance connectivity is not assumed. Feed staleness and missing baselines are reported on the dashboard.

Estimated crypto taker fees are included in demo cash and P&L. A held-side CLOB midpoint at or above $0.99 is counted as a $1 payout per remaining share; a best bid at or below $0.01 is counted as $0.00. This is a demo threshold heuristic, not official resolution. Other shares still open at the five-minute close wait for official Polymarket resolution. Account equity is cash plus the marked value of all open shares; total P&L is equity minus starting capital.

This strategy is strictly demo-only. LIVE_TRADING=true is refused before wallet authentication, and the active bot uses only DemoTrader. The $10,000 paper balance, trade history, and loss-step sizing reset when the process restarts. Simulated fills, estimated fees, and P&L are behavior checks—not evidence of live execution or profitability.

Run `npm test` from this directory to verify the BTC block projection, book execution, settlement, sizing progression, and live guard. For local startup and dashboard checks, follow DEMO_RUNBOOK.md.
