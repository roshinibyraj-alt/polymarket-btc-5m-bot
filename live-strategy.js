'use strict';

const WINDOW_CONFIG = Object.freeze({
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
});
const STRATEGY_TIMEFRAMES = Object.freeze(['5m']);
const CANDLE_WINDOW_MS = 5 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const ENTRY_RUNGS = Object.freeze([
  Object.freeze({ price: 0.40, shares: 10 }),
  Object.freeze({ price: 0.60, shares: 20 }),
]);

const ENTRY_DELAY_MS = 0;
const ENTRY_TRIGGER_MIDPOINT = 0.80;
const QUOTE_MAX_AGE_MS = 5_000;
const STRATEGY_VERSION = 'btc-midpoint-trigger-ladder-v3';
const { candleColor } = require('./candle-strategy');

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

function previousCandleFilter(minuteCandles, windowStart) {
  const candleStart = Number(windowStart) - CANDLE_WINDOW_MS;
  const byStart = new Map((Array.isArray(minuteCandles) ? minuteCandles : [])
    .map(row => [Number(row?.t), row]));
  const rows = [];
  for (let index = 0; index < CANDLE_WINDOW_MS / MINUTE_MS; index++) {
    const row = byStart.get(candleStart + index * MINUTE_MS);
    if (!row) {
      return {
        status: 'unavailable',
        color: null,
        allowedSide: null,
        previous: null,
        reason: 'Waiting for all five Chainlink BTC/USD minute bars from the previous 5-minute candle',
      };
    }
    rows.push(row);
  }

  const open = Number(rows[0].o);
  const close = Number(rows.at(-1).c);
  const highs = rows.map(row => Number(row.h));
  const lows = rows.map(row => Number(row.l));
  if (![open, close, ...highs, ...lows].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      color: null,
      allowedSide: null,
      previous: null,
      reason: 'Previous BTC 5-minute candle has invalid OHLC data',
    };
  }
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const color = candleColor(open, close, high, low);
  const allowedSide = color === 'GREEN' ? 'UP' : color === 'RED' ? 'DOWN' : null;
  return {
    status: 'ready',
    color,
    allowedSide,
    previous: { start: candleStart, end: Number(windowStart), open, close, high, low, color },
    reason: color === 'DOJI'
      ? 'Previous BTC 5-minute candle is a doji; no directional restriction'
      : `Previous BTC 5-minute candle was ${color.toLowerCase()}; only ${allowedSide} entries are allowed`,
  };
}

function evaluateWindow({ now = Date.now(), market, quotes, startedAt = null, candleFilter } = {}) {
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
      candleFilter: candleFilter || null,
      reason: 'Waiting for at least one fresh UP or DOWN midpoint quote',
    };
  }
  if (candleFilter?.status !== 'ready') {
    return {
      eligible: false,
      status: 'waiting_for_previous_candle',
      elapsedMs,
      upMid: values.UP,
      downMid: values.DOWN,
      freshSides,
      qualifyingSides,
      selectedSide: null,
      candleFilter: candleFilter || null,
      reason: candleFilter?.reason || 'Waiting for the previous closed BTC 5-minute candle',
    };
  }
  const permittedSides = candleFilter.allowedSide
    ? [candleFilter.allowedSide]
    : ['UP', 'DOWN'];
  const permittedQualifyingSides = qualifyingSides.filter(side => permittedSides.includes(side));
  const selectedSide = permittedQualifyingSides[0] || null;
  const eligible = selectedSide !== null;
  const oppositeSideQualified = qualifyingSides.length > 0 && !eligible;
  return {
    eligible,
    status: eligible ? 'eligible' : oppositeSideQualified ? 'waiting_for_candle_side_trigger' : 'watching_for_trigger',
    elapsedMs,
    upMid: values.UP,
    downMid: values.DOWN,
    freshSides,
    qualifyingSides,
    permittedQualifyingSides,
    selectedSide,
    triggeringPrice: selectedSide ? values[selectedSide] : null,
    triggerPrice: ENTRY_TRIGGER_MIDPOINT,
    candleFilter,
    selectionReason: !selectedSide
      ? null
      : candleFilter.allowedSide
        ? 'PREVIOUS_CANDLE_DIRECTION'
        : qualifyingSides.length > 1
        ? 'HIGHEST_QUALIFYING_MIDPOINT'
        : 'MIDPOINT_TRIGGER',
    strategyVersion: STRATEGY_VERSION,
    reason: eligible
      ? `${selectedSide} midpoint reached $${values[selectedSide].toFixed(3)}; previous candle filter allows ${selectedSide}`
      : oppositeSideQualified
        ? `Price trigger reached ${qualifyingSides.join(' and ')}, but previous ${candleFilter.color.toLowerCase()} candle allows only ${candleFilter.allowedSide}; waiting for ${candleFilter.allowedSide} midpoint to reach $0.80`
        : candleFilter.allowedSide
          ? `Previous ${candleFilter.color.toLowerCase()} candle allows only ${candleFilter.allowedSide}; waiting for a fresh midpoint to reach $0.80`
          : 'Previous candle is a doji; waiting for a fresh UP or DOWN midpoint to reach $0.80 or higher',
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
  previousCandleFilter,
  evaluateWindow,
  evaluateSourceExit,
  resolvedMarketPayout,
  windowStartFor,
};
