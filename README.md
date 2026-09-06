# Polymarket BTC 5m Up/Down Bot — paper trading

Engine B runs an interval-based accumulation ("ladder") strategy against
Polymarket's `btc-updown-5m-*` markets, in **paper mode** (simulated
$5,000 balance, no real orders) with a live dashboard.

## Strategy — Engine B (interval ladder)

**Phase 1 (t=0s to t=120s):** every 15 seconds (9 checks: 0, 15, 30, ...,
120), buy the **cheaper** side for **50 shares**, only if its price is
below **0.40**. The side can differ from check to check.

**Gap (t=120s to t=135s):** idle, no checks.

**Phase 2 (t=135s to t=255s):** every 15 seconds (9 checks: 135, 150,
..., 255), buy the **cheaper** side for **50 shares**, only if its
price is below **0.40** — same entry rule as phase 1, same size, just a
different timing window.

**t=255s to close (300s):** idle, hold everything to expiry.

No stop loss, no take profit — every individual fill across both phases
is tracked separately and settled against Polymarket's **real**
outcome at window close (via `fetch_resolution`, retried for ~6s with a
last-price fallback): $1/share if that fill's side won, $0/share if it
lost.

A side printing 0.90+ in the last 2 seconds before close is logged for
visibility but never triggers an action.

## Fees

Modeled on Polymarket's published taker-fee formula:

```
fee = shares * TAKER_FEE_RATE * price * (1 - price)
```

`TAKER_FEE_RATE = 0.07` (current Crypto-category rate). Peaks at a 0.50
price and shrinks symmetrically toward the extremes — e.g. 100 shares
at 0.30 costs ~$1.47 in fees, at 0.05 costs ~$0.33. Charged on every
buy (every fill in this bot is a taker fill). Redemption at expiry is
not a matched CLOB trade and isn't fee'd. Verify the current rate at
docs.polymarket.com/trading/fees before relying on this for real
capital — Polymarket has changed its fee structure more than once in
2026.

## Dashboard

- Live Up/Down prices + sparkline.
- **Window timeline**: a segmented bar showing phase 1 / gap / phase 2 /
  hold, with all 18 check points marked — filled green/red if bought
  (colored by side), hollow gray if skipped, dark gray if still
  upcoming. A moving amber playhead tracks elapsed time.
- **Exposure cards** for Up and Down: total shares, average entry
  price, cost basis, live mark-to-market value, and unrealized P&L.
- Balance / total P&L strip and full trade log.

## Project layout

```
app/
  config.py             strategy + runtime parameters
  models.py              shared dataclasses/enums
  polymarket_client.py   Gamma (market discovery) + CLOB (pricing) + resolution API client
  paper_broker.py         simulated wallet / fills / PnL
  engine_b.py              the ladder strategy
  state.py                 background polling loop + orchestration
  main.py                  FastAPI app (serves API + dashboard)
static/index.html          dashboard UI
```

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

Open http://localhost:8000

## Deploy: GitHub → Railway

1. Push this folder to a new GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Interval ladder strategy"
   git branch -M main
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway auto-detects Python via Nixpacks and uses the `Procfile` /
   `railway.json` start command — no manual build config needed.
3. Under **Variables**, set any of the values from `.env.example` you
   want to override (defaults work out of the box for paper mode).
4. Deploy. Railway assigns a public URL — that's your dashboard.

## Verify the Polymarket API responses once live

`app/polymarket_client.py` isolates all HTTP calls to Polymarket's
public Gamma (metadata) and CLOB (pricing) APIs. After your first
deploy, confirm:

- The dashboard header shows a real slug instead of "waiting for
  market...".
- Up/Down prices populate and the sparkline moves.
- Fills settle correctly at window close (check the trade log for
  `RESOLVE_WIN` / `RESOLVE_LOSS` rows, or `RESOLUTION_FALLBACK` if the
  real outcome wasn't confirmed in time).

If any of these are off, the fix is contained to `polymarket_client.py`.

## Going live (real orders)

This build intentionally stops at paper trading. To route real orders,
add `py-clob-client`, a funded Polygon wallet, and Polymarket API
credentials, then replace the `buy`/`sell` calls in `paper_broker.py`
with real order calls and add slippage/fee handling and a kill switch
before risking capital.
