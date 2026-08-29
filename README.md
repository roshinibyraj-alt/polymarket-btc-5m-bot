# Polymarket Cricket Bucket Bot

Paper (demo) scalping bot for the **Zimbabwe** outcome of `crint-zaf-zwe-2026-08-29` (SA vs Zimbabwe, live T20 cricket).

## Strategy
- **Capital:** $1,000 demo, split into **4 buckets of $250** each.
- Each bucket independently places a **limit buy 0.02 below the live price**.
- The 4 buckets are stacked **0.02 apart** (bucket 1 closest to live, bucket 4 deepest, e.g. live 0.60 → buys 0.58 / 0.56 / 0.54 / 0.52).
- Buy levels re-anchor upward toward the market on rallies (catch dips); if a bucket's buy **hasn't filled within 5 minutes**, it is forcibly **re-anchored** to the current live level.
- Individual bucket depths are fixed and spaced, so re-anchored buckets **never overlap**.
- Once filled, the bucket places a **limit sell at entry + 0.02**; on exit the whole bucket reinvests into a fresh buy.

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `MARKET_SLUG` | `crint-zaf-zwe-2026-08-29` | Gamma slug |
| `OUTCOME_INDEX` | `1` | Index of the traded outcome (1 = Zimbabwe) |
| `TOTAL_CAPITAL` | `1000` | Total demo capital |
| `BUCKET_COUNT` | `4` | Parallel buckets |
| `SPACING` / `PUSH` | `0.02` | Bucket separation / entry–exit offsets |
| `REANCHOR_MS` | `300000` | Re-anchor a bucket if its buy hasn't filled in 5 min |
| `CLOB_POLL_MS` | `300` | CLOB polling interval |

## Pricing
Gamma is used **only** to resolve the slug into the Zimbabwe CLOB token ID; all prices come from the CLOB order book (`POST /books`). Pure paper limit simulation — BUY fills when best ask ≤ limit, SELL fills when best bid ≥ limit. No wallet/private key.

## Dashboard
Live Zimbabwe bid/ask/mid, total equity, realized PnL, drawdown from peak, lifetime equity curve, 4 bucket cards (capital, state, resting buy, entry/sell), trade feed, logs.

```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # syntax checks
```
