# Polymarket BTC candle-pattern paper bot

Paper BTC UP/DOWN trading on 5-minute and 15-minute Polymarket markets, with an optional, separately gated 5-minute live entry mirror.

At each window open, evaluate the previous fully closed market candle:

- Green selects UP.
- Red selects DOWN.
- A doji after at least two consecutive red candles selects UP.
- A doji after at least two consecutive green candles selects DOWN.
- An unconfirmed doji does not trade.

Doji means the candle body is no more than 10% of its high-low range. In the demo 5-minute strategy, a signal waits 120 seconds after the window opens, then places 500-share paper limit buys on the selected outcome at $0.30, $0.20, and $0.12. There is no 180-second entry cutoff; unfilled orders expire at market-window rollover. If the best ask is below a rung's limit price, the simulated fill uses the lower ask. Each filled signal-side rung exits when its own-side bid reaches $0.80 and then places an opposite-side $0.20 limit for the same share count; opposite-side positions have no take-profit. A fresh own-side bid at $0.01 still completes the window. Unresolved shares close at rollover. The 15-minute demo now uses a paper-only random forest trained on 15-minute BTC candles. It estimates the chance that the next candle rises more than 0.52%; at probability ≥60%, it buys UP at the best ask with a $50 stake. Otherwise it does not trade (class 0 is not a DOWN prediction). It holds until market-window rollover. The 5-minute strategy and its separately gated live mirror are unchanged.

Each timeframe has an independent $10,000 in-memory paper ledger. The dashboard shows demo state plus real USDC, equity, the two most recently traded open positions, and all open orders. Position value and equity still include the full account. When `PRIVATE_KEY` is present, account reads remain available; real 5-minute entry mirroring remains unchanged at two 20-share orders per eligible signal and is separately gated by `LIVE_TRADING=true`. Live exit management is not part of this demo change. Paper ledgers reset when the process restarts.

Run `npm test` and `npm start`. The Railway `node index.js` start command remains valid.
