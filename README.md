# Polymarket Sports Pyramid Bot

Paper (demo) bot for **South Africa** in `crint-zaf-zwe-2026-08-29` (SA vs Zimbabwe T20, live). Aggressive compounding: the ±0.02 scalp engine grinds cash, and every profit is swept into a **pyramid pool** that is deployed into **SA held shares** on every +0.03 up-move of price, riding to the $1.00 win.

## Strategy
- **Scalp engine:** 4 independent buckets of $250. Each rests a limit buy 0.02 below live price (stacked 0.02 apart), sells at entry + 0.02. The bucket's capital is restored after each round-trip so it keeps scalping.
- **Profit sweep:** each round-trip's **entire profit** is moved into the pyramid pool (not kept in the bucket), so all scalp earnings feed the hold.
- **Pyramid deploy (Option 4):** every time SA's live mid rises by **+0.03** from the last pyramid entry, the whole pool is spent buying **SA shares at market**, held to resolution. Each +0.03 step only fires once per fresh step.
- **Hold:** pyramid shares are never sold — they pay $1.00 each if South Africa wins. If SA loses, the pyramid is wiped (you've assumed SA wins).

## Example
- SA mid starts 0.50 → anchor. Scalp buckets grind profit into the pool.
- Mid rises to 0.53 → pool deployed into SA shares at ~0.53.
- Mid rises to 0.56 → next fresh step, pool redeployed, more SA shares held.
- ... continuing every +0.03 until SA is ~0.90+, then riding to $1.00.

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `MARKET_SLUG` | `crint-zaf-zwe-2026-08-29` | Gamma slug |
| `SA_INDEX` | `0` | Index of SA outcome |
| `TOTAL_CAPITAL` | `1000` | Total demo capital |
| `BUCKET_COUNT` | `4` | Scalp buckets |
| `SPACING` / `PUSH` | `0.02` | Bucket separation / entry exit offsets |
| `PYRAMID_STEP` | `0.03` | Up-move per pyramid deploy |

## Pricing
Gamma resolves the slug to the SA CLOB token ID; all prices from the CLOB order book (POST /books). Pure paper limit simulation (BUY fills when best ask <= limit, SELL when best bid >= limit). No wallet/private key.

## Dashboard
Live SA bid/ask/mid, equity, realized PnL, drawdown, lifetime equity curve, pyramid bar (pool, held shares, deployed, next step, entries), 4 bucket cards, trade feed, logs.

```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # syntax checks
```
