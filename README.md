# BTC 5-minute one-minute color-change paper bot

This service watches BTC UP/DOWN five-minute markets. It uses Binance BTCUSDT one-minute kline WebSocket candles for direction and the Polymarket CLOB WebSocket for paper execution quotes. It is paper-only: it does not submit real orders or sign with a wallet.

## Signal flow

Each active Polymarket five-minute window contains five one-minute BTC candles. Minute 1 is reference-only. At the close of minute 2, the bot compares its color with minute 1; it repeats this for minute 3 versus minute 2 and minute 4 versus minute 3. Matching colors produce no trade. A color change triggers a 200-share buy in the current candle's direction: green buys UP and red buys DOWN. Minute 5 has no signal. Doji candles are neutral and do not trigger a trade.

## Paper execution

- On a reversal, the bot attempts to sell all open shares on the previous side against visible bids, then independently attempts the 200-share buy on the new side. A sell that cannot fully fill does not block the new-side buy; any remainder stays open for resolution.
- Taker-style paper buys sweep visible asks up to $0.99. The simulator records only visible depth, so an order can be partially filled. Fees use market metadata when available and the configured crypto-fee fallback otherwise.
- No fixed take-profit or stop-loss applies. Shares still open at expiry are settled using the official Polymarket result, polled every five seconds.
- Trading pauses if the Binance WebSocket is disconnected/stale or if the required CLOB quote is not fresh. REST candle history only seeds/reconciles closed candles; it does not replace the live WebSocket check for signal execution.

## Dashboard and history

The mobile dashboard puts large UP/DOWN CLOB prices near the top, followed by paper account totals, current positions, the five one-minute candle colors, and recent orders/results. The strategy explanation is last. `PAPER_LEDGER_PATH` controls paper-history storage. The new strategy ID resets the replaced strategy's ledger on deploy; restarts after this deploy keep this strategy's positions and history.

## Run

```sh
npm test
npm start
```
