# Polymarket BTC candle-pattern paper bot

Paper-only BTC UP/DOWN trading on 5-minute and 15-minute Polymarket markets.

At each window open, evaluate the previous fully closed market candle:

- Green selects UP.
- Red selects DOWN.
- A doji after at least two consecutive red candles selects UP.
- A doji after at least two consecutive green candles selects DOWN.
- An unconfirmed doji does not trade.

Doji means the candle body is no more than 10% of its high-low range. A signal places two resting paper limit buys on the selected outcome: 500 shares at $0.30 and 500 at $0.20. Any unfilled orders are canceled 180 seconds after the market window opens. Filled shares are held for official Gamma resolution.

Each timeframe has an independent $10,000 in-memory paper ledger. The dashboard shows both timeframe states, orders, positions, and combined account totals. Paper state resets when the process restarts. No live orders or wallet credentials are used.

Run `npm test` and `npm start`. The Railway `node index.js` start command remains valid.
