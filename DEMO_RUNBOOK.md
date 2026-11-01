# Paper bot runbook

The bot discovers BTC and ETH 5-minute and 15-minute markets through Polymarket Gamma/CLOB. Demo mode is mandatory; `LIVE_TRADING=true` is refused at startup.

## Strategy

- Runs independent paper ledgers for BTC and ETH on both 5-minute and 15-minute windows ($5,000 each; $20,000 combined).
- During each window's final 60 seconds, requires fresh UP and DOWN midpoints both within $0.05-$0.96 inclusive.
- Places 500-share paper limit buys on both outcomes at $0.30, $0.25, $0.20, $0.15, $0.10, and $0.05.
- Maps take-profits to $0.70, $0.75, $0.80, $0.85, $0.90, and $0.95 respectively. A rung is not re-entered after its take-profit.
- Cancels unfilled orders at rollover. Real order submission remains paused.

Run `npm test`, then `npm start`. Paper balances and trade history reset on process restart.
