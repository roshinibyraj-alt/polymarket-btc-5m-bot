# Polymarket Binary Copy-Trading Bot

Mirrors a master Polymarket **binary** (up/down) trader in **paper/demo**
mode using public APIs — no wallet or keys needed. Includes a **learning
model** that fingerprints the master's strategy from its real on-chain
trade history.

## What it does

- Watches `WATCH_WALLET` (default `0x251c1a283703beed41590b0875a8dcb8ddd1541f`).
- Polls the master's trades every `POLL_INTERVAL_MS` (5s) and mirrors
  each **BUY/SELL** in paper at the master's own price and size
  (× `MIRROR_SCALE`, default 1).
- When a mirrored binary market resolves, the paper position settles at
  **$1/share (won)** or **$0 (lost)** — no manual redemption needed.
- Mirrors the master's current open positions on start
  (`MIRROR_EXISTING_ON_START`), so paper equity starts at the same point.
- Runs the **learning model** (`learn-model.js`) every
  `LEARN_REFRESH_MS` (10 min) over the master's full activity feed and
  reports the strategy fingerprint on the dashboard:
  market mix (5m/15m), sides, stake sizes, entry prices, entry timing,
  buys per window, per-window win rate, edge per window, repeat-vs-fade,
  and named behavior labels (hold-to-resolution, ladder buyer,
  winner-chaser, dip buyer, profitable/breakeven/losing).

## API

| Endpoint | Purpose |
|---|---|
| `GET /` | Dashboard |
| `GET /api/status` | Full bot state (master + mirror + learning) |
| `GET /api/learn` | Learning fingerprint JSON |
| `POST /api/pause` / `POST /api/resume` | Pause / resume mirroring |
| `POST /api/set-mode` | Requests live mode (not implemented — demo only) |
| `GET /healthz` | Health check |

## Env knobs

- `WATCH_WALLET` — master address (`0x…`) or profile `@username`.
- `POLL_INTERVAL_MS` (5000), `POSITION_SWEEP_INTERVAL_MS` (30000),
  `LEARN_REFRESH_MS` (600000).
- `DEMO_CAPITAL` (20000) — paper starting bankroll.
- `MIRROR_SCALE` (1) — bot shares = master shares × scale.
- `MIRROR_FIXED_SHARES` — if set, flat share size per trade instead.
- `MAX_POSITION_USDC` (20000) — skip buys that push a mirrored window's
  cost above this.
- `MIRROR_EXISTING_ON_START` (true).

## Run

```bash
npm install
npm start          # dashboard on :8080 + mirror loop
```

## Honesty

The learning model reports the master's **actual** numbers — realized
P&L, current open P&L, win rate, and edge per window — including when
the master is losing money. Paper mirroring is not financial advice.
