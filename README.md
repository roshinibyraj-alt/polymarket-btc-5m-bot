# Polymarket BTC 5-minute edge-gated volume paper bot

This Railway app is a paper-only simulator. It does not load or submit real orders, even if `LIVE_TRADING=true` is present.

## Strategy

The bot tracks eligible taker volume, fees, and tier-based rebate estimates, but it does not trade just to inflate volume:

1. It estimates the chance of UP at resolution from the live Binance BTCUSDT price relative to the current 5-minute candle open, scaled by the recent 60-second realized price range. DOWN probability is `1 − UP probability`.
2. It compares those estimates with Polymarket's live UP/DOWN books. It simulates a taker sweep of up to 10 shares across visible asks, allowing a realistic partial FAK fill only when at least 5 shares and $1 notional execute; the unfilled remainder is cancelled. It skips prices above $0.90.
3. An entry is allowed only when estimated payout minus the full sweep cost, modeled taker fee, and a 2¢ Binance/Chainlink basis buffer leaves at least 5¢ expected edge per share.
4. UP and DOWN are evaluated independently. The higher qualifying edge is bought first; each side has a 10-second cooldown and a 10-entry-per-window limit. The bot also enforces a $250 per-window entry-spend cap, $500 total open-cost cap, and $100 daily realized-loss stop.
5. A position is sold only when a full visible-bid sweep would realize at least 3¢ per share after both entry and exit fees. Otherwise it stays open for official Polymarket resolution, checked every 10 seconds.

This is an uncalibrated probability model, not a forecast guarantee. Binance is only a proxy for the Chainlink-based resolution price. The dashboard shows the underlying inputs and uses conservative basis-risk padding.

## Volume and rebate tracking

- Taker fees use the market fee schedule when provided, otherwise the BTC 5-minute default of 5%. The fee calculation is `shares × fee rate × price × (1 − price)`.
- Eligible weighted volume is tracked as `dollar trade size × (1 − entry price)` only for fee-paying taker fills.
- The paper tier starts at 0 because no wallet or existing Polymarket tier is connected. The published tiers are None below $200k 30-day weighted volume, then Gold (10%), Platinum (25%), Diamond (40%), Obsidian (50%), and Onyx (60%). Tier changes apply on the daily update; prior trades are not repriced. Rebates are estimates and the $1 minimum payout is shown separately.
- Direct market liquidity rewards are checked for the current market. The BTC 5-minute market observed during implementation returned an empty `rewards_config`; the strategy is taker-only and does not place maker quotes, so even an allocation on another market would not be treated as earnings.
- No self-matching or artificial touch-fill accounting is used.

Official references:

- [Polymarket trading fees](https://docs.polymarket.com/trading/fees)
- [Polymarket taker rebates](https://docs.polymarket.com/programs/taker-rebates)
- [Polymarket liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards)

## Running and testing

Run `npm test` and `npm start`. The dashboard and `/api/state` expose the active model, live books, paper positions, orders, fees, weighted-volume progress, and rebate estimates.

## Paper history

The existing paper ledger is persisted on the Railway volume. Strategy migration preserves cash, positions, and history; only unfilled orders from the replaced strategy are marked cancelled. Changing `PAPER_HISTORY_RESET_VERSION` intentionally starts a fresh paper ledger.
