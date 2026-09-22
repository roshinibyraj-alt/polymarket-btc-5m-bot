"""
ALPHASTRIKE trading engine -- "follow the last window".

Signal : the side that won the PREVIOUS window (winner = the side priced 0.95+ in the last
         second of that window, read from the CLOB -- see state.py) is traded in the next one.

Entry  : on the traded side, size = current base. ONE order type, a taker market buy: at least
         ENTRY_DELAY_SECONDS (5s) after the window opens, buy the current base size at market,
         whatever the price -- no price cap, no resting limit order. Depth-walked fill, taker
         fee. If there is no ask / no depth at 5s, retries every tick until the window closes;
         never filling means no trade that window.
Exit   : none. Held to the window end and settled by the 0.95 rule: winner $1/share, loser $0.

Size   : ONE shared base, starts at BASE_SHARES (500). Each win -SHARES_STEP (100), floor 0. Any
         loss resets to 500. At 0, same-direction signals are skipped; the first opposite-direction
         signal trades 500 and restarts the base. Windows with no trade (skipped, no signal, never
         filled) change nothing.
"""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
    """Volume-weighted average price to actually trade `shares` against a real order book,
    instead of assuming the whole size fills at the single best quote.

    - levels is None -> no depth data this tick; fall back to filling the whole size at
      `fallback_price`.
    - levels is [] -> book fetched fine, genuinely nothing resting on this side; return None,
      the caller must not invent a fill.
    - levels is non-empty -> walk best-price-first; any shortfall in visible depth is priced at
      the worst level seen.
    """
    if levels is None:
        return fallback_price
    if not levels:
        return None
    remaining = shares
    cost = 0.0
    worst_price = levels[-1][0]
    for price, size in levels:
        if remaining <= 1e-9:
            break
        take = min(remaining, size) if size and size > 0 else 0.0
        if take <= 0:
            continue
        cost += take * price
        remaining -= take
    if remaining > 1e-9:
        cost += remaining * worst_price
    return cost / shares


@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: list = field(default_factory=list)

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
    entry_ts: float


@dataclass
class EngineState:
    """Per-window transient state -- fully replaced by reset_for_window() at the start of every
    window. The size ladder and cumulative stats live on the Engine so they survive windows."""
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    # plan: no_signal (nothing to follow) | floor_skip (base is 0 and the signal is the same side
    # as the streak that emptied it) | trading | halted
    plan: str = "no_signal"
    plan_note: str = ""
    side: Optional[Side] = None      # the side being followed this window (also set for floor_skip)
    shares: float = 0.0              # size for this window (the base at window open)
    entered: bool = False            # the window's single entry has happened
    entry_wait_logged: bool = False  # so the "no ask / no depth" note logs once, not every tick
    position: Optional[Position] = None
    window_pnl: float = 0.0


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)
        self.history = deque(maxlen=30)      # one row per finished window, for the dashboard

        # ---- size ladder (shared across both sides) -------------------------
        self.base: int = config.BASE_SHARES
        self.floor_side: Optional[Side] = None   # side of the winning streak that emptied the base

        # ---- last finished window: the signal for the next one -----------------
        self.prev: Optional[dict] = None         # {slug, open_ts, winner: Side|None, up, down, age}

        # ---- cumulative stats -------------------------------------------------
        self.total_taker_entries = 0
        self.total_no_fills = 0              # armed, but never filled (no ask / no depth all window)
        self.total_floor_skips = 0
        self.total_no_signal = 0
        self.total_undecided = 0             # finished windows where neither side was 0.95+
        self.total_illiquid_skips = 0
        self.follow_right = 0                # windows with a followed side where it won...
        self.follow_wrong = 0                # ...and where it lost (traded or not)
        self.total_pnl = 0.0
        self.wins = 0
        self.losses = 0

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    # ---- window lifecycle --------------------------------------------------------

    def reset_for_window(self, window: WindowMarket, now: Optional[float] = None):
        """A new window has opened: decide what to follow."""
        now = now if now is not None else time.time()
        self.s = EngineState(window=window)
        if self.capital.halted:
            self.s.plan = "halted"
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        prev = self.prev
        if prev is None:
            return self._no_signal("no previous window observed yet -- watching this one to read its result")
        if window.open_ts - prev["open_ts"] != config.WINDOW_SECONDS:
            return self._no_signal("missed a window (no consecutive previous result) -- no signal")
        if prev["winner"] is None:
            return self._no_signal("previous window undecided (no side at "
                                   f"{config.WIN_PRICE:.2f}+ in its last second) -- no signal")

        side: Side = prev["winner"]
        self.s.side = side

        if self.base <= 0:
            if side == self.floor_side:
                self.s.plan = "floor_skip"
                self.s.plan_note = f"base is 0 -- skipping {side.value} signals until {side.other().value} wins"
                self.total_floor_skips += 1
                self._log("SKIP_BASE_ZERO", side=side.value, note=self.s.plan_note)
                return
            self.base = config.BASE_SHARES
            self.floor_side = None
            self._log("BASE_RESTART", side=side.value,
                       note=f"{side.value} signal after the {side.other().value} run emptied the base -- base back to {self.base}")

        self.s.plan = "trading"
        self.s.shares = float(self.base)
        self._log("SIGNAL", side=side.value,
                   note=(f"previous window {side.value} won (UP {_fmt(prev['up'])} / DOWN {_fmt(prev['down'])}) "
                         f"-> follow {side.value}, {self.s.shares:.0f}sh. Taker buy at market, "
                         f"{config.ENTRY_DELAY_SECONDS:g}s after this window opens, any price"))

    def _no_signal(self, why: str):
        self.s.plan = "no_signal"
        self.s.plan_note = why
        self.total_no_signal += 1
        self._log("NO_TRADE", note=why)

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, now: Optional[float] = None,
                up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None,
                down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels, self.s.up_ask_levels = up_bid_levels, up_ask_levels
        self.s.down_bid_levels, self.s.down_ask_levels = down_bid_levels, down_ask_levels

        if self.s.position is not None or self.s.entered:
            return                                   # no exits: held to the window end
        if self._entry_due(now):
            self._try_entry(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    # ---- entry: one taker market buy, ENTRY_DELAY_SECONDS after open ---------

    def _entry_due(self, now: float) -> bool:
        s = self.s
        if s.plan != "trading" or s.entered or s.side is None:
            return False
        w = s.window
        return w.open_ts + config.ENTRY_DELAY_SECONDS <= now < w.close_ts

    def _try_entry(self, now: float):
        """Buy the window's size at market on the followed side -- no price cap. The fill is
        priced by walking real ask depth for the full size and pays the taker fee. With no ask or
        an empty book, nothing is invented: it retries on the next tick until the window closes."""
        side, shares = self.s.side, self.s.shares
        ask = self._ask_for(side)
        fill_price = _realistic_fill_price(self._ask_levels_for(side), shares, ask)
        if fill_price is None:
            if not self.s.entry_wait_logged:
                self.s.entry_wait_logged = True
                self.total_illiquid_skips += 1
                self._log("NO_LIQUIDITY", side=side.value, price=ask,
                           note=f"entry due but {side.value} has no ask / zero ask depth -- retrying every tick until window close")
            return
        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.s.entered = True
        self.total_taker_entries += 1
        self._log("TAKER_ENTRY", side=side.value, price=fill_price, shares=shares, fee=fee,
                   note=(f"taker buy filled @ {fill_price:.4f} (best ask {ask}), {shares:.0f}sh, "
                         f"fee ${fee:.4f}, total cost ${cost:.4f}, {now - self.s.window.open_ts:.1f}s after window open"))
        self.capital.balance -= cost
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=fill_price, shares=shares, cost=cost, entry_ts=now)

    # ---- window close: settle, update the ladder, remember the result --------------

    def finalize_window(self, result: dict):
        """`result` comes from state.py: {winner: Side|None, up, down, age, reason}. Settles any
        open position, moves the size ladder, and stores this window's result as the next
        window's signal."""
        if self.s.window is None:
            return
        window = self.s.window
        winner: Optional[Side] = result.get("winner")
        self.prev = {"slug": window.slug, "open_ts": window.open_ts, "winner": winner,
                     "up": result.get("up"), "down": result.get("down"), "age": result.get("age")}
        if winner is None:
            self.total_undecided += 1

        # Did following the previous window pay off this time? (counted whether or not we traded)
        if self.s.side is not None and winner is not None:
            if self.s.side == winner:
                self.follow_right += 1
            else:
                self.follow_wrong += 1

        result_txt = {"no_signal": "no signal", "floor_skip": f"skipped (base 0, {self.s.side.value if self.s.side else ''})",
                      "halted": "halted"}.get(self.s.plan)
        traded = False
        if self.s.position is not None:
            traded = True
            pos = self.s.position
            if winner is not None:
                won = pos.side == winner
                proceeds = pos.shares * (1.0 if won else 0.0)
                how = (f"window resolved {winner.value} (UP {_fmt(result.get('up'))} / DOWN {_fmt(result.get('down'))}): "
                       f"{pos.side.value} {'WON, pays $1/share' if won else 'LOST, worth $0'}")
            else:
                # undecided: nothing to redeem -- get out at the last bid as a taker. This isn't a
                # real win/loss against the 0.95 rule, so it doesn't move the size ladder.
                bid = self._bid_for(pos.side)
                fill_price = _realistic_fill_price(self._bid_levels_for(pos.side), pos.shares, bid)
                if fill_price is None:
                    fill_price = 0.0
                fee = self.broker.taker_fee_amount(pos.shares, fill_price)
                proceeds = pos.shares * fill_price - fee
                how = f"window undecided -- closed at the last bid {fill_price:.4f} (fee ${fee:.4f})"
            pnl = proceeds - pos.cost
            self.capital.balance += proceeds
            self.total_pnl += pnl
            self.s.window_pnl = pnl
            self.capital.check_halt()
            if winner is not None:
                self._log("SETTLED_WIN" if won else "SETTLED_LOSS", side=pos.side.value, price=pos.entry_price,
                           shares=pos.shares, pnl=pnl,
                           note=f"{how} (entry {pos.entry_price:.4f}, cost ${pos.cost:.2f}, pnl ${pnl:.2f})")
                self._update_ladder(won, pos.side)
                result_txt = "won (taker)" if won else "lost (taker)"
            else:
                self._log("SETTLED_UNDECIDED", side=pos.side.value, price=pos.entry_price,
                           shares=pos.shares, pnl=pnl,
                           note=f"{how} (entry {pos.entry_price:.4f}, cost ${pos.cost:.2f}, pnl ${pnl:.2f}) -- base unchanged")
                result_txt = "undecided (closed at market)"
            self.s.position = None
        elif self.s.plan == "trading" and not self.capital.halted:
            self.total_no_fills += 1
            self._log("ENTRY_MISSED", side=self.s.side.value,
                       note="window closed without a fill: no ask / no depth on the followed side "
                            f"any time after {config.ENTRY_DELAY_SECONDS:g}s -- no trade, base stays {self.base}")
            result_txt = "no fill (empty book)"

        self.history.appendleft({
            "slug": window.slug, "open_ts": window.open_ts,
            "followed": self.s.side.value if self.s.side else None,
            "winner": winner.value if winner else None,
            "up": result.get("up"), "down": result.get("down"),
            "shares": self.s.shares if traded else None,
            "result": result_txt or "—", "pnl": round(self.s.window_pnl, 2) if traded else None,
            "base_after": self.base,
        })
        self.s.window = None
        self.capital.record_equity_point(window.slug)

    def _update_ladder(self, won: bool, side: Side):
        before = self.base
        if won:
            self.wins += 1
            self.base = max(0, self.base - config.SHARES_STEP)
            if self.base == 0:
                self.floor_side = side
            note = f"win -> base {before} -> {self.base}" + (
                f" (floor: skipping {side.value} signals until {side.other().value} wins)" if self.base == 0 else "")
        else:
            self.losses += 1
            self.base = config.BASE_SHARES
            self.floor_side = None
            note = f"loss -> base reset {before} -> {self.base}"
        self._log("LADDER", side=side.value, note=note)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        now = time.time()
        s = self.s
        pos = s.position
        pos_payload = None
        open_market_value = 0.0
        unrealized = 0.0
        if pos is not None:
            bid = self._bid_for(pos.side)
            mark = bid if bid is not None else pos.entry_price
            open_market_value = pos.shares * mark
            unrealized = open_market_value - pos.cost
            pos_payload = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": pos.shares,
                "cost": round(pos.cost, 4), "mark_price": mark, "unrealized_pnl": round(unrealized, 4),
                "seconds_since_entry": round(now - pos.entry_ts, 1),
                "payout_if_win": round(pos.shares - pos.cost, 4), "loss_if_lose": round(-pos.cost, 4),
            }

        # Armed and waiting to fire (the 5s delay, or an empty book): what the bot is about to buy.
        entry_payload = None
        w = s.window
        if (w is not None and not self.capital.halted and s.plan == "trading"
                and not s.entered and s.side is not None):
            entry_payload = {
                "side": s.side.value, "shares": s.shares,
                "fires_in": round(max(0.0, w.open_ts + config.ENTRY_DELAY_SECONDS - now), 1),
                "ask": self._ask_for(s.side),
            }

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif entry_payload is not None:
            status = "entry_pending"
        elif s.plan == "floor_skip":
            status = "floor_skip"
        elif s.plan == "no_signal":
            status = "no_signal"
        else:
            status = "done"

        prev = self.prev
        prev_payload = None
        if prev is not None:
            prev_payload = {"slug": prev["slug"], "winner": prev["winner"].value if prev["winner"] else None,
                            "up": prev["up"], "down": prev["down"], "age": prev["age"]}

        win_rate = round(100 * self.wins / (self.wins + self.losses), 1) if (self.wins + self.losses) else None
        judged = self.follow_right + self.follow_wrong
        follow_acc = round(100 * self.follow_right / judged, 1) if judged else None
        steps_taken = (config.BASE_SHARES - self.base) // config.SHARES_STEP if config.SHARES_STEP else 0

        return {
            "engine": "BOT", "label": "ALPHASTRIKE",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": round(self.total_pnl, 4),
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(s.window_pnl, 4),

            "status": status,
            "plan": s.plan, "plan_note": s.plan_note,
            "side": s.side.value if s.side else None,
            "window_shares": s.shares,
            "entry": entry_payload, "position": pos_payload,

            "prev": prev_payload,
            "sizing": {
                "base": self.base, "start": config.BASE_SHARES, "step": config.SHARES_STEP,
                "wins_in_run": steps_taken,
                "floor_side": self.floor_side.value if self.floor_side else None,
            },
            "history": list(self.history),

            "total_taker_entries": self.total_taker_entries,
            "total_no_fills": self.total_no_fills,
            "total_floor_skips": self.total_floor_skips,
            "total_no_signal": self.total_no_signal,
            "total_undecided": self.total_undecided,
            "total_illiquid_skips": self.total_illiquid_skips,
            "follow_right": self.follow_right, "follow_wrong": self.follow_wrong, "follow_accuracy": follow_acc,
            "wins": self.wins, "losses": self.losses, "win_rate": win_rate,

            "def": {
                "entry_delay_s": config.ENTRY_DELAY_SECONDS, "base_shares": config.BASE_SHARES,
                "step": config.SHARES_STEP, "win_price": config.WIN_PRICE,
            },
        }


def _fmt(v) -> str:
    return "—" if v is None else f"{v:.3f}"
