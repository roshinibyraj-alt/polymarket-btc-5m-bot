'use strict';

const WINDOW_CONFIG = Object.freeze({
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
});

const ENTRY_RUNGS = Object.freeze([
  Object.freeze({ price: 0.25, shares: 10, takeProfitPrice: 0.75 }),
  Object.freeze({ price: 0.15, shares: 10, takeProfitPrice: 0.85 }),
]);

const MIN_MIDPOINT = 0.30;
const MAX_MIDPOINT = 0.71;
const FINAL_MINUTE_MS = 60_000;
const QUOTE_MAX_AGE_MS = 5_000;

function bestPrice(levels, select) {
  if (!Array.isArray(levels)) return null;
  const prices = levels
    .map(level => Number(level?.price))
    .filter(price => Number.isFinite(price) && price > 0 && price <= 1);
  return prices.length ? select(...prices) : null;
}

function quoteFromBook(book, now = Date.now()) {
  const bestBid = bestPrice(book?.bids, Math.max);
  const bestAsk = bestPrice(book?.asks, Math.min);
  const valid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid <= bestAsk;
  return {
    status: valid ? 'LIVE' : 'MISSING',
    bestBid,
    bestAsk,
    mid: valid ? (bestBid + bestAsk) / 2 : null,
    bidSize: valid ? Number(book.bids.find(level => Number(level.price) === bestBid)?.size) || 0 : 0,
    askSize: valid ? Number(book.asks.find(level => Number(level.price) === bestAsk)?.size) || 0 : 0,
    updatedAt: now,
    stale: false,
    error: null,
  };
}

function evaluateWindow({ now = Date.now(), market, quotes, startedAt = null } = {}) {
  if (!market || !Number.isFinite(Number(market.start)) || !Number.isFinite(Number(market.end))) {
    return { eligible: false, status: 'waiting_for_market', reason: 'Waiting for BTC market discovery' };
  }

  const start = Number(market.start);
  const end = Number(market.end);
  if (now < start) {
    return { eligible: false, status: 'waiting_for_window', reason: 'Window has not started' };
  }
  if (now >= end) {
    return { eligible: false, status: 'window_ended', reason: 'Window has ended' };
  }
  if (startedAt !== null && start < Number(startedAt)) {
    return {
      eligible: false,
      status: 'skipped_restart_window',
      reason: 'Window was already open when this process started',
    };
  }

  const remainingMs = end - now;
  if (remainingMs > FINAL_MINUTE_MS) {
    return {
      eligible: false,
      status: 'watching',
      remainingMs,
      reason: 'Waiting for the final 60 seconds',
    };
  }

  const values = { UP: null, DOWN: null };
  const freshSides = [];
  for (const side of ['UP', 'DOWN']) {
    const quote = quotes?.[side];
    const updatedAt = Number(quote?.updatedAt);
    const bid = Number(quote?.bestBid);
    const ask = Number(quote?.bestAsk);
    const fresh = quote?.status === 'LIVE'
      && quote?.stale !== true
      && Number.isFinite(updatedAt)
      && updatedAt <= now
      && now - updatedAt <= QUOTE_MAX_AGE_MS
      && Number.isFinite(bid)
      && Number.isFinite(ask)
      && bid > 0
      && ask >= bid
      && ask <= 1;

    if (!fresh) continue;
    values[side] = (bid + ask) / 2;
    freshSides.push(side);
  }

  const inBand = price => price >= MIN_MIDPOINT && price <= MAX_MIDPOINT;
  const qualifyingSides = ['UP', 'DOWN'].filter(side => inBand(values[side]));
  if (freshSides.length === 0) {
    return {
      eligible: false,
      status: 'waiting_for_fresh_quotes',
      remainingMs,
      upMid: values.UP,
      downMid: values.DOWN,
      freshSides,
      reason: 'Waiting for at least one fresh UP or DOWN bid/ask quote',
    };
  }
  const eligible = qualifyingSides.length > 0;
  return {
    eligible,
    status: eligible ? 'eligible' : 'outside_midpoint_band',
    remainingMs,
    upMid: values.UP,
    downMid: values.DOWN,
    freshSides,
    qualifyingSides,
    reason: eligible
      ? `${qualifyingSides.join(' and ')} midpoint is in the $0.30–$0.71 band`
      : 'No fresh outcome midpoint is in the $0.30–$0.71 band',
  };
}

function windowStartFor(now, timeframe) {
  const windowMs = WINDOW_CONFIG[timeframe];
  if (!windowMs) throw new Error(`Unsupported BTC timeframe: ${timeframe}`);
  return Math.floor(now / windowMs) * windowMs;
}

module.exports = {
  WINDOW_CONFIG,
  ENTRY_RUNGS,
  MIN_MIDPOINT,
  MAX_MIDPOINT,
  FINAL_MINUTE_MS,
  QUOTE_MAX_AGE_MS,
  quoteFromBook,
  evaluateWindow,
  windowStartFor,
};
