# Polymarket BTC 5m Momentum Bot (paper)

Paper/demo trading bot for the Polymarket **BTC Up/Down 5-minute** market, modelled on the momentum-near-close strategy. No wallet, no private key — every fill is simulated on the live CLOB order book.

## Strategy
1. Bot discovers the active `btc-updown-5m-<bucket>` market via Gamma (slug lookup) — prices always come from the CLOB order book (`POST /books`), no Gamma price fallback.
2. On (re)start, the bot waits for the **next full window** before trading.
3. Entry is gated to roughly **120s left** in the window (default ±30s tolerance, never earlier than 60s left).
4. Momentum confirmation: BTC must have moved **$70–100** in the active 5m interval (Binance 1m candles + tick price).
5. Trigger: the side whose **best ask reaches ≥ 0.70** is entered (follows momentum). If both sides are ≥ 0.70, the **stronger side** (higher ask) is picked.
6. Safety guards: skip if spread > 0.03, top-of-book ask notional < $30, stale quotes (>8s), or after API failures.
7. One trade per window. Optional stop-loss at `STOP_LOSS_PCT` below entry; otherwise position exits before **20s left** if marketable, else **holds to resolution** (paper settlement via final observed CLOB mid).

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `PROFILE` | `conservative` | `conservative` (5/8) or `aggressive` (5/15) sizing reference |
| `THRESHOLD` | `0.70` | Trigger on best ask ≥ threshold |
| `STAKE_USD` | `5` | Paper stake per trade |
| `MAX_NOTIONAL` | `8` | Hard cap per trade (conservative) |
| `STOP_LOSS_PCT` | `0.25` | Stop-loss below entry; `0` disables |
| `ENTRY_TARGET_LEFT` | `120` | Target seconds left for entry |
| `ENTRY_TOLERANCE` | `30` | ± tolerance on the entry target |
| `MIN_ENTRY_LEFT` | `60` | Never enter earlier than this |
| `EXIT_BEFORE_SEC` | `20` | Try to exit before this many seconds left |
| `MOVE_MIN_USD` / `MOVE_MAX_USD` | `70` / `100` | Impulse confirmation range (BTC USD move) |
| `SPREAD_GUARD` | `0.03` | Skip if spread wider |
| `MIN_TOP_NOTIONAL` | `30` | Skip if top ask notional thinner |
| `STALE_GUARD_MS` | `8000` | Skip if quote older |
| `CLOB_POLL_MS` | `300` | CLOB polling interval |

## Run
```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # syntax checks
```

## Dashboard
Live BTC price + impulse, window countdown, UP/DOWN bid/ask/mid/depth, open position (entry/mark/unrealized), bankroll/equity/realized PnL, drawdown from peak, lifetime equity curve, trade feed and logs.
