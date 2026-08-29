# Polymarket BTC 5m Limit-Hedge Bot (paper)

Paper/demo trading bot for the Polymarket **BTC Up/Down 5-minute** market. No wallet, no private key — every fill is simulated on the live CLOB order book.

## Strategy
1. At the start of each window, the bot places **two resting limit buy orders @ 0.40** — one on UP, one on DOWN (100 shares each).
2. A side fills when its CLOB ask reaches ≤ 0.40 (natural limit fill).
3. The **first side to fill** immediately gets a **resting limit sell @ 0.60** (take-profit).
4. When that TP limit sell fills, the **other side is already/also filled at 0.40** (binary: if UP is 0.60, DOWN is 0.40) and is **held to resolution** — its exit is by resolution, not TP — but its **stop-loss stays 0.25**.
5. **Stop-loss = market order** @ 0.25. If **any side hits SL**, the window is **paused**: all pending orders cancelled, no more entries that window.
6. **Up to two bets per window** (both 0.40 sides can fill; one TP's, the other rides to resolution).

### Order types
- **Entry:** limit buy @ 0.40
- **TP:** limit sell @ 0.60 (first-filled side only)
- **SL:** market order @ 0.25 (any side)

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `ENTRY_PRICE` | `0.40` | Limit buy entry level |
| `TP_PRICE` | `0.60` | Limit sell TP level |
| `SL_PRICE` | `0.25` | Market-order stop-loss level |
| `SHARES` | `100` | Shares per side (cost = shares × entry) |
| `CLOB_POLL_MS` | `300` | CLOB polling interval |

## Pricing
Gamma is used **only** to resolve the slug into the UP/DOWN CLOB token IDs; all prices come from the CLOB order book (`POST /books`). Pure paper simulation — limit fills when best ask ≤ entry / bid ≥ TP, market SL exits at the quoted mid. No fees modelled.

## Run
```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # engine+index syntax + internal window simulation
```

## Dashboard
Live BTC 5m UP/DOWN bid/ask/mid, window countdown, both 0.40 limit-buy orders + 0.60 TP order status, open positions (entry/mark/unrealized, TP vs held-to-resolution), bankroll/equity/realized PnL, wins/losses, drawdown, pause status, trade feed, logs, lifetime equity chart.
