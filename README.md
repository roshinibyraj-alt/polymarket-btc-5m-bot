# Polymarket BTC five-minute candle-pattern strategy

The demo-only bot reads BTC spot from a public CCXT feed and the UP/DOWN Polymarket order books. Within each five-minute market window, it builds timestamp-aligned one-minute BTC candles from the feed. A candle is green when its close is above its open, red when its close is below its open, and neutral when it is a doji or has too few samples. The sequence resets at the start of each five-minute window.

## Trading rules

| Completed candle sequence | Action |
| --- | --- |
| `RG` or `RRG` | Buy UP |
| `GR` or `GGR` | Buy DOWN |
| `RGR` or `RRGR` | Sell an existing UP position |
| `GRG` or `GGRG` | Sell an existing DOWN position |

`RR` by itself does not open a position. A sell closes only the matching open side; it does not open the opposite side. The bot does not reverse or re-enter after an exit. It allows at most one filled entry per window, with each entry targeting exactly 500 shares. There is no strategy-level contract-price band; available demo cash and simulated fills still apply.

Entries and exits use demo marketable FAK orders against the visible outcome book. If a sell only partially fills, the remainder stays open and the exit signal is retried while the window is active. Remaining shares at the five-minute close wait for settlement or resolution. After close, a held-side CLOB midpoint at or above $0.99 or best bid at or below $0.01 may be counted as a demo threshold settlement; otherwise the bot checks Polymarket's official resolution. Threshold settlement is not used as an in-window substitute for the candle-pattern exit.

## Dashboard and operation

The dashboard shows BTC spot and its trailing 10-second average, the completed candle sequence and latest pattern action, UP/DOWN asks and their trailing averages, positions, marks, cash, equity, and realized/unrealized P&L. The BTC averaging line is informational; it is not part of the strategy signal.

Coinbase BTC/USD is the default feed. Set `CCXT_EXCHANGE` and, if needed, `CCXT_SYMBOL` to select another CCXT market; the feed honors an exchange's higher minimum interval if required. Feed staleness and missing candle data are reported on the dashboard. Estimated crypto taker fees are included in demo cash and P&L. When visible depth runs short, DemoTrader may model the remainder at the worst visible price; that liquidity is synthetic.

The strategy is strictly demo-only. `LIVE_TRADING=true` is refused before wallet authentication, and the active bot uses only DemoTrader. The $10,000 paper balance and trade history reset when the process restarts. Simulated fills, fees, and P&L are behavior checks—not evidence of live execution or profitability.

Run `npm test` to verify candle classification, exact entry/exit patterns, timestamped candle aggregation, order handling, settlement, and the live guard. For startup and dashboard checks, follow [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).