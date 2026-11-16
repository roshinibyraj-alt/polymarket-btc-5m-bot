# BTC 5-minute pressure forecast paper bot

The active app is paper-only. Its startup file loads the demo strategy and does not load the real-order bot or Polymarket trading adapter. `LIVE_TRADING=true` is ignored and logged as a safety warning.

## Inputs and forecast

- BTCUSDT aggregate trades arrive through Binance's public `data-stream.binance.vision` WebSocket.
- The current BTC 5-minute candle open, current price, and recent one-second prices feed a zero-drift volatility estimate.
- Each second, combine Binance aggressive buy/sell flow with UP/DOWN Polymarket CLOB depth imbalance and microprice pressure.
- Collect ten fresh one-second pressure samples. Until all ten, no forecast entry qualifies.
- Blend the experimental price/volatility estimate, current Polymarket midpoint odds, and the recent pressure trend into an estimated UP/DOWN resolution probability.
- The estimate is uncalibrated. It is not a validated probability or guarantee of direction.

## Entry and flip rules

- Consider only the cheaper outcome when its best ask is below $0.50.
- Enter 100 shares only when that side's experimental estimate is above 50%, the full visible ask sweep stays at or below $0.90, paper cash covers it, and expected net edge after the market's taker fees is at least $0.10 per share.
- Allow only one initial position per window. Do not add to a same-side position.
- An opposite-side signal can flip only while the open position can be sold for positive net proceeds after taker fees and visible book depth. Sell the full position down to a $0.01 bid floor, then buy the opposite side for the same filled share count under the $0.90 ask cap. The opposite buy must still clear the net-edge filter at that size.
- A $0.99 bid is counted as a $1 payout per share; a $0.01 bid or lower is counted as $0. Otherwise hold the position until the original Polymarket market confirms resolution.
- When visible depth is insufficient to complete the requested sweep within the cap/floor, skip the action rather than simulate a partial position.

## Running and checking

Run `npm test`, then `npm start`. The dashboard is available at `/`; `/api/state` reports the forecast, candidate sides, paper orders, positions, and resolutions. Paper account history is held in memory and resets when the process restarts.
