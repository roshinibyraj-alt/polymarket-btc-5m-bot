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

- Either UP or DOWN may qualify at any quoted price; there is no $0.50 cheaper-side filter.
- Enter 100 shares only when that side's experimental estimate is above 50%, the full visible ask sweep stays at or below $0.90, paper cash covers it, and expected net edge after the market's taker fees is at least $0.05 per share.
- UP and DOWN have separate 15-second entry cooldowns. After its own cooldown, either side may add another independent 100-share position; there is no fixed per-window entry cap beyond available paper cash and qualifying signals.
- Do not sell or settle a position from a price threshold, or because a signal points to the opposite side. Each position remains open independently through the window.
- After the original market window ends, check Polymarket for official resolution every 10 seconds. Settle only when the original market is confirmed resolved with a definitive UP/DOWN outcome.
- When visible depth is insufficient to complete the requested sweep within the cap/floor, skip the action rather than simulate a partial position.

## Adaptive-sample shadow comparison

- Keep the active trading signal on ten one-second samples throughout each window.
- In parallel, calculate a shadow-only forecast using 10 samples through the first minute, then 9, 8, 7, and 6 samples at the 60-, 120-, 180-, and 240-second marks.
- Simulate an independent paper portfolio with the same 100-share entries, signal filters, per-side 15-second cooldowns, visible ask-sweep cap, taker-fee estimate, and official-resolution-only settlement.
- Shadow entries never create orders, consume the trading portfolio's cash, or influence the selected trading side.
- Compare settled and floating P&L, entry counts, wins/losses, and unresolved positions. Floating P&L marks open shares at the latest bid; unresolved positions are excluded until the official result arrives.
- The comparison is an experimental fill simulation, not a live execution guarantee. Its in-memory portfolio resets when the process restarts.

## Running and checking

Run `npm test`, then `npm start`. The dashboard is available at `/`; `/api/state` reports the forecast, candidate sides, paper orders, positions, and resolutions. Paper account history is held in memory and resets when the process restarts.
