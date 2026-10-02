# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. The bot reads public CCXT BTC spot data and Polymarket books; `DemoTrader` simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to a value other than the exact text `true`. No wallet key is needed for demo mode.
2. From this directory, run `npm install`, then `npm test`.
3. Start the app with `npm start` and open http://localhost:3000.
4. Confirm the dashboard says DEMO MODE, shows $10,000 starting capital, and reports a live CCXT price. After about one minute of valid BTC samples, confirm the adaptive threshold is ready. `LIVE_TRADING=true` is refused before wallet authentication.

The default source is Coinbase `BTC/USD`; configure another CCXT exchange with `CCXT_EXCHANGE` and `CCXT_SYMBOL`. The feed honors the exchange's minimum rate limit, so a provider may require a slower interval than 500 ms. Binance returned a location restriction from the development runtime; verify the chosen deployment source before relying on the feed.

## What to check

- The CCXT feed targets a 500 ms poll. The one-second trigger is the P99 of absolute BTC moves from the previous rolling 20-minute window, with a $1 minimum. After restart, it starts signaling after 120 valid moves (about one minute); the window fills to 20 minutes as samples accumulate. The dashboard shows the threshold and sample warm-up count. A move at or above the threshold buys UP; a move at or below its negative buys DOWN.
- The order target is 500 shares. BUY orders may sweep up to 50% above the observed best ask by default (`MAX_BUY_SLIPPAGE_PERCENT` is configurable); they still partially fill if visible depth within the cap is insufficient. The maximum slippage price is used to size the marketable limit for 500 shares, so better prices do not increase the target quantity. A same-direction signal does not add shares. On an opposite signal, the bot sells only if the position's average entry fill was at or below $0.40. A worse average entry above $0.40 is held and cannot be sold on reversal under that guard. A permitted reversal also blocks the new side if any of the old position remains after a partial sale.
- Demo marketable orders consume visible book depth. BUYs are capped at the slippage price; SELLs remain limited to the observed best bid. Empty or thin books can produce no fill or a partial fill. Estimated taker fees are included in paper P&L.
- During the window, a held-side CLOB midpoint at or above $0.99 settles remaining shares as a $1-per-share win; at or below $0.01 it settles as a $0-per-share loss. After close, the bot periodically checks that token's CLOB book for the same thresholds before falling back to Gamma's official result. This is a demo heuristic, not a guarantee of the official outcome.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital; it should reconcile to realized plus unrealized P&L.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash and trade history are in memory and reset when the process restarts. Treat simulated book fills, estimated fees, and P&L as behavior checks—not as evidence of live execution or profitability.
