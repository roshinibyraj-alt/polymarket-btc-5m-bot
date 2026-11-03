# Polymarket BTC 5m/15m Bot — Strategy and Live-Trading Handoff

This README documents the standalone real-order bot. Older descriptions of paper candle strategies, RSI, MACD, trendlines, and probability models are obsolete for this app.

This document does not authorize a real order or a production deployment. Never put a private key or other secret in source control, this README, prompts, logs, or the dashboard.

## 1. Scope

- Trade Polymarket Bitcoin Up/Down markets for **BTC 5-minute and BTC 15-minute windows only**.
- Do not trade ETH or other assets.
- Discover each market and its UP/DOWN token IDs from Polymarket market data. Use the Polymarket CLOB order book for outcome prices.
- The running app is live-order only. Paper fills and paper balances are not part of this service.
- The live signal is based on the two Polymarket outcome prices. It does **not** use BTC candle direction, RSI, MACD, trendlines, a probability model, or an ML classifier.

## 2. Current strategy

### Price inputs

For the current BTC window, obtain a valid best bid and best ask for both UP and DOWN. Calculate each midpoint as:

`midpoint = (best bid + best ask) / 2`

Both quotes must be marked live, have valid prices, and be no more than **5 seconds old** when evaluated. If either side is missing, stale, or invalid, do not trigger because the strategy submits orders on both outcomes.

### Entry condition

Evaluate during the **last 60 seconds of the current window**. Trigger while the window is still open when **either** midpoint is within the inclusive band **$0.30 to $0.71**:

- UP midpoint: $0.30–$0.71, or
- DOWN midpoint: $0.30–$0.71

At least one condition must be true at the same evaluation. The band applies to the outcome midpoint, not the buy-limit price. Both quotes still must be fresh.

### Orders after a trigger

This is a **two-sided strategy**, not a directional chooser. On a valid trigger, submit the following limit-buy ladder for **both UP and DOWN**:

| Outcome | Buy limit | Live shares | Take-profit sell limit |
|---|---:|---:|---:|
| UP | $0.25 | 10 | $0.75 |
| UP | $0.15 | 10 | $0.85 |
| DOWN | $0.25 | 10 | $0.75 |
| DOWN | $0.15 | 10 | $0.85 |

That is four buy orders per eligible window. If all four fill at their limits, the nominal entry notional is $8 before fees. Do not change the 10-share live size without an explicit instruction.

- Submit each rung once per market window; do not continuously rebuy, add replacement buys after a take-profit, or flip/reverse the signal.
- The $0.25 rung always maps to a $0.75 take-profit; the $0.15 rung always maps to a $0.85 take-profit. Each sell is for the **same outcome token** that was bought.
- Do not add a 30-second delay. The strategy is eligible only in the final 60 seconds.
- A trade is **not guaranteed every window**. Missing/stale quotes or a midpoint outside the band means no trigger. Do not bypass these conditions to force an order.

### Dashboard mode

The dashboard reports live account and exchange-order state only. It does not simulate fills or display a separate paper ledger.

## 3. Real order lifecycle

### Enablement

Real strategy orders require:

- `LIVE_TRADING=true`
- `PRIVATE_KEY` provided only through the deployment's secret manager
- `BOT_STATE_DIR` pointing to a persistent mounted directory for the live-order ledger
- Successful Polymarket authentication and a healthy, reconciled live account snapshot
- `LIVE_ORDER_FLOW_TEST=false`

If live trading is enabled without `PRIVATE_KEY` or durable state storage, fail safely and do not start real trading. If authentication, account readiness, reconciliation, or order status is unhealthy, block new buys and show the reason. Do not silently fall back to paper and label it live.

### Entry order

- Submit a Polymarket **limit BUY** at the configured rung price and the fixed 10-share quantity.
- Do not substitute a market order or raise the limit to force a fill.
- The current client sends the limit price and size with `postOnly:false`; it does not send an explicit expiration timestamp.
- The bot attempts to cancel still-active entry orders at the window end. This is a local cancellation attempt, not an order-expiration timestamp. Report cancellation failures rather than pretending the order is gone.

### Fill checks and take-profit

- The live order polling target is **500 ms**. This is not a guarantee that Polymarket will respond or fill within 500 ms.
- Poll and reconcile both BUY and SELL orders on the 500 ms target; a dashboard signal is not proof of an exchange fill.
- Use Polymarket's matched-share count as the source of truth. Never infer a real fill from a paper fill, a submitted response, or a quote touching the limit.
- After a real fill is confirmed, submit a **limit SELL** at the corresponding take-profit price for the confirmed filled shares that have not already been assigned to an exit order.
- Handle partial fills without overselling: account for shares already sold or reserved by a pending sell, and place a new sell only for the remaining confirmed quantity.
- The current minimum live sell size is 5 shares. If a partial fill is below 5, wait for more matched shares; if the total remains below the minimum, report the blocked quantity clearly. Do not mark it as sold.
- On an uncertain order-submission response, halt additional submissions until the order can be reconciled. Do not retry an uncertain BUY or SELL blindly, because that can create duplicates.
- Reconcile TP SELL fills, cancellations, and rejections. Do not duplicate an uncertain sell. A confirmed insufficient-balance rejection may retry after a delay; other rejected or canceled exits are not automatically re-armed.

There is **no live stop-loss rule** in this strategy. Live exits are the mapped take-profit limit sells; there is no automatic market sell or opposite-side reversal. Take-profit orders have no explicit expiry and are left to Polymarket's market lifecycle. Do not claim a take-profit happened just because the price briefly touched it.

## 4. Account readiness, rate limits, and safety

- Account balance, positions, open orders, and recent activity are read separately from market quotes and order polling.
- The normal live account snapshot interval is **15 seconds**. The Positions API has a minimum request interval and its `Retry-After` response must be honored. On errors, use bounded exponential backoff (up to 15 seconds); do not hammer the endpoint.
- The 500 ms tracked-order poll is **not** permission to poll the Positions API every 500 ms.
- Require `accountReady=true` and a healthy live status before submitting new strategy orders. A successful HTTP response with an error payload is not readiness.
- If the Positions API returns 429, keep the account unready, show the error and next retry, and block new real entries. Never bypass a 429 by using stale account data.

### Restart and duplicate protection

The live bot writes an order ledger atomically to `BOT_STATE_DIR` before submitting orders. In Railway, attach a persistent volume at `/data` and set `BOT_STATE_DIR=/data`. The bot skips markets whose window began before the current process started and reconciles saved orders against Polymarket before enabling new entries. If the volume is missing, the ledger is invalid, or an order cannot be reconciled, live execution remains blocked.

Persist before/with every live submission:

- Market slug, timeframe, window start/end, side, rung price, requested shares
- CLOB order ID, order status, matched shares, and last reconciliation time
- Parent/child relationship between each BUY and its take-profit SELL
- Submitted, filled, reserved-for-exit, and exited share quantities
- Per-window/per-side/per-rung idempotency keys

On startup, reconcile the persisted ledger against Polymarket open orders and positions before enabling new entries. If an order's submission result is uncertain, search/reconcile before retrying. Do not reset live order state or paper balances as an implicit side effect of deployment.

Run one active trading instance per wallet unless shared durable coordination prevents duplicate orders across instances.

## 5. Dashboard and API

The dashboard must show, separately for BTC 5m and BTC 15m:

- Current market slug and time remaining
- UP and DOWN best bid, best ask, and midpoint
- Quote timestamp/age and an explicit `LIVE`, `STALE`, or `MISSING` state
- The evaluated midpoint band, signal decision, and skip reason
- Live trading enabled/paused state, account readiness, last successful snapshot, next retry, and any 429/error
- Each live BUY and SELL order's side, limit price, requested shares, matched shares, status, and linked take-profit
- Live account readiness, tracked BUY/SELL orders, matched shares, and bot events

`/api/state` is the live bot snapshot. `/api/live-balance` reports the last account snapshot and tracked live orders. `/api/healthz` returns 503 until live account reconciliation is healthy. Never display private keys or secrets.

## 7. Acceptance tests before using real funds

At minimum, test that:

1. Only BTC 5m and BTC 15m markets are accepted; ETH and malformed/expired markets are rejected.
2. No signal is produced before the final 60 seconds, after window end, with stale/missing quotes, or if both midpoints are outside $0.30–$0.71.
3. An eligible signal produces exactly four 10-share BUY attempts: both outcomes at $0.25 and $0.15, with the correct $0.75/$0.85 take-profit mapping.
4. Repeated scans of the same window do not duplicate a rung.
5. Confirmed full and partial fills produce SELL orders only for unsold matched shares; sub-5-share exits are reported as blocked; SELL fills/cancellations/rejections are reconciled.
6. 429 responses honor `Retry-After`, block new orders, and do not cause rapid retries or stale-account trading.
7. Restart recovery reconciles previous order IDs and partial fills without duplicating BUYs or SELLs.
8. A restarted process loads the durable ledger and does not duplicate a submitted entry.
9. Missing/corrupt persistent state and unknown open orders block live execution.

## 8. Development

The Railway start command is `node index.js`; local development uses `npm start`. Run `npm test` before deployment. Set `BOT_STATE_DIR` to the mounted persistent volume path before enabling live trading.

Any new live-order behavior must be tested with mocked CLOB responses first. Do not place a real test order, enable live trading, reset a ledger, or deploy without the owner's explicit authorization.
