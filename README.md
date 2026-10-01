# Polymarket BTC 5-minute strategy

At the start of each BTC 5-minute UP/DOWN market, the demo bot independently places one GTC limit BUY on each outcome: 500 shares at $0.30 per side. A demo BUY counts as filled in full when the best ask is at or below $0.30; visible order-book depth is intentionally ignored. After a BUY fills, the bot rests a GTC limit SELL for the acquired shares at $0.70. A best bid at or above $0.70 counts the entire remaining TP order as filled. Once a side's position is fully TP-closed, that side places a fresh 500-share $0.30 BUY if the same window is still open. The two sides cycle independently.

There is no stop loss and no adaptive sizing. At the 5-minute close, the bot cancels resting entry and TP orders. Shares that were not TP-sold remain open until the existing official-resolution check returns a decisive market result; live prices are never used to guess the resolution.

This strategy is demo-only and fails closed when `LIVE_TRADING=true`; the bot does not submit real orders. Demo mode starts with $10,000 and reads public Polymarket market data. Simulated maker fills have zero maker fees and accrue a fee-curve-based rebate estimate using the Crypto fee rate and rebate-pool share. The estimate is credited immediately for demo P&L; it is not an actual payout. Polymarket calculates actual maker rebates daily in pUSD, weighted by liquidity filled within each market, so actual payouts can differ.

The simulated touch behavior is a simplified fill assumption, not a claim about actual queue position, depth, fees, rebate payout, or live execution.

Run `npm test` to verify strategy behavior. For local demo startup and dashboard checks, follow `DEMO_RUNBOOK.md`.
