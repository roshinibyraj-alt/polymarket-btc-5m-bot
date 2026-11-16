# BTC 5-minute pressure forecast paper bot

The active app is paper-only. Its startup file loads the demo strategy and does not load the real-order bot or Polymarket trading adapter. `LIVE_TRADING=true` is ignored and logged as a safety warning.

## Inputs and forecast

- BTCUSDT aggregate trades arrive through Binance's public `data-stream.binance.vision` WebSocket.
- The current BTC 5-minute candle open, current price, and recent one-second prices feed a zero-drift volatility estimate.
- Each second, combine Binance aggressive buy/sell flow with UP/DOWN Polymarket CLOB depth imbalance and microprice pressure.
- Collect ten fresh one-second pressure samples. Until all ten, no forecast entry qualifies.
- Blend the experimental price/volatility estimate, current Polymarket midpoint odds, and the recent pressure trend into an estimated UP/DOWN resolution probability.
- The estimate is uncalibrated. It is not a validated probability or guarantee of direction.

## Repeat-entry and exit rules

- Consider only the cheaper outcome when its best ask is below $0.50.
- Enter 100 shares only when that side's experimental estimate is above 50%, the full visible ask sweep stays at or below $0.90, paper cash covers it, and expected net edge after the market's taker fees is at least $0.05 per share.
- After each successful entry, wait 15 seconds before another entry can be made. Once the cooldown ends, any newly qualifying UP or DOWN signal may add another independent 100-share position; there is no fixed per-window entry cap beyond available paper cash and qualifying signals.
- Do not sell an existing position just because a signal points to the opposite side. Each position remains open independently and exits at its own $0.99/$0.01 threshold, or waits for confirmed resolution of its original market.
- A $0.99 bid is counted as a $1 payout per share; a $0.01 bid or lower is counted as $0. Otherwise hold the position until the original Polymarket market confirms resolution.
- When visible depth is insufficient to complete the requested sweep within the cap/floor, skip the action rather than simulate a partial position.

## Running and checking

Run `npm test`, then `npm start`. The dashboard is available at `/`; `/api/state` reports the forecast, candidate sides, paper orders, positions, and resolutions. Paper account history is held in memory and resets when the process restarts.
