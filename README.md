# BTC 5-minute previous-candle color paper bot

This service watches BTC UP/DOWN five-minute markets. It uses Binance BTCUSDT one-minute kline WebSocket candles for direction and the Polymarket CLOB WebSocket for paper execution quotes. It is paper-only: it does not submit real orders or sign with a wallet.

## Signal flow

At the start of every one-minute interval, use the immediately preceding closed Binance candle to choose a side: RED buys UP; GREEN buys DOWN. Minute 1 of each five-minute market uses the previous market window’s final one-minute candle. Minutes 2–5 use the preceding candle in the current window, so all five minutes can create one entry each. The current candle’s color does not change that interval’s entry. Doji candles are neutral and do not create an entry.

## Paper execution

- Each minute start requests 200 shares with no $0.50 entry-price gate. Buys sweep visible asks over the valid CLOB price range; actual fills can be partial if displayed depth is insufficient.
- Candle signals never sell positions. Each minute can buy independently, including the opposite side while an earlier position remains open.
- A fresh held-side midpoint at or above $0.99 triggers the $1/share take-profit only when the remaining position will not close at a net loss after fees. There is no stop-loss; positions not closed by take-profit remain open for official resolution.
- Taker-style paper buys use visible book depth; fees use market metadata when available and the configured crypto-fee fallback otherwise.
- Shares still open at expiry are settled using the official Polymarket result, polled every five seconds.
- Trading pauses if the Binance WebSocket is disconnected/stale or if the required CLOB quote is not fresh. REST candle history only seeds/reconciles closed candles; it does not replace the live WebSocket check for signal execution.

## Dashboard and history

The mobile dashboard puts large UP/DOWN CLOB prices near the top, followed by paper account totals, current positions, the five one-minute candle colors, and recent orders/results. The strategy explanation is last. `PAPER_LEDGER_PATH` controls paper-history storage. The new strategy ID resets the replaced strategy's ledger on deploy; restarts after this deploy keep this strategy's positions and history.

## Run

```sh
npm test
npm start
```
