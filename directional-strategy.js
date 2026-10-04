'use strict';

const ENTRY_PATTERNS = Object.freeze({
  RG: 'UP',
  RRG: 'UP',
  GR: 'DOWN',
  GGR: 'DOWN',
});

function candleColor(open, close) {
  if (open == null || open === '' || close == null || close === '') return 'N';
  const openPrice = Number(open);
  const closePrice = Number(close);
  if (!Number.isFinite(openPrice) || !Number.isFinite(closePrice)) return 'N';
  if (closePrice > openPrice) return 'G';
  if (closePrice < openPrice) return 'R';
  return 'N';
}

function matchMinutePattern(colors) {
  const sequence = Array.isArray(colors) ? colors.join('') : String(colors || '');
  if (Object.prototype.hasOwnProperty.call(ENTRY_PATTERNS, sequence)) {
    return { action: 'BUY', side: ENTRY_PATTERNS[sequence], pattern: sequence, sequence };
  }
  return { action: 'WAIT', side: null, pattern: null, sequence };
}

module.exports = { candleColor, matchMinutePattern, ENTRY_PATTERNS };
