# Polymarket BTC 5m Breakout Bot

Autonomous 5-minute BTC paper bot priced only by direct Polymarket CLOB order-book snapshots.

## Strategy
- Trade only `btc-updown-5m-*`.
- Poll both UP and DOWN CLOB books every 500 ms.
- When either midpoint reaches `0.89`, immediately buy that side at its executable ask.
- Base size is 100 shares.
- If the held side's bid reaches `0.79` or lower, sell immediately at that bid and realize the stop-loss.
- Otherwise hold until resolution. During the final two seconds, each side's maximum midpoint is tracked. The first side above `0.90` wins; the opposite side settles to zero.
- Aggregate all paper trades in a window. A negative net result advances martingale; a non-negative net result resets it.
- Martingale sequence: 100 → 210 → 441 → 926 → 1,945 shares. After the fourth losing martingale, reset to 100.

## Pricing
- Discovery uses Gamma only to resolve the exact BTC window slug into UP/DOWN CLOB token IDs.
- All trading prices come from batched direct CLOB `/books` requests.
- There is no alternate or fallback price source. If CLOB polling fails, trading pauses.

## Dashboard
The mobile-friendly black dashboard shows live bid/ask/mid/spread/quote age, active position, global equity, current martingale level, next loss size, completed-window P&L, execution feed and server logs.
