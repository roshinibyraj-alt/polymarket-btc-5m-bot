# Polymarket near-resolution paper bot

The active Railway entrypoint is paper-only. It does not load real-order modules or submit Polymarket orders, even if live-trading variables are present.

## Market discovery and strategy

1. The Gamma API is scanned for active, order-book-enabled markets with an end time in the next two hours. Crypto markets are excluded by crypto market metadata and market/event text. The market's actual outcome labels and CLOB token IDs are mapped from Gamma, so sports outcomes such as home team, away team, and draw are supported.
2. One CLOB market WebSocket subscribes to the discovered outcome IDs. The dashboard shows executable best bids and asks; Gamma's last-traded outcome prices are not used as fills.
3. Each outcome can be entered once. When its live best ask is from $0.80 through $0.90, inclusive, the paper bot sweeps visible asks up to $0.90 for up to 100 shares. If the book is shallow, it records the actual partial fill rather than inventing 100 shares.
4. A simulated resting take-profit sell is set at $0.99 and fills only against visible bids at or above that level. Maker fees and rebates are not estimated.
5. If the best bid reaches $0.60 or lower, the bot sweeps available bids. The market is then removed from active scanning and cannot be traded again. Any remaining shares are held until official resolution.
6. Shares not exited by the TP or SL remain open until Gamma reports the official result. Resolution checks run every 10 seconds.

Paper cash starts at $10,000. Taker fees are estimated from each market's Gamma fee schedule when enabled. The dashboard marks open positions at the best bid and labels the entry fill quantity and average price.

## Run and verify

- `npm start` — start the dashboard and paper bot.
- `npm test` — run local unit tests.
- `npm run smoke:near-resolution` — read-only check against live Gamma discovery and CLOB books; it never places orders.

The dashboard is mobile-first. `/api/state` exposes the scan state, WebSocket status, positions, and trade ledger.

## Paper history

The Railway paper ledger is stored on its persistent volume. The new strategy has a distinct persistence version, so the prior BTC volume ledger is reset once on replacement and the new paper balance starts at $10,000. The strategy version and `PAPER_HISTORY_RESET_VERSION` marker are saved so later restarts retain new history.
