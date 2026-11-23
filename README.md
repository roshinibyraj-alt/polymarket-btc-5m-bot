# Invented BTC/ETH 5-minute cross-pair paper bot

Invented tracks the Polymarket BTC and ETH UP/DOWN markets on 5-minute windows. It is a paper simulator only: it does not submit real orders or use wallet credentials.

## Strategy

Four cross-pairs are evaluated independently:

- BTC UP + ETH DOWN
- ETH UP + BTC DOWN
- BTC UP + ETH UP
- BTC DOWN + ETH DOWN

For each pair, the bot watches the two fresh best asks from the Polymarket CLOB WebSocket. When their sum is strictly below $0.80, it makes one paper taker entry for that pair in the current 5-minute window. All four pairs can enter independently during the same window.

Each leg always requests 10 shares, regardless of previous results. The paper simulator sweeps visible asks up to $0.99, records simulated filled quantities, volume-weighted entry prices, and market-specific modeled taker fees, and cancels any unfilled remainder. A book must match the current market and token, have a post-open timestamp, and be no older than 2 seconds. Displayed ask depth is shared across all pair entries that use the same token and book update, so the same shares are not simulated as filled twice. Entry is skipped while the same cross-pair has an earlier position awaiting official resolution.

The four pairs are inverse-linked: BTC UP + ETH UP ↔ BTC DOWN + ETH DOWN, and BTC UP + ETH DOWN ↔ BTC DOWN + ETH UP. That relationship does not trigger a sale: an opposite pair may enter only when its own fresh ask sum is below $0.80, while existing positions remain open.

The previous per-side exits are restored: a best bid at or above $0.99 closes the remaining quantity with a modeled $1 payout per share; a fresh empty bid book triggers the $0 stop-loss. Any remaining shares at window end wait for the official result of their exact BTC or ETH market. The bot checks pending markets every 5 seconds and settles only after Polymarket publishes a closed market and a definitive winning outcome. Floating P&L estimates a full exit by sweeping visible bid depth and subtracting the estimated taker sell fee; any shares beyond visible depth are conservatively valued at $0. This estimate does not submit a sell order.

Wins and losses do not change sizing. Each pair can have one entry per window. A delayed official result delays the next entry for that same pair, but does not block the other pairs.

## Data and dashboard

Market metadata and official outcomes come from Polymarket Gamma. The live order books use a Polymarket CLOB WebSocket subscription for the active BTC and ETH token IDs. Every new entry stores its market and token IDs, window, source and receive timestamps, both book sides, fee schedule, available simulated ask depth, and exact fill levels. The mobile-first dashboard shows this audit inside each pair leg. Fee rebates are not assumed. This remains a paper model: it does not receive exchange acknowledgements, and its simulated order submission has no modeled network or exchange latency.

## Persistent paper history

On Railway, `PAPER_LEDGER_PATH` should point into the mounted persistent volume. The 10-share reset deployment uses a new strategy ID to start a fresh $3,000 paper ledger; later restarts preserve that new history and any open positions.

## Run

```sh
npm test
npm start
```
