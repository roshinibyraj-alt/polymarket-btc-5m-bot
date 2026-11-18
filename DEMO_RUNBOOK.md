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
- Enter only when that side's uncalibrated estimate is above 50%, the full visible ask sweep stays at or below $0.95, paper cash covers it, and expected net edge after the market's taker fees is at least $0.02 per share.
- Start at 100 shares. For every full $0.01 of net edge above the unchanged $0.10 sizing base, increase the order by 10 shares, up to 200 shares. Calculate the edge using the all-in cost for the selected share size; require the selected size itself to retain at least $0.02 edge.
- UP and DOWN have separate 5-second entry cooldowns. After its own cooldown, either side may add another independent 100–200 share position; there is no fixed per-window entry cap beyond available paper cash and qualifying signals.
- Before the window ends, close an open paper position when its fresh best bid reaches $0.99, crediting $1 per share. Do not apply a stop-loss or close because a signal points to the opposite side.
- If take-profit is not reached, keep the position open through the window and check Polymarket for official resolution every 10 seconds afterward. Settle only when the original market is confirmed resolved with a definitive UP/DOWN outcome.
- When visible depth is insufficient to complete the requested sweep within the cap/floor, skip the action rather than simulate a partial position.

## Running and checking

Run `npm test`, then `npm start`. The dashboard is available at `/`; `/api/state` reports the forecast, candidate sides, paper orders, positions, and resolutions. Railway paper history is persisted on its mounted volume; a one-time `PAPER_HISTORY_RESET_VERSION` change resets it.
