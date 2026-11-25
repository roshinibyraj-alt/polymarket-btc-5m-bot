# BTC 5-minute previous-candle color paper bot

This service watches BTC UP/DOWN five-minute markets. It uses Binance BTCUSDT one-minute kline WebSocket candles for direction and the Polymarket CLOB WebSocket for paper execution quotes. It is paper-only: it does not submit real orders or sign with a wallet.

## Signal flow

At the start of minutes 1–3 in each five-minute market, use the immediately preceding closed Binance candle to choose a side: RED buys UP; GREEN buys DOWN. Minute 1 of each five-minute market uses the previous market window’s final one-minute candle. Minutes 2–3 use the preceding candle in the current window. Minutes 4 and 5 do not trade. The current candle’s color does not change that interval’s entry. Doji candles are neutral and do not create an entry.

## Paper execution

- Each of the first three minute starts requests 200 shares only when the signalled side’s best ask is between $0.11 and $0.70 inclusive. Buys sweep visible asks up to $0.70; actual fills can be partial if displayed depth is insufficient. A signal waits for an in-band fresh quote until the next minute starts. Minutes 4 and 5 are skipped.
- Candle signals never sell positions. Each eligible minute can buy independently, including the opposite side while an earlier position remains open.
- The first side with an open position to reach a fresh $0.85 midpoint closes at $0.85/share and disables only the opposite side's $0.85 intra-window target for that market window; later entries on the triggering side can still use $0.85. The separate $0.99 midpoint target remains active and credits $1/share only when it will not close at a net loss after fees. There is no stop-loss; remaining positions are held for official resolution.
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
