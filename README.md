# ⚡ ALPHASTRIKE — BTC 5m up/down bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Strategy:
**follow the last window.** Everything is priced and settled off
Polymarket's own CLOB — no external price feed.

## The signal

Whichever side **won the previous window** is bought in the next one:

- previous window UP → buy UP; previous window DOWN → buy DOWN.

**Winner rule:** in the last second of a window, read both sides' CLOB
prices. A side is the winner once its price is **0.95+** (`WIN_PRICE`).
If neither side gets there, the window is undecided and the next window
has no signal. The very first window after startup is watched only —
there's no previous result yet to follow.

## The trade

One order type: a **taker market buy**, on the followed side, sized to
the current base (see below).

1. At least **5 seconds** (`ENTRY_DELAY_SECONDS`) after the window opens,
   buy the base size at market — **whatever the price**, no cap. The fill
   is priced by walking real ask depth and pays the taker fee. If there's
   no ask / no depth at 5s, it keeps checking every tick until the window
   closes; never filling means no trade that window (the base doesn't move).
2. **No exit.** The position is held to the window's close and settled by
   the same 0.95 rule: winner pays **$1/share**, loser **$0**. If the
   window turns out undecided, any open position is closed at the last
   bid instead (real proceeds, not $1/$0) — and this doesn't move the
   ladder, since it isn't a real win or loss.
3. One entry per window.

## Size ladder

One shared base for both sides, starting at **500** shares
(`BASE_SHARES`):

```
500 → 400 → 300 → 200 → 100 → 0   (−100 per win, floor 0)
```

- Every **win** (the followed side matched the window's winner) takes
  100 off the base.
- **Any loss resets the base to 500** — wherever it was on the ladder.
- At **0**, the bot **skips** signals on the side that ran the base down
  (it still watches and records the result, just doesn't trade). The
  **first signal on the opposite side** trades 500 and restarts the base.
- An undecided window, a no-signal window, or a signal that never got
  filled all leave the base exactly where it was.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # all vars optional
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000: the countdown, the previous window's
result (both final prices, which side won), live UP/DOWN books, the
armed entry / open position, the size ladder, a history of recent
windows (followed side, winner, result, P&L, base after), stats, equity
curve and event log.

## Layout

- `app/engine.py` — the strategy: signal handling, the +5s taker entry,
  settlement, the size ladder
- `app/state.py` — runtime loop, window rolling, the last-second CLOB
  winner read, faster polling right at the close
- `app/polymarket_client.py`, `app/paper_broker.py`, `app/models.py` —
  Polymarket CLOB access, fee/log helper, shared types
- `tests/` — `python tests/run_all.py` (no network needed): the ladder
  (including the floor-skip / restart edge cases), the entry timing and
  any-price fill, empty-book retries, settlement (win/loss/undecided),
  and the orchestration with a fake CLOB across several windows

## Config (`app/config.py`, env-overridable)

`ENTRY_DELAY_SECONDS` (5), `BASE_SHARES` (500), `SHARES_STEP` (100),
`WIN_PRICE` (0.95), `STARTING_CAPITAL` ($2000), `POLL_INTERVAL_SECONDS`
(1.0), `CLOSE_PHASE_POLL_SECONDS` (0.25, used in the last 3s of a window
for a tighter winner read).

## Notes / assumptions

- The entry can only fire on a poll tick, so it lands between 5.0s and
  ~6s after open at the default 1s poll interval; lower
  `POLL_INTERVAL_SECONDS` to tighten it.
- "Buys regardless of price" means the bot pays whatever the ask is,
  including 0.95+ — right before the window is likely to resolve that
  side's way.
- The winner read is a single last-second snapshot, not an average —
  matching the "0.95+ in the final second" rule as literally as possible
  given 1s (0.25s near the close) polling.
- Taker fee uses `TAKER_FEE_RATE`/`TAKER_FEE_EXPONENT` in `config.py`;
  verify against Polymarket's fee-rate endpoint before real money.
- This is a fixed rule, not a fitted model: nothing here has been
  backtested. The dashboard's follow-accuracy and win-rate tallies are
  there to measure it as it runs.
