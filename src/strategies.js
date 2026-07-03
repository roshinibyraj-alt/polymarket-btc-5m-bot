// src/strategies.js — each strategy consumes the same predictor outputs but combines
// them differently, producing a trade decision: { trade: bool, side: 'up'|'down', confidence }
// This is where you encode *how* a prediction type gets turned into an action.

const config = require('../config');

function dirSign(d) { return d === 'up' ? 1 : d === 'down' ? -1 : 0; }

// Weighted vote across all predictors, weighted by each one's own confidence.
function consensusStrategy(signals) {
  const list = Object.values(signals);
  let score = 0, weight = 0;
  for (const s of list) {
    score += dirSign(s.direction) * s.confidence;
    weight += s.confidence;
  }
  if (weight === 0) return { trade: false };
  const netScore = score / list.length; // -1..1 roughly
  const side = netScore > 0 ? 'up' : netScore < 0 ? 'down' : null;
  const confidence = Math.abs(netScore);
  if (!side || confidence < config.minConfidenceToTrade) return { trade: false };
  return { trade: true, side, confidence, basis: 'consensus' };
}

// Fast, order-flow-only: order book + trade flow imbalance must agree.
function orderFlowScalpStrategy(signals) {
  const { orderFlow, orderBook } = signals;
  if (orderFlow.direction === 'flat' || orderBook.direction === 'flat') return { trade: false };
  if (orderFlow.direction !== orderBook.direction) return { trade: false };
  const confidence = (orderFlow.confidence + orderBook.confidence) / 2;
  if (confidence < config.minConfidenceToTrade) return { trade: false };
  return { trade: true, side: orderFlow.direction, confidence, basis: 'orderFlowScalp' };
}

// Trend-following: momentum + volatility breakout, both must point the same way.
function momentumFollowStrategy(signals) {
  const { momentum, volBreakout } = signals;
  if (momentum.direction === 'flat') return { trade: false };
  // volBreakout is optional confirmation — if it fired and disagrees, skip.
  if (volBreakout.direction !== 'flat' && volBreakout.direction !== momentum.direction) {
    return { trade: false };
  }
  const confidence = volBreakout.direction === 'flat'
    ? momentum.confidence
    : (momentum.confidence + volBreakout.confidence) / 2;
  if (confidence < config.minConfidenceToTrade) return { trade: false };
  return { trade: true, side: momentum.direction, confidence, basis: 'momentumFollow' };
}

// Contrarian: only the mean-reversion predictor, requires a stretched z-score.
function meanReversionStrategy(signals) {
  const { meanReversion } = signals;
  if (meanReversion.direction === 'flat') return { trade: false };
  if (meanReversion.confidence < config.minConfidenceToTrade) return { trade: false };
  return { trade: true, side: meanReversion.direction, confidence: meanReversion.confidence, basis: 'meanReversion' };
}

// Opportunistic: whichever single predictor is most confident this window, if it clears
// a stricter bar. This tends to fire less often but on (theoretically) cleaner signals.
function highConvictionAnyStrategy(signals) {
  const strictBar = Math.max(config.minConfidenceToTrade, 0.7);
  let best = null;
  for (const s of Object.values(signals)) {
    if (s.direction === 'flat') continue;
    if (!best || s.confidence > best.confidence) best = s;
  }
  if (!best || best.confidence < strictBar) return { trade: false };
  return { trade: true, side: best.direction, confidence: best.confidence, basis: `highConviction:${best.name}` };
}

// Registry — add/remove strategies here. Each runs with its own paper bankroll.
const STRATEGIES = {
  consensus: consensusStrategy,
  orderFlowScalp: orderFlowScalpStrategy,
  momentumFollow: momentumFollowStrategy,
  meanReversion: meanReversionStrategy,
  highConvictionAny: highConvictionAnyStrategy,
};

module.exports = { STRATEGIES };
