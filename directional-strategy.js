'use strict';

const DEFAULT_BLOCK_MS = 10_000;
const DEFAULT_INITIAL_BLOCKS = 12;

function sampleTime(sample) {
  const value = Number(sample && (sample.sampledAt ?? sample.receivedAt ?? sample.ts ?? sample.timestamp));
  return Number.isFinite(value) ? value : null;
}

function samplePrice(sample) {
  const value = Number(sample && sample.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function previousCloseSample(samples, windowOpenMs, maxAgeMs = 5000) {
  const openAt = Number(windowOpenMs);
  if (!Array.isArray(samples) || !Number.isFinite(openAt)) return null;
  let closest = null;
  for (const sample of samples) {
    const at = sampleTime(sample);
    const price = samplePrice(sample);
    if (at == null || price == null || at > openAt) continue;
    if (!closest || at > closest.sampledAt) closest = { price, sampledAt: at };
  }
  if (!closest || openAt - closest.sampledAt > Math.max(0, Number(maxAgeMs) || 0)) return null;
  return { ...closest, ageMs: openAt - closest.sampledAt };
}

function computeTenSecondProjection(samples, options = {}) {
  const baselinePrice = samplePrice({ price: options.baselinePrice });
  const openAt = Number(options.windowOpenMs);
  const nowAt = Number(options.nowMs);
  const closeAt = Number(options.windowCloseMs);
  const blockMs = Math.max(1000, Number(options.blockMs) || DEFAULT_BLOCK_MS);
  const initialBlocks = Math.max(1, Math.floor(Number(options.initialBlocks) || DEFAULT_INITIAL_BLOCKS));
  const initialMs = blockMs * initialBlocks;
  const minSamples = Math.max(2, Math.floor(Number(options.minSamplesPerBlock) || 2));
  const maxGapMs = Math.max(blockMs / 2, Number(options.maxSampleGapMs) || 5000);
  const base = {
    phase: 'waiting_for_baseline', baselinePrice, initialDriftUsdPer10s: null,
    recentRateUsdPer10s: null, projectedClose: null, projectedDeltaUsd: null,
    remainingSeconds: null, elapsedSeconds: Number.isFinite(nowAt) && Number.isFinite(openAt)
      ? Math.max(0, (nowAt - openAt) / 1000) : 0,
    completedBlocks: 0, side: null, observedAt: Number.isFinite(nowAt) ? nowAt : null,
  };
  if (baselinePrice == null || !Number.isFinite(openAt) || !Number.isFinite(nowAt)
    || !Number.isFinite(closeAt) || closeAt <= openAt || !Array.isArray(samples)) return base;

  const elapsedMs = nowAt - openAt;
  if (elapsedMs < initialMs) return { ...base, phase: 'building_initial_averages' };
  const completedBlocks = Math.min(
    Math.floor((nowAt - openAt) / blockMs),
    Math.ceil((closeAt - openAt) / blockMs),
  );
  const aggregates = Array.from({ length: completedBlocks }, () => ({ sum: 0, count: 0, lastAt: null }));
  for (const sample of samples) {
    const at = sampleTime(sample);
    const price = samplePrice(sample);
    if (at == null || price == null || at < openAt || at >= nowAt) continue;
    const index = Math.floor((at - openAt) / blockMs);
    if (index < 0 || index >= completedBlocks) continue;
    const aggregate = aggregates[index];
    aggregate.sum += price;
    aggregate.count += 1;
    aggregate.lastAt = at;
  }
  const blocks = aggregates.map((aggregate, index) => {
    const endMs = openAt + (index + 1) * blockMs;
    const ready = aggregate.count >= minSamples && aggregate.lastAt != null
      && endMs - aggregate.lastAt <= maxGapMs;
    return {
      index, startMs: openAt + index * blockMs, endMs,
      sampleCount: aggregate.count,
      averagePrice: ready ? aggregate.sum / aggregate.count : null,
      ready,
    };
  });
  const initial = blocks.slice(0, initialBlocks);
  if (initial.length < initialBlocks || initial.some((block) => !block.ready)) {
    return { ...base, phase: 'insufficient_initial_block_data', completedBlocks };
  }
  const initialEndMs = openAt + initialMs;
  const initialEndpoint = samples.reduce((best, sample) => {
    const at = sampleTime(sample);
    const price = samplePrice(sample);
    if (at == null || price == null || at < initialEndMs - blockMs || at >= initialEndMs) return best;
    return !best || at > best.sampledAt ? { price, sampledAt: at } : best;
  }, null);
  if (!initialEndpoint || initialEndMs - initialEndpoint.sampledAt > maxGapMs) {
    return { ...base, phase: 'insufficient_initial_block_data', completedBlocks };
  }
  const initialDrift = (initialEndpoint.price - baselinePrice) / initialBlocks;
  const enriched = {
    ...base,
    baselinePrice,
    initialDriftUsdPer10s: initialDrift,
    completedBlocks,
    initialPrice: initialEndpoint.price,
  };
  const future = blocks.filter((block) => block.index >= initialBlocks && block.ready);
  const latest = future[future.length - 1];
  const previous = future.length > 1 ? future[future.length - 2] : null;
  if (!latest || !previous || latest.index !== previous.index + 1) {
    return { ...enriched, phase: 'waiting_for_20_second_trend' };
  }
  const current = samples.reduce((best, sample) => {
    const at = sampleTime(sample);
    const price = samplePrice(sample);
    if (at == null || price == null || at < openAt || at > nowAt) return best;
    return !best || at > best.sampledAt ? { price, sampledAt: at } : best;
  }, null);
  if (!current) return { ...enriched, phase: 'waiting_for_current_price' };
  const recentRate = (latest.averagePrice - previous.averagePrice)
    / (latest.index - previous.index);
  const remainingMs = Math.max(0, closeAt - nowAt);
  const projectedClose = current.price + recentRate * (remainingMs / blockMs);
  const projectedDeltaUsd = projectedClose - baselinePrice;
  const side = projectedDeltaUsd > 1e-9 ? 'UP' : projectedDeltaUsd < -1e-9 ? 'DOWN' : null;
  return {
    ...enriched,
    phase: side ? 'projection_ready' : 'projected_at_baseline',
    recentRateUsdPer10s: recentRate,
    projectedClose,
    projectedDeltaUsd,
    remainingSeconds: remainingMs / 1000,
    currentPrice: current.price,
    trendFromMs: previous.startMs,
    trendToMs: latest.endMs,
    side,
  };
}

module.exports = { previousCloseSample, computeTenSecondProjection };
