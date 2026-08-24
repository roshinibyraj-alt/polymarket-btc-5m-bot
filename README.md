# Polymarket Momentum Lag Bot

Autonomous demo bot modeled on the observed master behavior:

- Discovers the exact active and next 5-minute UP/DOWN markets for BTC, ETH, SOL and XRP.
- Uses one public CLOB market WebSocket for all tokens; no polling for price discovery.
- Treats BTC as the lead. A sharp BTC repricing fires only lagging ETH/SOL/XRP sides.
- Buys paper FOK at the live ask, holds through resolution, then verifies winners with Gamma.
- Every CLOB tick updates each market's UP/DOWN bid, ask, mid, spread and short-window delta in the dashboard.

## Controls

| Environment | Default | Meaning |
|---|---:|---|
| `ASSETS` | `btc,eth,sol,xrp` | Tracked/followed markets |
| `LEAD_ASSET` | `btc` | Momentum leader |
| `START_BANKROLL` | `5000` | Demo cash |
| `BASE_NOTIONAL` | `40` | Base paper order notional |
| `MAX_COST_PER_SIDE` | `180` | Maximum deployed per market side/window |
| `MAX_TRADES_PER_SIDE` | `6` | Rapid-fire tranche limit |
| `LEAD_THRESHOLD` | `0.030` | Required 2.2s BTC move |
| `FOLLOWER_MAX_MOVE` | `0.014` | Follower must still be lagging |
| `MIN_ENTRY_PRICE` / `MAX_ENTRY_PRICE` | `0.40 / 0.90` | Master-style quote range |
| `NO_NEW_ENTRIES_AFTER` | `255` | No new entries in final 45 seconds |

This is deliberately a paper-trading implementation. It does not submit live orders or require a private key.
