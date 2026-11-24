'use strict';

const STRATEGY = Object.freeze({
  id: 'btc-5m-explainable-model-independent-sides-50-per-decision-20261124',
  name: 'BTC 5-minute explainable decision model',
  version: 1,
  assets: ['BTC'],
  timeframes: ['5m'],
  sharesPerBuyDecision: 50,
  reviewIntervalMs: 15_000,
  pressureSampleIntervalMs: 1_000,
  pressureLookbackSamples: 10,
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

function pressureSummary(samples = []) {
  const usable = samples
    .filter((sample) => finite(sample.score))
    .slice(-STRATEGY.pressureLookbackSamples);
  if (!usable.length) {
    return {
      score: null,
      count: 0,
      persistence: null,
      slope: null,
      acceleration: null,
    };
  }
  const scores = usable.map((sample) => clamp(Number(sample.score), -1, 1));
  const last = scores.at(-1);
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const direction = Math.sign(last);
  const persistence = direction === 0 ? 0
    : scores.filter((score) => Math.sign(score) === direction).length / scores.length;
  const slope = scores.length < 2 ? 0 : (scores.at(-1) - scores[0]) / (scores.length - 1);
  const firstSlope = scores.length < 3 ? slope
    : (scores.at(-2) - scores[0]) / (scores.length - 2);
  const acceleration = slope - firstSlope;
  const score = clamp(
    last * 0.45
      + mean * 0.20
      + clamp(slope * 5, -1, 1) * 0.20
      + clamp(acceleration * 8, -1, 1) * 0.10
      + direction * persistence * 0.05,
    -1,
    1,
  );
  return {
    score: round(score),
    count: scores.length,
    persistence: round(persistence),
    slope: round(slope),
    acceleration: round(acceleration),
  };
}

function candleSummary(candles = []) {
  const recent = candles.slice(-3).filter((candle) =>
    finite(candle.open) && finite(candle.close) && Number(candle.open) > 0);
  if (!recent.length) return { score: null, count: 0, rmsReturn: null };
  const returns = recent.map((candle) =>
    (Number(candle.close) - Number(candle.open)) / Number(candle.open));
  const rmsReturn = Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0) / returns.length);
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const normalized = rmsReturn > 0 ? meanReturn / rmsReturn : Math.sign(meanReturn);
  return {
    score: round(Math.tanh(normalized * 0.55)),
    count: recent.length,
    rmsReturn: round(rmsReturn),
    returns: returns.map((value) => round(value)),
  };
}

function sampledPriceTrend(samples = []) {
  const priced = samples
    .filter((sample) => finite(sample.price) && Number(sample.price) > 0)
    .slice(-STRATEGY.pressureLookbackSamples);
  if (priced.length < 2) return { score: null, changePct: null, count: priced.length };
  const first = Number(priced[0].price);
  const last = Number(priced.at(-1).price);
  const changePct = (last - first) / first;
  return {
    score: round(Math.tanh(changePct / 0.00012)),
    changePct: round(changePct),
    count: priced.length,
  };
}

function directionalEstimate({
  price,
  windowOpen,
  secondsRemaining,
  candles = [],
  pressureSamples = [],
  upMid = null,
  downMid = null,
}) {
  const pressure = pressureSummary(pressureSamples);
  const candle = candleSummary(candles);
  const shortTrend = sampledPriceTrend(pressureSamples);
  const components = [];
  if (finite(price) && finite(windowOpen) && Number(windowOpen) > 0) {
    const movePct = (Number(price) - Number(windowOpen)) / Number(windowOpen);
    const remainingRatio = clamp(Number(secondsRemaining) / 300, 0.02, 1);
    const observedVol = candle.rmsReturn || Math.abs(shortTrend.changePct || 0) || 0.00002;
    const expectedRemainingVol = Math.max(observedVol * Math.sqrt(remainingRatio), 0.00002);
    const zScore = movePct / expectedRemainingVol;
    components.push({
      key: 'windowMove',
      weight: 0.32,
      score: clamp(Math.tanh(zScore * 0.45), -1, 1),
      movePct: round(movePct),
      zScore: round(zScore),
      remainingVol: round(expectedRemainingVol),
    });
  }
  if (pressure.score != null) {
    components.push({ key: 'tradePressure', weight: 0.30, score: pressure.score });
  }
  if (shortTrend.score != null) {
    components.push({ key: 'oneSecondTrend', weight: 0.16, score: shortTrend.score });
  }
  if (candle.score != null) {
    components.push({ key: 'closedCandles', weight: 0.10, score: candle.score });
  }
  let impliedUp = null;
  if (finite(upMid) && finite(downMid)) {
    impliedUp = clamp((Number(upMid) + (1 - Number(downMid))) / 2, 0.02, 0.98);
    components.push({
      key: 'polymarketMidpoints',
      weight: 0.12,
      score: clamp((impliedUp - 0.5) * 2, -1, 1),
    });
  }
  const weightTotal = components.reduce((sum, component) => sum + component.weight, 0);
  const combinedScore = weightTotal
    ? components.reduce((sum, component) => sum + component.score * component.weight, 0) / weightTotal
    : 0;
  const probabilityUp = round(clamp(0.5 + combinedScore * 0.43, 0.02, 0.98), 4);
  return {
    probabilityUp,
    probabilityDown: round(1 - probabilityUp, 4),
    combinedScore: round(combinedScore, 4),
    impliedUp,
    components,
    pressure,
    candle,
    shortTrend,
  };
}

function buildQuestion(prompt, answer, reason, detail = null) {
  return { prompt, answer, reason, detail };
}

module.exports = {
  STRATEGY,
  clamp,
  round,
  pressureSummary,
  candleSummary,
  sampledPriceTrend,
  directionalEstimate,
  buildQuestion,
};
