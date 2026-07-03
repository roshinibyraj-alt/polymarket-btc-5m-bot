# Polymarket-style BTC 5m Paper Trading Simulator

Live paper-trading bot for 5-minute BTC up/down binary windows. Pulls real-time
price/trade/order-book data from Binance, runs 5 independent prediction signals,
and lets 5 different strategies each decide independently whether to "trade" and
which side — with their own separate paper bankrolls so you can compare them.

## Setup

```bash
npm install    # no dependencies needed beyond Node 18+ (uses native fetch/WebSocket)
npm start
```

Runs continuously. Logs every window's signals/decisions to console and writes
running results to `results.json` after every resolution. Ctrl+C to stop (persists
final state first).

## How it works

1. **Data** (`src/binanceFeed.js`): live trades + order book depth via Binance
   WebSocket, backfilled with recent 1-minute klines on startup.
2. **Predictors** (`src/predictors.js`): 5 independent signals, each returning
   `{direction, confidence}`:
   - `momentum` — recent return over 1min/5min
   - `orderFlow` — aggressor buy vs sell volume imbalance
   - `orderBook` — resting bid vs ask depth imbalance
   - `meanReversion` — z-score vs short moving average (contrarian)
   - `volBreakout` — recent range expansion vs historical average
3. **Strategies** (`src/strategies.js`): different ways of turning those signals
   into a trade decision — consensus vote, order-flow-only scalp, momentum-follow,
   pure mean-reversion, and "whichever single signal is most confident."
4. **Paper engine** (`src/paperEngine.js`): each strategy gets its own $1000
   virtual bankroll, sizes bets as a confidence-scaled fraction of bankroll
   (capped), and settles against the actual window close.
5. **Window manager** (`src/windowManager.js`): aligns to 5-minute UTC
   boundaries, waits `decisionOffsetSeconds` before locking in a decision.

## Important caveats — read before trusting any numbers this produces

- **Market pricing is simulated, not real.** `paperEngine.js` prices every
  YES/NO position at `0.5 + spread/2` (a fixed synthetic spread). It does **not**
  reflect Polymarket's actual order book, which moves with sentiment and can be
  far from 50/50 heading into a window. To make this realistic you need to pull
  live prices from Polymarket's CLOB API and price fills against that book. Until
  then, treat P&L here as "how often was I directionally right," not "what I'd
  actually have earned."
- **Verify the resolution source.** This uses Binance spot BTCUSDT for open/close.
  Confirm which price feed/oracle the specific Polymarket market you're targeting
  actually resolves against — if it differs from Binance spot, your backtest
  edge won't transfer.
- **Short backtests lie.** A handful of winning windows means nothing. Run this
  for at least a few hundred windows (it logs every one) before drawing any
  conclusion about whether a strategy has real edge.
- **This was built and syntax/logic-tested with synthetic data in a sandboxed
  environment without live network access.** I verified the full pipeline
  (predictors → strategies → paper engine → resolution) runs correctly against
  mocked feed data, but I have not been able to test it against live Binance
  WebSocket connections myself — do a short supervised run first to confirm the
  live data wiring behaves as expected on your machine.

## Tuning

All thresholds, lookback windows, position sizing, and the simulated spread are
in `config.js` — nothing is hardcoded in the logic files.

## Natural next steps

- Replace `quotePrice()` in `paperEngine.js` with a real Polymarket CLOB fetch
- Add a signal-calibration step (log predicted probability vs actual outcome
  over many windows, check if it's actually calibrated — most raw heuristics
  aren't)
- Persist raw signals per window (not just trades) so you can retrain/tune
  offline against a larger history
