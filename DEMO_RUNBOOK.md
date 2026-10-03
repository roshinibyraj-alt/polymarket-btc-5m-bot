# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. The bot reads public CCXT BTC spot data and Polymarket books; DemoTrader simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep LIVE_TRADING unset or set to a value other than the exact text true. No wallet key is needed for demo mode.
2. From this directory, run npm install, then npm test.
3. Start the app with npm start and open http://localhost:3000.
4. Confirm the dashboard says DEMO MODE, shows $10,000 starting capital, and reports the CLOB price feed. The BTC P99 monitor warms up after about one minute, but BTC signals are informational and are not required for entries. LIVE_TRADING=true is refused before wallet authentication.

The default informational BTC source is Coinbase BTC/USD; configure another CCXT exchange with CCXT_EXCHANGE and CCXT_SYMBOL. The feed honors the exchange's minimum rate limit, so a provider may require a slower interval than 500 ms. Binance returned a location restriction from the development runtime; verify the chosen deployment source before relying on the feed.

## What to check

- The CCXT feed targets a 500 ms poll. Its informational one-second monitor is the P99 of absolute BTC moves from the prior rolling 5-minute window, with a $1 minimum. It begins reporting after 120 valid moves (about one minute) and fills to five minutes as samples accumulate. Moves can be shown as UP/DOWN diagnostics, but they do not gate or choose entries.
- The bot waits **180 seconds** after each five-minute market window opens. After that, the first UP or DOWN token with a best ask in the inclusive **$0.20-$0.45** band can trigger one entry, without a BTC signal. A window permits at most one entry.
- Entry size starts at **500 shares**. Each loss increases the next entry by **200 shares** (500, 700, 900, …); a single win resets the next size to 500. This progression is held in memory and resets when the process restarts.
- Demo marketable BUY orders consume visible book depth. The observed best ask must be in the entry band; execution is capped at $0.45 even when the configurable slippage allowance of up to 50% would allow more. Empty or thin books can produce no fill or a partial fill. Estimated taker fees are included in paper P&L.
- During the window, a held-side CLOB midpoint at or above $0.99 settles remaining shares as a $1-per-share win; a best bid at or below $0.01 settles them as a $0-per-share loss, even if the ask keeps the midpoint above $0.01. After close, the bot periodically checks that token's CLOB book for these thresholds before falling back to Gamma's official result. This is a demo heuristic, not a guarantee of the official outcome.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital; it should reconcile to realized plus unrealized P&L.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash, trade history, and loss-step sizing are in memory and reset when the process restarts. Treat simulated book fills, estimated fees, and P&L as behavior checks—not as evidence of live execution or profitability.
