# Polymarket BTC Divergence Bot

Autonomous 5-minute paper bot using real CLOB order-book streams.

## Rule
- BTC 5-minute UP/DOWN is the signal only.
- If BTC UP midpoint is above `0.75`, buy any other tracked pair's UP while its midpoint is below `0.50`.
- If BTC DOWN midpoint is above `0.75`, buy any other tracked pair's DOWN while its midpoint is below `0.50`.
- Maximum one 100-share FOK-style paper entry per side direction per window: at most one UP fill and one DOWN fill.
- Entries fill at the target token's live CLOB ask.
- During the final two seconds, the highest UP and DOWN midpoints are captured. If one side exceeds `0.90`, that side wins immediately and capital/P&L updates.
- If the final-two-second rule cannot determine a winner, Gamma resolution remains authoritative.

## Dashboard
Every CLOB tick updates all tracked markets' UP/DOWN bid, ask, midpoint, spread and short-window delta. Positions are marked to market continuously. The dashboard also shows discovery status, subscriptions, reconnects, execution feed, active windows, resolved results and server logs.
