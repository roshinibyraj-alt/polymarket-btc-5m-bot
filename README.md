# Polymarket Perps paper copy bot

This service replaces the BTC paper strategy with a **paper-only** copy simulator for the selected Polymarket Perps account. It reads public Perps portfolio and fill endpoints. It does not load a wallet signer, submit orders, or access private credentials.

## Source account

- Public smart-wallet address: `0x23ecee90767f510347d5005dc680ff5d24c7325c`
- Perps owner EOA: `0x5eee21f22ac3bb72c979d801270d7f322d6b2d6f`
- Polymarket's Perps API keys registration, portfolio, and fills to the owner EOA. The app checks that account before initializing.

The first successful start captures a baseline of existing positions and the newest fill watermark. Pre-existing positions are **not** adopted; only subsequent source exposure changes are copied, avoiding a surprise opening of old positions on deploy.

## Paper sizing and accounting

- Starting paper capital: `$500`
- Proportional multiplier: `$500 / source equity at baseline`
- Maximum marked open notional across all instruments: `$500`
- New paper exposure is clipped to available cap; if mark movement takes total notional over the cap, the simulator trims positions.
- Simulated fills use one adverse price tick from each observed source fill and a tier-0 taker-fee estimate of `0.05%`.
- Floating P&L uses mark prices derived from the public source portfolio snapshots.
- Funding payments are not included. The dashboard labels this limitation.

The proportional multiplier stays fixed for the run. The ledger persists the baseline, source fill IDs, paper positions, P&L, and activity so restarts do not replay fills.

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
