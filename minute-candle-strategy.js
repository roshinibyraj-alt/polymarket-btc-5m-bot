'use strict';

const STRATEGY = Object.freeze({
  id: 'btc-5m-cross-window-color-persistence-profitable-exits-20261126',
  name: 'BTC 5-minute cross-window one-minute color persistence',
  version: 3,
  assets: ['BTC'],
  timeframes: ['5m'],
  candleIntervalMs: 60_000,
  firstSignalCandle: 1,
  lastSignalCandle: 4,
  sharesPerTrigger: 200,
  maximumEntriesPerWindow: 4,
  maximumEntryAsk: null,
  oppositeSignalVetoBestBid: null,
  takeProfitMid: 0.99,
  stopLossMid: null,
  maximumBuyPrice: 1.00,
  maximumQuoteAgeMs: 2_500,
  maximumSignalDelayMs: 5_000,
  signalValidityMs: 60_000,
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
    return { eligible: false, candleNumber: null, color, previousColor, side: null, colorChanged: false, reason: 'Candle does not align to this five-minute market.' };
  }
  if (candleNumber < STRATEGY.firstSignalCandle || candleNumber > STRATEGY.lastSignalCandle) {
    return {
      eligible: false,
      candleNumber,
      color,
      previousColor,
      side: null,
      colorChanged: false,
      reason: candleNumber === 5
        ? 'Minute 5 is excluded from entries.'
        : 'This candle is outside the signal minutes.',
    };
  }
  if (!Number.isFinite(previousStart) || previousStart !== start - interval) {
    return { eligible: false, candleNumber, color, previousColor, side: null, colorChanged: false, reason: 'The immediately previous one-minute candle is not available.' };
  }
  if (color === 'DOJI' || previousColor === 'DOJI' || color === 'UNKNOWN' || previousColor === 'UNKNOWN') {
    return {
      eligible: true,
      candleNumber,
      color,
      previousColor,
      side: null,
      colorChanged: false,
      reason: 'A doji or unavailable candle has no usable color; no trade.',
    };
  }
  if (color !== previousColor) {
    const heldSide = previousColor === 'GREEN' ? 'UP' : 'DOWN';
    return {
      eligible: true,
      candleNumber,
      color,
      previousColor,
      side: null,
      colorChanged: true,
      exitSide: heldSide,
      reason: `Minute ${candleNumber} changed from ${previousColor} to ${color}; sell the held ${heldSide} position and do not enter the new side on this candle.`,
    };
  }
  return {
    eligible: true,
    candleNumber,
    color,
    previousColor,
    side: color === 'GREEN' ? 'UP' : 'DOWN',
    colorChanged: false,
    reason: `Minute ${candleNumber} is consecutive ${color}; buy ${color === 'GREEN' ? 'UP' : 'DOWN'}.`,
  };
}

module.exports = { STRATEGY, candleColor, classifyCandleTransition };
