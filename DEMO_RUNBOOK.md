# Paper bot runbook

The bot uses a Chainlink BTC/USD feed for completed candles and Polymarket Gamma/CLOB for market data. Demo mode is mandatory; `LIVE_TRADING=true` is refused at startup.

## Strategy

- Runs separate 5-minute and 15-minute windows with independent $10,000 paper ledgers.
- At each window open, checks the immediately previous complete candle. Green selects UP; red selects DOWN.
- A doji (body at most 10% of range) selects UP after two or more consecutive red candles, and DOWN after two or more consecutive green candles. Other dojis are skipped.
- Places two paper resting limit buys on the selected outcome: 500 shares at $0.30 and 500 at $0.20.
- Simulates a fill only when a fresh CLOB ask touches or moves below the limit. Cancels unfilled orders after 180 seconds on 5-minute windows and 540 seconds on 15-minute windows.
- Holds filled shares until official Gamma resolution. No live orders are sent.

Run `npm test`, then `npm start`. Paper balances and trade history reset on process restart.
