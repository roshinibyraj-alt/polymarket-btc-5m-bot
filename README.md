# BTC 5-minute one-minute color-follow-through paper bot

This service watches BTC UP/DOWN five-minute markets. It uses Binance BTCUSDT one-minute kline WebSocket candles for direction and the Polymarket CLOB WebSocket for paper execution quotes. It is paper-only: it does not submit real orders or sign with a wallet.

## Signal flow

Each active Polymarket five-minute window contains five one-minute BTC candles. Minute 1 is reference-only. At the close of minutes 2–4, compare the candle with the immediately preceding candle. Two consecutive green candles signal UP; two consecutive red candles signal DOWN. Each qualifying one-minute candle can produce one entry. A candle that changes color exits the previously held side and does not enter the new side in that same candle; the next candle continuing the new color can enter. Minute 5 has no new entry or exit signal. Doji candles are neutral.

## Paper execution

- Each qualifying candle requests 200 shares with no $0.50 entry-price gate. Buys sweep visible asks over the valid CLOB price range; actual fills can be partial if displayed depth is insufficient.
- On a candle-color change, sell open shares in the previously held direction against visible bids. If the book only fills part of the position, keep the rest open and retry on a later eligible candle that continues the new color. Do not buy the new side on the change candle itself.
- A fresh held-side midpoint at or above $0.99 triggers the take-profit and credits $1/share; a fresh midpoint at or below $0.00 triggers the stop-loss and credits $0/share. If neither triggers, hold through official resolution. An unavailable midpoint does not count as $0.00.
- Taker-style paper buys and sells use visible book depth; fees use market metadata when available and the configured crypto-fee fallback otherwise.
- Shares still open at expiry are settled using the official Polymarket result, polled every five seconds.
- Trading pauses if the Binance WebSocket is disconnected/stale or if the required CLOB quote is not fresh. REST candle history only seeds/reconciles closed candles; it does not replace the live WebSocket check for signal execution.

## Dashboard and history

The mobile dashboard puts large UP/DOWN CLOB prices near the top, followed by paper account totals, current positions, the five one-minute candle colors, and recent orders/results. The strategy explanation is last. `PAPER_LEDGER_PATH` controls paper-history storage. The new strategy ID resets the replaced strategy's ledger on deploy; restarts after this deploy keep this strategy's positions and history.

## Run

```sh
npm test
npm start
```
