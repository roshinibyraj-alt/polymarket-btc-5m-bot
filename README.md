# Polymarket BTC 5-minute dual-engine paper bot

This Railway app is a paper-only BTC 5-minute strategy. Real-order modules are not loaded by the demo runner.

## Strategy

- **UP engine:** Normally trigger a 50-share UP taker sweep when the UP best ask reaches $0.71. Do not sweep above $0.99.
- **DOWN engine:** Place a resting paper limit order for DOWN at $0.30 at the start of each window. Its normal trigger is a later CLOB midpoint tick below $0.30.
- **Unfilled side swap:** Before any position fills, a new UP or DOWN midpoint crossing at $0.65 cancels the live resting order, swaps which outcome each engine targets, and carries each engine's share stake with it. A side can swap again after its midpoint falls below $0.65 and later crosses upward through it. Once paired positions fill, further swaps are disabled for that window.
- **Paired paper fill:** When either normal entry trigger fires, record both UP and DOWN positions filled at the same event time. The UP leg uses its current ask sweep; the DOWN leg is recorded at $0.30. This is an explicit paper assumption, not confirmation both live orders would execute.
- **Window expiry:** If neither entry trigger fires, the DOWN order expires at the end of its original window.
- **Take profit:** A fresh best bid of $0.99 or higher records an exit payout of $1 per share.
- **Sizing:** UP always stays at 50 shares. Positive realized UP take-profit P&L is carried into the next DOWN entry using `50 + carried dollars / $0.30` shares. A DOWN take-profit clears the carry so both engines start at 50 shares again.
- **No stop-loss or timed exit:** Positions without take-profit remain open until the original Polymarket market resolves. Resolution is checked every 10 seconds.

The paired fill and side-swap rules are simplified paper simulations, not proof that live orders would be matched. The dashboard lists each swap and the active engine-to-outcome mapping. It does not model maker rebates. The taker entry includes the market's modeled fee when its fee schedule is available. No strategy or fill rule guarantees profit.

## Running and testing

Run `npm test` and `npm start`. The dashboard and `/api/state` expose the active engine states, paper orders, positions, global equity, and resolutions.

## Paper history

Paper history is persisted on the existing Railway volume. A change to `PAPER_HISTORY_RESET_VERSION` intentionally starts a fresh paper ledger on deployment.
