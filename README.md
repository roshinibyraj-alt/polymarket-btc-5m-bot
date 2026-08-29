# Polymarket Sports Bucket Bot

A paper (demo) scalping bot for Polymarket sports markets. Trades the **South Africa** outcome of `crint-zaf-zwe-2026-08-29` (South Africa vs Zimbabwe, live T20 cricket).

## Strategy
- **Capital:** $1,000 demo, split into **4 buckets of $250** each.
- Each bucket independently places a **limit buy 0.02 below the live price**.
- The 4 buckets are stacked **0.02 apart** (bucket 1 closest to live, bucket 4 deepest).
- Buy levels track the live CLOB price (dynamic re-anchor). When the ask crosses a bucket's limit, the bucket fills.
- Once filled, the bucket places a **limit sell at entry + 0.02**. When the bid crosses, it sells, realizes the profit, and the whole bucket is reinvested in the next buy.
- All 4 buckets cycle independently and in parallel.

## Example (live price 0.60)
- Buy limits: 0.58, 0.56, 0.54, 0.52 (each 0.02 apart, below live).
- On fill at 0.56 → sell limit at 0.58 → profit = shares × 0.02.

## Configuration (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `MARKET_SLUG` | `crint-zaf-zwe-2026-08-29` | Gamma slug for discovery |
| `SA_INDEX` | `0` | Index of South Africa outcome |
| `TOTAL_CAPITAL` | `1000` | Total demo capital |
| `BUCKET_COUNT` | `4` | Number of parallel buckets |
| `SPACING` | `0.02` | Distance between adjacent bucket levels |
| `PUSH` | `0.02` | Entry offset below live / exit offset above entry |
| `CLOB_POLL_MS` | `300` | CLOB polling interval |

## Pricing
- Gamma is used **only** to resolve the slug into the South Africa CLOB token ID.
- All prices come from the CLOB order book (`POST /books`). Pure limit-order simulation: BUY fills when best ask ≤ limit, SELL fills when best bid ≥ limit.
- Paper trading only — no wallet, no private key, no real orders.

## Dashboard
- Live SA bid/ask/mid, total equity, realized PnL, drawdown from peak, lifetime equity curve.
- 4 bucket cards showing capital, state (FLAT / BUY_PLACED / HELD), open order, entry/sell levels.
- Trade feed and logs.

## Run
```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # syntax checks
```
