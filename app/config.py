"""
Central configuration for the BTC 5-min up/down bot.

Two candle-signal engines that hand control back and forth -- only one
is ever active (placing new trades) at a time:

  Engine 1 -- 3-in-a-row continuation:
    - Candle = the real BTC/USDT 5-min spot candle (Binance klines) for
      the window that just closed, colored green (close > open) or red
      (close < open). Independent of Polymarket's own resolution.
    - The first time Engine 1 activates (or re-activates after a
      hand-back from Engine 2), it watches candle history for 3
      consecutive same-colored candles: 3 red -> lock onto UP, 3 green
      -> lock onto DOWN.
    - Once locked, it buys ENGINE1_SHARES (500) shares of the locked
      side, taker, immediately on every subsequent window's open --
      it does NOT re-check the streak again, win or lose -- until this
      activation's realized P&L reaches +ENGINE_PROFIT_TARGET_USD ($500).
    - Hitting the target pauses Engine 1 (hands control to Engine 2) and
      clears the lock, so next time it activates it re-arms from a
      fresh 3-in-a-row.

  Engine 2 -- single-candle contrarian (only runs while Engine 1 is
  paused):
    - Every window, looks at just the single most-recently-closed
      candle: green -> buy DOWN next window, red -> buy UP next window
      (a doji candle is skipped -- no signal that window).
      ENGINE2_SHARES (500) shares, taker, on window open.
    - Same rule: fires every window it's active, until this
      activation's realized P&L reaches +ENGINE_PROFIT_TARGET_USD,
      then pauses (hands control back to Engine 1).

  Shared exit mechanics for BOTH engines' entries:
    - A resting take-profit sell at ENGINE_TP_PRICE (0.99) (maker). If
      it fills, realized proceeds are booked as $1.00/share (not the
      literal 0.99 fill price) per explicit instruction -- fee/rebate
      is still computed off the real 0.99 fill price.
    - No stop loss. If the window closes before TP fills, the position
      is NOT force-closed at market -- it settles naturally with the
      binary market's real resolution: $1/share if the position's side
      won that window, $0/share if it lost (no fee on settlement --
      it's a resolution, not a trade).
    - Each engine keeps its own capital pool, and its own realized-P&L
      counter that resets to zero every time it (re)activates.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
# CLOB only -- no Gamma price fallback anywhere in this app. Gamma is
# used purely for one-time window metadata (slug -> token ids) in
# polymarket_client.py; every live price/book read goes to CLOB.
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Candle source (Binance spot, independent of Polymarket) -----------
BINANCE_SYMBOL = os.getenv("BINANCE_SYMBOL", "BTCUSDT")
CANDLE_HISTORY_MAXLEN = 20  # rolling window of recent candle colors kept in memory

# ---- Candle-signal engines: shared exit mechanics ----------------------
ENGINE_TP_PRICE = 0.99          # resting maker sell
ENGINE_TP_COUNTS_AS = 1.00      # TP fill is booked at this price for realized P&L, not 0.99
ENGINE_PROFIT_TARGET_USD = 500.0  # each engine pauses (hands off) after +$500 this activation

# ---- Engine 1: 3-in-a-row continuation ---------------------------------
ENGINE1_STREAK_LEN = 3
ENGINE1_SHARES = 500.0

# ---- Engine 2: single-candle contrarian (only while Engine 1 is paused) -
ENGINE2_SHARES = 500.0

MAKER_REBATE_FRACTION = 0.20  # rebate earned on every resting-order fill (maker side)

# Demo capital: each engine gets its own pool, debited on entry fill,
# credited on TP/settlement. An engine halts permanently if its own
# balance ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Entries are taker orders and pay the fee for real; TP is a resting
# maker order (rebate). Window-close settlement is not a trade -- no fee
# either way. Verify against GET https://clob.polymarket.com/fee-rate?token_id=...
# before trading real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
