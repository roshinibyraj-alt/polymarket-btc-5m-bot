# Version History

## v101-cheap-hunter-strategy (current)
- Strategy changed to CheapHunter (on original FlipBot discovery/polling engine).
- Entry: wait 30s -> buy cheapest side (underdog) if ask <= 0.20.
- Exit: check mid >= 0.50 each tick -> TP limit at 0.50. If not filled -> hold to resolution.
- No stop loss, no martingale, no re-entries. One trade per window.
- Config: $300 demo, 5% base, compounding, taker fees.

## v100-cheap-hunter-rewrite (abandoned - broken discovery, reverted)
