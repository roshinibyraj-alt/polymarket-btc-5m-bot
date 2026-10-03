# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. The bot reads public CCXT BTC spot data and Polymarket books; DemoTrader simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to a value other than the exact text `true`. No wallet key is needed for demo mode.
2. From this directory, run `npm install`, then `npm test`.
3. Start the app with `npm start` and open http://localhost:3000.
4. Confirm the dashboard says DEMO ONLY, shows $10,000 starting capital, identifies the CCXT feed, and reports the current one-minute candle sequence and pattern action. `LIVE_TRADING=true` is refused before wallet authentication.

The default BTC source is Coinbase BTC/USD; configure another CCXT exchange with `CCXT_EXCHANGE` and `CCXT_SYMBOL`. The feed honors the exchange's minimum rate limit, so a provider may require a slower interval than 500 ms. Feed staleness and missing candle data are reported on the dashboard.

## Strategy behavior

- At each five-minute market open, the bot starts a new candle sequence. BTC samples are grouped into timestamp-aligned one-minute candles; green means close above open, red means close below open, and dojis or candles with fewer than two samples are neutral.
- Entry patterns are `RG` or `RRG` → BUY UP, and `GR` or `GGR` → BUY DOWN. `RR` alone is not an entry.
- Exit patterns are `RGR` or `RRGR` → SELL an open UP position, and `GRG` or `GGRG` → SELL an open DOWN position. Exits only close the matching side; they never open the opposite side.
- Each window permits at most one filled entry targeting exactly 500 shares. After an exit, the bot does not reverse or re-enter during that window. Entries have no strategy-level contract-price band; available demo cash and simulated fills still apply.
- Pattern exits use a marketable demo SELL against visible bids. A partial fill leaves the remainder open and the active exit signal retries when a fresh book update arrives. Any shares still open at window close remain for settlement or resolution.
- If visible book depth runs short, DemoTrader can model the target remainder at the worst visible price. The modeled portion is synthetic, not actual market liquidity. Estimated taker fees are included in paper P&L.
- The dashboard shows the candle sequence and latest pattern action alongside BTC spot, Polymarket asks, open positions, marks, cash, equity, and realized/unrealized P&L. BTC trailing averages and Polymarket ask averages are informational only.
- After the five-minute window closes, a held-side CLOB midpoint at or above $0.99 may settle remaining shares as a $1-per-share win; a best bid at or below $0.01 may settle them as a $0-per-share loss. If neither threshold applies, the bot checks Gamma for the official outcome. These are demo settlement rules, not guarantees of official results, and they do not replace an in-window pattern exit.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital; it should reconcile to realized plus unrealized P&L.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash and trade history are in memory and reset when the process restarts. Treat simulated book fills, estimated fees, and P&L as behavior checks—not as evidence of live execution or profitability.