# Polymarket Perps paper copy bot

This service replaces the BTC paper strategy with a **paper-only** copy simulator for the selected Polymarket Perps account. It reads public Perps portfolio and fill endpoints. It does not load a wallet signer, submit orders, or access private credentials.

## Source account

- Public smart-wallet address: `0x23ecee90767f510347d5005dc680ff5d24c7325c`
- Perps owner EOA: `0x5eee21f22ac3bb72c979d801270d7f322d6b2d6f`
- Polymarket's Perps API keys registration, portfolio, and fills to the owner EOA. The app checks that account before initializing.

The first successful start captures current positions and the newest fill watermark. Current positions are queued at their live marks without importing pre-start profit or loss. Existing history and positions are retained on updates; legacy executions are not rewritten.

## Paper sizing and accounting

- Starting paper capital: `$5,000`
- Proportional multiplier: `current paper equity / current source equity`.
- Target quantity: `source signed position quantity × multiplier`, rounded down to instrument precision.
- There is no fixed notional cap and no additional margin reserve. Match the master's gross effective leverage; notional can exceed paper equity.
- New master fills queue limits at the **exact master execution price**. There is no automatic equity-rebalance trading that can bypass these limits. Pending quantities count toward the exposure target.
- Configured leverage is **5×**: initial margin = position notional / 5. This does not multiply copied quantities by five or force the account's effective leverage to equal five. Opening fills require adequate initial margin and fees. Reductions can proceed in margin call.
- Each limit expires **five minutes from local placement**. Only its remaining quantity then becomes a market sweep, using fresh depth and actual depth-weighted prices; insufficient liquidity remains explicitly pending and retries, never fabricates fills.
- On arrival, a marketable limit fills only qualifying opposing depth at book prices (taker). A previously resting limit needs strictly-through opposing depth (not equality), fills conservatively at the master limit (maker). Book liquidity is shared across pending orders and a sequence/timestamp snapshot cannot be reused. No pre-placement or stale snapshot fills.
- Fees come from `/v1/info/fees` and active instrument `fee_override`, standard tier 0 (normally maker `0.02%`, taker `0.05%` of executed notional). The live endpoint currently omits non-equity categories: crypto/index/commodity use the official published standard table, explicitly labelled as an estimate on each fill. Unknown categories block. Paper history does not inherit master beta/account discounts; no assumed rebate or builder fee.
- Opposing master actions cancel overlapping unfilled previous orders before placing a limit for any filled exposure that must exit. Restarts preserve remaining size and original deadlines.
- Floating P&L uses official `/v1/info/tickers` marks, supplemented by source portfolio marks.
- Funding payments are not included. The dashboard labels this limitation.

The proportional multiplier adapts for new source fills as either account's equity changes. Fees, latency, instrument precision and slippage mean resulting exposure is approximate. Five-second book snapshots cannot prove queue position or reproduce activity between polls. Liquidation and funding payments are not simulated; 5× margin accounting is not a complete exchange risk engine and does not guarantee capital preservation. The ledger persists source fill IDs, outstanding orders, paper positions, P&L, and activity so restarts do not replay fills.

## Data and service

- Public API base: `https://api.perpetuals.polymarket.com`
- Fill polling is every five seconds; portfolio/mark snapshots refresh every fifteen seconds.
- The public fills endpoint is paginated and de-duplicated by trade ID.
- The ledger is stored at `/data/perps-copy-paper-state.json` on Railway. It is separate from the previous BTC strategy ledger, which is left untouched.
- Local runs use `./.data/perps-copy-paper-state.json`.

Set `LIVE_TRADING=true` only to verify the startup safety stop; the app will refuse to start. The source code never uses private-key or order-placement modules.

## Verify

```sh
npm test
npm start
```

The dashboard is mobile-first and available at `/`. `/api/state` returns the paper ledger view and `/api/healthz` reports process health.
