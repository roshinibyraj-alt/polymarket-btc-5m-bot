# Independent BTC long / ETH short paper strategy

The active service no longer follows any wallet. It starts a separate **$5,000 paper account** and uses public Polymarket Perps marks, instruments, fees and books only. No signing, credentials or real order placement is used.

- Both sides use **5× cross-margin accounting**.
- Initially open BTC long with $1,500 margin ($7,500 target exposure), and ETH short with $1,000 margin ($5,000 target exposure). Size precision and fees apply.
- Each adjustment uses two units; a unit is 1% of current marked account equity, frozen when that adjustment is requested.
- Price levels are **0.5%, 1%, 1.5%, ... from the original filled opening VWAP**. Original references never move when the average entry changes.
- A favourable level reduces two units; an adverse level adds two. Falling ETH is favourable for the short.
- **Each level is used once**, including partial execution. Staying beyond or recrossing a used level does not repeat it.
- Additions are skipped when initial margin plus fees are unaffordable; they can retry if margin frees and the unused level still qualifies.
- A price gap across several levels processes successive unused levels using later actual books, not the historical threshold prices.
- A fully closed side stays closed. It is not automatically rebalanced back to its initial allocation.
- Orders wait at least 500ms and sweep later available depth with taker fees. Partial remainders are retained; unchanged consumed liquidity is not reused.
- Both marks must be fresh for new equity-based sizing. Unknown valuations are not zero.
- Public fee schedules and instrument overrides apply; missing crypto categories use the clearly labelled documented standard-tier estimate.
- Funding is estimated at hourly boundaries using the last public rate and observed mark. Missed hours are labelled last-known-input estimates, not an exact funding ledger.
- A maintenance-margin breach conservatively unwinds both sides with book depth and liquidation fees, then halts. This paper model does not reproduce exchange partial recovery, insurance transfers or ADL.
- The independent ledger is `independent-btc-eth-grid-v1.json` alongside the configured old ledger, or under `/data` on Railway. Copy history is retained separately but never imported. Restarts restore positions, original anchors, pending remainders and used levels.

Run with `npm start`; verify with `npm test`. `/api/state` is read-only and `/api/healthz` reports service status.

---

## Historical wallet-copy implementation — inactive

The sections below document the superseded copy simulator. They do not describe the active strategy.

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
