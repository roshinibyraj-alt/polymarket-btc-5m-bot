# Polymarket BTC Divergence Bot

Autonomous 5-minute paper bot using real CLOB order-book streams.

## Rule
- BTC 5-minute UP/DOWN is the signal only.
- After a two-minute wait from window start (`ENTRY_WAIT_SECONDS=120`), if BTC UP midpoint is above `0.65`, buy any other tracked pair's UP while its midpoint is below `0.50`.
- After the wait, if BTC DOWN midpoint is above `0.65`, buy any other tracked pair's DOWN while its midpoint is below `0.50`.
- Each non-BTC pair may receive at most one 100-share entry per window, independently of every other pair.
- Entries fill at the target token's live CLOB ask.
- Expired/stale windows cannot fire, including during the rotation boundary.
- During the final two seconds, current UP/DOWN midpoints are sampled continuously and each side's highest price is captured. If one side exceeds `0.90`, that side wins immediately and capital/P&L updates.
- There is no price fallback. Trading and dashboard prices use only CLOB order-book WebSocket data; if CLOB fails, trading stops.
- Expired market subscriptions are released shortly after final-price settlement so the combined socket stays small and fast.

## Dashboard
Every CLOB tick updates all four active-window markets' UP/DOWN bid, ask, midpoint, spread and short-window delta. Positions are marked to market continuously. The dashboard also shows discovery status, subscriptions, reconnects, execution feed, active windows, resolved results and server logs.
