'use strict';

const STRATEGY = Object.freeze({
  id: 'btc-5m-closed-candle-multiframe-6-4-2-20261125',
  name: 'BTC 5-minute closed-candle model',
  version: 2,
  assets: ['BTC'],
  timeframes: ['5m'],
  candleLookbacks: Object.freeze({ '5m': 6, '15m': 4, '1h': 2 }),
  candleWeights: Object.freeze({ '5m': 0.65, '15m': 0.25, '1h': 0.10 }),
  sharesPerBuyDecision: 50,
  reviewIntervalMs: 15_000,
  minimumProbability: 0.58,
  minimumNetEdgePerShare: 0.05,
  exitAdvantagePerShare: 0.03,
  maximumBuyPrice: 0.99,
  minimumTimeRemainingSeconds: 15,
  execution: 'PAPER ONLY',
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => value != null && value !== '' && Number.isFinite(Number(value));
const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
};

function candleSummary(candles = [], limit = 6, timeframe = null) {
  const recent = candles
    .filter((candle) =>
      finite(candle.open)
      && finite(candle.close)
      && Number(candle.open) > 0
      && Number(candle.close) > 0)
    .slice(-limit);
  if (!recent.length) {
    return {
      timeframe,
      score: null,
      count: 0,
      required: limit,
      weightedReturn: null,
      persistence: null,
      volatility: null,
      bias: 'WAITING',
    };
  }
  const returns = recent.map((candle) =>
    (Number(candle.close) - Number(candle.open)) / Number(candle.open));
  const weights = returns.map((_, index) => index + 1);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const weightedReturn = returns.reduce((sum, value, index) => sum + value * weights[index], 0) / weightTotal;
  const volatility = Math.sqrt(
    returns.reduce((sum, value, index) => sum + value ** 2 * weights[index], 0) / weightTotal,
  );
  const persistence = returns.reduce((sum, value, index) =>
    sum + Math.sign(value) * weights[index], 0) / weightTotal;
  const normalizedDrift = volatility > 0 ? weightedReturn / volatility : 0;
  const score = clamp(Math.tanh(normalizedDrift * 0.9 + persistence * 0.45), -1, 1);
  return {
    timeframe,
    score: round(score),
    count: recent.length,
    required: limit,
    weightedReturn: round(weightedReturn),
    persistence: round(persistence),
    volatility: round(volatility),
    returns: returns.map((value) => round(value)),
    bias: score > 0.025 ? 'UP' : score < -0.025 ? 'DOWN' : 'MIXED',
  };
}

function directionalEstimate({ candleSets = {}, candles = null } = {}) {
  const inputs = {
    ...candleSets,
    ...(candles && !candleSets['5m'] ? { '5m': candles } : {}),
  };
  const timeframes = Object.fromEntries(Object.entries(STRATEGY.candleLookbacks).map(([timeframe, count]) => [
    timeframe,
    candleSummary(inputs[timeframe] || [], count, timeframe),
  ]));
  const components = Object.entries(STRATEGY.candleWeights).map(([timeframe, weight]) => ({
    key: `closedCandles${timeframe}`,
    timeframe,
    weight,
    score: timeframes[timeframe].score,
    count: timeframes[timeframe].count,
    required: timeframes[timeframe].required,
  }));
  const ready = components.every((component) => component.score != null
    && component.count >= component.required);
  const combinedScore = ready
    ? components.reduce((sum, component) => sum + component.score * component.weight, 0)
    : null;
  const probabilityUp = ready
    ? round(clamp(0.5 + combinedScore * 0.43, 0.02, 0.98), 4)
    : null;
  return {
    ready,
    probabilityUp,
    probabilityDown: probabilityUp == null ? null : round(1 - probabilityUp, 4),
    combinedScore: combinedScore == null ? null : round(combinedScore, 4),
    components,
    timeframes,
  };
}

function buildQuestion(prompt, answer, reason, detail = null) {
  return { prompt, answer, reason, detail };
}

module.exports = {
  STRATEGY,
  clamp,
  round,
  candleSummary,
  directionalEstimate,
  buildQuestion,
};
