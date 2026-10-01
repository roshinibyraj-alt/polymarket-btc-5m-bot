# Polymarket BTC 5-minute strategy

At the start of each BTC 5-minute UP/DOWN market, the demo bot places four 500-share GTC limit BUYs on each outcome, at $0.45, $0.40, $0.35, and $0.30. Each rung can fill once on UP and once on DOWN, for up to eight entries per window. The first side to fill on a rung gets that rung's take-profit ($0.55, $0.60, $0.65, or $0.70, respectively); if the opposite side fills on that same rung, its take-profit is $0.99. Fill order is independent for each rung. Completed rung/side slots do not re-arm.

A demo BUY counts as filled in full when the best ask is at or below its limit, and a demo TP counts as filled in full when the best bid is at or above its limit. Visible order-book depth and queue position are intentionally ignored. A $0.99 TP is accounted as $0.99 per share in demo cash and P&L.

There is no stop loss and no adaptive sizing. At the 5-minute close, the bot cancels resting entry and TP orders. Shares that were not TP-sold remain open until the existing official-resolution check returns a decisive market result; live prices are never used to guess the resolution.

This strategy is demo-only and fails closed when `LIVE_TRADING=true`; the bot does not submit real orders. Demo mode starts with $10,000 and reads public Polymarket market data. Simulated maker fills have zero maker fees and accrue a fee-curve-based rebate estimate using the Crypto fee rate and rebate-pool share. The estimate is credited immediately for demo P&L; it is not an actual payout. Polymarket calculates actual maker rebates daily in pUSD, weighted by liquidity filled within each market, so actual payouts can differ.

The simulated touch behavior is a simplified fill assumption, not a claim about actual queue position, depth, fees, rebate payout, or live execution.

Run `npm test` to verify strategy behavior. For local demo startup and dashboard checks, follow `DEMO_RUNBOOK.md`.
