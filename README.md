# BTC 5-minute closed-candle decision-model paper bot

This service watches the BTC UP/DOWN market on 5-minute windows. It is paper-only: it does not submit real orders or sign with a wallet.

## Decision flow

Once a window is available, the bot records a review immediately and then every 15 seconds. Each review stores answers and reasons for eight prompts:

- Why buy UP? Why not buy UP? Why hold UP? Why sell UP now?
- Why buy DOWN? Why not buy DOWN? Why hold DOWN? Why sell DOWN now?

The directional estimate uses only fully closed Binance candle OHLC:

- last 6 closed 5-minute candles: 65% of the score;
- last 4 closed 15-minute candles: 25%;
- last 2 closed 1-hour candles: 10%.

Within each timeframe, more recent candles receive more weight. The score combines the weighted candle return with directional persistence. It does not use Binance buy/sell volume, aggressor flow, live BTC ticks, Polymarket order-flow pressure, or Polymarket midpoint prices to choose UP or DOWN. The BTC tick stream is retained only for display. Polymarket CLOB UP/DOWN quotes and visible book levels are used for entry-price checks, simulated fills, fees, and position valuation.

The transparent weighted score maps to an estimated probability. It has not been statistically calibrated and is not a proven predictive edge.

## Paper orders

- UP and DOWN are independent positions. Either side may be held while the other is bought or sold.
- A buy decision requests 50 shares. It can add another 50 on any later 15-second review that independently passes the filters.
- A buy requires complete closed-candle history for all three timeframes, fresh Polymarket CLOB quotes, a full 50-share visible ask sweep at or below $0.99, an estimated side probability of at least 58%, net estimated edge of at least $0.05/share after modeled taker fees, and sufficient paper cash.
- The simulator records fills only against visible book depth. It does not invent a full fill when the book is shallow. Fees use market metadata when available and the configured crypto-fee fallback otherwise.
- A position is sold only when the model estimates future payout is at least $0.03/share below its current visible net bid liquidation value. The sale sweeps visible bids; any unfilled shares remain open.
- There is no fixed take-profit or stop-loss. Shares still open at expiry are sent to official Polymarket resolution; the result is polled every five seconds.

## Dashboard and storage

The mobile-first dashboard shows closed-candle bias for each timeframe, estimated UP/DOWN probabilities, live position shares and floating P&L, all eight model questions and answers, recent 15-second reviews, orders, and activity. Paper ledger storage is controlled by `PAPER_LEDGER_PATH`. A new strategy ID resets any ledger from the replaced strategy; subsequent restarts preserve the new model's history and open positions.

## Run

```sh
npm test
npm start
```
