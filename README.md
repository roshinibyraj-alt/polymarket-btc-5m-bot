# Polymarket near-resolution paper bot

The active Railway entrypoint is paper-only. It does not load real-order modules or submit Polymarket orders, even if live-trading variables are present.

## Market discovery and strategy

1. The Gamma API is scanned for active, order-book-enabled non-sports, non-crypto markets ending within two hours. Sports metadata, sport tags, and sports categories are excluded. Gamma provides the actual outcomes and CLOB token IDs.
2. One CLOB market WebSocket subscribes to discovered outcome IDs. The dashboard shows live midpoint, best bid, and best ask; open positions are marked at the latest best bid.
3. Each outcome can have one active resting buy order for 20 shares. When midpoint is from $0.80 through $0.90 and best bid is above $0.60, the order is placed at the current midpoint and re-quoted on each new midpoint tick while it remains in band. It is cancelled when midpoint leaves the band.
4. Paper fills are counted only from newly visible ask size at or below the active resting limit. Partial fills remain visible. Maker entry and take-profit orders have no trading fee.
5. A simulated resting take-profit sell is set at $0.99 and fills only against visible bids at or above that level. Real maker rebates are conditional on eligible fee-generating fills and maker tier; the paper bot has no connected wallet and does not credit actual rebates.
6. If the best bid reaches $0.60 or lower, the bot sweeps available bids and removes that market from active scanning. Any remaining shares stay open until Gamma reports the official result; resolution checks run every 10 seconds.

Paper cash starts at $10,000. Standard maker rebates start at $200,000 in 30-day maker weighted volume and require eligible filled orders; see [Polymarket's official fee and rebate rules](https://docs.polymarket.com/trading/fees). Stop-loss taker fees are estimated from the market's Gamma fee schedule when enabled. The dashboard shows each position's floating unrealized P&L and the account-wide floating P&L in real time.

## Run and verify

- `npm start` — start the dashboard and paper bot.
- `npm test` — run local unit tests.
- `npm run smoke:near-resolution` — read-only check against live Gamma discovery and CLOB books; it never places orders.

The dashboard is mobile-first. `/api/state` exposes scan state, WebSocket status, pending orders, positions, and the trade ledger.

## Paper history

The Railway paper ledger is stored on its persistent volume. The new strategy has a distinct persistence version, so the prior BTC volume ledger is reset once on replacement and the new paper balance starts at $10,000. The strategy version and `PAPER_HISTORY_RESET_VERSION` marker are saved so later restarts retain new history.
