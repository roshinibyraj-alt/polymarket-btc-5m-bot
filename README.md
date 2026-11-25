# BTC Edge Lab — paper experiment

**No profit guarantee. No live execution.** The active engine is `selective-edge-bot.js`.
Older engines remain only as inactive reference/test fixtures; startup never loads them.

## Hypothesis

An option-style short-horizon BTC forecast might identify executable Polymarket
odds that underestimate a side's chance of paying $1. This is a hypothesis, not
a demonstrated edge. The service can skip all windows.

Binance aggregate-trade WebSocket prices supply live spot data. The last 120
one-minute candles seed volatility, with at least 60 gap-free completed candles
required. Volatility is the maximum of 10-minute return RMS, 60-minute return RMS,
30-minute high/low volatility and a floor. No future candles enter the model.

The Binance window-open price is explicitly a **proxy** for the Chainlink strike.
Alternative zero/small-drift forecasts, 1×/1.5× volatility, and an adverse strike
buffer of max($15, half one-minute dollar volatility) create a scenario range.
Subtract another five probability points before deciding. This is not a
statistical confidence interval. TWAP-enabled markets use the variance of the
final-60-second average. Entry ends before that averaging interval starts.

## Entry and risk

- Evaluate once per second from seconds 45 through 210.
- Require the same side on three consecutive fresh trade ticks.
- Normal value entries require conservative scenario chance ≥52%; edge ≥$0.01/share after executable
  ask VWAP, taker fees and a $0.01/share execution reserve.
- Ask $0.05–$0.95; spread ≤$0.03; exchange and receive timestamps ≤2 seconds old.
- Only current-market outcome IDs and books hydrated on this connection qualify.
- One entry per window, maximum 50 shares and min($15, 0.5% of available capital).
- All unsettled entry cost, including fees, capped at 2% of starting capital.
- A 5% peak drawdown stops new entries persistently across restarts.
- No martingale, flips, opposite hedges, or forced-entry path. Windows may be
  skipped when no side passes the regular entry criteria.

## Conservative paper accounting

Signals wait at least 300 ms and require a new book update before execution;
all filters are revalidated. Use at most half the visible shares per ask level.
Partial fills are allowed; any remainder cancels. This still cannot model all
real latency, cancellations, adverse selection or exchange execution effects.

Fees are read from market metadata. Unsupported/missing schedules block entries.
For the current BTC schedule, fee = shares × rate × price × (1-price), calculated
per fill level. Taker buys earn no maker rebates. The one-cent execution reserve
is a decision buffer, not an additional booked fee.

Hold positions until **official resolution**, polled every five seconds after
expiry. A 99-cent quote never fabricates a $1 early payout. No empty-book loss.
Pending settlement does not block later windows except through the total risk cap.
Floating marks use net bid VWAP at half displayed depth, valuing any unliquidatable
remainder at zero without closing it. Stale marks are explicitly labelled estimates.

## Evaluation and operation

The mobile dashboard shows costs, fill details, skip reasons, floating and
realized results, fees, drawdown, and live feed health. Brier score, average entry
forecast and observed win rate are measured from actual official settlements,
not invented backtests. The model is **uncalibrated and profitability unproven**.
Collect fresh results across multiple market regimes before considering any
real-money use; a few wins or a positive backtest are not validation.

`PAPER_LEDGER_PATH` persists this strategy through restarts. The strategy ID
remains stable across this filter adjustment to preserve existing history and
open positions. Historical entries made under the removed cadence fallback
remain visible in the ledger; new trades must pass the normal entry filters.
`LIVE_TRADING=true` refuses startup. No private key is read and no wallet signing
or exchange order submission code is loaded. Real-money services are separate.

Run `npm test`, then `npm start` (Node 22+). Dashboard `/`, JSON `/api/state`,
health `/api/healthz`.

References checked when implementing:
- https://docs.polymarket.com/trading/fees
- https://docs.polymarket.com/market-data/realtime-data
- Current market Gamma metadata, description and `feeSchedule`
