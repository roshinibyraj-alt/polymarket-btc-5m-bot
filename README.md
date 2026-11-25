# BTC 5-minute cross-window candle-color paper bot

This service watches BTC UP/DOWN five-minute markets. It uses Binance BTCUSDT one-minute kline WebSocket candles for direction and the Polymarket CLOB WebSocket for paper execution quotes. It is paper-only: it does not submit real orders or sign with a wallet.

## Signal flow

At the close of minute 1 in each five-minute window, compare it with the previous window’s final one-minute candle. For minutes 2–4, compare with the immediately preceding candle in the current window. Two consecutive green candles buy DOWN; two consecutive red candles buy UP. Each qualifying one-minute candle can produce one entry. A candle that changes color exits the previously held side only if the sale is profitable after fees, and does not enter the new side in that same candle; the next candle continuing the new color can enter. Minute 5 has no new entry or exit signal. Doji candles are neutral.

## Paper execution

- Each qualifying candle requests 200 shares with no $0.50 entry-price gate. Buys sweep visible asks over the valid CLOB price range; actual fills can be partial if displayed depth is insufficient.
- On a candle-color change, sell open shares in the previously held direction only when the executable FIFO sale is not a loss after modeled fees. If the book only fills part of the position, keep the rest open and retry on a later eligible candle that continues the new color. Do not buy the new side on the change candle itself.
- A fresh held-side midpoint at or above $0.99 triggers the $1/share take-profit only when the remaining position will not close at a net loss after fees. There is no stop-loss: losing positions remain open for a later profitable signal exit or official resolution. If neither closes it, hold through official resolution.
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
