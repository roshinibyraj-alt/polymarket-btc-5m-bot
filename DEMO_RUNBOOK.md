# BTC dual-engine paper strategy

This runner is strictly paper-only. It subscribes to the current BTC 5-minute Polymarket CLOB WebSocket and does not load live order execution.

## Engine rules

### Side swaps before entry

1. Both engines start on their matching outcome: UP engine → UP and DOWN engine → DOWN.
2. While no position has filled, each new CLOB midpoint crossing upward through $0.65 cancels the active resting limit order, swaps the two engine outcome assignments, and places a new $0.30 resting limit for the DOWN engine on its newly assigned side.
3. Engine share sizes travel with their engine assignments. For example, after a swap, the DOWN engine's carried share size belongs to its new outcome side.
4. Repeated swaps are allowed after a side moves below $0.65 and later crosses upward again. A fill permanently disables side swaps for that five-minute window.
5. The dashboard shows the current mapping, swap count, and recent swap timestamps/prices.

### UP

1. Start each five-minute window armed for one 50-share UP entry.
2. When the UP best ask reaches $0.71, that side can trigger the paired entry. The UP leg uses a simulated taker sweep of 50 shares, no higher than $0.99.
3. A fresh UP best bid at $0.99 or higher records a take-profit payout of $1 per share.
4. The realized net UP take-profit profit, after the modeled taker entry fee, is added to the next DOWN order's notional. The next DOWN quantity is `50 + positive UP profit / $0.30` shares. UP remains at 50 shares.

### DOWN

1. At window start, place one simulated resting DOWN limit order at $0.30.
2. A later midpoint tick below $0.30 can trigger the paired entry.
3. When either side triggers, both positions are recorded filled at the same event time. UP uses its current visible-ask sweep through $0.99; DOWN is recorded at $0.30. This paired fill is a paper assumption, not proof of two live executions.
4. If neither side triggers by window end, expire the DOWN order. No partial fill or maker rebate is modeled.
5. A fresh DOWN best bid at $0.99 or higher records a take-profit payout of $1 per share. A DOWN take-profit clears carried profit, returning both engines to the 50-share base for the next window.

## Window close and settlement

- Each side has separate sizing, accounting, mark-to-market, and take-profit state; entry fills are paired when either trigger fires.
- There is no stop-loss, signal flip, or timed exit.
- Open shares that did not hit take-profit are held for the official resolution of their original market. Resolution is checked every 10 seconds.
- Entry fees are modeled for UP taker buys when fee data is available. DOWN limit orders have zero modeled taker fee and no modeled rebate.

## Dashboard and checks

The dashboard prioritizes each engine's assigned outcome, CLOB best bid, share size, fill status, floating P&L, committed capital, average entry, take-profit, carried profit, and next-window DOWN size. It also shows live side swaps, paper equity, orders, positions, completed transactions, and resolution records.

Run `npm test` and `npm start`. Check `/api/healthz` for app readiness and `/api/state` for current paper state. A new `PAPER_HISTORY_RESET_VERSION` intentionally clears the persisted paper ledger at deployment.

The fill rules are simplified paper assumptions; they do not guarantee execution at a live exchange or profitable results.
