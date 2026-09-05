"""
Engine B (v6) -- peak drawdown reversion strategy. The only engine running.

Rationale
---------
Rather than betting on momentum continuing, this version bets on small
pullbacks reverting: it waits out the noisy open of the window, then
buys dips off each side's own running peak, with a fixed take-profit
and stop-loss around every entry, plus an absolute floor that force-
exits regardless of the per-trade levels if a side falls out of the
tradable range.

Flow
----
Warm-up -- from window open to ENTRY_WAIT_SECONDS:
    No trading. Prices are still recorded.

Monitoring -- from ENTRY_WAIT_SECONDS to ENTRY_CUTOFF_SECONDS, every
tick (~1s):
    Each side (UP, DOWN) has its own running peak price, tracked
    independently from the moment monitoring starts. Whenever a side's
    current price is DIP_TRIGGER_AMOUNT or more below its peak, AND
    that price sits inside [RANGE_MIN, RANGE_MAX], buy TRADE_SHARES of
    that side as a new, independent leg with:
        take profit = entry + TP_OFFSET
        stop loss   = entry - SL_OFFSET
    A side will not fire again off the same peak -- it must make a NEW
    peak (a higher high than the one that triggered the last entry) and
    then dip DIP_TRIGGER_AMOUNT again before it can trigger another
    leg. Both sides are tracked independently and can hold positions
    concurrently; there is no cap on the number of legs.

Exit management -- every tick, for every open leg regardless of phase:
    If the leg's side price falls to HARD_STOP_PRICE, force-close it
    immediately at the market (taker, fee) -- hard stop overrides the
    leg's own TP/SL. Take profit is a resting limit sell order placed
    at entry + TP_OFFSET: it fills at that exact price (maker, no fee)
    once the market reaches it. Stop loss is a market exit (taker,
    fee) at entry - SL_OFFSET. A hard stop on one side never blocks new
    entries on the other side -- that side is usually still inside the
    tradable range and keeps trading normally.

No new entries -- after ENTRY_CUTOFF_SECONDS:
    Existing legs are still managed (hard stop / TP / SL) but no new
    legs are opened for the rest of the window.

Anything still open at window close is held to resolution and settled
against the real outcome.
"""
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class Leg:
    position: Position
    side: Side
    entry_price: float
    tp_price: float
    sl_price: float
    opened_at_elapsed: float
    peak_at_entry: float
    status: str = "open"   # open, tp_exit, sl_exit, hard_stop, resolved_win, resolved_loss
    exit_price: Optional[float] = None
    exit_elapsed: Optional[float] = None
    pnl: Optional[float] = None


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.window: Optional[WindowMarket] = None
        self.legs: List[Leg] = []
        self._elapsed: float = 0.0
        self._peak: Dict[Side, Optional[float]] = {Side.UP: None, Side.DOWN: None}
        self._last_trigger_peak: Dict[Side, Optional[float]] = {Side.UP: None, Side.DOWN: None}

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.legs = []
        self._elapsed = 0.0
        self._peak = {Side.UP: None, Side.DOWN: None}
        self._last_trigger_peak = {Side.UP: None, Side.DOWN: None}

        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"peak-dip reversion: wait {config.ENTRY_WAIT_SECONDS}s, then buy "
                  f"{config.TRADE_SHARES}sh on a {config.DIP_TRIGGER_AMOUNT:.2f} dip from peak "
                  f"inside [{config.RANGE_MIN:.2f}-{config.RANGE_MAX:.2f}]; "
                  f"TP +{config.TP_OFFSET:.2f} / SL -{config.SL_OFFSET:.2f}; "
                  f"hard stop @ {config.HARD_STOP_PRICE:.2f}; "
                  f"no new entries after {config.ENTRY_CUTOFF_SECONDS}s"),
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.window is None:
            return
        now = now or time.time()
        elapsed = now - self.window.open_ts
        self._elapsed = elapsed
        if up_price is None or down_price is None:
            return

        prices = {Side.UP: up_price, Side.DOWN: down_price}

        if elapsed >= config.ENTRY_WAIT_SECONDS:
            # Update running peaks first.
            for side, price in prices.items():
                if self._peak[side] is None or price > self._peak[side]:
                    self._peak[side] = price

            # Look for new dip-from-peak entries (only during the entry window).
            if elapsed <= config.ENTRY_CUTOFF_SECONDS:
                for side, price in prices.items():
                    self._maybe_enter(side, price, elapsed)

        # Manage exits for every open leg, every tick, regardless of phase.
        for leg in self.legs:
            if leg.status != "open":
                continue
            self._maybe_exit(leg, prices[leg.side], elapsed)

    def _maybe_enter(self, side: Side, price: float, elapsed: float):
        peak = self._peak[side]
        if peak is None:
            return
        last_trigger_peak = self._last_trigger_peak[side]
        if last_trigger_peak is not None and peak <= last_trigger_peak:
            return  # already fired off this peak -- need a new high first
        if price > peak - config.DIP_TRIGGER_AMOUNT:
            return  # not dipped enough yet
        if not (config.RANGE_MIN <= price <= config.RANGE_MAX):
            return  # outside tradable range

        self._open_leg(side, price, elapsed, peak)
        self._last_trigger_peak[side] = peak

    def _open_leg(self, side: Side, price: float, elapsed: float, peak: float):
        position = self.broker.buy(
            self.name, self.window.slug, side, config.TRADE_SHARES, price,
            note=f"dip-buy @ t={elapsed:.0f}s: peak {peak:.3f} -> {price:.3f} "
                 f"(-{peak - price:.3f})",
        )
        leg = Leg(
            position=position, side=side, entry_price=price,
            tp_price=price + config.TP_OFFSET, sl_price=price - config.SL_OFFSET,
            opened_at_elapsed=elapsed, peak_at_entry=peak,
        )
        self.legs.append(leg)
        self.broker.log_event(
            self.name, self.window.slug, "LEG_OPENED",
            side=side.value, price=price,
            note=(f"t={elapsed:.0f}s: {config.TRADE_SHARES}sh off peak {peak:.3f}, "
                  f"TP {leg.tp_price:.3f} / SL {leg.sl_price:.3f}"),
        )

    def _maybe_exit(self, leg: Leg, price: float, elapsed: float):
        # Hard stop and per-trade SL are urgent -- market/taker exits at
        # the observed price. TP is a resting limit order at exactly
        # leg.tp_price -- maker fill, no fee, exact fill price.
        if price <= config.HARD_STOP_PRICE:
            self._close_leg(leg, price, elapsed, "hard_stop", limit=False,
                             note=f"hard stop floor {config.HARD_STOP_PRICE:.2f} hit")
        elif price >= leg.tp_price:
            self._close_leg(leg, leg.tp_price, elapsed, "tp_exit", limit=True,
                             note=f"limit sell filled at TP {leg.tp_price:.3f}")
        elif price <= leg.sl_price:
            self._close_leg(leg, price, elapsed, "sl_exit", limit=False,
                             note=f"stop loss {leg.sl_price:.3f} hit")

    def _close_leg(self, leg: Leg, price: float, elapsed: float, status: str,
                    limit: bool, note: str):
        if limit:
            pnl = self.broker.sell_limit(self.name, self.window.slug, leg.position, price,
                                          note=f"{status} @ t={elapsed:.0f}s ({note})")
        else:
            pnl = self.broker.sell(self.name, self.window.slug, leg.position, price,
                                    note=f"{status} @ t={elapsed:.0f}s ({note})")
        leg.status = status
        leg.exit_price = price
        leg.exit_elapsed = elapsed
        leg.pnl = pnl
        self.broker.log_event(
            self.name, self.window.slug, "LEG_CLOSED",
            side=leg.side.value, price=price,
            note=f"{status} (t={elapsed:.0f}s, entry {leg.entry_price:.3f}): {note}",
        )

    def finalize_window(self, winning_side: Optional[Side]):
        if winning_side is not None:
            for leg in self.legs:
                if leg.status != "open":
                    continue
                won = leg.side == winning_side
                pnl = self.broker.resolve_expiry(
                    self.name, self.window.slug, leg.position, won,
                    note=f"held to expiry from t={leg.opened_at_elapsed:.0f}s",
                )
                leg.status = "resolved_win" if won else "resolved_loss"
                leg.exit_price = 1.0 if won else 0.0
                leg.pnl = pnl
        self.legs = []

    def snapshot(self) -> dict:
        if self.window is None:
            phase = "flat"
        elif self._elapsed < config.ENTRY_WAIT_SECONDS:
            phase = "waiting"
        elif self._elapsed <= config.ENTRY_CUTOFF_SECONDS:
            phase = "monitoring"
        elif self._elapsed < config.WINDOW_SECONDS:
            phase = "cutoff_no_new_entries"
        else:
            phase = "done"

        open_legs = [l for l in self.legs if l.status == "open"]

        def _agg(side: Side) -> dict:
            legs_for_side = [l for l in open_legs if l.side == side]
            total_shares = sum(l.position.shares for l in legs_for_side)
            avg_price = (sum(l.position.shares * l.entry_price for l in legs_for_side) / total_shares
                         if total_shares else None)
            total_fees = sum(l.position.fee for l in legs_for_side)
            total_cost = sum(l.position.cost for l in legs_for_side)
            return {
                "shares": total_shares,
                "avg_entry_price": avg_price,
                "total_fees": total_fees,
                "total_cost": total_cost,
                "num_legs": len(legs_for_side),
            }

        return {
            "phase": phase,
            "window": self.window.slug if self.window else None,
            "elapsed": round(self._elapsed, 1),
            "entry_wait_seconds": config.ENTRY_WAIT_SECONDS,
            "entry_cutoff_seconds": config.ENTRY_CUTOFF_SECONDS,
            "range_min": config.RANGE_MIN,
            "range_max": config.RANGE_MAX,
            "hard_stop_price": config.HARD_STOP_PRICE,
            "peak_up": self._peak[Side.UP],
            "peak_down": self._peak[Side.DOWN],
            "up_position": _agg(Side.UP),
            "down_position": _agg(Side.DOWN),
            "legs": [
                {
                    "side": leg.side.value,
                    "shares": leg.position.shares,
                    "entry_price": leg.entry_price,
                    "tp_price": leg.tp_price,
                    "sl_price": leg.sl_price,
                    "peak_at_entry": leg.peak_at_entry,
                    "opened_at_elapsed": round(leg.opened_at_elapsed, 0),
                    "status": leg.status,
                    "exit_price": leg.exit_price,
                    "exit_elapsed": (round(leg.exit_elapsed, 0)
                                      if leg.exit_elapsed is not None else None),
                    "pnl": leg.pnl,
                }
                for leg in self.legs
            ],
        }
