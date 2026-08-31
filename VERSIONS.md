# Version History

## v070-pullback-analyzed  ← `git tag v070-pullback-analyzed`
- Commit: `0263963`
- The version whose logs were analyzed (uploaded `logs.1788122004250.csv`, Aug 30 13:20–20:30 UTC).
- Strategy: wait 45s · **first entry AT/BELOW 0.70** (pullback, no 0.65–0.70 band yet) · SL 0.50 · re-enter ≥0.65 ×2 · ceiling 0.99 · **base 1% · carry on loss**
- Known behavior in this version: first entry could buy the cheap side (0.12–0.30); profitable "SL at 0.50" still escalated the martingale.

## LATEST: equity chart on top + lifetime stats
- Commits up to `f3f1f66`
- First entry only in **0.65–0.70 band** (no cheap-side buys) · lifetime equity curve · max drawdown from peak · highest martingale tracker.

## LATEST: cheap-side initial entry
- First entry: buys the CHEAP side (lower ask) after 45s wait — always takes the underdog.
- Martingale re-entries unchanged (any side at ≥0.65 with 2× shares).
- Updated smoke scenarios with proper timing to avoid premature re-entry on wrong side.

## LATEST: TP on cheap first exit + frozen-market skip
- Cheap-side first entry (entry < 0.50) exiting at SL 0.50 is labeled **TP** (profitable win); martingale STILL escalates after it (unchanged flow).
- Frozen-market detection: if both sides are pinned at ~0.50 for 60s+ after the wait, the window is skipped (market suspended).
