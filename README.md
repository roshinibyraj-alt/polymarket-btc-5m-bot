# polymarket-copy-bot

Watches a Polymarket wallet's trade activity and mirrors it as paper trades. Demo mode only — no live execution is wired in yet.

## How it works

- Polls `https://data-api.polymarket.com/activity?user=<wallet>&type=TRADE` every `POLL_INTERVAL_MS`.
- On first poll, seeds itself with the wallet's existing trades (doesn't mirror history) — mirroring starts from the next new trade onward.
- Each new BUY/SELL is mirrored as a paper trade sized at `MIRROR_SCALE` × the source wallet's share size (or a flat `MIRROR_FIXED_SHARES` if set), against a simulated `DEMO_CAPITAL` bankroll.
- Dashboard (Express + Socket.IO) shows the source wallet's raw feed side-by-side with your mirrored trades, open paper positions, and a paper equity curve.

## Local setup

```bash
npm install
cp .env.example .env    # edit WATCH_WALLET / sizing if needed
npm start
```

Dashboard at `http://localhost:8080`.

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `WATCH_WALLET` | `0xb5de863cfef62edecbf1f0e39d0c6acc82df2c54` | wallet address to mirror |
| `POLL_INTERVAL_MS` | `5000` | how often to check for new trades |
| `DEMO_CAPITAL` | `2000` | starting paper bankroll |
| `MIRROR_SCALE` | `0.01` | mirror this fraction of the source wallet's share size |
| `MIRROR_FIXED_SHARES` | unset | if set, always mirror this flat share count instead of scaling |
| `MIN_MIRROR_SHARES` | `1` | skip trades whose mirrored size rounds below this |
| `ACTIVITY_LIMIT` | `100` | rows pulled per poll |
| `PORT` | `8080` | dashboard port |

## Known limitations (v1)

- **Demo only.** `setMode(true)` (the LIVE toggle) is stubbed to refuse — no order-placement/auth code exists yet. Wiring in a real executor (CLOB or Perps API depending on what the source wallet actually trades) is a separate follow-up.
- **No live pricing on open positions.** Mark value uses cost basis, not current market price, since this build doesn't poll a price feed for held tokens yet.
- **REDEEM events aren't mirrored.** If the source wallet's position resolves (market settles) rather than being sold, that isn't reflected here yet — only BUY/SELL trade activity is.
- Data API `/activity` covers standard prediction-market (CTF) trades. If the watched wallet's activity is specifically on Polymarket Perps, that may live on a separate feed (`api.perpetuals.polymarket.com`) not yet wired into this watcher.

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: New Project → Deploy from GitHub repo → select this repo.
3. Railway auto-detects Node via `package.json` (`npm start`). No build step needed.
4. Set env vars from `.env.example` in the Railway service settings (at minimum, none are required — it'll run with defaults).
5. Railway assigns `PORT` automatically — the app already reads `process.env.PORT`.
