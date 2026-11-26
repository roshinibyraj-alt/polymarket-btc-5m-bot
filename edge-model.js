'use strict';

const RULES = Object.freeze({
  id: 'btc-5m-selective-edge-paper-v2-cadence',
  name: 'BTC Edge Lab',
  minimumHistory: 60,
  minimumElapsedSeconds: 20,
  lastEntrySecond: 240,
  maximumDataAgeMs: 2000,
  minimumProbability: 0.52,
  minimumNetEdge: null,
  probabilityHaircut: 0.03,
  minimumAsk: 0.05,
  maximumAsk: 0.95,
  maximumSpread: null,
  slippageReserve: 0.01,
  maxShares: 50,
  perWindowFraction: 0.005,
  perWindowDollarCap: 15,
  maximumOpenFraction: 0.02,
  drawdownLimitFraction: 0.05,
  confirmations: 2,
  decisionIntervalMs: 1000,
  fillLatencyMs: 300,
  depthParticipation: 0.5,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const rms = xs => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function forecast({ feed, market, now }) {
  const no = reason => ({ ready: false, reason, proxy: true });
  if (!market || !(Number(market.start) <= now && now < Number(market.end))) return no('No active BTC window.');
  if (feed.status !== 'CONNECTED' || feed.messageAgeMs == null
    || feed.messageAgeMs > RULES.maximumDataAgeMs || !(Number(feed.price) > 0)
    || !Number.isFinite(Number(feed.tickAt)) || Number(feed.tickAt) < now - RULES.maximumDataAgeMs
    || Number(feed.tickAt) > now + 1000) return no('Waiting for a fresh Binance trade tick.');
  const candles = (feed.closedCandles || []).filter(c => c.closed !== false
    && Number(c.closeAt) < now && Number(c.open) > 0 && Number(c.close) > 0)
    .sort((a, b) => a.start - b.start).slice(-120);
  if (candles.length < RULES.minimumHistory) return no('Warming up: 60 completed one-minute candles required.');
  if (candles.some(c => !(Number(c.high) >= Math.max(Number(c.open), Number(c.close)))
    || !(Number(c.low) > 0 && Number(c.low) <= Math.min(Number(c.open), Number(c.close))))) {
    return no('Invalid candle ranges; forecast paused rather than substituting volatility.');
  }
  // Never bridge missing candles or silently turn an old series into current volatility.
  if (now - candles.at(-1).closeAt > 90_000
    || candles.slice(-60).some((c, i, a) => i && c.start - a[i - 1].start !== 60_000)) {
    return no('Candle history is stale or has gaps.');
  }
  const anchorCandle = [...candles, feed.currentCandle].find(c => c && Number(c.start) === Number(market.start));
  if (!(Number(anchorCandle?.open) > 0)) return no('Waiting for the Binance window-open reference.');
  const price = Number(feed.price);
  const anchor = Number(anchorCandle.open);
  const returns = candles.map(c => Math.log(c.close / c.open));
  const slow = rms(returns.slice(-60));
  const fast = rms(returns.slice(-10));
  const range = rms(candles.slice(-30).map(c => Math.log(c.high / c.low))) / Math.sqrt(4 * Math.log(2));
  const sigma = Math.max(slow, fast, range, 0.00012);
  const remainingSeconds = Math.max(1, (market.end - now) / 1000);
  // Final-60s TWAP averages a Brownian path: variance is T - 2L/3 before
  // the averaging interval begins. Entries close at second 240, at that boundary.
  const twap = /twap|time-weighted/i.test(market.raw?.description || '')
    || market.raw?.cryptoMarketConfig?.twapEnabled === true;
  const effectiveMinutes = Math.max(1 / 60, (remainingSeconds - (twap ? 40 : 0)) / 60);
  const sd = sigma * Math.sqrt(effectiveMinutes);
  const recent = returns.slice(-5).reduce((a, x) => a + x, 0) / 5;
  const drift = clamp(recent, -sigma * 0.25, sigma * 0.25) * effectiveMinutes * 0.25;
  const distance = Math.log(price / anchor);
  // Binance is a proxy, not the Chainlink strike. Evaluate an adverse strike
  // displacement as well as high-volatility and momentum alternatives.
  const basisBufferUsd = Math.max(15, price * sigma * 0.5);
  const basis = basisBufferUsd / anchor;
  const rawUp = normalCdf((distance + drift) / sd);
  const probabilities = [];
  for (const v of [1, 1.5]) for (const d of [0, drift]) for (const b of [-basis, basis]) {
    probabilities.push(normalCdf((distance + d + b) / (sd * v)));
  }
  return {
    ready: true, proxy: true, price, anchor, remainingSeconds, rawUp,
    lowerUp: clamp(Math.min(...probabilities) - RULES.probabilityHaircut, 0.01, 0.99),
    lowerDown: clamp(1 - Math.max(...probabilities) - RULES.probabilityHaircut, 0.01, 0.99),
    sigmaPerMinute: sigma, basisBufferUsd, twap, historyCandles: candles.length,
    reason: 'Experimental Binance proxy forecast; conservative bounds are scenario estimates, not calibrated guarantees.',
  };
}

function marketFee(market) {
  if (market?.feesEnabled === false) return { rate: 0, exponent: 1 };
  const schedule = market?.feeSchedule;
  if (market?.feesEnabled !== true || schedule?.rate == null) return null;
  const rate = Number(schedule.rate);
  const exponent = Number(schedule.exponent ?? 1);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1 || exponent !== 1) return null;
  return { rate, exponent };
}

function freshQuote(quote, market, side, now) {
  const id = String(market?.id || market?.slug);
  return quote?.updatedAt != null && quote?.receivedAt != null
    && Number.isFinite(quote.updatedAt) && Number.isFinite(quote.receivedAt)
    && now - quote.updatedAt >= -1000 && now - quote.updatedAt <= RULES.maximumDataAgeMs
    && now - quote.receivedAt >= 0 && now - quote.receivedAt <= RULES.maximumDataAgeMs
    && quote.marketId === id && quote.tokenId === String(market.tokens?.[side])
    && Number(quote.windowStart) === Number(market.start)
    && Number(quote.windowEnd) === Number(market.end)
    && Number(quote.bestBid) > 0 && Number(quote.bestAsk) < 1
    && Number(quote.bestBid) <= Number(quote.bestAsk);
}

function candidate({ model, quote, market, side, now, budget }) {
  const probability = side === 'UP' ? model.lowerUp : model.lowerDown;
  const base = { side, estimate: side === 'UP' ? model.rawUp : 1 - model.rawUp,
    conservativeProbability: probability, bestAsk: quote?.bestAsk ?? null, eligible: false };
  const no = reason => ({ ...base, reason });
  if (!freshQuote(quote, market, side, now)) return no('Stale, missing, crossed, or wrong-window book.');
  const spread = quote.bestAsk - quote.bestBid;
  base.spread = spread;
  if (quote.bestAsk < RULES.minimumAsk || quote.bestAsk > RULES.maximumAsk) {
    return no('Ask outside $0.05–$0.95 value-entry band.');
  }
  const fee = marketFee(market);
  if (!fee) return no('Unknown or unsupported fee schedule; no fee-free assumption.');
  // Probability and estimated edge no longer limit executable ask prices.
  // Keep the explicit entry-price band, visible depth and capital budget.
  const maxPrice = RULES.maximumAsk;
  const requestedShares = Math.min(RULES.maxShares,
    Math.floor(budget / (quote.bestAsk + fee.rate * quote.bestAsk * (1 - quote.bestAsk)
      + RULES.slippageReserve)));
  const fills = [];
  let remaining = requestedShares;
  let cost = 0;
  let fees = 0;
  for (const level of [...(quote.asks || [])].sort((a, b) => a.price - b.price)) {
    const price = Number(level.price);
    const shares = Math.min(remaining, Number(level.size) * RULES.depthParticipation);
    if (!(price >= quote.bestAsk && price <= maxPrice) || !(shares > 0)) continue;
    const f = shares * fee.rate * price * (1 - price);
    if (cost + fees + shares * price + f > budget + 1e-8) break;
    fills.push({ price, shares, fee: f });
    cost += shares * price;
    fees += f;
    remaining -= shares;
    if (remaining < 1e-8) break;
  }
  const filledShares = requestedShares - remaining;
  const allInCost = filledShares > 0 ? (cost + fees) / filledShares : null;
  const netEdge = allInCost == null ? null : probability - allInCost - RULES.slippageReserve;
  Object.assign(base, { requestedShares, filledShares, allInCost, netEdge, cost, fees, fills,
    averagePrice: filledShares > 0 ? cost / filledShares : null, feeRate: fee.rate });
  if (probability < RULES.minimumProbability) return no('Conservative chance below 52%.');
  if (filledShares < 5 || cost < 1) return no('Insufficient executable ask depth within the price band and capital budget (minimum 5 shares and $1 cost).');
  return { ...base, eligible: true, reason: 'Probability threshold met with executable asks within the price band and capital budget; spread and estimated edge are informational only.' };
}

module.exports = { RULES, forecast, candidate, marketFee, freshQuote, normalCdf };
