'use strict';

function observeEntry(windowState, mids, elapsedSeconds, config) {
  const events = [];
  if (!windowState || windowState.tradeTaken) return { events, shouldBuy: false, side: null, direction: null };
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < config.ENTRY_START_SECONDS) {
    return { events, shouldBuy: false, side: null, direction: null };
  }

  if (!windowState.previousMids || typeof windowState.previousMids !== 'object') windowState.previousMids = {};
  const threshold = Number(config.ENTRY_TRIGGER_PRICE);
  if (!Number.isFinite(threshold)) return { events, shouldBuy: false, side: null, direction: null };
  let side = null;
  let direction = null;

  for (const outcome of ['UP', 'DOWN']) {
    const rawMid = mids && mids[outcome];
    const current = rawMid === null || rawMid === undefined || rawMid === '' ? NaN : Number(rawMid);
    const previousRaw = windowState.previousMids[outcome];
    const previous = previousRaw === null || previousRaw === undefined ? NaN : Number(previousRaw);
    const currentIsValid = Number.isFinite(current) && current > 0 && current < 1;
    const previousIsValid = Number.isFinite(previous) && previous > 0 && previous < 1;

    if (currentIsValid && previousIsValid && !side) {
      if (previous < threshold && current >= threshold) {
        side = outcome;
        direction = 'up';
      } else if (previous > threshold && current <= threshold) {
        side = outcome;
        direction = 'down';
      }
    }
    if (currentIsValid) windowState.previousMids[outcome] = current;
    else delete windowState.previousMids[outcome];
  }

  const shouldBuy = !!side;
  if (shouldBuy) events.push('ENTRY_READY');
  return { events, shouldBuy, side, direction };
}

function estimateMarketBuyBudget(book, targetShares) {
  const asks = ((book && book.asks) || [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = Math.max(0, Number(targetShares) || 0);
  let shares = 0;
  let amount = 0;
  for (const level of asks) {
    const take = Math.min(remaining, level.size);
    amount += take * level.price;
    shares += take;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  return { amount, shares, averagePrice: shares > 0 ? amount / shares : 0, remaining };
}

function normalizeMarketFill(result, side) {
  const raw = (result && result.raw) || {};
  const making = Number(raw.makingAmount);
  const taking = Number(raw.takingAmount);
  let shares = String(side).toUpperCase() === 'BUY' ? taking : making;
  let notional = String(side).toUpperCase() === 'BUY' ? making : taking;
  if (!(shares > 0) || !(notional > 0)) {
    const fallbackShares = Number(raw.size_matched || raw.filled_size || (result && result.filledSize));
    const fallbackPrice = Number((result && result.avgPrice) || raw.avg_fill_price || raw.price);
    if (fallbackShares > 0 && fallbackPrice > 0) {
      shares = fallbackShares;
      notional = fallbackShares * fallbackPrice;
    }
  }
  return {
    shares: Number.isFinite(shares) && shares > 0 ? shares : 0,
    notional: Number.isFinite(notional) && notional > 0 ? notional : 0,
    averagePrice: shares > 0 && notional > 0 ? notional / shares : 0,
  };
}

function adjustBaseShares(currentBase, outcome, config) {
  const floor = config.BASE_SHARES;
  const step = config.SHARE_STEP;
  const ceiling = floor + step * config.MAX_SHARE_ADDITIONS;
  const current = Math.max(floor, Math.min(ceiling, Number(currentBase) || floor));
  if (outcome === 'STOP_LOSS' || outcome === 'STOP') return Math.min(ceiling, current + step);
  if (outcome === 'WIN' || outcome === 'TAKE_PROFIT') return Math.max(floor, current - step);
  return current;
}

function additionCount(baseShares, config) {
  const count = Math.round(((Number(baseShares) || config.BASE_SHARES) - config.BASE_SHARES) / config.SHARE_STEP);
  return Math.max(0, Math.min(config.MAX_SHARE_ADDITIONS, count));
}

module.exports = { observeEntry, estimateMarketBuyBudget, normalizeMarketFill, adjustBaseShares, additionCount };
