'use strict';

function candleColor(open, close) {
  if (open == null || open === '' || close == null || close === '') return 'N';
  const openPrice = Number(open);
  const closePrice = Number(close);
  if (!Number.isFinite(openPrice) || !Number.isFinite(closePrice)) return 'N';
  if (closePrice > openPrice) return 'G';
  if (closePrice < openPrice) return 'R';
  return 'N';
}

function calculateAtr(candles, period = 14) {
  const valid = (Array.isArray(candles) ? candles : []).filter((c) =>
    c && [c.high, c.low, c.close].every((n) => Number.isFinite(Number(n))));
  if (valid.length < period + 1) return null;
  const rows = valid.slice(-(period + 1));
  const ranges = [];
  for (let i = 1; i < rows.length; i += 1) {
    const c = rows[i], previousClose = Number(rows[i - 1].close);
    ranges.push(Math.max(Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - previousClose), Math.abs(Number(c.low) - previousClose)));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / period;
}

function createRetestState(referencePrice, atr, multiplier = 0.5) {
  const reference = Number(referencePrice), range = Number(atr), factor = Number(multiplier);
  const valid = Number.isFinite(reference) && reference > 0
    && Number.isFinite(range) && range > 0 && Number.isFinite(factor) && factor > 0;
  return {
    referencePrice: valid ? reference : null,
    atr: valid ? range : null,
    threshold: valid ? range * factor : null,
    phase: valid ? 'WAITING_FOR_MOVE' : 'WAITING_FOR_ATR_OR_REFERENCE',
    excursion: null,
    signal: null,
  };
}

function updateRetestState(state, price) {
  const current = Number(price);
  if (!state || !Number.isFinite(current) || state.threshold == null) {
    return { action: 'WAIT', side: null, phase: state?.phase || 'WAITING_FOR_ATR_OR_REFERENCE' };
  }
  if (state.signal) return state.signal;
  const ref = state.referencePrice, threshold = state.threshold;
  if (state.phase === 'WAITING_FOR_MOVE') {
    if (current <= ref - threshold) {
      state.phase = 'WAITING_FOR_RETEST';
      state.excursion = 'BELOW';
    } else if (current >= ref + threshold) {
      state.phase = 'WAITING_FOR_RETEST';
      state.excursion = 'ABOVE';
    }
  } else if (state.excursion === 'BELOW' && current >= ref) {
    state.phase = 'RETEST_CONFIRMED';
    state.signal = { action: 'BUY', side: 'UP', pattern: 'LOWER_RETEST', sequence: 'LOWER_RETEST' };
  } else if (state.excursion === 'ABOVE' && current <= ref) {
    state.phase = 'RETEST_CONFIRMED';
    state.signal = { action: 'BUY', side: 'DOWN', pattern: 'UPPER_RETEST', sequence: 'UPPER_RETEST' };
  }
  return state.signal || { action: 'WAIT', side: null, phase: state.phase };
}

module.exports = { candleColor, calculateAtr, createRetestState, updateRetestState };
