'use strict';

const WINDOW_CONFIG = Object.freeze({
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
});
const STRATEGY_TIMEFRAMES = Object.freeze(['5m']);

const ENTRY_RUNGS = Object.freeze([
  Object.freeze({ price: 0.40, shares: 10 }),
  Object.freeze({ price: 0.60, shares: 20 }),
]);

const ENTRY_DELAY_MS = 0;
const ENTRY_TRIGGER_MIDPOINT = 0.80;
const QUOTE_MAX_AGE_MS = 5_000;
const STRATEGY_VERSION = 'btc-midpoint-trigger-ladder-v2';

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

  const elapsedMs = now - start;
  if (elapsedMs < ENTRY_DELAY_MS) {
    return {
      eligible: false,
      status: 'waiting_for_delay',
      elapsedMs,
      reason: 'Waiting for the window to open',
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

  const qualifyingSides = ['UP', 'DOWN']
    .filter(side => Number.isFinite(values[side]) && values[side] >= ENTRY_TRIGGER_MIDPOINT)
    .sort((a, b) => values[b] - values[a] || (a === 'UP' ? -1 : 1));
  if (freshSides.length === 0) {
    return {
      eligible: false,
      status: 'waiting_for_fresh_quotes',
      elapsedMs,
      upMid: values.UP,
      downMid: values.DOWN,
      freshSides,
      reason: 'Waiting for at least one fresh UP or DOWN midpoint quote',
    };
  }
  const selectedSide = qualifyingSides[0] || null;
  const eligible = selectedSide !== null;
  return {
    eligible,
    status: eligible ? 'eligible' : 'watching_for_trigger',
    elapsedMs,
    upMid: values.UP,
    downMid: values.DOWN,
    freshSides,
    qualifyingSides,
    selectedSide,
    triggeringPrice: selectedSide ? values[selectedSide] : null,
    triggerPrice: ENTRY_TRIGGER_MIDPOINT,
    selectionReason: !selectedSide
      ? null
      : qualifyingSides.length > 1
        ? 'HIGHEST_QUALIFYING_MIDPOINT'
        : 'MIDPOINT_TRIGGER',
    strategyVersion: STRATEGY_VERSION,
    reason: eligible
      ? `${selectedSide} midpoint reached ${values[selectedSide].toFixed(3)} during the window`
      : 'Waiting for a fresh UP or DOWN midpoint to reach $0.80 or higher',
  };
}

function evaluateSourceExit() {
  return null;
}

function parseMarketArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolvedMarketPayout(market, { marketId, tokenId, outcome } = {}) {
  if (!market
    || String(market.id) !== String(marketId)
    || market.closed !== true
    || market.umaResolutionStatus !== 'resolved') return null;
  const prices = parseMarketArray(market.outcomePrices)
    .map(value => value === '0' || value === '1' ? Number(value) : value);
  const tokens = parseMarketArray(market.positionIds || market.clobTokenIds || market.outcomeTokenIds);
  const outcomes = parseMarketArray(market.outcomes);
  if (prices.length !== 2 || !prices.every(price => price === 0 || price === 1)
    || prices[0] + prices[1] !== 1) return null;
  let index = tokenId
    ? tokens.findIndex(token => String(token) === String(tokenId))
    : -1;
  if (index < 0 && outcome) {
    index = outcomes.findIndex(value => String(value?.name || value?.label || value).toUpperCase() === String(outcome).toUpperCase());
  }
  return index >= 0 && index < prices.length ? prices[index] : null;
}

function windowStartFor(now, timeframe) {
  const windowMs = WINDOW_CONFIG[timeframe];
  if (!windowMs) throw new Error(`Unsupported BTC timeframe: ${timeframe}`);
  return Math.floor(now / windowMs) * windowMs;
}

module.exports = {
  WINDOW_CONFIG,
  STRATEGY_TIMEFRAMES,
  ENTRY_RUNGS,
  ENTRY_DELAY_MS,
  ENTRY_TRIGGER_MIDPOINT,
  QUOTE_MAX_AGE_MS,
  STRATEGY_VERSION,
  quoteFromBook,
  evaluateWindow,
  evaluateSourceExit,
  resolvedMarketPayout,
  windowStartFor,
};
