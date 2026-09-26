"""
Central configuration for the BTC 5-min up/down bot.

16-candle imbalance mean-reversion engine:
  - Candle = the real BTC/USDT 5-min spot candle (Binance klines) for
    the window that just closed, colored green (close > open) or red
    (close < open). Independent of Polymarket's own resolution.
  - At startup, immediately backfills the last IMBALANCE_WINDOW (16)
    closed Binance candles -- no waiting around for 16 windows to pass
    organically before the bot can trade.
  - Every time a new candle closes (i.e. every window rollover), counts
    reds vs greens across the most recent IMBALANCE_WINDOW (16) candles
    (recalculated fresh each time -- oldest drops off, newest comes in).
  - If reds - greens >= IMBALANCE_THRESHOLD (2): green is "lacking" ->
    lock onto UP. If greens - reds >= IMBALANCE_THRESHOLD: red is
    "lacking" -> lock onto DOWN. Otherwise (gap is 0 or 1 either way):
    no signal, no trade that window.
  - Once locked onto a side, it keeps trading that side every window --
    ignoring what the rolling-16 recompute says in the meantime, since
    that number can shrink just from an old candle aging out of the
    window with no real reversal -- until a candle of the lacking color
    actually closes. That unlocks it, and the signal is re-evaluated
    from scratch (may immediately re-lock, flip sides, or go flat).
  - Sizing: each settled win reduces the next trade by ENGINE2_SIZE_STEP
    (100) shares, but never below ENGINE2_MIN_SHARES (500). Each settled
    loss adds 100 shares, up to ENGINE2_MAX_ADDITIONS (7) additions above
    the 500-share base, for a maximum of 1,200 shares. Unfilled and
    unresolved windows do not change the size. Taker, on window open.
  - Runs continuously -- no profit-target pause/sleep of any kind.

  Exit mechanics:
    - A resting take-profit sell at ENGINE_TP_PRICE (0.99) (maker). If
      it fills, realized proceeds are booked as $1.00/share (not the
      literal 0.99 fill price) per explicit instruction -- fee/rebate
      is still computed off the real 0.99 fill price.
    - No stop loss. If the window closes before TP fills, the position
      is NOT force-closed at market -- it settles naturally with the
      binary market's real resolution: $1/share if the position's side
      won that window, $0/share if it lost (no fee on settlement --
      it's a resolution, not a trade).

  Dashboard also tracks running peak equity and maximum drawdown from
  that peak (in $ and %), using live mark-to-market equity (balance +
  open position's current market value) so intra-window swings count.
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

# ---- Imbalance signal ---------------------------------------------------
IMBALANCE_WINDOW = 10      # how many recent candles to count reds/greens over
IMBALANCE_THRESHOLD = 2    # minimum gap (reds - greens or greens - reds) to trigger a buy

# ---- Take profit (shared exit mechanic) --------------------------------
ENGINE_TP_PRICE = 0.99          # resting maker sell
ENGINE_TP_COUNTS_AS = 1.00      # TP fill is booked at this price for realized P&L, not 0.99

# ---- Engine sizing -------------------------------------------------------
ENGINE2_SHARES = 500.0           # base size, used at the moment a side locks in
ENGINE2_SIZE_STEP = 100.0        # shares added/removed per +1/-1 move in the gap since lock
ENGINE2_MAX_ADDITIONS = 7        # seven loss additions (base + 7*step = 1200sh max)
ENGINE2_MIN_SHARES = 500.0       # wins reduce only to the 500-share base floor

MAKER_REBATE_FRACTION = 0.20  # rebate earned on every resting-order fill (maker side)

# Demo capital: debited on entry fill, credited on TP/settlement. The
# engine halts permanently if balance ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "10000"))

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
