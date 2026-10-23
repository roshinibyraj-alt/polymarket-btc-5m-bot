# Paper bot runbook

1. Verify the dashboard shows one 15-minute market, paper-only mode, live UP/DOWN CLOB quotes, and a fresh Chainlink BTC/USD feed.
2. The bot observes the first 5 minutes. After that it requires a BTC move in one direction spanning at least 60 seconds, at least 0.3% range during the last hour, and at least 50 minutes of BTC price history.
3. The rule-based probability proxy must exceed the effective ask by 10 percentage points or more; the quote spread must be no wider than $0.02. There is no scheduled-news filter.
4. Entry sizing is one-quarter Kelly from the proxy, capped at 8% of the original demo bankroll and available cash. At most one position per 15-minute market; no martingale.
5. Paper exit sells at the current best bid at $0.85 or above, or after the bid remains between $0.60 and $0.70 for 3 minutes. Otherwise, settle against the official Gamma result at close.
6. All fills and fees are simulated. No live orders are placed. Paper trades and account state reset on process restart.

The bot refreshes Polymarket market metadata and CLOB books every 500 ms and reads Chainlink BTC/USD data from Polymarket RTDS. The dashboard refreshes every 2 seconds. The probability proxy is experimental and is not validated as predictive; the missing news filter should be considered before interpreting paper results.
