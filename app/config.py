"""
Central configuration for ALPHASTRIKE -- BTC 5-minute up/down, "follow the last window".

  SIGNAL: whichever side won the PREVIOUS window is the side to trade in the next one.
  WINNER: read from Polymarket's own CLOB prices in the last second of the window --
          the side whose price is 0.95+ won. Neither at 0.95+ -> undecided -> no signal.

  ENTRY (next window, traded side, size = current base): ONE order type, a taker market buy.
    At least ENTRY_DELAY_SECONDS (5) after the window opens, buy the current base size at
    market, whatever the price -- no price cap, no resting limit order. Depth-walked fill,
    taker fee. If there is no ask / no depth at 5s, it retries every tick until the window
    closes; never filling means no trade that window.
  EXIT: none. The position is held to the window end and settled by the 0.95 rule:
        winner pays $1/share, loser $0.

  SIZE: one shared base, starts at BASE_SHARES (500). Every win takes off SHARES_STEP (100),
        floor 0. Any loss resets it to 500. At 0 the bot skips same-direction signals; the
        first opposite-direction signal trades 500 and restarts the base.

Everything is priced/filled against Polymarket's CLOB book. No other data source.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
# CLOB only for prices. Gamma is used purely for one-time window metadata
# (slug -> token ids) in polymarket_client.py.
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

# ---- Polling cadence -----------------------------------------------------
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))
# Faster polling in the last seconds of a window, so the 0.95 winner read is as close to the
# final second as possible.
CLOSE_PHASE_POLL_SECONDS = float(os.getenv("CLOSE_PHASE_POLL_SECONDS", "0.25"))
CLOSE_PHASE_SECONDS = 3.0

# ---- Entry: one taker buy, fired shortly after the window opens ---------
ENTRY_DELAY_SECONDS = float(os.getenv("ENTRY_DELAY_SECONDS", "5"))   # fire this long after the window opens

# ---- Sizing ladder ------------------------------------------------------------
BASE_SHARES = int(os.getenv("BASE_SHARES", "500"))
SHARES_STEP = int(os.getenv("SHARES_STEP", "100"))

# ---- Winner rule --------------------------------------------------------------
WIN_PRICE = float(os.getenv("WIN_PRICE", "0.95"))                 # side priced at/above this at the close won
SETTLE_MAX_STALENESS_SECONDS = float(os.getenv("SETTLE_MAX_STALENESS_SECONDS", "3"))  # older reads don't count

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# The entry is a taker market order and pays the real fee, priced by walking real order-book
# depth. Settlement at window end is a redemption: no fee.
# Verify against GET https://clob.polymarket.com/fee-rate?token_id=... before real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
