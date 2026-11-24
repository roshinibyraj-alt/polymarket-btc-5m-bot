'use strict';

const STRATEGY = Object.freeze({
  id: 'btc-5m-one-minute-color-flip-200-20261126',
  name: 'BTC 5-minute one-minute color-flip',
  version: 1,
  assets: ['BTC'],
  timeframes: ['5m'],
  candleIntervalMs: 60_000,
  firstSignalCandle: 2,
  lastSignalCandle: 4,
  sharesPerTrigger: 200,
  maximumBuyPrice: 0.99,
  maximumQuoteAgeMs: 2_500,
  maximumSignalDelayMs: 5_000,
  execution: 'PAPER ONLY',
});

function candleColor(candle) {
  const open = Number(candle?.open);
  const close = Number(candle?.close);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return 'UNKNOWN';
  if (close > open) return 'GREEN';
  if (close < open) return 'RED';
  return 'DOJI';
}

function classifyCandleTransition({ candle, previousCandle, windowStart }) {
  const start = Number(candle?.start);
  const previousStart = Number(previousCandle?.start);
  const marketStart = Number(windowStart);
  const interval = STRATEGY.candleIntervalMs;
  const offset = start - marketStart;
  const candleNumber = Number.isFinite(offset) && offset >= 0 && offset % interval === 0
    ? Math.floor(offset / interval) + 1
    : null;
  const color = candleColor(candle);
  const previousColor = candleColor(previousCandle);

  if (candleNumber == null) {
    return { eligible: false, candleNumber: null, color, previousColor, side: null, reason: 'Candle does not align to this five-minute market.' };
  }
  if (candleNumber < STRATEGY.firstSignalCandle || candleNumber > STRATEGY.lastSignalCandle) {
    return {
      eligible: false,
      candleNumber,
      color,
      previousColor,
      side: null,
      reason: candleNumber === 1
        ? 'Minute 1 is reference-only; no trade is allowed.'
        : candleNumber === 5
          ? 'Minute 5 is excluded from entries.'
          : 'This candle is outside the signal minutes.',
    };
  }
  if (!Number.isFinite(previousStart) || previousStart !== start - interval) {
    return { eligible: false, candleNumber, color, previousColor, side: null, reason: 'The immediately previous one-minute candle is not available.' };
  }
  if (color === 'DOJI' || previousColor === 'DOJI' || color === 'UNKNOWN' || previousColor === 'UNKNOWN') {
    return { eligible: true, candleNumber, color, previousColor, side: null, reason: 'A doji or unavailable candle has no usable colour; no trade.' };
  }
  if (color === previousColor) {
    return { eligible: true, candleNumber, color, previousColor, side: null, reason: `Minute ${candleNumber} matches minute ${candleNumber - 1}; no trade.` };
  }
  return {
    eligible: true,
    candleNumber,
    color,
    previousColor,
    side: color === 'GREEN' ? 'UP' : 'DOWN',
    reason: `Minute ${candleNumber} changed from ${previousColor} to ${color}; buy ${color === 'GREEN' ? 'UP' : 'DOWN'}.`,
  };
}

module.exports = { STRATEGY, candleColor, classifyCandleTransition };
