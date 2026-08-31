# Version History

## v100-cheap-hunter ← current
- Complete rewrite: **CheapHunter** strategy.
- **Entry**: wait 30s → market buy underdog if ask ≤ 0.20 (GTC 0.99 ceiling).
- **Exit**: immediately place limit sell at 0.50 (resting TP). If unfilled at resolution → resolve.
- **No stop loss, no martingale, no re-entries.** One trade per window.
- **Config**: $300 demo · 10% base · compounding · fees.
- Dashboard: "30 Seconds Waiter"
