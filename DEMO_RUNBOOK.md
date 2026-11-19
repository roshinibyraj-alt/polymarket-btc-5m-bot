# BTC 5-minute reversed-signal dip-and-spike paper bot

The active app is paper-only. Startup does not load the real-order bot or Polymarket trading adapter. `LIVE_TRADING=true` is ignored and logged as a safety warning.

## Data

- Subscribe to the current BTC 5-minute market's UP and DOWN Polymarket CLOB WebSocket books.
- Use each side's midpoint history independently. Binance remains connected for dashboard context but does not select a side or gate the strategy.
- A trigger needs a fresh midpoint history for its signal side and a fresh quote book for the opposite side that would be bought.

## Entries: buy a confirmed dip

- Trade only from the market's start through second 239. At second 240, stop buys and attempt to close remaining positions at current executable bids.
- Keep a rolling 20-second midpoint history for each side. Require at least six quotes spanning eight seconds.
- Define a dip as a recent trough at least $0.04 below the high observed before the latest five-second trough window.
- Do not buy during the fall. Wait until the midpoint has bounced at least $0.01 from that trough and the last three quotes are rising.
- Reverse only the outcome bought: a confirmed UP dip signal buys 20 DOWN shares; a confirmed DOWN dip signal buys 20 UP shares.
- Sweep the opposite side's visible asks, capped at $0.85. Include modeled taker fees; skip rather than inventing a fill if the full amount is unavailable or paper cash is insufficient.
- UP and DOWN signal sides have separate entry state. Each signal side has a 10-second cooldown, must recover $0.02 from its last trigger before it rearms, and can enter at most twice per window. These caps limit planned exposure to 40 shares per bought side and 80 shares across both sides.

## Exits: sell all shares into a profitable spike

- For a side with open shares, sweep its visible bid book for the entire side's current-window inventory.
- A spike exit is eligible only when the complete sweep's average price is at least $0.05 above that side's weighted gross entry price, and the estimated net profit remains at least $0.01 per share after entry and modeled exit fees.
- Close all current-window open positions on that side together; do not sell or block the opposite side.
- If there is not enough visible bid depth for the complete side inventory, do not claim a full sale.
- If a bought side's combined realized and current executable net P&L for the window reaches -$5, sweep its entire open position at available bids and block further signals that would buy that side for the window. This is a trigger, not a guaranteed maximum loss: gaps, fees, and shallow books can produce a larger realized loss.
- At second 240, stop triggering new buys and attempt a full bid-book sweep for any remaining shares, regardless of profit. If a fresh full sweep is unavailable, retain the unsold shares for official resolution of their original market, checked every 10 seconds.

## Dashboard and verification

The dashboard reports the signal side, opposite buy side, each side's midpoint and bid/ask, recent reference high and trough, dip and bounce sizes, entries used, and why a setup is waiting or eligible. Paper orders use visible-book taker-style sweeps and include modeled fees; this is a simulation, not an exchange fill guarantee.

Run `npm test`, then `npm start`. `/api/state` reports the active strategy, quotes, paper orders, positions, and resolutions. Railway paper history is stored on its existing volume and can be reset with a new `PAPER_HISTORY_RESET_VERSION`.
