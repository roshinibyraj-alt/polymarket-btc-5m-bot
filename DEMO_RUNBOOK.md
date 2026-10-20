# Paper bot runbook

1. Verify the dashboard shows one 5-minute market, a $10,000 demo bankroll, and live UP/DOWN CLOB quotes.
2. At window start, the paper model creates seven 100-share buy limits on each side: $0.40 down to $0.10 in $0.05 steps.
3. A rung fills at its limit when the fresh CLOB ask reaches or crosses that price. UP and DOWN positions are independent; both sides may fill.
4. At 30, 60, and 90 seconds, buy 500 shares at the lower of the two fresh best asks. At 120, 150, 180, and 210 seconds, buy 500 shares at the higher fresh best ask. No price threshold or martingale sizing applies; require both asks to be fresh and require sufficient paper cash.
5. End scheduled entries after the 210-second buy. Existing take-profit, stop-loss, and official settlement rules remain in effect.
5. Existing TP/SL behavior remains: own-side CLOB quote at $0.99 or higher settles at $1/share; $0.01 or lower settles at $0/share. Otherwise retry the official Gamma result at close.
6. Timed entries are paper market buys at the current best ask and include configured taker fees. They are not maker fills and earn no maker rebate. The dashboard's rebate figure is only an estimate for eligible maker fills.
7. Paper trades and account state reset on process restart. No live order placement is present.

The bot refreshes Polymarket market metadata and CLOB books every 500 ms. It does not use candle patterns or an external BTC price feed for entries. The dashboard refreshes every 2 seconds; paper orders and account history reset on process restart.
