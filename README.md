# Polymarket BTC 5m/15m Bot — Strategy and Live-Trading Handoff

This README is the implementation brief for recreating or modifying this bot. Follow the current market-confusion strategy and live-order rules below; older README descriptions of candle-color entries, 20-share live entries, RSI, MACD, or trendlines are obsolete for this app.

This document does not authorize a real order or a production deployment. Never put a private key or other secret in source control, this README, prompts, logs, or the dashboard.

## 1. Scope

- Trade Polymarket Bitcoin Up/Down markets for **BTC 5-minute and BTC 15-minute windows only**.
- Do not trade ETH or other assets.
- Discover each market and its UP/DOWN token IDs from Polymarket market data. Use the Polymarket CLOB order book for outcome prices.
- Keep paper/demo execution separate from real execution. A paper fill must never be treated as proof that a real order was placed or filled.
- The live signal is based on the two Polymarket outcome prices. It does **not** use BTC candle direction, RSI, MACD, trendlines, a probability model, or an ML classifier.

## 2. Current strategy

### Price inputs

For the current BTC window, obtain a valid best bid and best ask for both UP and DOWN. Calculate each midpoint as:

`midpoint = (best bid + best ask) / 2`

Both quotes must be marked live, have valid prices, and be no more than **5 seconds old** when evaluated. If either side is missing, stale, or invalid, do not trigger.

### Entry condition

Evaluate during the **last 60 seconds of the current window**. Trigger only while the window is still open and both midpoint prices are within the inclusive band **$0.30 to $0.71**:

- UP midpoint: $0.30–$0.71
- DOWN midpoint: $0.30–$0.71

Both conditions must be true at the same evaluation. The band applies to the two outcome midpoints; it is not the buy-limit price.

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

### Paper/demo sizing

The paper strategy uses 500 shares per rung, separately from live sizing. Paper state is a simulator and is not the source of live order signals or fill status. Keep paper balances and live wallet balances clearly labeled and separate in the UI.

## 3. Real order lifecycle

### Enablement

Real strategy orders require:

- `LIVE_TRADING=true`
- `PRIVATE_KEY` provided only through the deployment's secret manager
- Successful Polymarket authentication and a healthy, reconciled live account snapshot
- `LIVE_ORDER_FLOW_TEST` unset or `false`

If live trading is enabled without `PRIVATE_KEY`, fail safely and do not start real trading. If authentication, account readiness, reconciliation, or order status is unhealthy, block new buys and show the reason. Do not silently fall back to paper and label it live.

### Entry order

- Submit a Polymarket **limit BUY** at the configured rung price and the fixed 10-share quantity.
- Do not substitute a market order or raise the limit to force a fill.
- The current client sends the limit price and size with `postOnly:false`; it does not send an explicit expiration timestamp.
- The current implementation attempts to cancel still-active entry orders at the window end. This is a local cancellation attempt, not an order-expiration timestamp. Preserve this behavior only if cloning the current implementation; report cancellation failures rather than pretending the order is gone.

### Fill checks and take-profit

- The live order polling target is **500 ms**. This is not a guarantee that Polymarket will respond or fill within 500 ms.
- The current code polls BUY entry fills on that interval but does **not** reconcile the status or fills of TP SELL orders. The replacement must poll and reconcile both BUY and SELL orders; otherwise the dashboard and recovery logic cannot reliably know whether an exit filled.
- Use Polymarket's matched-share count as the source of truth. Never infer a real fill from a paper fill, a submitted response, or a quote touching the limit.
- After a real fill is confirmed, submit a **limit SELL** at the corresponding take-profit price for the confirmed filled shares that have not already been assigned to an exit order.
- Handle partial fills without overselling: account for shares already sold or reserved by a pending sell, and place a new sell only for the remaining confirmed quantity.
- The current minimum live sell size is 5 shares. If a partial fill is below 5, wait for more matched shares; if the total remains below the minimum, report the blocked quantity clearly. Do not mark it as sold.
- On an uncertain order-submission response, halt additional submissions until the order can be reconciled. Do not retry an uncertain BUY or SELL blindly, because that can create duplicates.
- Reconcile TP SELL fills, cancellations, and rejections. If a sell is cancelled or rejected, only retry after checking the live position and open orders so shares are not sold twice.

There is **no live stop-loss rule** in the current market-confusion strategy. Live exits are the mapped take-profit limit sells; there is no automatic market sell or opposite-side reversal. If a take-profit does not fill, it remains an open limit order until it is filled, cancelled, or the market resolves. Do not claim a take-profit happened just because the price briefly touched it.

## 4. Account readiness, rate limits, and safety

- Account balance, positions, open orders, and recent activity are read separately from market quotes and order polling.
- The normal live account snapshot interval is **15 seconds**. The Positions API has a minimum request interval and its `Retry-After` response must be honored. On errors, use bounded exponential backoff (up to 15 seconds); do not hammer the endpoint.
- The 500 ms tracked-order poll is **not** permission to poll the Positions API every 500 ms.
- Require `accountReady=true` and a healthy live status before submitting new strategy orders. A successful HTTP response with an error payload is not readiness.
- If the Positions API returns 429, keep the account unready, show the error and next retry, and block new real orders. Never bypass a 429 by using stale account data.
- During the current monitoring session, production continued to report Positions API 429 with `accountReady=false`. Treat that as an active blocker until a fresh successful snapshot and order reconciliation are confirmed.

### Restart and duplicate protection

The current implementation keeps its signal deduplication and tracked-order map in process memory. It skips markets whose window began before the current process started and treats open account orders not tracked by the process as an error requiring reconciliation. Do not assume it can resume a pre-restart order automatically.

For a replacement implementation, persist before/with every live submission:

- Market slug, timeframe, window start/end, side, rung price, requested shares
- CLOB order ID, order status, matched shares, and last reconciliation time
- Parent/child relationship between each BUY and its take-profit SELL
- Submitted, filled, reserved-for-exit, and exited share quantities
- Per-window/per-side/per-rung idempotency keys

On startup, reconcile the persisted ledger against Polymarket open orders and positions before enabling new entries. If an order's submission result is uncertain, search/reconcile before retrying. Do not reset live order state or paper balances as an implicit side effect of deployment.

Run one active trading instance per wallet unless shared durable coordination prevents duplicate orders across instances.

## 5. Optional one-shot order-flow test

`LIVE_ORDER_FLOW_TEST=true` is a separate **real-money test mode**, not the strategy. It pauses normal live strategy entries. In the first BTC 5-minute window that starts after the test is armed, it waits for a fresh UP or DOWN ask at or below $0.70 with at least 5 shares visible. It submits one 5-share $0.70 limit BUY if that quote appears before the window ends, then uses the fill poller to place a $0.75 limit SELL after a confirmed fill. The quote check runs every 1 second; tracked BUY fill checks use the 500 ms interval.

This mode can lose money and must remain off during normal strategy trading. Do not run it without explicit authorization for a real order.

## 6. Dashboard and API requirements

The dashboard must show, separately for BTC 5m and BTC 15m:

- Current market slug and time remaining
- UP and DOWN best bid, best ask, and midpoint
- Quote timestamp/age and an explicit `LIVE`, `STALE`, or `MISSING` state
- The evaluated midpoint band, signal decision, and skip reason
- Live trading enabled/paused state, account readiness, last successful snapshot, next retry, and any 429/error
- Each live BUY and SELL order's side, limit price, requested shares, matched shares, status, and linked take-profit
- Open positions and open orders from the live account, clearly distinguished from paper records

In this app, `/api/state` is primarily the paper-bot snapshot and can say `DEMO ONLY` even while the separate live-order service is enabled. Use `/api/live-balance` for live account readiness and live order/account information. Do not infer real trading status from the paper snapshot alone. Never display private keys or secrets.

## 7. Acceptance tests before using real funds

At minimum, test that:

1. Only BTC 5m and BTC 15m markets are accepted; ETH and malformed/expired markets are rejected.
2. No signal is produced before the final 60 seconds, after window end, with stale/missing quotes, or if either midpoint is outside $0.30–$0.71.
3. An eligible signal produces exactly four 10-share BUY attempts: both outcomes at $0.25 and $0.15, with the correct $0.75/$0.85 take-profit mapping.
4. Repeated scans of the same window do not duplicate a rung.
5. Confirmed full and partial fills produce SELL orders only for unsold matched shares; sub-5-share exits are reported as blocked; SELL fills/cancellations/rejections are reconciled.
6. 429 responses honor `Retry-After`, block new orders, and do not cause rapid retries or stale-account trading.
7. Restart recovery reconciles previous order IDs and partial fills without duplicating BUYs or SELLs.
8. The flow-test switch pauses strategy entries and can submit no more than its single authorized test order.
9. Paper activity cannot be counted as a live order or live fill.

## 8. Development

Keep the existing project structure and test suite. Run `npm test` before changes are considered complete. The existing Railway start command is `node index.js`; local development uses `npm start`.

Any new live-order behavior must be tested with mocked CLOB responses first. Do not place a real test order, enable live trading, reset a ledger, or deploy without the owner's explicit authorization.
