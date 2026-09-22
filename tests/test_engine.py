import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app import config
from app.engine import Engine
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker

T = 1_800_000_000

def mk(prev=None):
    """prev: None (no signal yet) or a Side (previous window's winner)."""
    e = Engine(PaperBroker())
    if prev is not None:
        e.prev = {"slug": "w0", "open_ts": T - 300, "winner": prev, "up": 0.97, "down": 0.03, "age": 0.1}
    w = WindowMarket("w1", None, "u", "d", float(T), float(T + 300))
    e.reset_for_window(w, now=float(T))
    return e

def tick(e, ts, ua, da, ul=None, dl=None, ub=0.30, db=0.30):
    e.on_tick(ub, ua, db, da, now=ts, up_bid_levels=[(ub, 1000)], down_bid_levels=[(db, 1000)],
              up_ask_levels=ul, down_ask_levels=dl)

def ev(e): return [x.event for x in e.broker.log]
def close(e, winner=None, up=None, down=None): e.finalize_window({"winner": winner, "up": up, "down": down, "age": 0.1})

# ---- 0. no resting limit order logic anywhere
assert not hasattr(Engine, "_check_fill") and not hasattr(Engine, "_check_taker")
for name in ("LIMIT_PRICE", "LIMIT_TIMEOUT_SECONDS", "TAKER_MAX_PRICE"):
    assert not hasattr(config, name), name
assert config.ENTRY_DELAY_SECONDS == 5 and config.BASE_SHARES == 500 and config.SHARES_STEP == 100
print("0 ok: no limit-order logic left; ENTRY_DELAY_SECONDS=5, BASE_SHARES=500, SHARES_STEP=100")

# ---- 1. no previous window -> no signal, nothing fires
e = mk(prev=None); assert e.s.plan == "no_signal" and e.snapshot()["status"] == "no_signal"
tick(e, T + 5, 0.45, 0.55); assert e.s.position is None
print("1 ok: no previous window -> no signal, no trade")

# ---- 2. UP won previous window -> follow UP, 500sh, armed but nothing before +5s
e = mk(prev=Side.UP); assert e.s.plan == "trading" and e.s.side == Side.UP and e.s.shares == 500
assert e.snapshot()["status"] == "entry_pending" and e.snapshot()["entry"]["shares"] == 500
tick(e, T + 1, 0.45, 0.55); tick(e, T + 4.9, 0.45, 0.55); assert e.s.position is None
print("2 ok: UP won last window -> armed 500sh UP, nothing before +5s")

# ---- 3. at +5s: taker buy 500sh at market, any price, depth-walked
lv = [(0.62, 200), (0.70, 400)]
tick(e, T + 5.0, 0.62, 0.55, ul=lv)
p = e.s.position
vwap = (200 * 0.62 + 300 * 0.70) / 500
assert p and p.side == Side.UP and p.shares == 500 and abs(p.entry_price - vwap) < 1e-9
fee = e.broker.taker_fee_amount(500, vwap)
assert abs(p.cost - (500 * vwap + fee)) < 1e-9
assert e.total_taker_entries == 1 and e.snapshot()["status"] == "open" and e.snapshot()["entry"] is None
print(f"3 ok: +5s taker 500sh @ {vwap:.4f} (depth-walked, above 0.60), fee ${fee:.3f}")

# ---- 4. buys regardless of price: 0.97 ask and 0.03 ask both get bought
for ask in (0.97, 0.03):
    e = mk(prev=Side.UP); tick(e, T + 5, ask, 1 - ask, ul=[(ask, 1000)])
    assert e.s.position and abs(e.s.position.entry_price - ask) < 1e-9
print("4 ok: buys at any price (0.97 and 0.03)")

# ---- 5. DOWN won previous window -> follows DOWN
e = mk(prev=Side.DOWN); tick(e, T + 5, 0.30, 0.66, dl=[(0.66, 1000)])
assert e.s.position and e.s.position.side == Side.DOWN and abs(e.s.position.entry_price - 0.66) < 1e-9
print("5 ok: DOWN won -> follows DOWN")

# ---- 6. one entry per window: no second buy
e = mk(prev=Side.UP); tick(e, T + 5, 0.50, 0.50); tick(e, T + 100, 0.40, 0.60); tick(e, T + 200, 0.30, 0.70)
assert e.total_taker_entries == 1 and e.s.position.shares == 500
print("6 ok: one entry per window")

# ---- 7. no ask / empty book at +5s: nothing invented, retries, logs once, buys when depth appears
e = mk(prev=Side.UP)
tick(e, T + 5, None, 0.5, ul=[]); tick(e, T + 6, None, 0.5, ul=[]); tick(e, T + 7, 0.50, 0.5, ul=[])
assert e.s.position is None and e.total_illiquid_skips == 1 and ev(e).count("NO_LIQUIDITY") == 1
tick(e, T + 8, 0.55, 0.45, ul=[(0.55, 1000)])
assert e.s.position and e.s.position.entry_price == 0.55 and e.s.position.shares == 500
print("7 ok: empty book -> retries, no fake fill, buys when depth returns")

# ---- 8. never any depth -> ENTRY_MISSED at close, base unchanged, no fill result
e = mk(prev=Side.UP); tick(e, T + 5, None, None, ul=[]); tick(e, T + 200, None, None, ul=[])
close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.total_no_fills == 1 and "ENTRY_MISSED" in ev(e) and e.capital.balance == config.STARTING_CAPITAL
assert e.base == 500 and e.history[0]["result"] == "no fill (empty book)"
print("8 ok: no depth all window -> no trade, base untouched, balance untouched")

# ---- 9. no entry at/after the window close
e = mk(prev=Side.UP); tick(e, T + 300, 0.50, 0.50); assert e.s.position is None
print("9 ok: nothing fires at/after the window close")

# ---- 10. settlement: win pays $1/share, loss pays $0 -- and the ladder moves
e = mk(prev=Side.UP); tick(e, T + 5, 0.40, 0.60, ul=[(0.40, 1000)]); cost = e.s.position.cost
close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.wins == 1 and e.base == 400 and abs(e.total_pnl - (500 * 1.0 - cost)) < 1e-9
e2 = mk(prev=Side.DOWN); tick(e2, T + 5, 0.40, 0.60, ul=[(0.40, 1000)]); cost2 = e2.s.position.cost
close(e2, winner=Side.UP, up=0.97, down=0.03)          # followed DOWN, UP won -> loss
assert e2.losses == 1 and e2.base == 500 and abs(e2.total_pnl - (0 - cost2)) < 1e-9
print("10 ok: win -> $1/share, base -100; loss -> $0/share, base reset to 500")

# ---- 11. undecided close (neither side 0.95+): no ladder move, open position exits at last bid
e = mk(prev=Side.UP); tick(e, T + 5, 0.40, 0.60, ul=[(0.40, 1000)])
tick(e, T + 250, 0.55, 0.60, ub=0.55)
close(e, winner=None, up=0.55, down=0.45)
assert e.total_undecided == 1 and e.wins == 0 and e.losses == 0 and e.base == 500     # undecided doesn't move the ladder
assert "no signal" not in ev(e) and e.history[0]["winner"] is None
print("11 ok: undecided window -> position exits at last bid, ladder untouched")

def next_window(prev_open_ts):
    ot = prev_open_ts + 300
    return WindowMarket(f"w{int(ot)}", None, "u", "d", float(ot), float(ot + 300)), ot

# ---- 12. the ladder: 500 -> 400 -> 300 -> 200 -> 100 -> 0, then same-side signals are skipped
e = mk(prev=Side.UP); ot = T
for expected in (500, 400, 300, 200, 100):
    assert e.s.plan == "trading" and e.s.shares == expected, (e.s.shares, expected)
    tick(e, ot + 5, 0.40, 0.60, ul=[(0.40, 1000)])
    close(e, winner=Side.UP, up=0.97, down=0.03)
    w, ot = next_window(ot)
    e.reset_for_window(w, now=float(ot))
assert e.base == 0 and e.floor_side == Side.UP
assert e.s.plan == "floor_skip" and e.s.plan_note.startswith("base is 0")
tick(e, ot + 5, 0.40, 0.60); tick(e, ot + 200, 0.30, 0.70)
assert e.s.position is None and e.total_floor_skips == 1
close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.base == 0                                    # still skipped -> ladder doesn't move
print("12 ok: 500->400->300->200->100->0, then UP signals skipped at the floor")

# ---- 13. first opposite-direction signal after the floor: trades 500, restarts the base
w, ot = next_window(ot); e.reset_for_window(w, now=float(ot))
e.prev = {"slug": "wx", "open_ts": ot, "winner": Side.DOWN, "up": 0.03, "down": 0.97, "age": 0.1}
w, ot = next_window(ot); e.reset_for_window(w, now=float(ot))
assert e.s.plan == "trading" and e.s.side == Side.DOWN and e.s.shares == 500
assert "BASE_RESTART" in ev(e)
tick(e, ot + 5, 0.60, 0.40, dl=[(0.40, 1000)])
assert e.s.position and e.s.position.shares == 500
print("13 ok: opposite signal after the floor -> 500sh, base restarted")

# ---- 14. any loss (even mid-ladder) resets the base to 500
e = mk(prev=Side.UP); ot = T; tick(e, ot + 5, 0.40, 0.60, ul=[(0.40, 1000)])
close(e, winner=Side.UP, up=0.97, down=0.03); assert e.base == 400          # one win
w, ot = next_window(ot); e.reset_for_window(w, now=float(ot))
tick(e, ot + 5, 0.40, 0.60, ul=[(0.40, 1000)])
close(e, winner=Side.DOWN, up=0.03, down=0.97)                              # followed UP, DOWN won -> loss
assert e.base == 500 and e.floor_side is None
print("14 ok: a loss mid-ladder resets the base to 500")

# ---- 15. no signal / floor-skip / no-fill windows never move the base
e = mk(prev=None); tick(e, T + 5, 0.4, 0.6); close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.base == 500 and e.wins == 0 and e.losses == 0
print("15 ok: no-signal window doesn't move the base")

# ---- 16. missed a window (gap) -> no signal even though prev exists
e = Engine(PaperBroker())
e.prev = {"slug": "w0", "open_ts": T - 900, "winner": Side.UP, "up": 0.97, "down": 0.03, "age": 0.1}  # 3 windows back
w = WindowMarket("w1", None, "u", "d", float(T), float(T + 300))
e.reset_for_window(w, now=float(T))
assert e.s.plan == "no_signal" and "missed a window" in e.s.plan_note
print("16 ok: gap in windows -> no signal")

# ---- 17. JSON snapshot + history rows
e = mk(prev=Side.UP); tick(e, T + 5, 0.40, 0.60, ul=[(0.40, 1000)])
snap = e.snapshot(); json.dumps(snap)
assert snap["position"]["side"] == "UP" and snap["def"] == {"entry_delay_s": 5, "base_shares": 500, "step": 100, "win_price": 0.95}
close(e, winner=Side.UP, up=0.97, down=0.03)
h = e.history[0]; assert h["followed"] == "UP" and h["winner"] == "UP" and h["base_after"] == 400
print("17 ok: JSON snapshot + history row")
print("ALL PASSED")
