"""
Thin client for Binance's public BTC/USDT spot klines (candlesticks).

Used purely as the "candle color" signal source for the candle-signal
engines (see engine.py) -- completely independent of Polymarket's own
CLOB prices. A candle is "green" if its close > open, "red" if
close < open (a rare exact-tie close==open is "doji" and is skipped by
the engines rather than guessed at).

Binance's 5m kline buckets are UTC-aligned to the epoch (same as
Polymarket's 5-min window boundaries, both being `floor(ts / 300) * 300`),
so a window's `open_ts` lines up exactly with a kline's open/close time
in seconds (Binance reports ms).
"""
import time
from typing import List, Optional

import httpx

from . import config

KLINES_URL = "https://api.binance.com/api/v3/klines"


class BinanceCandleClient:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=8.0)

    async def close(self):
        await self._client.aclose()

    async def get_closed_candles(self, limit: int = 10) -> List[dict]:
        """Most recent *closed* 5m BTCUSDT candles, oldest -> newest. Each:
        {open_time_ms, close_time_ms, open, close, color}. Drops the
        currently-forming candle (Binance includes it as the last row)."""
        try:
            resp = await self._client.get(KLINES_URL, params={
                "symbol": config.BINANCE_SYMBOL, "interval": "5m", "limit": limit + 1,
            })
            resp.raise_for_status()
            raw = resp.json()
        except Exception:
            return []
        if not isinstance(raw, list):
            return []

        now_ms = time.time() * 1000
        candles = []
        for row in raw:
            try:
                open_time_ms, o, c, close_time_ms = float(row[0]), float(row[1]), float(row[4]), float(row[6])
            except (IndexError, TypeError, ValueError):
                continue
            if close_time_ms > now_ms:
                continue  # still forming -- not a closed candle yet
            color = "green" if c > o else ("red" if c < o else "doji")
            candles.append({
                "open_time_ms": open_time_ms, "close_time_ms": close_time_ms,
                "open": o, "close": c, "color": color,
            })
        return candles

    async def get_candle_for_close_ts(self, close_ts: float) -> Optional[dict]:
        """The single closed candle whose close time matches `close_ts`
        (a window's open_ts/close_ts, in seconds) -- i.e. "the candle that
        just closed as this window started." Returns None if it isn't
        available yet (e.g. Binance briefly lagging) or on a network error."""
        candles = await self.get_closed_candles(limit=5)
        if not candles:
            return None
        target_ms = close_ts * 1000
        # Binance's close_time is (open_time + interval - 1ms), so the next
        # candle's open_time is close_time + 1 -- compare loosely (a couple
        # seconds of slop) rather than requiring an exact ms match.
        for c in candles:
            if abs((c["close_time_ms"] + 1) - target_ms) < 2000:
                return c
        return None
