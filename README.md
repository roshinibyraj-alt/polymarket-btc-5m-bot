# Polymarket BTC 5-minute pressure forecast — paper demo

The active production entrypoint is now a paper-only BTC 5-minute pressure-forecast demo. It loads `pressure-forecast-bot.js` and does not import or start the real-order bot or Polymarket trading adapter. The detailed live-order sections later in this file are dormant reference material and are not part of the active runtime.

This document does not authorize a real order or a production deployment. Never put a private key or other secret in source control, this README, prompts, logs, or the dashboard.

## 1. Scope

- Monitor only BTC 5-minute UP/DOWN markets.
- Use Binance BTCUSDT aggregate trades and Polymarket CLOB order books.
- The running app is demo-only. No real order adapters are loaded at startup, regardless of the `LIVE_TRADING` variable.
- The new signal is an experimental, uncalibrated estimate; it does not claim validated predictive accuracy.

## 2. Current strategy

The full active rules are in `DEMO_RUNBOOK.md`. In short, the strategy waits for ten one-second Binance/Polymarket pressure samples and estimates each side's resolution probability from price, volatility, Polymarket odds, and pressure. Either side may qualify at any quoted price when its probability is above 70% and its net edge is at least $0.10 per share; the full ask sweep remains capped at $0.95. Entries start at 100 shares and grow by 10 shares per additional $0.01 of net edge, capped at 200 shares. Each side has an independent 15-second cooldown. A fresh best bid of $0.99 triggers a simulated $1-per-share take-profit; there is no stop-loss. Positions that do not hit take-profit settle only after official resolution of the original market, checked every 10 seconds.

The dashboard shows the experimental forecast and explicitly labels it uncalibrated. A separate adaptive-sample shadow portfolio compares hypothetical P&L using 10 samples for the first minute, then 9, 8, 7, and 6 samples at later minute marks. The trading model remains fixed at 10 samples; the shadow never submits orders or changes trading cash.

The demo paper ledger is stored separately from the live-order ledger on the existing Railway volume at `/data/pressure-paper-state.json`. On first startup, the app imports the current demo snapshot from its existing dashboard before opening the new service; if that import or validation fails, it does not start a fresh empty bot. Afterward, trade/history changes and periodic checkpoints are saved atomically and restored on restart. The public snapshot exposes the shadow portfolio's totals but not its old individual tickets, so those pre-migration shadow totals are carried forward as a historical summary.

## 3. Real order lifecycle

### Enablement

Real strategy orders require:

- `LIVE_TRADING=true`
- `PRIVATE_KEY` provided only through the deployment's secret manager
- `BOT_STATE_DIR` pointing to a persistent mounted directory for the live-order ledger
- Successful Polymarket authentication and durable live-order storage
- `LIVE_ORDER_FLOW_TEST=false` for normal strategy operation; set true only to arm the one-shot smoke test below

If live trading is enabled without `PRIVATE_KEY` or durable state storage, fail safely and do not start real trading. Positions, collateral, activity, and open-order snapshots are informational and do not gate entries. Polymarket validates funds and allowances on each order. Keep the hard stop for failed authentication, durable-ledger failures, or an order submission whose acceptance is uncertain. Do not silently fall back to paper and label it live.

### One-shot real order-flow smoke test

When explicitly enabled, the smoke test pauses normal strategy entries and waits for the next BTC 5-minute window after it was armed. On the first fresh UP or DOWN ask at or below $0.70 with at least five shares offered, it submits one five-share limit BUY at $0.70 (maximum buy notional $3.50 before fees). The order is stored in the same durable ledger as strategy orders. The regular 500 ms order poll waits for Polymarket-confirmed matched shares; only then does the bot submit a five-share limit SELL at $0.75.

The test is one-shot and restart-safe. A confirmed take-profit submission completes the test and resumes normal strategy entries on later eligible windows. If the test window ends without a fillable quote, it completes without an order. A partial fill below the minimum sell size, a rejected take-profit, an uncertain submission, or a ledger failure stays visible and keeps strategy entries paused rather than risking a duplicate or leaving the test position unmanaged. Dashboard/API state identifies the test order and status.

### Entry order

- Submit Polymarket **limit BUY** orders: the candle-selected opening order is 10 shares at $0.30; the trigger ladder is 10 shares at $0.40 and 20 shares at $0.45.
- Do not substitute a market order or raise the limit to force a fill.
- The current client sends the limit price and size with `postOnly:false`; it does not send an explicit expiration timestamp.
- The bot attempts to cancel still-active entry orders at the window end. This is a local cancellation attempt, not an order-expiration timestamp. Report cancellation failures rather than pretending the order is gone.

### Fill checks and resolution

- The live order polling target is **500 ms**. This is not a guarantee that Polymarket will respond or fill within 500 ms.
- Poll and reconcile both BUY and SELL orders on the 500 ms target; a dashboard signal is not proof of an exchange fill.
- Use Polymarket's matched-share count as the source of truth. Never infer a real fill from a paper fill, a submitted response, or a quote touching the limit.
- On the first confirmed partial fill of a new rung, cancel its unfilled BUY remainder. Wait for final fill confirmation before sizing the exit.
- Do not submit TP or SL sells for strategy entries. Keep confirmed shares until the original market is closed and its resolution is confirmed.
- When a threshold is reached, submit a resting limit SELL at the selected source exit price ($0.99 TP or $0.01 SL) for the confirmed unsold shares.
- Handle partial fills without overselling: account for shares already sold or reserved by a pending sell, and place a new sell only for the remaining confirmed quantity.
- The current minimum live sell size is 5 shares. If a partial fill is below 5, wait for more matched shares; if the total remains below the minimum, report the blocked quantity clearly. Do not mark it as sold.
- On an uncertain order-submission response, halt additional submissions until the order can be reconciled. Do not retry an uncertain BUY or SELL blindly, because that can create duplicates.
- Reconcile TP/SL SELL fills, cancellations, and rejections. Do not duplicate an uncertain sell. A confirmed insufficient-balance rejection may retry after a delay; other rejected or canceled exits are not automatically re-armed.

At window end, cancel any still-open BUY orders and wait for confirmed resolution of the **original market**. Do not infer settlement from the next window's UP/DOWN tokens. New strategy entries have no take-profit or stop-loss orders.

## 4. Account readiness, rate limits, and safety

- Account balance, positions, open orders, and recent activity are read separately from market quotes and order polling. Snapshot health is informational; it does not determine whether the authenticated CLOB order path is ready.
- The normal live account snapshot interval is **15 seconds**. Cache informational `/v2/activity` results for five minutes. If `/v2/positions` returns 429, honor `Retry-After` and apply a separate exponential cooldown from 15 seconds up to five minutes across repeated 429s. A successful complete positions read resets that cooldown.
- The 429 cooldown applies only to account snapshots. The **500 ms** tracked-order fill poll remains independent and continues during account-read backoff.
- The 500 ms tracked-order poll is **not** permission to poll the Positions API every 500 ms.
- `accountReady=true` means the live trading client authenticated and the bot is not halted by an uncertain submission or ledger failure. It does not mean the positions snapshot is fresh.
- If the Positions API returns 429, show the error and next retry while keeping the authenticated CLOB order path available. The exchange accepts or rejects each order based on its current balance and allowance checks.
- Unclassified open orders are shown as warnings but do not block entries; never blindly retry a submission whose exchange acceptance is uncertain.

### Restart and duplicate protection

The live bot writes an order ledger atomically to `BOT_STATE_DIR` before submitting orders. In Railway, attach a persistent volume at `/data` and set `BOT_STATE_DIR=/data`. A qualifying midpoint trigger is also saved; it can fire once after an authentication delay or process restart, but only before that same window ends. A restart does not invent a trigger for a window with no saved qualifying tick. If the volume is missing or the ledger is invalid, live execution remains blocked.

Persist before/with every live submission:

- Market slug, timeframe, window start/end, side, rung price, requested shares
- CLOB order ID, order status, matched shares, and last reconciliation time
- Parent/child relationship between each BUY and its take-profit SELL
- Submitted, filled, reserved-for-exit, and exited share quantities
- Per-window/per-side/per-rung idempotency keys

On startup, load the durable ledger before enabling new entries. Open-order and positions snapshots are useful for recovery and dashboard visibility, but they do not gate authenticated CLOB submissions. If an order's submission result is uncertain, reconcile that specific order before any retry. Do not reset live order state or paper balances as an implicit side effect of deployment.

Run one active trading instance per wallet unless shared durable coordination prevents duplicate orders across instances.

## 5. Dashboard and API

The dashboard must show the active BTC 5m market and its current strategy:

- Current market slug and time remaining
- UP and DOWN best bid, best ask, and midpoint
- Quote timestamp/age and an explicit `LIVE`, `STALE`, or `MISSING` state
- The evaluated midpoint band, signal decision, and skip reason
- Live trading enabled/paused state, CLOB order-path readiness, snapshot freshness, last successful snapshot, next retry, and any 429/error
- Each live BUY and SELL order's side, limit price, requested shares, matched shares, status, and linked take-profit
- Live account readiness, tracked BUY/SELL orders, matched shares, and bot events

`/api/state` is the live bot snapshot. `/api/live-balance` reports the last account snapshot and tracked live orders. `/api/healthz` returns 503 until the CLOB client authenticates or while a hard safety halt is active; a stale Positions API snapshot alone does not fail health. Never display private keys or secrets.

## 7. Acceptance tests before using real funds

At minimum, test that:

 1. Only BTC 5m markets are actively scanned for new entries; ETH, 15m, and malformed/expired markets are not traded.
2. At window open, a green previous candle selects UP or a red previous candle selects DOWN for one 10-share limit BUY at $0.30; a doji skips this order.
3. A fresh midpoint at or above $0.70 triggers the separate two-order ladder: 10 shares at $0.40 and 20 shares at $0.45 on the candle-permitted side. Confirmed shares wait for original-market resolution, with no strategy TP/SL sells.
4. Repeated scans do not duplicate either rung or submit a buy on the opposite side.
6. Repeated scans of the same window do not duplicate either trigger's orders.
7. Confirmed full and partial fills are tracked correctly and held until original-market resolution; no strategy SELL orders are submitted.
8. 429 responses honor `Retry-After` for snapshot retries but do not block an authenticated CLOB order path.
9. Restart recovery reconciles previous order IDs and partial fills without duplicating BUYs or SELLs.
10. A restarted process loads the durable ledger, preserves a qualifying new-strategy trigger only for its still-open window, does not replay retired opening-pair intents, and does not duplicate submitted entries.
11. Missing/corrupt persistent state and ambiguous order submissions halt live execution; unclassified open orders are visible warnings.

## 8. Development

The Railway start command is `node index.js`; local development uses `npm start`. Run `npm test` before deployment. Set `BOT_STATE_DIR` to the mounted persistent volume path before enabling live trading.

Any new live-order behavior must be tested with mocked CLOB responses first. Do not place a real test order, enable live trading, reset a ledger, or deploy without the owner's explicit authorization.
