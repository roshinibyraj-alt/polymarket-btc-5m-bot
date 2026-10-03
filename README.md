# Polymarket BTC 5-minute projection strategy

The demo bot reads a public CCXT BTC spot feed and the two Polymarket outcome books. At each five-minute window open it captures the most recent BTC sample at or immediately before the prior candle close. If no suitably fresh baseline sample is available, it skips that window rather than inventing one.

For the first 150 seconds, the bot calculates one average BTC price for each completed 10-second block. It also records the average drift from the prior close across those 15 blocks (for example, a $10 rise is about +$0.67 per block). After 150 seconds, each pair of adjacent future 10-second blocks provides a rolling 20-second trend. The bot applies that latest per-block change to the current BTC price for the seconds remaining until the five-minute window closes. A projected close above the previous candle close selects UP; a projected close below selects DOWN. If the projection is exactly at the baseline, it waits for the next block update. The earliest forecast can form after 170 seconds.

The bot buys the latest forecasted Polymarket side at any valid contract price in the 0–1 range, subject to available demo cash and simulated fills; there is no strategy-level ask band or slippage cap. Every BUY targets exactly 500 shares, regardless of previous wins or losses. If the forecast flips while a position is open, the bot sells the held side and buys 500 shares of the new forecast. It can reverse repeatedly within the same five-minute window. If a reversal sell cannot close the full position, the bot waits for more exit liquidity before opening the other side.

The dashboard charts BTC spot against its trailing 10-second average and compares UP/DOWN asks with their trailing 10-second averages. It also shows the live forecast, average entry, position marks, cash, equity, and realized/unrealized P&L. When visible book depth runs short, DemoTrader models the remainder at the worst visible price; that liquidity is synthetic, not actual market depth.

Coinbase BTC/USD is the default feed. Set CCXT_EXCHANGE and, if needed, CCXT_SYMBOL to select another CCXT market; the feed honors an exchange's higher minimum interval if required. Binance returned a location restriction from this runtime, so Binance connectivity is not assumed. Feed staleness and missing baselines are reported on the dashboard.

Estimated crypto taker fees are included in demo cash and P&L. A held-side CLOB midpoint at or above $0.99 is counted as a $1 payout per remaining share; a best bid at or below $0.01 is counted as $0.00. This is a demo threshold heuristic, not official resolution. Other shares still open at the five-minute close wait for official Polymarket resolution. Account equity is cash plus the marked value of all open shares; total P&L is equity minus starting capital.

This strategy is strictly demo-only. LIVE_TRADING=true is refused before wallet authentication, and the active bot uses only DemoTrader. The $10,000 paper balance and trade history reset when the process restarts. Simulated fills, estimated fees, and P&L are behavior checks—not evidence of live execution or profitability.

Run `npm test` from this directory to verify the BTC block projection, fixed-size entries, repeated reversals, book execution, settlement, and live guard. For local startup and dashboard checks, follow DEMO_RUNBOOK.md.
