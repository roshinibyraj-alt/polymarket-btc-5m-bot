# Polymarket BTC 5m/15m Bot — Strategy and Live-Trading Handoff

This README documents the standalone real-order bot. Older descriptions of paper candle strategies, RSI, MACD, trendlines, and probability models are obsolete for this app.

This document does not authorize a real order or a production deployment. Never put a private key or other secret in source control, this README, prompts, logs, or the dashboard.

## 1. Scope

- Trade Polymarket Bitcoin Up/Down markets for **BTC 5-minute windows only**.
- Do not trade ETH or other assets.
- Discover each market and its UP/DOWN token IDs from Polymarket market data. Use the Polymarket CLOB order book for outcome prices.
- The running app is live-order only. Paper fills and paper balances are not part of this service.
- The live signal is based on the two Polymarket outcome prices. It does **not** use BTC candle direction, RSI, MACD, trendlines, a probability model, or an ML classifier.

## 2. Current strategy

### Price inputs

For the current BTC window, obtain valid best bid and best ask quotes for UP and DOWN when available. Calculate each midpoint as:

`midpoint = (best bid + best ask) / 2`

Each quote used for a trigger must be live, valid, and no more than **5 seconds old**. Either outcome can trigger independently; a stale or missing quote on the other side does not cancel a qualifying fresh tick.

### Entry condition

For each BTC 5-minute window that starts after the process starts:

1. Wait **120 seconds after the window opens**.
2. From then until the window ends, watch fresh UP and DOWN midpoint quotes.
3. The first fresh midpoint at or above **$0.80** triggers a one-shot entry. If both qualify on the same check, choose the higher midpoint; if equal, choose UP.
4. Latch and persist the selected side and triggering price so a later quote change or account-data delay does not change the signal. A process restart does not invent a signal; an already-open window is skipped unless it has a persisted qualifying trigger.

Read the market's Gamma `version` before choosing its outcome asset IDs: use `clobTokenIds` for `v1` and `positionIds` for `v2`, aligned with the decoded `outcomes` array. Do not substitute one ID type for the other.

### Orders after a trigger

Submit two resting limit BUY orders on the **selected side only**:

| Outcome | Buy limit | Live shares | Source exit |
|---|---:|---:|---:|
| Selected side | $0.40 | 10 | $0.99 TP / $0.01 SL |
| Selected side | $0.60 | 20 | $0.99 TP / $0.01 SL |

At most these two entry orders are submitted per window, for a combined nominal entry notional of **$16** if both fill. No opening pair is submitted. Do not replace orders, rearm, or enter the other side for the same signal.

- A first partial fill completes that buy rung: cancel its unfilled remainder, confirm final matched shares, and manage only the confirmed quantity.
- During the active window, a fresh own-side best bid at or above $0.99 triggers a resting limit SELL at $0.99.
- A fresh own-side best bid at or below $0.01 triggers a resting limit SELL at $0.01 only after 295 seconds from window start.
- Cancel unfilled entry and exit orders at window end. Keep unsold shares pending until the original market is confirmed closed and resolved; map payout from that market's exact outcome token.
- The source paper bot records threshold exits as idealized $1/$0 payouts with a taker-fee estimate. Real orders use actual confirmed fill quantities and prices; a limit sell can remain unfilled until expiry and resolution.

### Dashboard mode

The dashboard reports live account and exchange-order state only. It does not simulate fills or display a separate paper ledger.

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

- Submit a Polymarket **limit BUY** at the configured rung price and rung quantity: 10 shares at $0.40 or 20 shares at $0.60.
- Do not substitute a market order or raise the limit to force a fill.
- The current client sends the limit price and size with `postOnly:false`; it does not send an explicit expiration timestamp.
- The bot attempts to cancel still-active entry orders at the window end. This is a local cancellation attempt, not an order-expiration timestamp. Report cancellation failures rather than pretending the order is gone.

### Fill checks and source exits

- The live order polling target is **500 ms**. This is not a guarantee that Polymarket will respond or fill within 500 ms.
- Poll and reconcile both BUY and SELL orders on the 500 ms target; a dashboard signal is not proof of an exchange fill.
- Use Polymarket's matched-share count as the source of truth. Never infer a real fill from a paper fill, a submitted response, or a quote touching the limit.
- On the first confirmed partial fill of a new rung, cancel its unfilled BUY remainder. Wait for final fill confirmation before sizing the exit.
- During the active market, compare a fresh own-side best bid to the source thresholds: TP at $0.99 any time; SL at $0.01 only at or after 295 seconds.
- When a threshold is reached, submit a resting limit SELL at the selected source exit price ($0.99 TP or $0.01 SL) for the confirmed unsold shares.
- Handle partial fills without overselling: account for shares already sold or reserved by a pending sell, and place a new sell only for the remaining confirmed quantity.
- The current minimum live sell size is 5 shares. If a partial fill is below 5, wait for more matched shares; if the total remains below the minimum, report the blocked quantity clearly. Do not mark it as sold.
- On an uncertain order-submission response, halt additional submissions until the order can be reconciled. Do not retry an uncertain BUY or SELL blindly, because that can create duplicates.
- Reconcile TP/SL SELL fills, cancellations, and rejections. Do not duplicate an uncertain sell. A confirmed insufficient-balance rejection may retry after a delay; other rejected or canceled exits are not automatically re-armed.

At window end, cancel any still-open exit limits and wait for confirmed resolution of the **original market**. Do not infer settlement from the next window's UP/DOWN tokens. No old $0.75/$0.85 exit mapping or other legacy TP/SL rule applies to new strategy entries. The live $0.99/$0.01 limit orders are not guaranteed to fill merely because the source trigger fired.

## 4. Account readiness, rate limits, and safety

- Account balance, positions, open orders, and recent activity are read separately from market quotes and order polling. Snapshot health is informational; it does not determine whether the authenticated CLOB order path is ready.
- The normal live account snapshot interval is **15 seconds**. Cache informational `/v2/activity` results for five minutes. If `/v2/positions` returns 429, honor `Retry-After` and apply a separate exponential cooldown from 15 seconds up to five minutes across repeated 429s. A successful complete positions read resets that cooldown.
- The 429 cooldown applies only to account snapshots. The **500 ms** tracked-order fill poll remains independent and continues during account-read backoff.
- The 500 ms tracked-order poll is **not** permission to poll the Positions API every 500 ms.
- `accountReady=true` means the live trading client authenticated and the bot is not halted by an uncertain submission or ledger failure. It does not mean the positions snapshot is fresh.
- If the Positions API returns 429, show the error and next retry while keeping the authenticated CLOB order path available. The exchange accepts or rejects each order based on its current balance and allowance checks.
- Unclassified open orders are shown as warnings but do not block entries; never blindly retry a submission whose exchange acceptance is uncertain.

### Restart and duplicate protection

The live bot writes an order ledger atomically to `BOT_STATE_DIR` before submitting orders. In Railway, attach a persistent volume at `/data` and set `BOT_STATE_DIR=/data`. A qualifying midpoint trigger after the 120-second delay is also saved; it can fire once after an authentication delay or process restart, but only before that same window ends. A restart does not invent a trigger for a window with no saved qualifying tick. If the volume is missing or the ledger is invalid, live execution remains blocked.

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
2. No strategy order is submitted before 120 seconds after a window opens; a fresh midpoint at or above $0.80 then selects one outcome.
3. A trigger produces exactly two BUY attempts on the selected side: 10 shares at $0.40 and 20 shares at $0.60. Source exits are a $0.99 limit sell on a fresh bid trigger, a $0.01 limit sell after the 295-second stop gate, or original-market resolution for unsold shares.
4. Repeated scans do not duplicate either rung or submit a buy on the opposite side.
6. Repeated scans of the same window do not duplicate either trigger's orders.
7. Confirmed full and partial fills produce SELL orders only for unsold matched shares; sub-5-share exits are reported as blocked; SELL fills/cancellations/rejections are reconciled.
8. 429 responses honor `Retry-After` for snapshot retries but do not block an authenticated CLOB order path.
9. Restart recovery reconciles previous order IDs and partial fills without duplicating BUYs or SELLs.
10. A restarted process loads the durable ledger, preserves a qualifying new-strategy trigger only for its still-open window, does not replay retired opening-pair intents, and does not duplicate submitted entries.
11. Missing/corrupt persistent state and ambiguous order submissions halt live execution; unclassified open orders are visible warnings.

## 8. Development

The Railway start command is `node index.js`; local development uses `npm start`. Run `npm test` before deployment. Set `BOT_STATE_DIR` to the mounted persistent volume path before enabling live trading.

Any new live-order behavior must be tested with mocked CLOB responses first. Do not place a real test order, enable live trading, reset a ledger, or deploy without the owner's explicit authorization.
