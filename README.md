# Polymarket BTC 5-minute dual-engine paper bot

This Railway app is a paper-only BTC 5-minute strategy. Real-order modules are not loaded by the demo runner.

## Strategy

- **UP engine:** Buy 50 UP shares with a paper taker sweep when the UP best ask reaches $0.71. Do not sweep above $0.99.
- **DOWN engine:** Place a resting paper limit order for DOWN at $0.30 at the start of each window. Confirm the full requested quantity at $0.30 when a later CLOB midpoint tick is below $0.30. The order expires unfilled at the end of its original window.
- **Take profit:** A fresh best bid of $0.99 or higher records an exit payout of $1 per share.
- **Sizing:** UP always stays at 50 shares. Positive realized UP take-profit P&L is carried into the next DOWN entry using `50 + carried dollars / $0.30` shares. A DOWN take-profit clears the carry so both engines start at 50 shares again.
- **No stop-loss or timed exit:** Positions without take-profit remain open until the original Polymarket market resolves. Resolution is checked every 10 seconds.

The DOWN fill rule is a simplified paper simulation, not proof that a live limit order would be fully matched. It does not model maker rebates. The UP taker entry includes the market's modeled fee when its fee schedule is available. No strategy or fill rule guarantees profit.

## Running and testing

Run `npm test` and `npm start`. The dashboard and `/api/state` expose the active engine states, paper orders, positions, global equity, and resolutions.

## Paper history

Paper history is persisted on the existing Railway volume. A change to `PAPER_HISTORY_RESET_VERSION` intentionally starts a fresh paper ledger on deployment.
