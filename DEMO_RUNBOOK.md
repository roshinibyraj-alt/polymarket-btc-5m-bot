# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. Demo mode consumes public Polymarket market data; the demo adapter simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to a value other than the exact text `true`. No wallet key is needed for demo mode.
2. From the repository root, install dependencies once with npm install, then run npm test.
3. Start the app with npm start and open http://localhost:3000.
4. Confirm the dashboard says DEMO MODE and shows $10,000 starting capital. If `LIVE_TRADING=true`, startup is refused before wallet authentication; no live client or orders are created.

## What to check

- As soon as the active window tokens are available, the bot places independent 500-share GTC BUY limits at $0.30 for UP and DOWN.
- In demo, a best ask at or below $0.30 fills the whole 500-share buy, regardless of visible depth. After a buy fills, the bot places a GTC SELL TP at $0.70 for all acquired shares.
- In demo, a best bid at or above $0.70 fills all remaining shares on that TP order. When a side fully closes, only that side re-arms its 500-share $0.30 buy, and only while the window remains open.
- Simulated maker fills have a $0 maker fee and accrue a fee-curve-based rebate estimate. The demo credits that estimate immediately; actual Polymarket rebates are paid daily in pUSD and depend on the market's rebate pool and filled maker liquidity.
- There is no stop loss or adaptive sizing. At window close, resting entry and TP orders are canceled. Remaining shares are held until Gamma reports a closed market with a decisive outcome; no price-based resolution guess is used.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash and trade history are in memory and reset when the process restarts. Treat touch-based fills, estimated rebates, and P&L as simplified behavior checks, not as evidence of queue position, actual rebate payout, live execution, or profitability.
