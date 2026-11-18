# BTC 5-minute independent dip-and-spike paper bot

The active app is paper-only. Startup does not load the real-order bot or Polymarket trading adapter. `LIVE_TRADING=true` is ignored and logged as a safety warning.

## Data

- Subscribe to the current BTC 5-minute market's UP and DOWN Polymarket CLOB WebSocket books.
- Use each side's midpoint history independently. Binance remains connected for dashboard context but does not select a side or gate the strategy.
- A side can be evaluated with its own fresh book even when the other side's book is missing or stale.

## Entries: buy a confirmed dip

- Trade only from the market's start through second 239. At second 240, stop all strategy buys and sells.
- Keep a rolling 20-second midpoint history for each side. Require at least six quotes spanning eight seconds.
- Define a dip as a recent trough at least $0.04 below the high observed before the latest five-second trough window.
- Do not buy during the fall. Wait until the midpoint has bounced at least $0.01 from that trough and the last three quotes are rising.
- Buy a fixed 20 shares by sweeping the current visible ask book, capped at $0.85. Include the market's modeled taker fees; skip rather than inventing a fill if the full amount is unavailable or paper cash is insufficient.
- UP and DOWN have separate entry state. Each side has a 10-second cooldown, must recover $0.02 from its last trigger before it rearms, and can enter at most four times per window. These caps limit the planned entry size to 80 shares per side and 160 shares across both sides.

## Exits: sell all shares into a profitable spike

- For a side with open shares, sweep its visible bid book for the entire side's current-window inventory.
- A spike exit is eligible only when the complete sweep's average price is at least $0.05 above that side's weighted gross entry price, and the estimated net profit remains at least $0.01 per share after entry and modeled exit fees.
- Close all current-window open positions on that side together; do not sell or block the opposite side.
- If there is not enough visible bid depth for the complete side inventory, do not claim a full sale.
- At second 240, stop triggering new buys and spike exits. Any remaining shares stay open through the market and settle only from official resolution of their original market, checked every 10 seconds.

## Dashboard and verification

The dashboard reports each side's midpoint, bid/ask, recent reference high and trough, dip and bounce sizes, entries used, and why a setup is waiting or eligible. Paper orders use visible-book taker-style sweeps and include modeled fees; this is a simulation, not an exchange fill guarantee.

Run `npm test`, then `npm start`. `/api/state` reports the active strategy, quotes, paper orders, positions, and resolutions. Railway paper history remains on its existing volume; this strategy change does not reset it.
