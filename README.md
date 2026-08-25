# Polymarket BTC 5m Flip Bot

A deterministic five-minute BTC paper bot that targets $50 profit per window by entering at 0.60 and flipping on opposite-side triggers.

## Strategy
- Trade only the current `btc-updown-5m-*` market.
- Wait 60 seconds after window opens before monitoring.
- After 60s, buy whichever side's ask price reaches 0.60 (UP or DOWN).
- Initial size: 125 shares ($75 cost, $50 profit if wins at $1.00).
- After entry, monitor the opposite side. If the opposite side's ask hits 0.60, flip: close the current position (assumed zero) and open on the new side.
- Share size recalculates on every flip to cover all sunk costs plus $50 target profit.
- Flips are unlimited — the bot keeps flipping as long as the opposite side hits 0.60.
- Hold final position to resolution. The first side strictly above 0.90 during the final two seconds wins.
- Dashboard shows real-time accumulated UP and DOWN share counts.

## Math
- Profit per share at 0.60 entry: $0.40 (1.00 - 0.60, ignoring fees)
- Initial shares: ceil(50 / 0.40) = 125
- Flip shares: ceil((50 + total sunk cost) / 0.40)
- With fees: profit per share = (1 - exit_fee_rate) - 0.60 × (1 + entry_fee_rate)

## Window Rollover
Discovery is deduplicated and starts for both current and next windows. At rollover the prior market is settled, statistics finalized, and accumulators reset. A missing or failed discovery never reuses stale prices.

## Pricing
Gamma is used only to resolve the exact slug into UP/DOWN CLOB token IDs. All prices come from batched CLOB `/prices` requests. There is no alternate price source.
