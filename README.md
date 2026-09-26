# BTC 5-minute candle-imbalance bot

Paper-trading bot for Polymarket `btc-updown-5m-*` markets. It uses real BTCUSDT 5-minute candle colors from Binance to drive a mean-reversion signal, then trades the corresponding Polymarket side through public CLOB reads.

## Strategy

- At startup, backfill the most recent **10 closed BTCUSDT candles**.
- Count red and green candles across that rolling 10-candle window.
- If red candles exceed green candles by at least 2, lock onto UP because green is considered lacking.
- If green candles exceed red candles by at least 2, lock onto DOWN because red is considered lacking.
- While locked, keep trading that side each window. Unlock only when a candle of the required missing color closes, then evaluate the 10-candle imbalance again.
- If the gap is smaller than 2 and no side is locked, skip the window.

## Win/loss sizing

The next trade starts at 500 shares. Each settled win reduces the next size by 100 shares, but never below 500. Each settled loss adds 100 shares, up to seven additions:

`500 → 600 → 700 → 800 → 900 → 1000 → 1100 → 1200`

Unfilled and unresolved windows do not change the size. The size continues across windows and is not reset merely because the imbalance lock changes.

## Execution and settlement

- One taker buy is simulated at the first available ask when a signal is armed.
- A resting maker take-profit is watched at 0.99 and booked as $1.00 per share, including the configured maker rebate.
- If the position remains open at window close, it settles at $1.00 per share when its side wins and $0.00 when it loses.
- Live equity includes unrealized mark-to-market P&L from the open position.
- This app remains paper trading; no signed live orders are sent.

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Dashboard: http://localhost:8000