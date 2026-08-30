# Polymarket BTC 5m Flip Bot (paper)

Paper/demo trading bot for the Polymarket **BTC Up/Down 5-minute** market. No wallet, no private key — every fill is simulated on the live CLOB order book.

## Strategy (intra-window stop-loss flip)
- **Demo capital:** $1,000 (configurable via `START_BANKROLL`).
- **Wait gate:** after a window opens the bot waits **7s** before any order.
- **First entry:** once the wait elapses, whichever side's **ask reaches 0.70** fires immediately (no previous-tick-below requirement). **Slippage ceiling 0.99**: the fill is taken at the actual observed ask, never above 0.99.
- **Sizing:** base = **1% of current capital** in shares (at 0.70). Every re-entry after a stop-loss = **2× the previous position's shares** — doubling is **unlimited** (14 → 28 → 56 → 112 → …).
- **Stop loss:** while holding, if the held side's price drops to **0.50**, the bot sells immediately at 0.50.
- **Re-entry after SL:** once stopped out, the bot waits for **any side** to reach **0.65** and fires with double the shares. This repeats for every stop-loss (flip is unlimited, side is whichever crosses the level first).
- **Hold to resolution:** if a position never hits the stop-loss it is held until the window resolves; the winning side pays 1.0, the losing side 0.
- **Next window:** after a window resolves, base is recalculated as 1% of the updated capital.

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `ENTRY_PRICE` | `0.70` | First entry fires when any side's ask reaches this |
| `SL_PRICE` | `0.50` | Stop-loss level (market sell) |
| `REENTRY_PRICE` | `0.65` | Re-entry fires when any side's ask reaches this |
| `WAIT_SECONDS` | `7` | Wait after window open before trading |
| `SLIP_CEILING` | `0.99` | Max accepted fill price (slippage ceiling) |
| `BASE_PCT` | `0.01` | Base = this fraction of capital (in shares at entry price) |
| `MARTINGALE_X` | `2` | Each re-entry = previous shares × this |
| `START_BANKROLL` | `1000` | Demo starting capital |
| `CLOB_POLL_MS` | `300` | CLOB polling interval |

## Pricing
Gamma is used only to resolve the slug into the UP/DOWN CLOB token IDs; all prices come from the CLOB order book (`POST /books`). Fires use the actual observed ask (slippage accepted up to 0.99); the stop-loss sells at 0.50. No fees modelled.

## Run
```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # engine+index syntax + internal window simulation
```

## Dashboard
Live BTC 5m UP/DOWN bid/ask/mid, window countdown, wait countdown, entry/status, base/next shares, SL/re-entry info, open positions (entry/mark/unrealized), bankroll/equity/realized PnL, wins/losses, drawdown, trade feed, logs, lifetime equity chart.
