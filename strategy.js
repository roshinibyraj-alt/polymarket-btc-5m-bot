'use strict';

function observeEntry(windowState, mids, elapsedSeconds, config) {
  const events = [];
  if (!windowState || windowState.tradeTaken) return { events, shouldBuy: false, side: null };
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < config.ENTRY_START_SECONDS) {
    return { events, shouldBuy: false, side: windowState.armedSide || null };
  }

  if (!windowState.armedSide) {
    const candidates = ['UP', 'DOWN']
      .map((side) => ({ side, mid: Number(mids && mids[side]) }))
      .filter((item) => Number.isFinite(item.mid) && item.mid > config.ENTRY_ARM_PRICE && item.mid < 1)
      .sort((a, b) => b.mid - a.mid);
    if (candidates.length) {
      windowState.armedSide = candidates[0].side;
      windowState.entryReadyLogged = false;
      events.push('SIDE_ARMED');
    }
  }

  const side = windowState.armedSide || null;
  const mid = side ? Number(mids && mids[side]) : NaN;
  const shouldBuy = !!side && Number.isFinite(mid) && mid > 0 && mid <= config.ENTRY_TRIGGER_PRICE;
  if (shouldBuy && !windowState.entryReadyLogged) {
    windowState.entryReadyLogged = true;
    events.push('ENTRY_READY');
  }
  return { events, shouldBuy, side };
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
