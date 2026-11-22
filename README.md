# Polymarket near-resolution paper bot

The active Railway entrypoint is paper-only. It does not load real-order modules or submit Polymarket orders, even if live-trading variables are present.

## Market discovery and strategy

1. The Gamma API is scanned for active, order-book-enabled non-sports, non-crypto markets ending within two hours. Sports metadata, sport tags, and sports categories are excluded. Gamma provides the actual outcomes and CLOB token IDs.
2. One CLOB market WebSocket subscribes to discovered outcome IDs. The dashboard shows live midpoint, best bid, and best ask; open positions are marked at the latest best bid.
3. Each outcome can have one 20-share market-sweep entry when midpoint is from $0.80 through $0.90 and best bid is above $0.60. This is an entry filter only, not a stop-loss. The current CLOB WebSocket ask book is swept up to $1.00; actual visible depth determines full or partial fills. No entry order rests or uses additional REST polling.
4. Entry taker fees are modeled from Gamma's market fee schedule when fees are enabled. A simulated resting take-profit sell is set at $0.99 and fills only against visible bids at or above that level; it has no maker trading fee.
5. Real maker rebates apply only to eligible filled maker orders on fee-generating markets and depend on maker tier. Market-sweep entries are takers, and the paper bot has no connected wallet or real rebate payout.
6. There is no stop-loss. Open shares remain held unless the $0.99 take-profit fills; otherwise they stay open until Gamma reports the official result. Resolution checks run every 10 seconds.

Paper cash starts at $10,000. Standard maker rebates start at $200,000 in 30-day maker weighted volume and require eligible filled orders; see [Polymarket's official fee and rebate rules](https://docs.polymarket.com/trading/fees). Entry taker fees are estimated from the market's Gamma fee schedule when enabled. The dashboard shows each position's floating unrealized P&L and the account-wide floating P&L in real time.

## Run and verify

- `npm start` — start the dashboard and paper bot.
- `npm test` — run local unit tests.
- `npm run smoke:near-resolution` — read-only check against live Gamma discovery and CLOB books; it never places orders.

The dashboard is mobile-first. `/api/state` exposes scan state, WebSocket status, pending orders, positions, and the trade ledger.

## Paper history

The Railway paper ledger is stored on its persistent volume. The new strategy has a distinct persistence version, so the prior BTC volume ledger is reset once on replacement and the new paper balance starts at $10,000. The strategy version and `PAPER_HISTORY_RESET_VERSION` marker are saved so later restarts retain new history.
