# Polymarket BTC five-minute candle-pattern strategy

The demo-only bot reads BTC spot from a public CCXT feed and the UP/DOWN Polymarket order books. Within each five-minute market window, it builds timestamp-aligned one-minute BTC candles from the feed. A candle is green when its close is above its open, red when its close is below its open, and neutral when it is a doji or has too few samples. The sequence resets at the start of each five-minute window.

## Trading rules

| Completed entry sequence | Action |
| --- | --- |
| `RG` or `RRG` | Buy UP |
| `GR` or `GGR` | Buy DOWN |

`RR` by itself does not open a position. Only the four listed sequences can enter. The bot never sells in response to a candle pattern; an open position remains held through the window until post-close settlement or official resolution. It allows at most one filled entry per window, with each entry targeting exactly 500 shares. There is no strategy-level contract-price band; available demo cash and simulated fills still apply.

Entries use demo marketable FAK orders against the visible outcome book. During the active window, CLOB prices only mark open positions; they do not trigger sells or settlement. At expiry, paired UP/DOWN CLOB midpoints must show one side at $0.98 or higher and the other at $0.02 or lower continuously through the final two seconds to settle the winner at $1 per share and the loser at $0. If that end-of-window signal is missing or ambiguous, the existing post-close held-side thresholds ($0.99 midpoint win or $0.01 best-bid loss) remain a fallback; otherwise the bot checks Polymarket's official resolution.

## Dashboard and operation

The dashboard shows BTC spot and its trailing 10-second average, the completed candle sequence and latest pattern action, UP/DOWN asks and their trailing averages, positions, marks, cash, equity, and realized/unrealized P&L. The BTC averaging line is informational; it is not part of the strategy signal.

Coinbase BTC/USD is the default feed. Set `CCXT_EXCHANGE` and, if needed, `CCXT_SYMBOL` to select another CCXT market; the feed honors an exchange's higher minimum interval if required. Feed staleness and missing candle data are reported on the dashboard. Estimated crypto taker fees are included in demo cash and P&L. When visible depth runs short, DemoTrader may model the remainder at the worst visible price; that liquidity is synthetic.

The strategy is strictly demo-only. `LIVE_TRADING=true` is refused before wallet authentication, and the active bot uses only DemoTrader. The $10,000 paper balance and trade history reset when the process restarts. Simulated fills, fees, and P&L are behavior checks—not evidence of live execution or profitability.

Run `npm test` to verify candle classification, exact entry patterns, hold-through-window behavior, timestamped candle aggregation, settlement, and the live guard. For startup and dashboard checks, follow [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).