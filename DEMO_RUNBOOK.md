# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. Demo mode consumes public Polymarket market data; the demo adapter simulates fills and does not sign or submit orders. This strategy is blocked in live mode.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to a value other than the exact text `true`. No wallet key is needed for demo mode.
2. From the repository root, install dependencies once with npm install, then run npm test.
3. Start the app with npm start and open http://localhost:3000.
4. Confirm the dashboard says DEMO MODE and shows $10,000 starting capital. If `LIVE_TRADING=true`, startup is refused before wallet authentication; no live client or orders are created.

## What to check

- As soon as the active window tokens are available, the bot places four 500-share GTC BUY limits on each outcome: $0.45, $0.40, $0.35, and $0.30. That is one UP and one DOWN entry at each rung, up to eight trades in a window.
- For each rung independently, the first side to fill gets its regular TP: $0.45→$0.70, $0.40→$0.65, $0.35→$0.60, and $0.30→$0.50. If the opposite side fills at that rung, its TP is $0.99. There is no same-side re-arm at a rung during that window.
- In demo, an executable best ask at or below an entry limit fills that entire 500-share order regardless of visible depth. A best bid at or above the assigned TP fills all remaining shares; a $0.99 TP credits $0.99 per share to cash and P&L.
- Simulated maker fills have a $0 maker fee and accrue a fee-curve-based rebate estimate. The demo credits that estimate immediately; actual Polymarket rebates are paid daily in pUSD and depend on the market's rebate pool and filled maker liquidity.
- There is no stop loss or adaptive sizing. At window close, resting entry and TP orders are canceled. Remaining shares are held until Gamma reports a closed market with a decisive outcome; no price-based resolution guess is used.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash and trade history are in memory and reset when the process restarts. Treat touch-based fills, estimated rebates, and P&L as simplified behavior checks, not as evidence of queue position, actual rebate payout, live execution, or profitability.
