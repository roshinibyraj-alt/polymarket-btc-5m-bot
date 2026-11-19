# BTC dual-engine paper strategy

This runner is strictly paper-only. It subscribes to the current BTC 5-minute Polymarket CLOB WebSocket and does not load live order execution.

## Engine rules

### UP

1. Start each five-minute window armed for one 50-share UP entry.
2. When the UP best ask reaches $0.71, submit a simulated taker sweep of 50 shares. Sweep no higher than $0.99. If the full requested quantity is not available within that ceiling, record no fill.
3. A fresh UP best bid at $0.99 or higher records a take-profit payout of $1 per share.
4. The realized net UP take-profit profit, after the modeled taker entry fee, is added to the next DOWN order's notional. The next DOWN quantity is `50 + positive UP profit / $0.30` shares. UP remains at 50 shares.

### DOWN

1. At window start, place one simulated resting DOWN limit order at $0.30.
2. A later midpoint tick below $0.30 confirms the full requested quantity at $0.30 in this paper fill model. A quote that was already below $0.30 when the order was placed does not count; a later tick is required.
3. If it has not filled by window end, expire the order. No partial fill or maker rebate is modeled.
4. A fresh DOWN best bid at $0.99 or higher records a take-profit payout of $1 per share. A DOWN take-profit clears carried profit, returning both engines to the 50-share base for the next window.

## Window close and settlement

- Both engines operate independently; both sides may hold positions in one window.
- There is no stop-loss, signal flip, or timed exit.
- Open shares that did not hit take-profit are held for the official resolution of their original market. Resolution is checked every 10 seconds.
- Entry fees are modeled for UP taker buys when fee data is available. DOWN limit orders have zero modeled taker fee and no modeled rebate.

## Dashboard and checks

The dashboard prioritizes each engine's status, current bid/ask, trigger or limit, size, average entry, take-profit, carried profit, and next-window DOWN size. It also shows paper equity, orders, positions, completed transactions, and resolution records.

Run `npm test` and `npm start`. Check `/api/healthz` for app readiness and `/api/state` for current paper state. A new `PAPER_HISTORY_RESET_VERSION` intentionally clears the persisted paper ledger at deployment.

The fill rules are simplified paper assumptions; they do not guarantee execution at a live exchange or profitable results.
