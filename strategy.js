'use strict';

function previousCandleSignal(candles, windowOpenTs, windowSeconds = 300) {
  const expectedOpenTs = windowOpenTs - windowSeconds;
  const candle = (candles || []).find((item) => item.openTs === expectedOpenTs);
  if (!candle) return { ready: false, candle: null, color: null, side: null };
  const color = candle.close > candle.open ? 'GREEN' : candle.close < candle.open ? 'RED' : 'DOJI';
  const side = color === 'GREEN' ? 'UP' : color === 'RED' ? 'DOWN' : null;
  return { ready: true, candle, color, side };
}

/** Track a strict below-floor dip followed by a recovery to the entry level. */
function observeEntryPrice(windowState, ask, secondsRemaining, config) {
  const price = Number(ask);
  const events = [];
  if (!Number.isFinite(price) || price <= 0 || price >= 1 || windowState.tradeTaken) {
    return { events, shouldBuy: false };
  }
  if (price < config.DIP_PRICE && !windowState.dipSeen) {
    windowState.dipSeen = true;
    events.push('DIP_SEEN');
  }
  if (windowState.dipSeen && price >= config.ENTRY_PRICE && !windowState.reboundSeen) {
    windowState.reboundSeen = true;
    events.push('REBOUND_SEEN');
  }
  const shouldBuy = windowState.dipSeen && windowState.reboundSeen
    && price <= config.ENTRY_PRICE
    && secondsRemaining >= config.MIN_SECONDS_REMAINING;
  return { events, shouldBuy };
}

function adjustBaseShares(currentBase, outcome, config) {
  const floor = config.BASE_SHARES;
  const step = config.SHARE_STEP;
  const ceiling = floor + step * config.MAX_SHARE_ADDITIONS;
  if (outcome === 'LOSS') return Math.min(ceiling, Math.max(floor, currentBase) + step);
  if (outcome === 'WIN') return Math.max(floor, Math.min(ceiling, currentBase) - step);
  return Math.min(ceiling, Math.max(floor, currentBase));
}

function additionCount(baseShares, config) {
  return Math.max(0, Math.min(config.MAX_SHARE_ADDITIONS, Math.round((baseShares - config.BASE_SHARES) / config.SHARE_STEP)));
}

module.exports = { previousCandleSignal, observeEntryPrice, adjustBaseShares, additionCount };
