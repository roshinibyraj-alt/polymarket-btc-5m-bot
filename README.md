# Polymarket BTC 5m Breakout Bot

A deterministic five-minute BTC paper bot with one strict lifecycle per UTC-aligned window.

## Strategy
- Trade only the current `btc-updown-5m-*` market.
- Poll both UP/DOWN CLOB top-of-book prices every 100 ms.
- On any single snapshot, fire immediately if bid, ask, or midpoint touches `0.89`.
- Buy at executable ask by paper market order; one entry maximum per window.
- Close immediately when held-side bid reaches `0.79` or lower.
- Track each side's maximum midpoint during the final two seconds.
- The first side strictly above `0.90` during the final two seconds wins. If neither side meets that rule by window end, an open paper position is marked to its last CLOB midpoint so it can never block the next window.
- A losing window advances martingale: 100 → 210 → 441 → 926 → 1,945 shares.
- A win or flat trading window resets to 100 shares. After the fourth martingale loss, reset to 100 shares.

## Window Rollover
Discovery is deduplicated and starts for both current and next windows. At rollover the prior market is settled, its position/statistics are finalized, and the new current slug is used immediately. A missing or failed discovery never reuses stale prices or another market.

## Pricing
Gamma is used only to resolve the exact slug into UP/DOWN CLOB token IDs. All displayed and trading prices come from batched direct CLOB `/prices` requests, using `BUY` as best bid and `SELL` as executable ask. There is no alternate price source.

## Dashboard
The black mobile dashboard renders live UP/DOWN bid/ask/mid, timer, floating P&L, global equity curve, completed-window results, executions and server logs.
