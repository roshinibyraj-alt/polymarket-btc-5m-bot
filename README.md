# Polymarket Perps paper copy bot

This service replaces the BTC paper strategy with a **paper-only** copy simulator for the selected Polymarket Perps account. It reads public Perps portfolio and fill endpoints. It does not load a wallet signer, submit orders, or access private credentials.

## Source account

- Public smart-wallet address: `0x23ecee90767f510347d5005dc680ff5d24c7325c`
- Perps owner EOA: `0x5eee21f22ac3bb72c979d801270d7f322d6b2d6f`
- Polymarket's Perps API keys registration, portfolio, and fills to the owner EOA. The app checks that account before initializing.

The first successful start captures current positions and the newest fill watermark. Current positions are adopted at their live marks without importing pre-start profit or loss. The existing ledger is retained on updates; positions are adjusted to the current equity ratio rather than reset.

## Paper sizing and accounting

- Starting paper capital: `$5,000`
- Proportional multiplier: `current paper equity / current source equity`.
- Target quantity: `source signed position quantity × multiplier`, rounded down to instrument precision.
- There is no fixed notional cap and no additional margin reserve. Match the master's gross effective leverage; notional can exceed paper equity.
- Existing positions are rebalanced at each portfolio snapshot; new fills use the latest available equity ratio. Adjustments incur simulated costs.
- Simulated fills use one adverse price tick from each observed source fill and a tier-0 taker-fee estimate of `0.05%`.
- Floating P&L uses mark prices derived from the public source portfolio snapshots.
- Funding payments are not included. The dashboard labels this limitation.

The proportional multiplier adapts as either account's equity changes. Fees, latency, instrument precision and slippage mean the resulting effective leverage is approximate, not tick-perfect. If either account has non-positive or unavailable equity, copying pauses explicitly. Liquidation and funding payments are not simulated; matching leverage does not guarantee capital preservation. The ledger persists source fill IDs, paper positions, P&L, and activity so restarts do not replay fills.

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
