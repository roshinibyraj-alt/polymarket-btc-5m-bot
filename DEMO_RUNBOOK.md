# Paper bot runbook

1. Verify the dashboard shows one 5-minute market, a $10,000 demo bankroll, and live UP/DOWN CLOB quotes.
2. Every 20 seconds from 20 through 260 seconds, evaluate each side's fresh best ask independently. Buy each side priced from $0.52 through $0.75, inclusive; both sides may fill on one check.
3. The first successful entry in each 5-minute window is 50 shares. Each subsequent successful entry in that window is 1.3 times the previous filled entry. Skips and insufficient-cash rejections do not advance the size.
4. Entries are paper market buys at the current best ask and include configured taker fees. Sufficient paper cash is required; no live orders are placed.
5. No new entries at or after 270 seconds. Existing TP/SL behavior remains: own-side CLOB quote at $0.99 or higher settles at $1/share; $0.01 or lower settles at $0/share. Otherwise retry the official Gamma result at close.
6. Paper trades and account state reset on process restart.

The bot refreshes Polymarket market metadata and CLOB books every 500 ms. It does not use candle patterns or an external BTC price feed for entries. The dashboard refreshes every 2 seconds; paper orders and account history reset on process restart.
