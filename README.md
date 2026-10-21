# BTC 5m CLOB Timed-Entry Paper Bot

Polymarket BTC 5-minute UP/DOWN paper trading only. The bot has a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- Every 20 seconds from 20 through 260 seconds, check UP and DOWN independently. Paper-buy each side whose fresh best ask is within $0.52-$0.75, inclusive. Both sides may be bought at the same check.
- The first successful entry in each 5-minute window is 50 shares. Each subsequent successful entry in that window is 1.3× the previous filled entry; out-of-band, stale-quote, and insufficient-cash attempts do not advance the size. Available paper cash remains the limit.
- No new entries at or after 270 seconds. Existing take-profit, stop-loss, and official settlement rules remain in effect.
- No new entries at or after 270 seconds into the window. Filled positions remain open for the existing TP/SL or official-result handling.
- Entries are modeled as taker market buys at the current best ask and use the configured crypto taker fee. They do not earn maker rebates; the rebate dashboard remains for any eligible historical maker fills.
- During the window, a fresh own-side CLOB bid, ask, or midpoint at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower it settles as a $0/share loss. Otherwise, use the official Gamma market result at window close, retrying until resolved.

The strategy uses Polymarket market metadata and CLOB quotes only; candle patterns and external BTC feeds do not drive entries. The dashboard shows the 5-minute market, both-side prices, timed entries, positions, equity, fees, and estimated rebates. Paper history resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
