'use strict';

const STRATEGY = Object.freeze({
  id: 'btc-5m-previous-closed-color-entry-every-minute-20261125',
  name: 'BTC 5-minute previous-candle color entries',
  version: 6,
  assets: ['BTC'],
  timeframes: ['5m'],
  candleIntervalMs: 60_000,
  firstSignalCandle: 1,
  lastSignalCandle: 5,
  sharesPerTrigger: 200,
  maximumEntriesPerWindow: 5,
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

function sideForColor(color) {
  if (color === 'GREEN') return 'DOWN';
  if (color === 'RED') return 'UP';
  return null;
}

function classifyMinuteEntry({ previousCandle, targetCandleStart, windowStart }) {
  const targetStart = Number(targetCandleStart);
  const previousStart = Number(previousCandle?.start);
  const marketStart = Number(windowStart);
  const interval = STRATEGY.candleIntervalMs;
  const offset = targetStart - marketStart;
  const candleNumber = Number.isFinite(offset) && offset >= 0 && offset % interval === 0
    ? Math.floor(offset / interval) + 1
    : null;
  const referenceColor = candleColor(previousCandle);

  if (candleNumber == null) {
    return {
      eligible: false,
      candleNumber: null,
      referenceColor,
      side: null,
      reason: 'The target minute does not align to this five-minute market.',
    };
  }
  if (candleNumber < STRATEGY.firstSignalCandle || candleNumber > STRATEGY.lastSignalCandle) {
    return {
      eligible: false,
      candleNumber,
      referenceColor,
      side: null,
      reason: 'This minute is outside the entry schedule.',
    };
  }
  if (!Number.isFinite(previousStart)
    || previousStart !== targetStart - interval
    || previousCandle?.closed === false
    || !Number.isFinite(Number(previousCandle?.closeAt))
    || Number(previousCandle.closeAt) > targetStart) {
    return {
      eligible: false,
      candleNumber,
      referenceColor,
      side: null,
      reason: 'The immediately previous closed one-minute candle is not available.',
    };
  }
  if (referenceColor === 'DOJI' || referenceColor === 'UNKNOWN') {
    return {
      eligible: true,
      candleNumber,
      referenceColor,
      side: null,
      reason: `Minute ${candleNumber} has no entry because the previous candle was ${referenceColor}.`,
    };
  }
  const side = sideForColor(referenceColor);
  return {
    eligible: true,
    candleNumber,
    referenceColor,
    side,
    reason: `Minute ${candleNumber} uses the previous ${referenceColor} candle; buy ${side}.`,
  };
}

module.exports = { STRATEGY, candleColor, sideForColor, classifyMinuteEntry };
