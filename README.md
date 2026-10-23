# BTC 15m Confirmation Paper Bot

Polymarket BTC 15-minute UP/DOWN paper trading only. The bot has a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- Observe the first 5 minutes of each 15-minute market; require the selected BTC direction to have a net move over at least 60 seconds.
- Estimate UP/DOWN probability with a transparent normal-distribution proxy using the Chainlink BTC/USD reference price, the market-open price, and up to 60 minutes of minute-bar log-return volatility. Enter only when estimated probability exceeds the effective ask by at least 10 percentage points, the CLOB spread is at most $0.02, and the last-hour BTC range is at least 0.3%.
- Size at one-quarter Kelly using the proxy, capped at 8% of starting bankroll and available paper cash. Allow one entry per 15-minute market; no martingale.
- Do not enter during the final 3 minutes so the 3-minute stall exit can operate.
- Paper-sell at the best bid at or above $0.85, or if the best bid remains between $0.60 and $0.70 for 3 minutes. Otherwise hold to official Gamma resolution.
- Scheduled-news filtering is not implemented. This is an article-inspired approximation, not the article author’s probability model; the probability proxy is not validated as predictive.
- Paper market buys and sells use the configured crypto taker fee. No live orders are submitted.

The dashboard shows the active 15-minute market, both-side prices, price-feed status, entry-gate explanation, paper positions, equity, and fees. Paper history resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
