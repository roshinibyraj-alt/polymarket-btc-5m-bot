# BTC 5-minute explainable decision-model paper bot

This service watches the BTC UP/DOWN market on 5-minute windows. It is paper-only: it does not submit real orders or sign with a wallet.

## Decision flow

The bot samples Binance BTCUSDT aggregate trades once per second. Once a window is available, it records a review immediately and then every 15 seconds. Each review stores answers and reasons for eight prompts:

- Why buy UP? Why not buy UP? Why hold UP? Why sell UP now?
- Why buy DOWN? Why not buy DOWN? Why hold DOWN? Why sell DOWN now?

The directional estimate combines:

- BTC's current move from the Binance 5-minute window open, scaled by recent volatility and time remaining;
- buyer/seller aggressor imbalance and its direction, persistence, and acceleration over the latest ten one-second samples;
- the latest three closed Binance 5-minute candles;
- fresh UP and DOWN Polymarket midpoint prices.

This is a transparent weighted score mapped to an estimated probability. It has not been statistically calibrated, and is not a proven predictive edge.

## Paper orders

- UP and DOWN are independent positions. Either side may be held while the other is bought or sold.
- A buy decision requests 50 shares. It can add another 50 on any later 15-second review that independently passes the filters.
- A buy requires current Binance and Polymarket data, at least three recent valid pressure samples, a full 50-share visible ask sweep at or below $0.99, an estimated side probability of at least 58%, net estimated edge of at least $0.05/share after modeled taker fees, and sufficient paper cash.
- The simulator records fills only against visible book depth. It does not invent a full fill when the book is shallow. Fees use market metadata when available and the configured crypto-fee fallback otherwise.
- A position is sold only when the model estimates future payout is at least $0.03/share below its current visible net bid liquidation value. The sale sweeps visible bids; any unfilled shares remain open.
- There is no fixed take-profit or stop-loss. Shares still open at expiry are sent to official Polymarket resolution; the result is polled every five seconds.

## Dashboard and storage

The mobile-first dashboard shows feed health, BTC window prices, estimated UP/DOWN probabilities, live position shares and floating P&L, all eight model questions and answers, recent 15-second reviews, orders, and activity. Paper ledger storage is controlled by `PAPER_LEDGER_PATH`. A new strategy ID resets any ledger from the replaced strategy; subsequent restarts preserve the new model's history and open positions.

## Run

```sh
npm test
npm start
```
