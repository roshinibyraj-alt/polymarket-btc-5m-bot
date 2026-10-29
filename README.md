# Polymarket BTC candle-pattern paper bot

Paper BTC UP/DOWN trading on 5-minute and 15-minute Polymarket markets, with an optional, separately gated 5-minute live entry mirror.

At each window open, evaluate the previous fully closed market candle:

- Green selects UP.
- Red selects DOWN.
- A doji after at least two consecutive red candles selects UP.
- A doji after at least two consecutive green candles selects DOWN.
- An unconfirmed doji does not trade.

Doji means the candle body is no more than 10% of its high-low range. A signal places two resting paper limit buys on the selected outcome: 500 shares at $0.30 and 500 at $0.20. Unfilled orders are canceled 180 seconds after a 5-minute window opens and 540 seconds after a 15-minute window opens (proportional to the window length). Filled shares are held for official Gamma resolution.

Each timeframe has an independent $10,000 in-memory paper ledger. The dashboard shows demo state plus real USDC, equity, the two most recently traded open positions, and all open orders. Position value and equity still include the full account. When `PRIVATE_KEY` is present, account reads remain available; live entries require `LIVE_TRADING=true` and use two 20-share orders per eligible 5-minute signal. The live monitor reconciles Polymarket open orders and cancels matching bot entry orders at the same 180-second cutoff as the demo. It does not manage live exits or claims. The demo strategy and ledger remain separate and paper-only.

Run `npm test` and `npm start`. The Railway `node index.js` start command remains valid.
