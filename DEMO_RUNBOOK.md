# Demo-mode runbook

Use this checklist to review behavior without enabling real trading. Demo mode consumes public Polymarket market data; the demo adapter simulates fills and does not sign or submit orders.

## Safe startup

1. Keep LIVE_TRADING unset or set to a value other than the exact text true. No wallet key is needed for demo mode.
2. From the repository root, install dependencies once with npm install, then run npm test.
3. Start the app with npm start and open http://localhost:3000.
4. Confirm the dashboard says DEMO MODE and shows $1,000 starting capital. If it says LIVE TRADING, stop the process immediately; do not continue the demo check.

## What to check

- Entry checks are active as soon as a five-minute window opens. Either an upward or downward midpoint crossing of $0.75 should trigger; exact price equality is not required.
- Whichever outcome midpoint crosses first sets the entry side. The bot submits a FAK market buy without a $0.75 ask cap, so the simulated fill may be above the midpoint signal. One entry maximum per window.
- Demo market fills use visible public order-book depth, so simulated share counts can vary. The $0.99 take-profit is simulated as a maker fill when the public best bid reaches it; a best bid at or below $0.52 triggers a simulated taker exit.
- Size starts at 50 shares. A stop hit adds 50 for the next window, up to 550; a win subtracts 50, down to 50. If neither exit happens before the window closes, the TP is canceled and remaining shares wait for official resolution.

## Finish and interpret results

Stop the process with Ctrl+C. Demo cash and sizing state are in memory and reset when the process restarts. Taker fees are estimates; the maker rebate is zero until verified. Treat demo fills and P&L as a behavior check, not as evidence of live execution or profitability.
