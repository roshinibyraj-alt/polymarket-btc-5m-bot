# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. The bot reads public CCXT BTC spot data and Polymarket books; `DemoTrader` simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to a value other than the exact text `true`. No wallet key is needed for demo mode.
2. From this directory, run `npm install`, then `npm test`.
3. Start the app with `npm start` and open http://localhost:3000.
4. Confirm the dashboard says DEMO MODE, shows $10,000 starting capital, and reports a live CCXT price. After about one minute of valid BTC samples, confirm the adaptive threshold is ready. `LIVE_TRADING=true` is refused before wallet authentication.

The default source is Coinbase `BTC/USD`; configure another CCXT exchange with `CCXT_EXCHANGE` and `CCXT_SYMBOL`. The feed honors the exchange's minimum rate limit, so a provider may require a slower interval than 500 ms. Binance returned a location restriction from the development runtime; verify the chosen deployment source before relying on the feed.

## What to check

- The CCXT feed targets a 500 ms poll. The one-second trigger is the P99 of absolute BTC moves from the previous rolling 5-minute window, with a $1 minimum. After restart, it starts signaling after 120 valid moves (about one minute); the window fills to 5 minutes as samples accumulate. The dashboard shows the threshold and sample warm-up count. A move at or above the threshold signals UP; a move at or below its negative target signals DOWN. While a window has not yet traded, the latest signal stays valid until the opposite signal.
- The order target is 500 shares, with no entry during the first 60 seconds after a five-minute window opens and at most one filled entry per window thereafter. A signal may occur during the delay and remains active until an opposite signal. After the delay, a BUY requires the signaled side's best ask to be between $0.45 and $0.55 inclusive; execution cannot exceed $0.55 even when the configurable slippage allowance of up to 50% would allow more. Orders can partially fill if visible depth within the cap is insufficient. Opposite signals after entry do not sell or reopen; the position is held for settlement.
- Demo marketable BUY orders consume visible book depth, require a best ask between $0.45 and $0.55 inclusive, and are capped at $0.55 or the configured slippage price, whichever is lower. Empty or thin books can produce no fill or a partial fill. Estimated taker fees are included in paper P&L.
- During the window, a held-side CLOB midpoint at or above $0.99 settles remaining shares as a $1-per-share win; a best bid at or below $0.01 settles them as a $0-per-share loss, even if the ask keeps the midpoint above $0.01. After close, the bot periodically checks that token's CLOB book for these thresholds before falling back to Gamma's official result. This is a demo heuristic, not a guarantee of the official outcome.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital; it should reconcile to realized plus unrealized P&L.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash and trade history are in memory and reset when the process restarts. Treat simulated book fills, estimated fees, and P&L as behavior checks—not as evidence of live execution or profitability.
