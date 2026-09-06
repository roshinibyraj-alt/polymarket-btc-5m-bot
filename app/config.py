"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Strategy: interval-based accumulation ("ladder") on Engine B. No stop
loss / take profit -- every fill is held to expiry and settled against
Polymarket's real outcome.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Capital ------------------------------------------------------------
STARTING_BALANCE_USDC = float(os.getenv("STARTING_BALANCE_USDC", "5000"))

# ---- Market discovery ---------------------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# How many seconds before window close counts as the "resolution window"
# for the logging-only 0.90+ signal.
RESOLUTION_WINDOW_SECONDS = 2.0

# How many seconds to retry Polymarket's real settlement outcome before
# falling back to a last-observed-price approximation.
RESOLUTION_RETRY_SECONDS = 6

# ---- Engine B: interval ladder strategy --------------------------------
#
# Phase 1: buy the CHEAPER side every 15s from t=0 to t=120, 20 shares,
#          only if that side is priced below 0.40.
PHASE1_START_OFFSET = 0
PHASE1_END_OFFSET = 120
PHASE1_INTERVAL_SECONDS = 15
PHASE1_SHARES = 20
PHASE1_MAX_PRICE = 0.40

# Gap: t=120 to t=135, no checks.

# Phase 2: buy the CHEAPER side every 15s from t=135 to t=255,
#          40 shares, only if that side is priced below 0.40 (same
#          entry logic as phase 1, different timing/size).
PHASE2_START_OFFSET = 135
PHASE2_END_OFFSET = 255
PHASE2_INTERVAL_SECONDS = 15
PHASE2_SHARES = 40
PHASE2_MAX_PRICE = 0.40

# t=255 to close (300): idle, hold everything to expiry.

# Logging-only signal: a side printing >= this in the last
# RESOLUTION_WINDOW_SECONDS is logged as the likely winner. No action is
# taken on it.
RESOLUTION_SIGNAL_PRICE = 0.90

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
