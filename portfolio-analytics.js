'use strict';

const SETTLED_STATUSES = new Set([
  'SETTLED_WIN',
  'SETTLED_LOSS',
  'SETTLED_EXIT',
]);

function summarizeCombinedResults(positions = []) {
  const settled = positions.filter((position) => SETTLED_STATUSES.has(position.status)
    && position.realizedPnl != null
    && Number.isFinite(Number(position.realizedPnl)));
  const wins = settled.filter((position) => Number(position.realizedPnl) > 0).length;
  const losses = settled.filter((position) => Number(position.realizedPnl) < 0).length;
  const breakEven = settled.length - wins - losses;

  return {
    settled: settled.length,
    wins,
    losses,
    breakEven,
    winRate: settled.length ? (wins / settled.length) * 100 : 0,
  };
}

function maximumConcurrentWindowExposure(positions = [], now = Date.now()) {
  const windows = new Map();

  for (const position of positions) {
    if (!position || position.status === 'CANCELLED_UNFILLED') continue;

    const windowStart = Number(position.windowStart);
    const cost = Number(position.totalCost ?? position.cost);
    if (!Number.isFinite(windowStart) || !Number.isFinite(cost) || cost <= 0) continue;

    const openedAt = Number(position.openedAt ?? position.filledAt
      ?? position.submittedAt ?? windowStart);
    if (!Number.isFinite(openedAt)) continue;

    const settledAt = position.settledAt == null ? Number.NaN : Number(position.settledAt);
    const hasSettlement = SETTLED_STATUSES.has(position.status)
      && Number.isFinite(settledAt);
    const endAt = hasSettlement ? Math.max(openedAt, settledAt) : null;
    const record = windows.get(windowStart) || {
      windowStart,
      slug: position.slug || null,
      title: position.title || null,
      events: [],
      maxExposure: 0,
      maxAt: null,
    };

    record.events.push({ at: openedAt, delta: cost });
    if (endAt != null) record.events.push({ at: endAt, delta: -cost });
    windows.set(windowStart, record);
  }

  let maximum = {
    windowStart: null,
    slug: null,
    title: null,
    amount: 0,
    at: null,
  };

  for (const window of windows.values()) {
    window.events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let exposure = 0;
    for (const event of window.events) {
      exposure = Math.max(0, exposure + event.delta);
      if (exposure > window.maxExposure) {
        window.maxExposure = exposure;
        window.maxAt = event.at;
      }
    }
    if (window.maxExposure > maximum.amount) {
      maximum = {
        windowStart: window.windowStart,
        slug: window.slug,
        title: window.title,
        amount: window.maxExposure,
        at: window.maxAt,
      };
    }
  }

  return maximum;
}

module.exports = {
  summarizeCombinedResults,
  maximumConcurrentWindowExposure,
};
