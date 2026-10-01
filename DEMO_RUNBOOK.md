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
- The order size is 500 shares. A same-direction signal does not add shares. An opposite signal first attempts to sell the held side; the new side is not opened if any of the old position remains.
- Demo marketable orders consume visible book depth but are limited to the observed best ask/bid. Empty or thin books can produce no fill or a partial fill. Estimated taker fees are included in paper P&L.
- At window close, any position still open is held until Gamma reports a closed market with a decisive outcome; no price-based resolution guess is used.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash and trade history are in memory and reset when the process restarts. Treat simulated book fills, estimated fees, and P&L as behavior checks—not as evidence of live execution or profitability.
