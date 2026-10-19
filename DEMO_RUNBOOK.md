# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. The bot reads public CCXT BTC spot data and Polymarket books; DemoTrader simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to a value other than the exact text `true`. No wallet key is needed for demo mode.
2. From this directory, run `npm install`, then `npm test`.
3. Start the app with `npm start` and open http://localhost:3000.
4. Confirm the dashboard says DEMO ONLY, shows $10,000 starting capital, identifies the CCXT feed, and reports ATR/retest state. `LIVE_TRADING=true` is refused before wallet authentication.

The default BTC source is Coinbase BTC/USD; configure another CCXT exchange with `CCXT_EXCHANGE` and `CCXT_SYMBOL`. The feed honors the exchange's minimum rate limit, so a provider may require a slower interval than 500 ms. Feed staleness and missing candle data are reported on the dashboard.

## Strategy behavior

- At each five-minute market open, the bot records the previous BTC close and calculates ATR(14) from the last 14 completed one-minute true ranges before that window. It waits for history and a fresh pre-window price if either is unavailable.
- A downside move of at least 0.5× ATR followed by a return to the previous close buys UP. An upside move of at least 0.5× ATR followed by a return buys DOWN. The excursion and retest are confirmed from successive live samples.
- Each window permits at most one filled entry. Sizing starts at 500 shares; each settled loss adds 200 shares to the next target, and each settled win subtracts 200 shares, with a 500-share floor. Unresolved positions do not change the target. There are no in-window retest-based sell orders; any open position is held until post-close settlement or resolution. Entries have no strategy-level contract-price band; available demo cash and simulated fills still apply.
- During the active window and after close, a held-side best bid at $0.99 or higher triggers take profit at $1 per remaining share; a best bid at $0.01 or lower triggers stop loss at $0 per share. These are simulated settlements, not sell orders. If neither threshold is reached, the bot waits for the paired final-window CLOB check or Gamma's official outcome.
- If visible book depth runs short, DemoTrader can model the target remainder at the worst visible price. The modeled portion is synthetic, not actual market liquidity. Estimated taker fees are included in paper P&L.
- The dashboard shows ATR/retest phase and signal alongside BTC spot, Polymarket asks, open positions, marks, cash, equity, and realized/unrealized P&L. Candle colors, BTC trailing averages, and Polymarket ask averages are informational only.
- At expiry, paired UP/DOWN CLOB midpoints that remain at $0.99 or higher on one side and $0.01 or lower on the other through the final two seconds settle the winner at $1 per share and the loser at $0. If CLOB thresholds are inconclusive, the bot checks Gamma for the official outcome. These are demo settlement rules, not guarantees of official results.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital; it should reconcile to realized plus unrealized P&L.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash, trade history, and the adaptive share-size sequence are in memory and reset when the process restarts. A new demo run starts at 500 shares. Treat simulated book fills, estimated fees, and P&L as behavior checks—not as evidence of live execution or profitability.