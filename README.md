# Polymarket BTC 5m Flip Bot (paper)

Paper/demo trading bot for the Polymarket **BTC Up/Down 5-minute** market. No wallet, no private key — every fill is simulated on the live CLOB order book.

## Strategy (intra-window flip)
- **Demo capital:** $1,000 (configurable via `START_BANKROLL`).
- **Trade price:** whenever either side's ask **ticks up to 0.55**, the bot **fires immediately** (no wait, accepts slippage up to `TRADE_PRICE + SLIP_TOL`).
- **Alternation / flip:** the flip alternates unlimited times. Once UP fires, only DOWN can fire next — and DOWN only fires when **DOWN itself** ticks to 0.55. Then it waits for UP again, and so on.
- **Sizing (martingale):** first flip of a window = **base = 1% of current capital** (in shares at 0.55). Every subsequent flip = **2× the previous flip's shares** (e.g. 18 → 36 → 72 → 144 → …).
- **Hold to resolution:** all accumulated shares (both sides) are held until the window resolves; the winning side pays 1.0, the losing side 0.
- **Next window:** after the window resolves, base is recalculated as 1% of the updated capital.

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `TRADE_PRICE` | `0.55` | Side fires when its ask ticks to this |
| `SLIP_TOL` | `0.05` | Max accepted entry slippage above `TRADE_PRICE` |
| `BASE_PCT` | `0.01` | Base = this fraction of capital (in shares at trade price) |
| `MARTINGALE_X` | `2` | Each flip = previous shares × this |
| `START_BANKROLL` | `1000` | Demo starting capital |
| `CLOB_POLL_MS` | `300` | CLOB polling interval |

## Pricing
Gamma is used only to resolve the slug into the UP/DOWN CLOB token IDs; all prices come from the CLOB order book (`POST /books`). Fills fire on ask tick crossing 0.55. No fees modelled.

## Run
```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # engine+index syntax + internal flip-window simulation
```

## Dashboard
Live BTC 5m UP/DOWN bid/ask/mid, window countdown, flip count + latest side, base/next shares, open flip positions (entry/mark/unrealized, held to resolution), bankroll/equity/realized PnL, wins/losses, drawdown, trade feed, logs, lifetime equity chart.
