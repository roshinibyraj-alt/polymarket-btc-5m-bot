"""
Trading engine -- 16-candle imbalance mean-reversion. See app/config.py
for the full strategy write-up.
"""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


# ---------------------------------------------------------------------------
# Capital -- balance, equity curve, and running peak / max-drawdown tracking.
# ---------------------------------------------------------------------------

@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)

    peak_equity: float = 0.0
    max_drawdown: float = 0.0       # largest $ drop from a peak, ever observed
    max_drawdown_pct: float = 0.0   # that drop as a % of the peak it fell from

    def __post_init__(self):
        self.peak_equity = self.balance

    def record_equity_point(self, window_slug: Optional[str]):
        self.equity_curve.append({
            "window": window_slug, "ts": time.time(), "balance": round(self.balance, 2),
        })
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    def update_drawdown(self, equity: float):
        """Call on every live equity read (balance + open position's
        current market value) so intra-window swings count, not just the
        balance at settlement."""
        if equity > self.peak_equity:
            self.peak_equity = equity
        drawdown = self.peak_equity - equity
        if drawdown > self.max_drawdown:
            self.max_drawdown = drawdown
            self.max_drawdown_pct = (drawdown / self.peak_equity * 100) if self.peak_equity else 0.0

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
# Engine state
# ---------------------------------------------------------------------------

@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    entry_side_this_window: Optional[Side] = None  # signalled side for the window that just opened
    reds_this_signal: int = 0
    greens_this_signal: int = 0
    entered_this_window: bool = False
    position: Optional[Position] = None

    locked_side: Optional[Side] = None       # side currently being traded every window
    required_color: Optional[str] = None     # the lacking color we're waiting to see, to unlock
    current_shares: float = config.ENGINE2_SHARES  # next trade size, adjusted after wins/losses

    total_pnl: float = 0.0
    fills: int = 0
    tp_fills: int = 0
    settled_wins: int = 0
    settled_losses: int = 0
    no_signal_windows: int = 0
    wins: int = 0
    losses: int = 0


class Engine:
    """16-candle imbalance mean-reversion engine: recomputes reds vs
    greens across the most recent 10 closed Binance candles; a gap of
    >=2 locks onto the lacking color's side (taker, every window's
    open) and keeps trading that side -- ignoring the recomputed gap
    for lock/unlock purposes in the meantime -- until a candle of the
    lacking color actually closes, at which point it unlocks and
    re-evaluates from scratch. Position size changes only after a
    settled trade: wins subtract 100sh down to 500sh, losses add 100sh
    up to 1200sh (seven additions). Resting TP at 0.99 (booked as
    $1/share); otherwise rides to the window's real $0/$1 settlement.
    Runs continuously -- no profit-target pause."""

    name = "E2"
    label = "10-candle imbalance"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.shares = config.ENGINE2_SHARES
        self.candle_history: Deque[str] = deque(maxlen=config.CANDLE_HISTORY_MAXLEN)
        self.last_candle: Optional[dict] = None
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    # ---- candle bookkeeping --------------------------------------------------

    def seed_history(self, candles: List[dict]):
        """Called once at startup with the last IMBALANCE_WINDOW closed
        Binance candles, so the bot can trade immediately instead of
        waiting 10 windows to accumulate history organically."""
        for c in candles:
            self.candle_history.append(c["color"])
        if candles:
            self.last_candle = candles[-1]
        reds = list(self.candle_history).count("red")
        greens = list(self.candle_history).count("green")
        self._log("HISTORY_SEEDED",
                   note=f"backfilled {len(candles)} closed candles ({reds} red, {greens} green) -- ready to trade immediately")

    def record_candle(self, candle: Optional[dict]):
        self.last_candle = candle
        if candle is not None:
            self.candle_history.append(candle["color"])

    # ---- signal: decide (if anything) to buy at the open of the new window -

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.entry_side_this_window = None
        self.s.entered_this_window = False

        if self.capital.halted:
            return

        last_n = list(self.candle_history)[-config.IMBALANCE_WINDOW:]
        reds = last_n.count("red")
        greens = last_n.count("green")
        self.s.reds_this_signal = reds
        self.s.greens_this_signal = greens

        if self.s.locked_side is not None:
            # Once locked onto a side, keep trading it every window
            # regardless of what the recomputed rolling-16 gap says (that
            # gap can shrink just because an old candle ages out, with no
            # real reversal) -- only unlock once the candle that just
            # closed is actually the color we're waiting to see.
            just_closed = self.candle_history[-1] if self.candle_history else None
            if just_closed == self.s.required_color:
                self._log("IMBALANCE_UNLOCK",
                           note=(f"a {self.s.required_color} candle finally closed -- unlocking "
                                 f"{self.s.locked_side.value}, re-evaluating from scratch"))
                self.s.locked_side = None
                self.s.required_color = None
                # fall through to a fresh evaluation below, same window
            else:
                self.s.entry_side_this_window = self.s.locked_side
                return

        if len(last_n) < config.IMBALANCE_WINDOW:
            self.s.no_signal_windows += 1
            return  # only possible right at startup if Binance backfill came up short

        if reds - greens >= config.IMBALANCE_THRESHOLD:
            self.s.locked_side = Side.UP
            self.s.required_color = "green"
            self.s.entry_side_this_window = Side.UP
            self._log("IMBALANCE_SIGNAL", side="UP",
                       note=(f"last {config.IMBALANCE_WINDOW} candles: {reds} red / {greens} green -- green lacking, "
                             f"locking onto UP until a green candle closes ({self.s.current_shares:.0f}sh)"))
        elif greens - reds >= config.IMBALANCE_THRESHOLD:
            self.s.locked_side = Side.DOWN
            self.s.required_color = "red"
            self.s.entry_side_this_window = Side.DOWN
            self._log("IMBALANCE_SIGNAL", side="DOWN",
                       note=(f"last {config.IMBALANCE_WINDOW} candles: {reds} red / {greens} green -- red lacking, "
                             f"locking onto DOWN until a red candle closes ({self.s.current_shares:.0f}sh)"))
        else:
            self.s.no_signal_windows += 1

    # ---- tick: fire the entry (once, on the first tick with a live ask),
    # watch for TP, and track live equity for max-drawdown -------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None):
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        if self.capital.halted or self.s.window is None:
            return

        if (self.s.entry_side_this_window is not None
                and not self.s.entered_this_window and self.s.position is None):
            ask = up_ask if self.s.entry_side_this_window == Side.UP else down_ask
            if ask is not None:
                self._enter(self.s.entry_side_this_window, ask, now)
                self.s.entered_this_window = True

        self._check_tp()
        self.capital.update_drawdown(self._live_equity())

    def _live_equity(self) -> float:
        pos = self.s.position
        if pos is None:
            return self.capital.balance
        mark = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        mark = mark if mark is not None else pos.entry_price
        return self.capital.balance + pos.shares * mark

    def _enter(self, side: Side, ask: float, now: float):
        shares = self.s.current_shares
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.capital.balance -= cost
        self.s.fills += 1
        self._log("CANDLE_BUY", side=side.value, price=ask, shares=shares, fee=fee,
                   note=f"taker buy {shares:.0f}sh {side.value} @ {ask} on window open (fee ${fee:.4f})")
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
                      note=(f"TP hit -- {pos.shares:.0f}sh sold @ {config.ENGINE_TP_PRICE} "
                            f"(maker, rebate ${rebate:.4f}), booked @ ${config.ENGINE_TP_COUNTS_AS:.2f}/sh "
                            f"(entry {pos.entry_price}, pnl ${pnl:.4f})"))
        self.s.tp_fills += 1
        self.s.position = None

    def finalize_window(self, winning_side: Optional[Side]):
        """Called once per window close -- an open position must still
        resolve. If TP already closed it, there's nothing left to do."""
        window_slug = self.s.window.slug if self.s.window else None
        pos = self.s.position
        if pos is not None:
            if winning_side is None:
                # no observed outcome (e.g. missing book data right at the
                # boundary) -- settle at cost rather than silently losing
                # the debit or guessing a winner.
                self._settle(pos, pos.cost, 0.0, "SETTLE_UNKNOWN", fee=0.0,
                              note="window closed with no observed winner -- settled at cost (no gain/loss)")
            elif pos.side == winning_side:
                proceeds = pos.shares * 1.0
                pnl = proceeds - pos.cost
                self._settle(pos, proceeds, pnl, "SETTLE_WIN", fee=0.0,
                              note=f"window resolved -- {pos.side.value} won, {pos.shares:.0f}sh paid $1.00/sh (pnl ${pnl:.4f})")
                self.s.settled_wins += 1
            else:
                pnl = 0.0 - pos.cost
                self._settle(pos, 0.0, pnl, "SETTLE_LOSS", fee=0.0,
                              note=f"window resolved -- {pos.side.value} lost, {pos.shares:.0f}sh paid $0.00/sh (pnl ${pnl:.4f})")
                self.s.settled_losses += 1
            self.s.position = None

        self.capital.update_drawdown(self._live_equity())
        self.capital.record_equity_point(window_slug)
        self.s.window = None

    def _settle(self, pos: Position, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee, note=note)
        self.capital.check_halt()
        self.capital.update_drawdown(self._live_equity())

        if reason in ("SETTLE_WIN", "TP_FILL"):
            self._adjust_size(is_win=True)
        elif reason == "SETTLE_LOSS":
            self._adjust_size(is_win=False)

    def _adjust_size(self, is_win: bool):
        """Move the next trade size one 100-share step after settlement."""
        old_size = self.s.current_shares
        if is_win:
            self.s.current_shares = max(
                config.ENGINE2_MIN_SHARES,
                self.s.current_shares - config.ENGINE2_SIZE_STEP,
            )
        else:
            max_size = config.ENGINE2_SHARES + (
                config.ENGINE2_MAX_ADDITIONS * config.ENGINE2_SIZE_STEP
            )
            self.s.current_shares = min(
                max_size,
                self.s.current_shares + config.ENGINE2_SIZE_STEP,
            )
        if self.s.current_shares != old_size:
            self._log(
                "SIZE_ADJUST",
                side=self.s.entry_side_this_window.value if self.s.entry_side_this_window else None,
                shares=self.s.current_shares,
                note=(f"{'win' if is_win else 'loss'}: next size "
                      f"{old_size:.0f}sh -> {self.s.current_shares:.0f}sh"),
            )

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
        elif pos is not None:
            status = "open"
        elif self.s.entry_side_this_window is not None and not self.s.entered_this_window:
            status = "armed"
        else:
            status = "waiting"

        equity = round(self.capital.balance + open_market_value, 4)

        return {
            "engine": self.name, "label": self.label, "base_shares": self.shares,
            "current_shares": self.s.current_shares,
            "next_size_if_win": max(config.ENGINE2_MIN_SHARES, self.s.current_shares - config.ENGINE2_SIZE_STEP),
            "next_size_if_loss": min(config.ENGINE2_SHARES + config.ENGINE2_MAX_ADDITIONS * config.ENGINE2_SIZE_STEP, self.s.current_shares + config.ENGINE2_SIZE_STEP),
            "size_step": config.ENGINE2_SIZE_STEP, "max_additions": config.ENGINE2_MAX_ADDITIONS,
            "min_shares": config.ENGINE2_MIN_SHARES,
            "max_shares": config.ENGINE2_SHARES + config.ENGINE2_MAX_ADDITIONS * config.ENGINE2_SIZE_STEP,

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": equity,

            "peak_equity": round(self.capital.peak_equity, 2),
            "max_drawdown": round(self.capital.max_drawdown, 2),
            "max_drawdown_pct": round(self.capital.max_drawdown_pct, 2),

            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),

            "entry_side_this_window": self.s.entry_side_this_window.value if self.s.entry_side_this_window else None,
            "locked_side": self.s.locked_side.value if self.s.locked_side else None,
            "required_color": self.s.required_color,
            "reds_this_signal": self.s.reds_this_signal, "greens_this_signal": self.s.greens_this_signal,
            "imbalance_window": config.IMBALANCE_WINDOW, "imbalance_threshold": config.IMBALANCE_THRESHOLD,
            "position": position_payload,

            "candle_history": list(self.candle_history)[-config.IMBALANCE_WINDOW:],
            "last_candle": self.last_candle,

            "fills": self.s.fills, "tp_fills": self.s.tp_fills,
            "settled_wins": self.s.settled_wins, "settled_losses": self.s.settled_losses,
            "no_signal_windows": self.s.no_signal_windows,
            "wins": self.s.wins, "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,
        }
