'use strict';

function sampleTime(sample) {
  const value = Number(sample && (sample.sampledAt ?? sample.receivedAt ?? sample.ts ?? sample.timestamp));
  return Number.isFinite(value) ? value : null;
}

function samplePrice(sample) {
  const value = Number(sample && sample.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function computeOneSecondMove(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const lookbackMs = Number(options.lookbackMs) || 1000;
  const toleranceMs = Number(options.toleranceMs) || 250;
  const valid = samples
    .map((sample) => ({ sample, at: sampleTime(sample), price: samplePrice(sample) }))
    .filter((item) => item.at != null && item.price != null)
    .sort((a, b) => a.at - b.at);
  if (valid.length < 2) return null;

  const current = valid[valid.length - 1];
  let baseline = null;
  let bestDifference = Infinity;
  for (const candidate of valid.slice(0, -1)) {
    const age = current.at - candidate.at;
    if (age <= 0) continue;
    const difference = Math.abs(age - lookbackMs);
    if (difference < bestDifference) {
      bestDifference = difference;
      baseline = { ...candidate, age };
    }
  }
  if (!baseline || bestDifference > toleranceMs) return null;

  return {
    fromPrice: baseline.price,
    toPrice: current.price,
    changeUsd: current.price - baseline.price,
    lookbackMs: baseline.age,
    receivedAt: Number(current.sample.receivedAt) || current.at,
  };
}

function sideForMove(changeUsd, thresholdUsd = 10) {
  const change = Number(changeUsd);
  const threshold = Number(thresholdUsd);
  if (!Number.isFinite(change) || !Number.isFinite(threshold) || threshold <= 0) return null;
  if (change >= threshold) return 'UP';
  if (change <= -threshold) return 'DOWN';
  return null;
}

module.exports = { computeOneSecondMove, sideForMove };