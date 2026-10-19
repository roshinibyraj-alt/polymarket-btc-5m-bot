# Polymarket BTC five-minute volatility-retest strategy

The demo-only bot reads BTC spot from a public CCXT feed and the UP/DOWN Polymarket order books. Within each five-minute market window, it builds timestamp-aligned one-minute BTC candles from the feed. A candle is green when its close is above its open, red when its close is below its open, and neutral when it is a doji or has too few samples. The sequence resets at the start of each five-minute window.

## Trading rules

| Completed entry sequence | Action |
| --- | --- |
| `RG` or `RRG` | Buy UP |
| `GR` or `GGR` | Buy DOWN |

`RR` by itself does not open a position. Only the four listed sequences can enter. The signal-side ask must fall back to $0.65 before entry if it first rises above $0.80. A held-side best bid of $0.99 triggers take profit and counts each remaining share as a $1 payout; a best bid of $0.01 triggers stop loss and counts each remaining share as a $0 payout. These thresholds apply during the active window and after close. It allows at most one filled entry per window. Sizing starts at 500 shares; after each settled loss, the next target increases by 200 shares, and after each settled win it decreases by 200 shares, never below 500. There is no other strategy-level contract-price band; available demo cash and simulated fills still apply.

Entries use demo marketable FAK orders against the visible outcome book. During the active window and after close, a held-side best bid at $0.99 or higher triggers take profit and counts remaining shares at $1 each; a best bid at $0.01 or lower triggers stop loss and counts them at $0 each. At expiry, paired UP/DOWN CLOB midpoints at $0.99 or higher on one side and $0.01 or lower on the other, continuously through the final two seconds, can also settle the winner at $1 per share and the loser at $0. If these CLOB signals are missing or ambiguous, the bot checks Polymarket's official resolution.

## Dashboard and operation

The dashboard shows BTC spot and its trailing 10-second average, the completed candle sequence and latest pattern action, UP/DOWN asks and their trailing averages, positions, marks, cash, equity, and realized/unrealized P&L. The BTC averaging line is informational; it is not part of the strategy signal.

Coinbase BTC/USD is the default feed. Set `CCXT_EXCHANGE` and, if needed, `CCXT_SYMBOL` to select another CCXT market; the feed honors an exchange's higher minimum interval if required. Feed staleness and missing candle data are reported on the dashboard. Estimated crypto taker fees are included in demo cash and P&L. When visible depth runs short, DemoTrader may model the remainder at the worst visible price; that liquidity is synthetic.

The strategy is strictly demo-only. `LIVE_TRADING=true` is refused before wallet authentication, and the active bot uses only DemoTrader. The $10,000 paper balance, trade history, and adaptive share-size sequence reset when the process restarts; a fresh run starts at 500 shares. Simulated fills, fees, and P&L are behavior checks—not evidence of live execution or profitability.

Run `npm test` to verify candle classification, exact entry patterns, hold-through-window behavior, timestamped candle aggregation, settlement, and the live guard. For startup and dashboard checks, follow [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).