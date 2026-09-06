"""
Engine B -- interval ladder strategy.

Phase 1 (t=0 to t=120s): every 15s, buy the CHEAPER side for 20 shares,
  only if its price is below 0.40. The side can differ from check to
  check -- whichever is cheaper at that moment.

Gap (t=120 to t=135s): idle.

Phase 2 (t=135 to t=255s): every 15s, buy the CHEAPER side for 40
  shares, only if its price is below 0.40 (same entry logic as phase 1,
  different timing window and share size).

t=255 to close (300s): idle, hold everything to expiry.

No stop loss, no take profit -- every individual fill is tracked
separately and settled against Polymarket's real outcome at window
close: $1/share if that fill's side won, $0/share if it lost. A side
printing 0.90+ in the last 2 seconds before close is logged for
visibility only.
"""
import time
from typing import List, Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker


def _build_check_schedule(open_ts: float, start_offset: int, end_offset: int,
                            interval: int) -> List[dict]:
    schedule = []
    t = start_offset
    while t <= end_offset:
        schedule.append({
            "t_offset": t,
            "at": open_ts + t,
            "status": "pending",  # pending | bought | skipped
            "side": None,
            "price": None,
        })
        t += interval
    return schedule


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.window: Optional[WindowMarket] = None
        self.fills: List[Position] = []  # every individual buy, held to expiry
        self.phase1_checks: List[dict] = []
        self.phase2_checks: List[dict] = []
        self._phase1_idx = 0
        self._phase2_idx = 0
        self.winner_logged = False

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.fills = []
        self._phase1_idx = 0
        self._phase2_idx = 0
        self.winner_logged = False
        self.phase1_checks = _build_check_schedule(
            window.open_ts, config.PHASE1_START_OFFSET,
            config.PHASE1_END_OFFSET, config.PHASE1_INTERVAL_SECONDS,
        )
        self.phase2_checks = _build_check_schedule(
            window.open_ts, config.PHASE2_START_OFFSET,
            config.PHASE2_END_OFFSET, config.PHASE2_INTERVAL_SECONDS,
        )
        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"Phase 1: cheaper side <{config.PHASE1_MAX_PRICE}, {config.PHASE1_SHARES} shares, "
                  f"every {config.PHASE1_INTERVAL_SECONDS}s to {config.PHASE1_END_OFFSET}s. "
                  f"Phase 2: cheaper side <{config.PHASE2_MAX_PRICE}, {config.PHASE2_SHARES} shares, "
                  f"every {config.PHASE2_INTERVAL_SECONDS}s from {config.PHASE2_START_OFFSET}s "
                  f"to {config.PHASE2_END_OFFSET}s."),
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.window is None:
            return
        now = now or time.time()
        prices = {Side.UP: up_price, Side.DOWN: down_price}

        self._run_due_checks(self.phase1_checks, "_phase1_idx", now, prices,
                              side_selector=self._cheaper_side,
                              price_condition=lambda p: p < config.PHASE1_MAX_PRICE,
                              shares=config.PHASE1_SHARES, tag="phase1")

        self._run_due_checks(self.phase2_checks, "_phase2_idx", now, prices,
                              side_selector=self._cheaper_side,
                              price_condition=lambda p: p < config.PHASE2_MAX_PRICE,
                              shares=config.PHASE2_SHARES, tag="phase2")

        if (not self.winner_logged and seconds_to_close <= config.RESOLUTION_WINDOW_SECONDS
                and seconds_to_close >= 0):
            self._log_resolution_signal(prices)

    @staticmethod
    def _cheaper_side(prices: dict) -> Optional[Side]:
        up_p, down_p = prices.get(Side.UP), prices.get(Side.DOWN)
        if up_p is None or down_p is None:
            return None
        return Side.UP if up_p <= down_p else Side.DOWN

    def _run_due_checks(self, schedule: List[dict], idx_attr: str, now: float,
                          prices: dict, side_selector, price_condition,
                          shares: int, tag: str):
        idx = getattr(self, idx_attr)
        while idx < len(schedule) and now >= schedule[idx]["at"]:
            check = schedule[idx]
            side = side_selector(prices)
            if side is not None:
                price = prices.get(side)
                if price is not None and price_condition(price):
                    position = self.broker.buy(
                        self.name, self.window.slug, side, shares, price,
                        note=f"{tag} check @ t+{check['t_offset']}s",
                    )
                    self.fills.append(position)
                    check["status"] = "bought"
                    check["side"] = side.value
                    check["price"] = price
                else:
                    check["status"] = "skipped"
                    check["side"] = side.value if side else None
                    check["price"] = price
                    self.broker.log_event(
                        self.name, self.window.slug, "CHECK_SKIPPED",
                        side=side.value if side else None, price=price,
                        note=f"{tag} check @ t+{check['t_offset']}s: condition not met",
                    )
            else:
                check["status"] = "skipped"
                self.broker.log_event(self.name, self.window.slug, "CHECK_SKIPPED",
                                       note=f"{tag} check @ t+{check['t_offset']}s: no price data")
            idx += 1
        setattr(self, idx_attr, idx)

    def _log_resolution_signal(self, prices):
        winner = None
        for side, p in prices.items():
            if p is not None and p >= config.RESOLUTION_SIGNAL_PRICE:
                winner = side
                break
        if winner is not None:
            self.winner_logged = True
            self.broker.log_event(self.name, self.window.slug, "RESOLUTION_SIGNAL",
                                   side=winner.value, price=prices[winner],
                                   note="Logging only, no action taken")

    def finalize_window(self, winning_side: Optional[Side]):
        if winning_side is not None:
            for fill in self.fills:
                won = fill.side == winning_side
                self.broker.resolve_expiry(self.name, self.window.slug, fill,
                                            won, note="Held to expiry")
        self.fills = []

    # ---- dashboard payload -------------------------------------------------

    def _side_summary(self, side: Side, mark_price: Optional[float]) -> dict:
        side_fills = [f for f in self.fills if f.side == side]
        shares = sum(f.shares for f in side_fills)
        cost = sum(f.cost for f in side_fills)
        avg_price = (cost / shares) if shares else None
        mark_value = (shares * mark_price) if (mark_price is not None and shares) else None
        unrealized_pnl = (mark_value - cost) if mark_value is not None else None
        return {
            "shares": shares,
            "avg_price": avg_price,
            "cost": cost,
            "mark_value": mark_value,
            "unrealized_pnl": unrealized_pnl,
        }

    def snapshot(self, up_price: Optional[float] = None, down_price: Optional[float] = None) -> dict:
        return {
            "window": self.window.slug if self.window else None,
            "phase1_checks": self.phase1_checks,
            "phase2_checks": self.phase2_checks,
            "fills_count": len(self.fills),
            "up": self._side_summary(Side.UP, up_price),
            "down": self._side_summary(Side.DOWN, down_price),
        }
