"""
Trading engines -- two independent candle-signal engines that trade in
parallel (neither stops the other). See app/config.py for the full
strategy write-up.
"""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


# ---------------------------------------------------------------------------
# Shared capital -- one balance per engine, debited/credited on fills.
# ---------------------------------------------------------------------------

@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)

    def record_equity_point(self, window_slug: Optional[str]):
        self.equity_curve.append({
            "window": window_slug, "ts": time.time(), "balance": round(self.balance, 2),
        })
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    def check_halt(self) -> bool:
        if not self.halted and self.balance < 0:
            self.halted = True
        return self.halted


@dataclass
class Position:
    side: Side
    entry_price: float
    shares: float
    cost: float
    entry_ts: float = 0.0


# ---------------------------------------------------------------------------
# One candle-signal engine (Engine 1 or Engine 2 -- same mechanics, only the
# entry-signal rule differs, via `sticky`).
# ---------------------------------------------------------------------------

@dataclass
class CandleEngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    active: bool = True            # False while sleeping off a hit profit target
    sleep_windows_remaining: int = 0  # counts down to 0 across window rollovers, then resumes
    locked_side: Optional[Side] = None   # engine 1 only: side locked in after a 3-in-a-row
    entry_side_this_window: Optional[Side] = None  # signalled side for the window that just opened
    entered_this_window: bool = False
    position: Optional[Position] = None

    session_pnl: float = 0.0       # resets to 0 every time this engine wakes up from sleep
    total_pnl: float = 0.0         # lifetime, across all sessions
    fills: int = 0
    tp_fills: int = 0
    settled_wins: int = 0
    settled_losses: int = 0
    no_signal_windows: int = 0
    wins: int = 0
    losses: int = 0


class CandleEngine:
    def __init__(self, name: str, label: str, broker: PaperBroker, shares: float, sticky: bool):
        self.name = name
        self.label = label
        self.broker = broker
        self.shares = shares
        self.sticky = sticky  # True = Engine 1 (lock a side, ignore new candles until pause)
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = CandleEngineState()
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def _wake_up(self):
        self.s.active = True
        self.s.sleep_windows_remaining = 0
        self.s.locked_side = None
        self.s.session_pnl = 0.0
        self._log("ENGINE_RESUMED", note=f"{self.label} resumed after sleep -- session P&L reset, target +${config.ENGINE_PROFIT_TARGET_USD:.0f}")

    def _check_sleep(self):
        if self.s.active and self.s.session_pnl >= config.ENGINE_PROFIT_TARGET_USD:
            self.s.active = False
            self.s.sleep_windows_remaining = config.ENGINE_SLEEP_WINDOWS
            self._log("ENGINE_SLEEP",
                       note=(f"{self.label} session P&L +${self.s.session_pnl:.2f} reached target -- "
                             f"sleeping {config.ENGINE_SLEEP_WINDOWS} windows (does not affect the other engine)"))

    # ---- signal: decide (if anything) to buy at the open of the new window -

    def on_new_window(self, window: WindowMarket, candle_history: Deque[str]):
        self.s.window = window
        self.s.entry_side_this_window = None
        self.s.entered_this_window = False

        if self.capital.halted:
            return

        if not self.s.active:
            if self.s.sleep_windows_remaining > 0:
                self.s.sleep_windows_remaining -= 1
                return  # this window is one of the 3 skipped -- no signal, no trade
            self._wake_up()  # remaining already hit 0 -- trade this window as usual below

        if self.sticky:
            if self.s.locked_side is None and len(candle_history) >= config.ENGINE1_STREAK_LEN:
                last_n = list(candle_history)[-config.ENGINE1_STREAK_LEN:]
                if all(c == "red" for c in last_n):
                    self.s.locked_side = Side.UP
                    self._log("ENGINE1_LOCKED", side="UP",
                               note=f"{config.ENGINE1_STREAK_LEN} red candles in a row -- locking onto UP every window")
                elif all(c == "green" for c in last_n):
                    self.s.locked_side = Side.DOWN
                    self._log("ENGINE1_LOCKED", side="DOWN",
                               note=f"{config.ENGINE1_STREAK_LEN} green candles in a row -- locking onto DOWN every window")
            self.s.entry_side_this_window = self.s.locked_side
        else:
            if candle_history:
                last_color = candle_history[-1]
                if last_color == "red":
                    self.s.entry_side_this_window = Side.UP
                elif last_color == "green":
                    self.s.entry_side_this_window = Side.DOWN
                # "doji" (or unknown) -- no signal this window

        if self.s.entry_side_this_window is None:
            self.s.no_signal_windows += 1

    # ---- tick: fire the entry (once, on the first tick with a live ask),
    # then watch for TP -----------------------------------------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, now: float):
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        if self.capital.halted or self.s.window is None:
            return

        if (self.s.active and self.s.entry_side_this_window is not None
                and not self.s.entered_this_window and self.s.position is None):
            ask = up_ask if self.s.entry_side_this_window == Side.UP else down_ask
            if ask is not None:
                self._enter(self.s.entry_side_this_window, ask, now)
                self.s.entered_this_window = True

        self._check_tp()

    def _enter(self, side: Side, ask: float, now: float):
        shares = self.shares
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.capital.balance -= cost
        self.s.fills += 1
        self._log("CANDLE_BUY", side=side.value, price=ask, shares=shares, fee=fee,
                   note=f"{self.label}: taker buy {shares:.0f}sh {side.value} @ {ask} on window open (fee ${fee:.4f})")
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=ask, shares=shares, cost=cost, entry_ts=now)

    def _check_tp(self):
        pos = self.s.position
        if pos is None:
            return
        bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        if bid is None or bid < config.ENGINE_TP_PRICE:
            return
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, config.ENGINE_TP_PRICE)
        proceeds = pos.shares * config.ENGINE_TP_COUNTS_AS + rebate
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, "TP_FILL", fee=rebate,
                      note=(f"{self.label}: TP hit -- {pos.shares:.0f}sh sold @ {config.ENGINE_TP_PRICE} "
                            f"(maker, rebate ${rebate:.4f}), booked @ ${config.ENGINE_TP_COUNTS_AS:.2f}/sh "
                            f"(entry {pos.entry_price}, pnl ${pnl:.4f})"))
        self.s.tp_fills += 1
        self.s.position = None

    def settle_at_window_close(self, winning_side: Optional[Side]):
        """Called once per window close for every engine, active or not --
        an open position must still resolve even if this engine paused
        mid-window. If TP already closed it, there's nothing left to do."""
        pos = self.s.position
        if pos is None:
            return
        if winning_side is None:
            # no observed outcome (e.g. missing book data right at the
            # boundary) -- can't settle; carry the position forward isn't
            # sound either since the market is gone, so mark it a wash at
            # cost (rare edge case, better than silently losing the debit).
            self._settle(pos, pos.cost, 0.0, "SETTLE_UNKNOWN", fee=0.0,
                          note=f"{self.label}: window closed with no observed winner -- settled at cost (no gain/loss)")
        elif pos.side == winning_side:
            proceeds = pos.shares * 1.0
            pnl = proceeds - pos.cost
            self._settle(pos, proceeds, pnl, "SETTLE_WIN", fee=0.0,
                          note=f"{self.label}: window resolved -- {pos.side.value} won, {pos.shares:.0f}sh paid $1.00/sh (pnl ${pnl:.4f})")
            self.s.settled_wins += 1
        else:
            proceeds = 0.0
            pnl = proceeds - pos.cost
            self._settle(pos, proceeds, pnl, "SETTLE_LOSS", fee=0.0,
                          note=f"{self.label}: window resolved -- {pos.side.value} lost, {pos.shares:.0f}sh paid $0.00/sh (pnl ${pnl:.4f})")
            self.s.settled_losses += 1
        self.s.position = None

    def _settle(self, pos: Position, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.session_pnl += pnl
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee, note=note)
        self.capital.check_halt()
        self._check_sleep()

    def record_equity_point(self, window_slug: Optional[str]):
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload --------------------------------------------------

    def snapshot(self) -> dict:
        pos = self.s.position
        position_payload = None
        unrealized_pnl = 0.0
        open_market_value = 0.0
        if pos is not None:
            mark = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
            mark_for_calc = mark if mark is not None else pos.entry_price
            open_market_value = pos.shares * mark_for_calc
            unrealized_pnl = open_market_value - pos.cost
            elapsed = max(0.0, time.time() - pos.entry_ts)
            position_payload = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": round(pos.shares, 2),
                "cost": round(pos.cost, 4), "tp_price": config.ENGINE_TP_PRICE,
                "seconds_since_entry": round(elapsed, 1), "mark_price": mark,
                "unrealized_pnl": round(unrealized_pnl, 4),
            }

        if self.capital.halted:
            status = "halted"
        elif not self.s.active:
            status = "sleeping"
        elif pos is not None:
            status = "open"
        elif self.sticky and self.s.locked_side is None:
            status = "waiting_for_streak"
        elif self.s.entry_side_this_window is not None and not self.s.entered_this_window:
            status = "armed"
        else:
            status = "waiting"

        return {
            "engine": self.name, "label": self.label, "active": self.s.active,
            "sleep_windows_remaining": self.s.sleep_windows_remaining,
            "sticky": self.sticky, "shares": self.shares,

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "session_pnl": round(self.s.session_pnl, 4),
            "total_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "profit_target": config.ENGINE_PROFIT_TARGET_USD,
            "progress_pct": round(100 * max(0.0, self.s.session_pnl) / config.ENGINE_PROFIT_TARGET_USD, 1),

            "locked_side": self.s.locked_side.value if self.s.locked_side else None,
            "entry_side_this_window": self.s.entry_side_this_window.value if self.s.entry_side_this_window else None,
            "position": position_payload,

            "fills": self.s.fills, "tp_fills": self.s.tp_fills,
            "settled_wins": self.s.settled_wins, "settled_losses": self.s.settled_losses,
            "no_signal_windows": self.s.no_signal_windows,
            "wins": self.s.wins, "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,
        }


# ---------------------------------------------------------------------------
# Manager -- runs both engines independently in parallel, keeps the same
# external surface app/state.py already drives (Engine(broker), on_tick,
# reset_for_window, finalize_window, snapshot).
# ---------------------------------------------------------------------------

class Engine:
    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.candle_history: Deque[str] = deque(maxlen=config.CANDLE_HISTORY_MAXLEN)
        self.last_candle: Optional[dict] = None

        self.engine1 = CandleEngine("E1", "Engine 1 (3-in-a-row continuation)", broker,
                                     shares=config.ENGINE1_SHARES, sticky=True)
        self.engine2 = CandleEngine("E2", "Engine 2 (single-candle contrarian)", broker,
                                     shares=config.ENGINE2_SHARES, sticky=False)
        # both start active and trade in parallel from the first window --
        # neither one's state depends on the other.

    def _log(self, engine_name, window_slug, event, **kw):
        self.broker.log_event(engine_name, window_slug, event, **kw)

    # ---- called by state.py right after it fetches the just-closed
    # Binance candle for the window that's ending -----------------------------

    def record_candle(self, candle: Optional[dict]):
        self.last_candle = candle
        if candle is not None:
            self.candle_history.append(candle["color"])

    def reset_for_window(self, window: WindowMarket):
        self.engine1.on_new_window(window, self.candle_history)
        self.engine2.on_new_window(window, self.candle_history)

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None):
        now = now if now is not None else time.time()
        self.engine1.on_tick(up_bid, up_ask, down_bid, down_ask, now)
        self.engine2.on_tick(up_bid, up_ask, down_bid, down_ask, now)

    def finalize_window(self, winning_side: Optional[Side]):
        window_slug = self.engine1.s.window.slug if self.engine1.s.window else (
            self.engine2.s.window.slug if self.engine2.s.window else None)
        self.engine1.settle_at_window_close(winning_side)
        self.engine2.settle_at_window_close(winning_side)
        self.engine1.record_equity_point(window_slug)
        self.engine2.record_equity_point(window_slug)
        self.engine1.s.window = None
        self.engine2.s.window = None

    # ---- dashboard payload --------------------------------------------------

    def snapshot(self) -> dict:
        e1 = self.engine1.snapshot()
        e2 = self.engine2.snapshot()

        # both engines record an equity point every window (in lockstep),
        # so index-pairing them gives a true combined balance curve.
        combined_curve = []
        for i in range(min(len(e1["equity_curve"]), len(e2["equity_curve"]))):
            p1, p2 = e1["equity_curve"][i], e2["equity_curve"][i]
            combined_curve.append({
                "window": p1["window"] or p2["window"], "ts": max(p1["ts"], p2["ts"]),
                "balance": round(p1["balance"] + p2["balance"], 2),
            })

        return {
            "balance": round(e1["balance"] + e2["balance"], 2), "starting_capital": 2 * config.STARTING_CAPITAL,
            "halted": e1["halted"] and e2["halted"],
            "equity_curve": combined_curve,
            "realized_pnl": round(e1["total_pnl"] + e2["total_pnl"], 4),
            "unrealized_pnl": round(e1["unrealized_pnl"] + e2["unrealized_pnl"], 4),

            "candle_history": list(self.candle_history)[-10:],
            "last_candle": self.last_candle,

            "engine1": e1,
            "engine2": e2,
        }
