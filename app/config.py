"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Engine A has been removed. Engine B is the only strategy running.
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

# ---- Engine B (v6 -- peak drawdown reversion strategy) -----------------
# Sits out the first ENTRY_WAIT_SECONDS of every window. After that, it
# tracks each side's (UP and DOWN) running peak price independently,
# second by second. Whenever a side's price falls DIP_TRIGGER_AMOUNT off
# its own peak -- and is still inside [RANGE_MIN, RANGE_MAX] -- it buys
# TRADE_SHARES of that side as an independent leg with its own take
# profit and stop loss. A side can fire again once it makes a NEW peak
# and then dips DIP_TRIGGER_AMOUNT again (no re-firing off the same
# peak). Both sides are tracked independently and can be in position at
# the same time. No new entries after ENTRY_CUTOFF_SECONDS; anything
# still open at window close settles against the real outcome.
RANGE_MIN = 0.40
RANGE_MAX = 0.90

ENTRY_WAIT_SECONDS = 100      # no trading at all before this
ENTRY_CUTOFF_SECONDS = 270    # no NEW entries after this (exits still managed)

DIP_TRIGGER_AMOUNT = 0.10     # buy trigger: price is this far below its peak
TP_OFFSET = 0.10              # take profit = entry + this
SL_OFFSET = 0.10              # per-trade stop loss = entry - this
TRADE_SHARES = 100            # fixed size per triggered leg, unlimited legs

# Hard stop loss: an absolute price floor that applies to either side.
# If a side's price falls to this level while a leg on that side is
# open, force-close it immediately regardless of that leg's own TP/SL.
# This is a floor on RANGE_MIN, not an extra exit level -- once one side
# hits it, the other side is usually still comfortably inside
# [RANGE_MIN, RANGE_MAX] and free to trade normally.
HARD_STOP_PRICE = 0.40

# ---- Trading fees ---------------------------------------------------------
# Polymarket taker fee (per docs.polymarket.com/trading/fees, Crypto
# category). Charged only on entry (buys); redemption/resolution is
# fee-free, and there is no maker fee since every fill here is a taker
# market order. Formula: fee = shares * price * FEE_RATE * (price * (1 - price)) ** FEE_EXPONENT
# NOTE: Polymarket has revised this fee schedule multiple times in 2026
# and third-party sources disagree on the exact current rate for the
# 5-min/15-min crypto sub-category specifically -- verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money. APPLY_TAKER_FEES can be set False to model a fee-free run.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
