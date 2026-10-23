'use strict';

const MINUTE_MS = 60_000;
const OBSERVATION_MS = 5 * MINUTE_MS;
const DIRECTION_HOLD_MS = MINUTE_MS;
const MAX_QUOTE_AGE_MS = 5_000;
const MAX_PRICE_AGE_MS = 15_000;
const MIN_EDGE = 0.10;
const MAX_SPREAD = 0.02;
const KELLY_FRACTION = 0.25;
const MAX_BANKROLL_FRACTION = 0.08;

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return Math.max(0, Math.min(1, 0.5 * (1 + sign * erf)));
}

function directionHeld(ticks, side, now, holdMs = DIRECTION_HOLD_MS) {
  const relevant = (ticks || []).filter(x => Number.isFinite(x?.ts)
    && Number.isFinite(x?.price) && x.ts >= now - holdMs - 5_000 && x.ts <= now)
    .sort((a, b) => a.ts - b.ts);
  if (relevant.length < 2) return false;
  const first = relevant[0], last = relevant.at(-1);
  if (first.ts > now - holdMs || now - last.ts > MAX_PRICE_AGE_MS) return false;
  return side === 'UP' ? last.price > first.price : last.price < first.price;
}

function volatilityPerMinute(candles) {
  const closes = (candles || []).filter(x => Number.isFinite(x?.t) && Number.isFinite(x?.c) && x.c > 0)
    .sort((a, b) => a.t - b.t).slice(-61);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const elapsed = closes[i].t - closes[i - 1].t;
    if (elapsed > 0 && elapsed <= 2 * MINUTE_MS) {
      returns.push(Math.log(closes[i].c / closes[i - 1].c) / Math.sqrt(elapsed / MINUTE_MS));
    }
  }
  if (returns.length < 10) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const sigma = Math.sqrt(variance);
  return Number.isFinite(sigma) && sigma > 0 ? sigma : null;
}

function lastHourRangePercent(candles) {
  const rows = (candles || []).filter(x => Number.isFinite(x?.t) && Number.isFinite(x?.c) && x.c > 0)
    .sort((a, b) => a.t - b.t).slice(-60);
  if (rows.length < 50) return null;
  const high = Math.max(...rows.map(x => Number.isFinite(x.h) ? x.h : x.c));
  const low = Math.min(...rows.map(x => Number.isFinite(x.l) ? x.l : x.c));
  return (high - low) / rows.at(-1).c;
}

function estimateUpProbability({ spot, strike, remainingMs, candles }) {
  if (!(spot > 0) || !(strike > 0) || !(remainingMs > 0)) return null;
  const sigma = volatilityPerMinute(candles);
  if (sigma == null) return null;
  const z = Math.log(spot / strike) / (sigma * Math.sqrt(remainingMs / MINUTE_MS));
  return normalCdf(z);
}

function evaluateArticleEntry({ now, windowStart, windowMs, referencePrice, ticks, candles, quotes, capital, cash, feePerShare }) {
  const elapsed = now - windowStart;
  const lastEntryAt = windowMs - 3 * MINUTE_MS;
  if (elapsed < OBSERVATION_MS) return { ready: false, reason: 'Observing the first five minutes' };
  if (elapsed >= lastEntryAt) return { ready: false, reason: 'Too little time remains for the article exit rules' };
  if (!(referencePrice > 0)) return { ready: false, reason: 'Waiting for the BTC reference price from market open' };
  const latest = (ticks || []).filter(x => Number.isFinite(x?.ts) && Number.isFinite(x?.price))
    .sort((a, b) => a.ts - b.ts).at(-1);
  if (!latest || now - latest.ts > MAX_PRICE_AGE_MS) return { ready: false, reason: 'BTC price feed is stale' };
  const fairUp = estimateUpProbability({
    spot: latest.price, strike: referencePrice, remainingMs: windowMs - elapsed, candles,
  });
  if (fairUp == null) return { ready: false, reason: 'Not enough recent BTC volatility data for the probability proxy' };
  const hourlyRange = lastHourRangePercent(candles);
  if (hourlyRange == null) return { ready: false, reason: 'Waiting for at least 50 minutes of BTC range data' };
  if (hourlyRange < 0.003) return { ready: false, reason: 'Low-volatility filter: BTC range is below 0.3% over the last hour', fairUp, hourlyRange };

  const candidates = [];
  for (const side of ['UP', 'DOWN']) {
    if (!directionHeld(ticks, side, now)) continue;
    const quote = quotes?.[side], ask = Number(quote?.bestAsk), bid = Number(quote?.bestBid);
    if (quote?.status !== 'LIVE' || !Number.isFinite(quote.updatedAt)
      || now - quote.updatedAt > MAX_QUOTE_AGE_MS || !(ask > 0 && ask < 1) || !(bid > 0)) continue;
    if (ask - bid < 0 || ask - bid > MAX_SPREAD) continue;
    const fairProbability = side === 'UP' ? fairUp : 1 - fairUp;
    const fee = typeof feePerShare === 'function' ? Number(feePerShare(side, ask)) : Number(feePerShare);
    const effectivePrice = ask + (Number.isFinite(fee) ? fee : 0);
    const edge = fairProbability - effectivePrice;
    if (edge < MIN_EDGE || effectivePrice >= 1) continue;
    const quarterKelly = KELLY_FRACTION * Math.max(0, edge / (1 - effectivePrice));
    const stakeUsd = Math.min(cash, capital * MAX_BANKROLL_FRACTION, capital * quarterKelly);
    const shares = Math.floor(stakeUsd / effectivePrice);
    if (shares < 1) continue;
    candidates.push({ side, ask, bid, spread: ask - bid, fairProbability, fairUp,
      edge, shares, stakeUsd: shares * effectivePrice, kellyFraction: quarterKelly,
      effectivePrice, spot: latest.price, referencePrice });
  }
  candidates.sort((a, b) => b.edge - a.edge);
  return candidates.length
    ? { ready: true, reason: 'Confirmed 60-second BTC direction and probability-proxy edge', candidate: candidates[0] }
    : { ready: false, reason: 'No confirmed direction with at least a 10-point proxy edge and ≤2¢ spread', fairUp };
}

module.exports = {
  OBSERVATION_MS, DIRECTION_HOLD_MS, MIN_EDGE, MAX_SPREAD, KELLY_FRACTION,
  MAX_BANKROLL_FRACTION, directionHeld, volatilityPerMinute, lastHourRangePercent, estimateUpProbability,
  evaluateArticleEntry,
};
