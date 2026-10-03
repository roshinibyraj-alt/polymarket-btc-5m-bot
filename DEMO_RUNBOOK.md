# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. The bot reads public CCXT BTC spot data and Polymarket books; DemoTrader simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep LIVE_TRADING unset or set to a value other than the exact text true. No wallet key is needed for demo mode.
2. From this directory, run `npm install`, then `npm test`.
3. Start the app with `npm start` and open http://localhost:3000.
4. Confirm the dashboard says DEMO MODE, shows $10,000 starting capital, identifies the CCXT feed, and reports the BTC baseline/projection phase. LIVE_TRADING=true is refused before wallet authentication.

The default BTC source is Coinbase BTC/USD; configure another CCXT exchange with CCXT_EXCHANGE and CCXT_SYMBOL. The feed honors the exchange's minimum rate limit, so a provider may require a slower interval than 500 ms. Binance returned a location restriction from the development runtime; verify the chosen deployment source before relying on the feed.

## Strategy behavior

- At each five-minute window open, the bot captures the latest BTC sample at or before the prior candle close. It skips that window if the baseline sample is missing or older than the allowed freshness window.
- It averages sampled BTC prices into 10-second blocks for the first 150 seconds. The initial drift is the difference between the BTC price at the end of that period and the previous close, divided by 15 blocks.
- After the initial 150 seconds, it uses adjacent future 10-second block averages as a rolling 20-second trend. It projects the latest per-block change from the current BTC price through the seconds remaining to the window close. Projected close above the prior close selects UP; below selects DOWN. A projection equal to the baseline waits for the next block update. The earliest signal is after two complete future blocks, at about 170 seconds.
- The bot buys only the projected Polymarket side, only once per window, and only when that side's best ask is between $0.20 and $0.45. Asks below $0.20 or above $0.45 are rejected. Orders may sweep up to 50% above the observed ask but cannot exceed the $0.45 maximum. This price band is an execution guard, not part of the BTC direction calculation.
- Entry size starts at 500 shares. Each loss adds 200 shares to the next target (500, 700, 900, …); a win resets the next size to 500. This progression is held in memory and resets when the process restarts.
- If visible ask depth runs short, modeled liquidity at the order price limit completes the full target in demo mode. The modeled portion is synthetic and is not actual market liquidity. Estimated taker fees are included in paper P&L.
- During the window, a held-side CLOB midpoint at or above $0.99 settles remaining shares as a $1-per-share win; a best bid at or below $0.01 settles them as a $0-per-share loss, even if the ask keeps the midpoint above $0.01. After close, the bot periodically checks that token's CLOB book for these thresholds before falling back to Gamma's official result. This is a demo heuristic, not a guarantee of the official outcome.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital; it should reconcile to realized plus unrealized P&L.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash, trade history, and loss-step sizing are in memory and reset when the process restarts. Treat simulated book fills, estimated fees, and P&L as behavior checks—not as evidence of live execution or profitability.
