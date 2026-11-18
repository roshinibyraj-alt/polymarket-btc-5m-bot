'use strict';

const config = require('./config');
const WickBot = require('./wick-bot');
const BinanceTickFeed = require('./binance-tick-feed');
const ClobMarketFeed = require('./clob-feed');
const defaultMarketData = require('./wick-market-data');
const { feeFor } = WickBot._test;
const {
  summarizeCombinedResults,
  maximumConcurrentWindowExposure,
} = require('./portfolio-analytics');

const EPSILON = 1e-9;
const SIDES = ['UP', 'DOWN'];

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pressureTrend(samples, sampleLimit = config.PRESSURE_SAMPLE_COUNT) {
  const values = samples.map((sample) => Number(sample.score))
    .filter(Number.isFinite)
    .slice(-sampleLimit);
  if (values.length < 2) {
    return {
      sampleCount: values.length,
      pressureTrendSlope: null,
      pressurePersistence: null,
      pressureAcceleration: null,
      pressureImpulse: null,
    };
  }

  const centerX = (values.length - 1) / 2;
  const centerY = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const x = index - centerX;
    numerator += x * (values[index] - centerY);
    denominator += x * x;
  }
  const slope = denominator > 0 ? numerator / denominator : 0;
  const direction = Math.sign(values.at(-1));
  const persistence = direction === 0
    ? 0
    : values.filter((value) => Math.sign(value) === direction).length / values.length;
  const split = Math.floor(values.length / 2);
  const acceleration = mean(values.slice(split)) - mean(values.slice(0, split));
  const normalizedSlope = clamp(slope * (values.length - 1));
  const persistenceBias = direction === 0 ? 0 : (persistence - 0.5) * 2 * direction;
  const impulse = clamp(
    0.40 * values.at(-1)
    + 0.25 * normalizedSlope
    + 0.20 * acceleration
    + 0.15 * persistenceBias,
  );
  return {
    sampleCount: values.length,
    pressureTrendSlope: slope,
    pressurePersistence: persistence,
    pressureAcceleration: acceleration,
    pressureImpulse: impulse,
  };
}

function projectPressureClose({
  currentPrice,
  previousClose,
  pressureImpulse,
  volatilityPerSecond: volatility,
  secondsRemaining,
}) {
  const price = Number(currentPrice);
  const reference = Number(previousClose);
  const impulse = Number(pressureImpulse);
  const perSecondVolatility = Number(volatility);
  const remaining = Number(secondsRemaining);
  if (!(price > 0 && reference > 0)
    || !Number.isFinite(impulse)
    || !Number.isFinite(perSecondVolatility)
    || perSecondVolatility < 0
    || !(remaining > 0)) return null;

  const pressureWeightedReturn = clamp(impulse) * perSecondVolatility * Math.sqrt(remaining);
  const projectedClose = price * Math.exp(pressureWeightedReturn);
  if (!Number.isFinite(projectedClose)) return null;
  const projectedMoveFromPreviousPct = ((projectedClose - reference) / reference) * 100;
  const side = projectedClose > reference
    ? 'UP'
    : projectedClose < reference ? 'DOWN' : null;
  return {
    projectedClose,
    pressureWeightedReturn,
    projectedMoveFromPreviousPct,
    side,
  };
}

function volatilityPerSecond(samples, sampleLimit = config.PRESSURE_SAMPLE_COUNT) {
  const prices = samples.slice(-sampleLimit)
    .map((sample) => Number(sample.price))
    .filter((price) => price > 0);
  if (prices.length < 3) return null;
  const returns = [];
  for (let index = 1; index < prices.length; index += 1) {
    returns.push(Math.log(prices[index] / prices[index - 1]));
  }
  return Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0) / returns.length);
}

function adaptiveShadowSampleCount(start, now) {
  const elapsed = Math.max(0, Number(now) - Number(start));
  const reductions = Math.floor(elapsed / config.PRESSURE_SHADOW_STEP_MS);
  return Math.max(
    config.PRESSURE_SHADOW_MIN_SAMPLE_COUNT,
    config.PRESSURE_SAMPLE_COUNT - reductions,
  );
}

function summarizePortfolio(positions, cash, initialCapital, historicalOffset = null) {
  const open = positions.filter((position) => position.status === 'OPEN');
  const pending = positions.filter((position) => position.status === 'PENDING_CLOB_RESULT');
  const settled = positions.filter((position) => position.realizedPnl != null
    && Number.isFinite(Number(position.realizedPnl))
    && !['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status));
  const realizedPnl = settled.reduce((total, position) => total + Number(position.realizedPnl), 0)
    + Number(historicalOffset?.realizedPnl || 0);
  const floatingPnl = open.reduce((total, position) => {
    if (position.markBid == null) return total;
    const bid = Number(position.markBid);
    if (!Number.isFinite(bid) || bid < 0) return total;
    return total + (bid * Number(position.shares)) - Number(position.totalCost || 0);
  }, Number(historicalOffset?.floatingPnl || 0));
  return {
    initialCapital,
    cash,
    entries: positions.length + Number(historicalOffset?.entries || 0),
    settledEntries: settled.length + Number(historicalOffset?.settledEntries || 0),
    wins: settled.filter((position) => Number(position.realizedPnl) > 0).length
      + Number(historicalOffset?.wins || 0),
    losses: settled.filter((position) => Number(position.realizedPnl) < 0).length
      + Number(historicalOffset?.losses || 0),
    openPositions: open.length + Number(historicalOffset?.openPositions || 0),
    awaitingResolution: pending.length + Number(historicalOffset?.awaitingResolution || 0),
    realizedPnl,
    floatingPnl,
    totalPnl: realizedPnl + floatingPnl,
  };
}

function summarizeWindowPositions(positions, windowStart) {
  return Object.fromEntries(SIDES.map((side) => {
    const matching = positions.filter((position) => Number(position.windowStart) === Number(windowStart)
      && position.side === side
      && position.status === 'OPEN'
      && Number(position.shares) > 0);
    const shares = matching.reduce((total, position) => total + Number(position.shares), 0);
    const totalCost = matching.reduce((total, position) => {
      const sharesForPosition = Number(position.shares);
      const cost = position.totalCost != null && Number.isFinite(Number(position.totalCost))
        ? Number(position.totalCost)
        : Number(position.avgEntry ?? position.averagePrice ?? 0) * sharesForPosition;
      return total + cost;
    }, 0);
    return [side, {
      side,
      shares,
      totalCost,
      averageCostPerShare: shares > EPSILON ? totalCost / shares : null,
      positionCount: matching.length,
    }];
  }));
}

function summarizeWindowOutcomeScenarios(positions, windowStart) {
  const matching = positions.filter((position) =>
    Number(position.windowStart) === Number(windowStart)
    && Number(position.initialShares ?? position.shares) > 0);
  const totalEntryCost = matching.reduce((total, position) => {
    const shares = Number(position.initialShares ?? position.shares);
    const cost = position.totalCost != null && Number.isFinite(Number(position.totalCost))
      ? Number(position.totalCost)
      : (Number(position.avgEntry ?? position.averagePrice ?? 0) * shares)
        + Number(position.entryFees ?? position.fees ?? 0);
    return total + cost;
  }, 0);
  const knownExitProceeds = matching.reduce((total, position) => {
    if (position.status === 'OPEN' || position.status === 'PENDING_CLOB_RESULT') return total;
    const proceeds = position.exitProceeds ?? position.proceeds;
    return total + (Number.isFinite(Number(proceeds)) ? Number(proceeds) : 0);
  }, 0);
  const openShares = Object.fromEntries(SIDES.map((side) => [
    side,
    matching.filter((position) => position.side === side && position.status === 'OPEN')
      .reduce((total, position) => total + Number(position.shares || 0), 0),
  ]));
  const upPayoutIfUpWins = knownExitProceeds + openShares.UP;
  const downPayoutIfDownWins = knownExitProceeds + openShares.DOWN;
  return {
    windowStart,
    totalEntryCost,
    knownExitProceeds,
    openShares,
    positionCount: matching.length,
    upWins: {
      payout: upPayoutIfUpWins,
      netPnl: upPayoutIfUpWins - totalEntryCost,
    },
    downWins: {
      payout: downPayoutIfDownWins,
      netPnl: downPayoutIfDownWins - totalEntryCost,
    },
  };
}

function sweepBook(levels, shares, action, market, {
  minimumPrice = 0,
  maximumPrice = Infinity,
  consume = false,
} = {}) {
  const ordered = (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .filter((level) => action !== 'SELL' || level.price + EPSILON >= minimumPrice)
    .filter((level) => action !== 'BUY' || level.price <= maximumPrice + EPSILON)
    .sort((a, b) => action === 'BUY' ? a.price - b.price : b.price - a.price);

  let remaining = Number(shares);
  let gross = 0;
  let fees = 0;
  const fills = [];
  for (const level of ordered) {
    if (remaining <= EPSILON) break;
    const filled = Math.min(remaining, level.size);
    gross += filled * level.price;
    fees += feeFor(market || {}, level.price, filled);
    fills.push({ price: level.price, shares: filled });
    remaining -= filled;
  }
  const filledShares = Number(shares) - remaining;
  if (consume && remaining <= EPSILON) {
    const sourceLevels = Array.isArray(levels) ? levels : [];
    for (const fill of fills) {
      let toConsume = fill.shares;
      for (const level of sourceLevels) {
        if (Math.abs(Number(level.price) - fill.price) > EPSILON || toConsume <= EPSILON) continue;
        const used = Math.min(toConsume, Number(level.size) || 0);
        level.size = Math.max(0, Number(level.size) - used);
        toConsume -= used;
      }
    }
  }
  return {
    complete: remaining <= EPSILON,
    requestedShares: Number(shares),
    filledShares,
    remainingShares: Math.max(0, remaining),
    gross,
    fees,
    averagePrice: filledShares > EPSILON ? gross / filledShares : null,
    netProceeds: gross - fees,
    totalCost: gross + fees,
    fills,
  };
}

function evaluatePressureCandidate(side, signalSide, quote) {
  const bestAsk = Number(quote?.bestAsk);
  const isSelected = side === signalSide;
  const hasUsableAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk < 1;
  const belowSignalPriceLimit = hasUsableAsk
    && bestAsk < config.PRESSURE_MAX_SIGNAL_SIDE_PRICE;
  const underPriceCap = hasUsableAsk
    && bestAsk <= config.PRESSURE_MAX_BUY_PRICE + EPSILON;
  let reason = `${side} is not the side selected by the projected close.`;

  if (isSelected && !hasUsableAsk) {
    reason = `The projected close selected ${side}; waiting for a fresh CLOB ask to execute.`;
  } else if (isSelected && !belowSignalPriceLimit) {
    reason = `The projected close selected ${side}, but its ask must be below $${config.PRESSURE_MAX_SIGNAL_SIDE_PRICE.toFixed(2)}.`;
  } else if (isSelected && !underPriceCap) {
    reason = `The projected close selected ${side}, but its ask is above the existing $${config.PRESSURE_MAX_BUY_PRICE.toFixed(2)} execution cap.`;
  } else if (isSelected) {
    reason = `The projected close selected ${side}; its current ask is below $${config.PRESSURE_MAX_SIGNAL_SIDE_PRICE.toFixed(2)}.`;
  }

  return {
    selectedByPressure: isSelected,
    bestAsk: hasUsableAsk ? bestAsk : null,
    maxSignalSidePrice: config.PRESSURE_MAX_SIGNAL_SIDE_PRICE,
    belowSignalPriceLimit,
    priceCap: config.PRESSURE_MAX_BUY_PRICE,
    requestedShares: config.PRESSURE_ENTRY_SHARES,
    qualifies: isSelected && belowSignalPriceLimit && underPriceCap,
    reason,
  };
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function resolvedPayout(market, position) {
  if (!market || typeof market !== 'object') return null;
  const status = String(
    market.umaResolutionStatus || market.resolutionStatus || market.status || '',
  ).toLowerCase();
  const isResolved = market.resolved === true || market.closed === true
    || ['resolved', 'finalized', 'settled'].includes(status);
  if (!isResolved) return null;

  const prices = parseArray(market.outcomePrices).map(Number);
  if (prices.length !== 2 || !prices.every((price) => price === 0 || price === 1)
    || prices[0] + prices[1] !== 1) return null;
  const outcomes = parseArray(market.outcomes);
  const tokens = parseArray(market.positionIds || market.clobTokenIds || market.outcomeTokenIds);
  let index = position.tokenId
    ? tokens.findIndex((token) => String(token) === String(position.tokenId))
    : -1;
  if (index < 0) {
    index = outcomes.findIndex((outcome) =>
      String(outcome?.name || outcome?.label || outcome).toUpperCase() === position.side);
  }
  return index >= 0 && index < prices.length ? prices[index] : null;
}

class PressureForecastBot extends WickBot {
  constructor({
    now = Date.now,
    marketData = defaultMarketData,
    priceFeed = null,
    clobFeedFactory = (options) => new ClobMarketFeed(options),
    initialCapital = config.DEMO_CAPITAL_5M,
  } = {}) {
    const feed = priceFeed || new BinanceTickFeed({ now });
    super({
      asset: 'BTC',
      timeframe: '5m',
      windowMs: config.WINDOW_MS_5M,
      capital: initialCapital,
      strategyMode: 'pressure-forecast',
      priceFeed: feed,
    });
    this.now = now;
    this.marketData = marketData;
    this.clobFeedFactory = clobFeedFactory;
    this.clobFeed = null;
    this.clobFeedMarketKey = null;
    this.initialCapital = initialCapital;
    this.strategyName = 'BTC 5-minute Binance pressure projection paper bot';
    this.strategyMode = 'pressure-forecast';
    this.pressureSamples = [];
    this.lastSampleAt = null;
    this.forecast = this.emptyForecast('Waiting for fresh Binance pressure data.');
    this.lastEntryAt = null;
    this.lastEntryAtBySide = { UP: null, DOWN: null };
    this.pendingEntries = { UP: null, DOWN: null };
    this.quoteUpdateSequence = { UP: 0, DOWN: 0 };
    this.shadowCash = initialCapital;
    this.shadowPositions = [];
    this.shadowStatsOffset = null;
    this.shadowInitialCapital = initialCapital;
    this.shadowLastEntryAt = null;
    this.shadowLastEntryAtBySide = { UP: null, DOWN: null };
    this.shadowSequence = 0;
    this.shadowSamplesRequired = config.PRESSURE_SAMPLE_COUNT;
    this.shadowForecast = this.emptyForecast('Waiting for live data for the adaptive shadow comparison.');
    this.lastResolutionCheckAt = new Map();
    this.actionSequence = 0;
    this.resolutions = [];
    this.persistenceStore = null;
    this.persistenceDirty = false;
    this.lastPersistedAt = 0;
    this.paperHistoryResetVersion = null;
  }

  log(event, data = {}) {
    super.log(event, data);
    this.persistenceDirty = true;
  }

  attachPersistenceStore(store) {
    this.persistenceStore = store;
  }

  serializePersistentState() {
    const market = this.market ? {
      id: this.market.id,
      slug: this.market.slug,
      title: this.market.title,
      start: this.market.start,
      end: this.market.end,
      tokens: this.market.tokens,
      feesEnabled: this.market.feesEnabled,
      feeSchedule: this.market.feeSchedule,
    } : null;
    return {
      schemaVersion: 1,
      paperHistoryResetVersion: this.paperHistoryResetVersion,
      capital: this.capital,
      cash: this.cash,
      startedAt: this.startedAt,
      positions: this.positions,
      orders: this.orders,
      events: this.events,
      resolutions: this.resolutions,
      market,
      orderWindowStart: this.orderWindowStart,
      quoteWindowStart: this.quoteWindowStart,
      liveQuotes: this.liveQuotes,
      pressureSamples: this.pressureSamples,
      lastSampleAt: this.lastSampleAt,
      lastEntryAt: this.lastEntryAt,
      lastEntryAtBySide: this.lastEntryAtBySide,
      shadowCash: this.shadowCash,
      shadowPositions: this.shadowPositions,
      shadowStatsOffset: this.shadowStatsOffset,
      shadowInitialCapital: this.shadowInitialCapital,
      shadowLastEntryAt: this.shadowLastEntryAt,
      shadowLastEntryAtBySide: this.shadowLastEntryAtBySide,
      shadowSequence: this.shadowSequence,
      shadowSamplesRequired: this.shadowSamplesRequired,
      shadowForecast: this.shadowForecast,
      forecast: this.forecast,
      actionSequence: this.actionSequence,
      completedWindows: [...this.completedWindows.entries()],
      lastResolutionCheckAt: [...this.lastResolutionCheckAt.entries()],
    };
  }

  restorePersistentState(state) {
    if (state?.schemaVersion !== 1
      || !Array.isArray(state.positions)
      || !Number.isFinite(Number(state.cash))
      || !Number.isFinite(Number(state.capital))) {
      throw new Error('Paper history import did not contain a valid portfolio snapshot');
    }

    this.capital = Number(state.capital);
    this.paperHistoryResetVersion = state.paperHistoryResetVersion || null;
    this.initialCapital = this.capital;
    this.cash = Number(state.cash);
    this.startedAt = Number(state.startedAt) || this.now();
    this.positions = state.positions;
    this.orders = Array.isArray(state.orders) ? state.orders : [];
    this.events = Array.isArray(state.events)
      ? state.events.map((event) => ({ ...event, ts: Number(event.ts ?? event.at) || this.now() })).slice(0, 100)
      : [];
    this.resolutions = Array.isArray(state.resolutions) ? state.resolutions : [];
    this.market = state.market || null;
    this.lastMarketAt = 0;
    this.orderWindowStart = Number.isFinite(Number(state.orderWindowStart))
      ? Number(state.orderWindowStart)
      : null;
    this.quoteWindowStart = Number.isFinite(Number(state.quoteWindowStart))
      ? Number(state.quoteWindowStart)
      : this.orderWindowStart;
    this.windowOrders = this.orders.filter((order) =>
      Number(order.windowStart) === Number(this.orderWindowStart));
    this.liveQuotes = state.liveQuotes || { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.pressureSamples = Array.isArray(state.pressureSamples)
      ? state.pressureSamples.filter((sample) => sample.scoreSource === 'BINANCE_PRESSURE_V1')
      : [];
    this.lastSampleAt = this.pressureSamples.length
      ? Number(this.pressureSamples.at(-1).at)
      : null;
    this.lastEntryAt = Number.isFinite(Number(state.lastEntryAt)) ? Number(state.lastEntryAt) : null;
    this.lastEntryAtBySide = state.lastEntryAtBySide || { UP: null, DOWN: null };
    this.pendingEntries = { UP: null, DOWN: null };
    this.quoteUpdateSequence = { UP: 0, DOWN: 0 };
    this.shadowCash = Number.isFinite(Number(state.shadowCash))
      ? Number(state.shadowCash)
      : this.capital;
    this.shadowPositions = Array.isArray(state.shadowPositions) ? state.shadowPositions : [];
    this.shadowStatsOffset = state.shadowStatsOffset || null;
    this.shadowInitialCapital = Number(state.shadowInitialCapital) || this.capital;
    this.shadowLastEntryAt = Number.isFinite(Number(state.shadowLastEntryAt))
      ? Number(state.shadowLastEntryAt)
      : null;
    this.shadowLastEntryAtBySide = state.shadowLastEntryAtBySide || { UP: null, DOWN: null };
    this.shadowSequence = Number(state.shadowSequence) || 0;
    this.shadowSamplesRequired = Number(state.shadowSamplesRequired) || config.PRESSURE_SAMPLE_COUNT;
    this.shadowForecast = this.emptyForecast(
      'Collecting fresh Binance pressure samples for the adaptive shadow comparison.',
      'COLLECTING_SAMPLES',
    );
    this.forecast = this.emptyForecast(
      'Collecting fresh Binance pressure samples after the strategy update.',
      'COLLECTING_SAMPLES',
    );
    this.actionSequence = Number(state.actionSequence) || 0;
    this.completedWindows = new Map(Array.isArray(state.completedWindows) ? state.completedWindows : []);
    this.lastResolutionCheckAt = new Map(
      Array.isArray(state.lastResolutionCheckAt) ? state.lastResolutionCheckAt : [],
    );
    this.status = 'starting';
    this.error = null;
    this.persistenceDirty = false;
    this.lastPersistedAt = this.now();
  }

  restoreFromSnapshot(snapshot) {
    if (snapshot?.mode !== 'DEMO ONLY'
      || !Array.isArray(snapshot.positions)
      || !snapshot.account
      || !Array.isArray(snapshot.account.equityCurve)
      || !Array.isArray(snapshot.events)
      || !Array.isArray(snapshot.resolutions)
      || !Number.isFinite(Number(snapshot.account.capital))
      || !Number.isFinite(Number(snapshot.account.cash))) {
      throw new Error('The running dashboard did not return a complete demo-only paper ledger');
    }
    const reportedSettledTrades = Number(snapshot.account.settledTrades);
    if (Number.isFinite(reportedSettledTrades) && snapshot.positions.length < reportedSettledTrades) {
      throw new Error('The running dashboard returned fewer positions than its settled-trade count');
    }

    const windowStart = Number(snapshot.window?.start ?? snapshot.markets?.['5m']?.windowStart);
    const positions = snapshot.positions;
    const orders = Array.isArray(snapshot.orders)
      ? snapshot.orders
      : (snapshot.markets?.['5m']?.orders || []);
    const lastEntryAtBySide = { UP: null, DOWN: null };
    for (const position of positions) {
      if (Number(position.windowStart) !== windowStart || !SIDES.includes(position.side)) continue;
      const filledAt = Number(position.filledAt ?? position.openedAt ?? position.submittedAt);
      if (Number.isFinite(filledAt)) {
        lastEntryAtBySide[position.side] = Math.max(lastEntryAtBySide[position.side] || 0, filledAt);
      }
    }
    for (const order of orders) {
      if (Number(order.windowStart) !== windowStart || !SIDES.includes(order.side)) continue;
      if (order.action !== 'BUY' || order.status !== 'FILLED') continue;
      const filledAt = Number(order.filledAt ?? order.createdAt);
      if (Number.isFinite(filledAt)) {
        lastEntryAtBySide[order.side] = Math.max(lastEntryAtBySide[order.side] || 0, filledAt);
      }
    }
    const sequenceValues = [...positions, ...orders].map((item) => {
      const match = String(item.id || '').match(/-(\d+)$/);
      return match ? Number(match[1]) : 0;
    });
    const shadow = snapshot.shadowComparison?.adaptive || null;
    const marketSnapshot = snapshot.markets?.['5m'];
    const completedByWindow = new Map();
    const positionsByWindow = new Map();
    for (const position of positions) {
      if (!positionsByWindow.has(position.windowStart)) positionsByWindow.set(position.windowStart, []);
      positionsByWindow.get(position.windowStart).push(position);
    }
    for (const [start, windowPositions] of positionsByWindow) {
      if (windowPositions.length && windowPositions.every((position) =>
        !['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status))) {
        completedByWindow.set(start, Math.max(...windowPositions.map((position) =>
          Number(position.settledAt ?? position.closedAt ?? position.resolvedAt) || this.now())));
      }
    }

    this.restorePersistentState({
      schemaVersion: 1,
      capital: snapshot.account.capital,
      cash: snapshot.account.cash,
      startedAt: snapshot.account.equityCurve?.[0]?.ts || snapshot.now,
      positions,
      orders,
      events: snapshot.events || [],
      resolutions: snapshot.resolutions || [],
      market: snapshot.window ? {
        id: null,
        slug: snapshot.window.slug || marketSnapshot?.slug || null,
        title: snapshot.window.title || marketSnapshot?.title || 'BTC 5-minute UP/DOWN',
        start: windowStart,
        end: snapshot.window.end ?? marketSnapshot?.windowEnd,
        tokens: {},
        feesEnabled: false,
      } : null,
      orderWindowStart: Number.isFinite(windowStart) ? windowStart : null,
      quoteWindowStart: Number.isFinite(windowStart) ? windowStart : null,
      liveQuotes: snapshot.quotes || marketSnapshot?.quotes,
      pressureSamples: [],
      lastSampleAt: null,
      lastEntryAt: Math.max(...Object.values(lastEntryAtBySide).filter(Number.isFinite), 0) || null,
      lastEntryAtBySide,
      shadowCash: Number.isFinite(Number(shadow?.cash))
        ? Number(shadow.cash)
        : Number(snapshot.account.capital),
      shadowPositions: [],
      shadowStatsOffset: shadow,
      shadowInitialCapital: Number.isFinite(Number(shadow?.initialCapital))
        ? Number(shadow.initialCapital)
        : Number(snapshot.account.capital),
      shadowLastEntryAt: null,
      shadowLastEntryAtBySide: { UP: null, DOWN: null },
      shadowSequence: 0,
      shadowSamplesRequired: Number(snapshot.shadowComparison?.activeSampleCount)
        || config.PRESSURE_SAMPLE_COUNT,
      shadowForecast: snapshot.shadowComparison?.currentForecast || null,
      forecast: snapshot.forecast,
      actionSequence: Math.max(0, ...sequenceValues),
      completedWindows: [...completedByWindow.entries()],
      lastResolutionCheckAt: [],
    });
  }

  async persistState(force = false) {
    if (!this.persistenceStore) return;
    const now = this.now();
    if (!force && !this.persistenceDirty && now - this.lastPersistedAt < 30_000) return;
    await this.persistenceStore.save(this.serializePersistentState());
    this.persistenceDirty = false;
    this.lastPersistedAt = now;
  }

  emptyForecast(reason, status = 'WAITING_FOR_DATA') {
    return {
      ready: false,
      calibrated: false,
      status,
      reason,
      signalSource: 'BINANCE_PRESSURE_CLOSE_PROJECTION',
      pressureScore: null,
      pressureImpulse: null,
      previousCandleClose: null,
      previousCloseSource: null,
      projectedClose: null,
      projectedMoveFromPreviousPct: null,
      selectedSide: null,
      executionPriceCap: config.PRESSURE_MAX_BUY_PRICE,
      entryShares: config.PRESSURE_ENTRY_SHARES,
      sampleCount: 0,
      requiredSamples: config.PRESSURE_SAMPLE_COUNT,
      pressureTrendSlope: null,
      pressurePersistence: null,
      pressureAcceleration: null,
      btcMoveFromOpenPct: null,
      volatilityPerSecond: null,
      secondsRemaining: null,
      candidateBySide: {
        UP: this.emptyCandidate('Waiting for 10 valid one-second samples.'),
        DOWN: this.emptyCandidate('Waiting for 10 valid one-second samples.'),
      },
    };
  }

  emptyCandidate(reason) {
    return {
      selectedByPressure: false,
      bestAsk: null,
      maxSignalSidePrice: config.PRESSURE_MAX_SIGNAL_SIDE_PRICE,
      priceCap: config.PRESSURE_MAX_BUY_PRICE,
      requestedShares: config.PRESSURE_ENTRY_SHARES,
      qualifies: false,
      reason,
    };
  }

  openStrategyWindow(start, now) {
    for (const side of SIDES) {
      const pending = this.pendingEntries?.[side];
      if (pending) {
        this.log('PAPER_PRESSURE_ENTRY_EXPIRED_WAITING_FOR_TICK', {
          side,
          shares: pending.shares,
          windowStart: pending.windowStart,
        });
      }
    }
    this.orderWindowStart = start;
    this.windowOrders = [];
    this.windowFiredEntries = 0;
    this.lastFiredEntryShares = 0;
    this.initialEntrySide = null;
    this.initialEntryAt = null;
    this.quoteWindowStart = start;
    this.liveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.pressureSamples = [];
    this.lastSampleAt = null;
    this.lastEntryAt = null;
    this.lastEntryAtBySide = { UP: null, DOWN: null };
    this.pendingEntries = { UP: null, DOWN: null };
    this.quoteUpdateSequence = { UP: 0, DOWN: 0 };
    this.shadowLastEntryAt = null;
    this.shadowLastEntryAtBySide = { UP: null, DOWN: null };
    this.shadowSamplesRequired = config.PRESSURE_SAMPLE_COUNT;
    this.shadowForecast = this.emptyForecast(
      'Collecting ten fresh one-second samples for the adaptive shadow comparison.',
      'COLLECTING_SAMPLES',
    );
    this.signal = null;
    this.forecast = this.emptyForecast('Collecting ten fresh one-second pressure samples.', 'COLLECTING_SAMPLES');
    this.log('PAPER_PRESSURE_WINDOW_STARTED', {
      windowStart: start,
      samplesRequired: config.PRESSURE_SAMPLE_COUNT,
      entryShares: config.PRESSURE_ENTRY_SHARES,
      entryDelayMs: config.PRESSURE_ENTRY_DELAY_MS,
      takeProfitTrigger: config.PRESSURE_TAKE_PROFIT_TRIGGER,
      takeProfitTriggerFields: ['BEST_BID', 'MIDPOINT', 'BEST_ASK'],
      stopLossTrigger: config.PRESSURE_STOP_LOSS_TRIGGER,
      stopLossTriggerField: 'BEST_BID',
    });
  }

  async tick() {
    const now = this.now();
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    try {
      await this.closePreviousWindows(start, now);
      await this.resolvePendingPositions(now);
      if (!this.market || this.market.start !== start
        || now - this.lastMarketAt > config.MARKET_REFRESH_MS) {
        this.market = await this.marketData.getBtcMarket(start, this.windowMs);
        this.lastMarketAt = now;
        if (!this.market) {
          this.status = 'waiting_for_market';
          this.lastScanAt = now;
          this.forecast = this.emptyForecast('Waiting for the current BTC 5-minute Polymarket market.');
          return;
        }
      }

      if (this.orderWindowStart !== start) this.openStrategyWindow(start, now);
      this.ensureClobFeed();
      await this.refreshLiveQuotes(now);
      this.processPositionExits(start, now);
      this.processPressureStrategy(start, now);
      this.lastScanAt = now;
      this.error = null;
      this.status = this.positions.some((position) =>
        position.windowStart === start && position.status === 'OPEN')
        ? 'position_open'
        : 'scanning';
    } catch (error) {
      this.status = 'blocked_or_error';
      this.error = error.message || String(error);
      if (this.lastError !== this.error || now - (this.lastErrorAt || 0) > 30_000) {
        this.lastError = this.error;
        this.lastErrorAt = now;
        this.log('PAPER_PRESSURE_SCAN_ERROR', { error: this.error });
      }
    }
  }

  ensureClobFeed() {
    if (!this.market?.tokens?.UP || !this.market?.tokens?.DOWN) return;
    const assetIds = [String(this.market.tokens.UP), String(this.market.tokens.DOWN)];
    const marketKey = `${this.market.start}:${assetIds.join(':')}`;
    if (this.clobFeed && this.clobFeedMarketKey === marketKey) return;

    this.clobFeed?.stop?.();
    this.clobFeedMarketKey = marketKey;
    this.liveQuotes = {
      UP: { status: 'MISSING', stale: true, source: 'POLYMARKET_CLOB_WEBSOCKET' },
      DOWN: { status: 'MISSING', stale: true, source: 'POLYMARKET_CLOB_WEBSOCKET' },
    };
    this.clobFeed = this.clobFeedFactory({
      assetIds,
      now: this.now,
      onQuote: (assetId, quote) => this.handleClobQuote(assetId, quote),
    });
    this.clobFeed.start?.();
  }

  handleClobQuote(assetId, quote) {
    const side = SIDES.find((candidate) =>
      String(this.market?.tokens?.[candidate]) === String(assetId));
    if (!side) return;
    if (!quote) {
      this.liveQuotes[side] = {
        ...this.liveQuotes[side],
        status: this.clobFeed?.snapshot?.().status === 'CONNECTED' ? 'MISSING' : 'STALE',
        stale: true,
        error: 'Waiting for a fresh CLOB book snapshot.',
      };
      return;
    }

    this.quoteUpdateSequence[side] = Number(this.quoteUpdateSequence[side] || 0) + 1;
    const now = this.now();
    const ageMs = Math.max(0, now - Number(quote.updatedAt));
    this.liveQuotes[side] = {
      ...quote,
      status: ageMs <= config.PRESSURE_MAX_QUOTE_AGE_MS ? quote.status : 'STALE',
      stale: ageMs > config.PRESSURE_MAX_QUOTE_AGE_MS,
    };
    this.confirmPendingEntryOnNextTick(side, this.liveQuotes[side]);
  }

  confirmPendingEntryOnNextTick(side, quote) {
    const pending = this.pendingEntries?.[side];
    if (!pending || Number(this.quoteUpdateSequence[side] || 0) <= pending.quoteUpdateSequence) {
      return false;
    }

    this.pendingEntries[side] = null;
    const now = this.now();
    if (pending.windowStart !== Number(this.market?.start)) {
      this.log('PAPER_PRESSURE_ENTRY_EXPIRED_WAITING_FOR_TICK', {
        side,
        shares: pending.shares,
        windowStart: pending.windowStart,
      });
      return false;
    }

    const nextAsk = Number(quote?.bestAsk);
    const quoteAgeMs = Number.isFinite(Number(quote?.updatedAt))
      ? Math.max(0, now - Number(quote.updatedAt))
      : Infinity;
    if (!Number.isFinite(nextAsk) || nextAsk <= 0 || quote.stale
      || quoteAgeMs > config.PRESSURE_MAX_QUOTE_AGE_MS) {
      this.forecast.status = 'ENTRY_SKIPPED_NO_NEXT_TICK_ASK';
      this.forecast.reason = `${side} entry was skipped because the next Polymarket tick had no fresh ask price.`;
      this.log('PAPER_PRESSURE_ENTRY_SKIPPED_NEXT_TICK', {
        side,
        shares: pending.shares,
        triggerPrice: pending.triggerPrice,
        reason: 'NEXT_TICK_ASK_MISSING_OR_STALE',
      });
      return false;
    }

    if (nextAsk >= config.PRESSURE_MAX_SIGNAL_SIDE_PRICE) {
      this.forecast.status = 'ENTRY_SKIPPED_SIGNAL_PRICE_FILTER';
      this.forecast.reason = `${side} entry was skipped because the next-tick ask was not below $${config.PRESSURE_MAX_SIGNAL_SIDE_PRICE.toFixed(2)}.`;
      this.log('PAPER_PRESSURE_ENTRY_SKIPPED_NEXT_TICK', {
        side,
        shares: pending.shares,
        triggerPrice: pending.triggerPrice,
        nextTickAsk: nextAsk,
        reason: 'NEXT_TICK_ASK_NOT_BELOW_SIGNAL_SIDE_PRICE_LIMIT',
      });
      return false;
    }

    if (nextAsk > config.PRESSURE_MAX_BUY_PRICE + EPSILON) {
      this.forecast.status = 'ENTRY_SKIPPED_PRICE_CAP';
      this.forecast.reason = `${side} entry was skipped because the next-tick ask exceeded the $${config.PRESSURE_MAX_BUY_PRICE.toFixed(2)} cap.`;
      this.log('PAPER_PRESSURE_ENTRY_SKIPPED_NEXT_TICK', {
        side,
        shares: pending.shares,
        triggerPrice: pending.triggerPrice,
        nextTickAsk: nextAsk,
        reason: 'NEXT_TICK_PRICE_ABOVE_CAP',
      });
      return false;
    }

    const opened = this.executeBuy(side, pending.shares, now, {
      kind: 'BUY_ENTRY',
      candidate: pending.candidate,
      signal: { binancePressureScore: pending.signalScore },
      fillQuote: quote,
      fillPrice: nextAsk,
      triggerPrice: pending.triggerPrice,
    });
    if (!opened) {
      this.forecast.status = 'ENTRY_REJECTED_INSUFFICIENT_CASH';
      this.forecast.reason = `${side} next-tick entry was rejected because paper cash could not cover the full requested size and fee.`;
      return false;
    }

    this.lastEntryAt = now;
    this.lastEntryAtBySide[side] = now;
    this.forecast.status = 'ENTRY_FILLED';
    this.forecast.reason = `Filled all ${opened.shares} ${side} shares at the next Polymarket ask tick ($${opened.avgEntry.toFixed(3)}).`;
    this.signal = { side, action: 'BUY_ENTRY', reason: this.forecast.reason };
    return true;
  }

  async refreshLiveQuotes(now) {
    if (!this.market) return;
    for (const side of SIDES) {
      const tokenId = this.market.tokens[side];
      const quote = this.clobFeed?.getQuote?.(tokenId);
      if (quote) {
        const ageMs = Math.max(0, now - Number(quote.updatedAt));
        this.liveQuotes[side] = {
          ...quote,
          status: ageMs <= config.PRESSURE_MAX_QUOTE_AGE_MS ? quote.status : 'STALE',
          stale: ageMs > config.PRESSURE_MAX_QUOTE_AGE_MS,
        };
      } else {
        const previous = this.liveQuotes[side] || {};
        const quoteAge = Number.isFinite(Number(previous.updatedAt))
          ? Math.max(0, now - Number(previous.updatedAt))
          : Infinity;
        this.liveQuotes[side] = {
          ...previous,
          status: quoteAge > config.PRESSURE_MAX_QUOTE_AGE_MS ? 'STALE' : previous.status || 'MISSING',
          stale: quoteAge > config.PRESSURE_MAX_QUOTE_AGE_MS,
          source: 'POLYMARKET_CLOB_WEBSOCKET',
          error: this.clobFeed?.snapshot?.().error || null,
        };
      }
    }
    for (const position of this.positions) {
      if (position.windowStart !== this.market.start || position.status !== 'OPEN') continue;
      const quote = this.liveQuotes[position.side];
      position.markBid = quote?.bestBid ?? null;
      position.markUpdatedAt = quote?.updatedAt || now;
      position.markStatus = quote?.bestBid == null || quote.stale ? 'MISSING' : 'LIVE';
    }
    for (const position of this.shadowPositions) {
      if (position.windowStart !== this.market.start || position.status !== 'OPEN') continue;
      const quote = this.liveQuotes[position.side];
      position.markBid = quote?.bestBid ?? null;
      position.markUpdatedAt = quote?.updatedAt || now;
      position.markStatus = quote?.bestBid == null || quote.stale ? 'MISSING' : 'LIVE';
    }
  }

  processPositionExits(windowStart, now) {
    const positions = [
      ...this.positions.filter((position) => position.windowStart === windowStart
        && position.status === 'OPEN'),
      ...this.shadowPositions.filter((position) => position.windowStart === windowStart
        && position.status === 'OPEN'),
    ];
    for (const position of positions) {
      const quote = this.liveQuotes[position.side];
      const updatedAt = Number(quote?.updatedAt);
      const bid = Number(quote?.bestBid);
      if (!quote || quote.status !== 'LIVE' || quote.stale
        || !Number.isFinite(updatedAt) || now < updatedAt
        || now - updatedAt > config.PRESSURE_MAX_QUOTE_AGE_MS) continue;
      const takeProfitQuote = [
        ['BEST_BID', bid],
        ['MIDPOINT', Number(quote.mid)],
        ['BEST_ASK', Number(quote.bestAsk)],
      ].find(([, price]) => Number.isFinite(price)
        && price > 0
        && price <= 1
        && price >= config.PRESSURE_TAKE_PROFIT_TRIGGER);
      const takeProfitHit = Boolean(takeProfitQuote);
      const stopLossHit = quote.bestBid != null
        && Number.isFinite(bid)
        && bid > 0
        && bid <= config.PRESSURE_STOP_LOSS_TRIGGER;
      if (!takeProfitHit && !stopLossHit) continue;
      const payout = takeProfitHit ? 1 : 0;
      const triggerField = takeProfitHit ? takeProfitQuote[0] : 'BEST_BID';
      const triggerPrice = takeProfitHit ? takeProfitQuote[1] : bid;
      const reason = takeProfitHit
        ? `TAKE_PROFIT_${triggerField}_0.99_ACCOUNTED_AS_1`
        : 'STOP_LOSS_BID_0.01_ACCOUNTED_AS_0';
      if (position.shadowOnly) {
        this.finalizeShadowPosition(position, payout, reason, now, false, triggerPrice, triggerField);
        this.log(takeProfitHit
          ? 'PAPER_PRESSURE_SHADOW_TAKE_PROFIT'
          : 'PAPER_PRESSURE_SHADOW_STOP_LOSS', {
          positionId: position.id,
          side: position.side,
          status: position.realizedPnl > 0 ? 'WIN' : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN',
          shares: position.shares,
          triggerPrice,
          triggerField,
          quote: { bestBid: quote.bestBid, mid: quote.mid, bestAsk: quote.bestAsk },
          payoutPerShare: payout,
          realizedPnl: position.realizedPnl,
        });
        continue;
      }
      this.finalizePosition(position, payout, reason, now, triggerPrice, takeProfitHit, triggerField, quote);
    }
  }

  freshQuote(side, now) {
    const quote = this.liveQuotes[side];
    if (!quote || quote.status !== 'LIVE' || quote.stale
      || !Number.isFinite(Number(quote.updatedAt))
      || now < Number(quote.updatedAt)
      || now - Number(quote.updatedAt) > config.PRESSURE_MAX_QUOTE_AGE_MS
      || !(Number(quote.bestBid) > 0 && Number(quote.bestAsk) < 1)
      || !Array.isArray(quote.bidLevels) || !Array.isArray(quote.askLevels)) return null;
    return quote;
  }

  buildPressureRead(now) {
    const feed = this.priceFeed.snapshot?.() || {};
    const flow = feed.tradeFlow || {};
    const tickAt = Number(feed.tickAt);
    const tickAgeMs = Number.isFinite(tickAt) ? Math.max(0, now - tickAt) : null;
    const binanceReady = feed.status === 'CONNECTED'
      && tickAgeMs != null
      && tickAgeMs <= config.PRESSURE_MAX_BINANCE_AGE_MS
      && Number(flow.tradeCount) >= config.PRESSURE_MIN_BINANCE_TRADES
      && Number.isFinite(Number(flow.imbalance));
    const quotes = Object.fromEntries(SIDES.map((side) => [side, this.freshQuote(side, now)]));
    if (!binanceReady) {
      return {
        ready: false,
        status: 'WAITING_FOR_DATA',
        reason: 'Waiting for fresh Binance trades and a current tick.',
        feed,
        flow,
        quotes,
        tickAgeMs,
      };
    }

    const binanceImbalance = clamp(Number(flow.imbalance));
    const priceChangePct = Number.isFinite(Number(flow.priceChangePct))
      ? Number(flow.priceChangePct)
      : 0;
    const momentum = clamp(priceChangePct / 0.0004);
    const binanceScore = clamp(0.75 * binanceImbalance + 0.25 * momentum);
    return {
      ready: true,
      status: 'READY',
      reason: 'Binance trade flow is fresh; Polymarket quotes are used only for execution.',
      feed,
      flow,
      quotes,
      tickAgeMs,
      binanceScore,
      pressureScore: binanceScore,
      binanceImbalance,
      momentum,
    };
  }

  processPressureStrategy(start, now) {
    const read = this.buildPressureRead(now);
    if (!read.ready) {
      this.forecast = {
        ...this.emptyForecast(read.reason),
        status: read.status,
        sampleCount: this.freshSamples(now).length,
        secondsRemaining: Math.max(0, (start + this.windowMs - now) / 1000),
      };
      this.shadowSamplesRequired = adaptiveShadowSampleCount(start, now);
      this.shadowForecast = {
        ...this.emptyForecast(read.reason),
        status: read.status,
        sampleCount: this.freshSamples(now, this.shadowSamplesRequired).length,
        requiredSamples: this.shadowSamplesRequired,
        secondsRemaining: Math.max(0, (start + this.windowMs - now) / 1000),
      };
      return false;
    }

    const evaluationDue = this.lastSampleAt == null
      || now - this.lastSampleAt >= config.PRESSURE_SAMPLE_INTERVAL_MS;
    if (evaluationDue) {
      this.lastSampleAt = now;
      const openPrice = Number(read.feed.currentCandle?.start) === start
        ? Number(read.feed.currentCandle.open)
        : null;
      this.pressureSamples.push({
        at: now,
        scoreSource: 'BINANCE_PRESSURE_V1',
        score: read.binanceScore,
        price: Number(read.feed.price),
        windowOpenPrice: openPrice,
      });
      this.pressureSamples = this.pressureSamples.slice(-config.PRESSURE_SAMPLE_COUNT);
    }

    const forecast = this.createForecast(read, now, start);
    this.forecast = forecast;
    this.shadowSamplesRequired = adaptiveShadowSampleCount(start, now);
    this.shadowForecast = this.createForecast(
      read,
      now,
      start,
      this.shadowSamplesRequired,
    );
    const entryDelayRemainingMs = start + config.PRESSURE_ENTRY_DELAY_MS - now;
    if (entryDelayRemainingMs > 0) {
      const seconds = Math.ceil(entryDelayRemainingMs / 1000);
      const waitReason = `Waiting for the 30-second window-start delay; entries become eligible in ${seconds} seconds.`;
      this.forecast.status = 'WINDOW_ENTRY_DELAY';
      this.forecast.entryDelayRemainingMs = entryDelayRemainingMs;
      this.forecast.reason = waitReason;
      this.shadowForecast.status = 'WINDOW_ENTRY_DELAY';
      this.shadowForecast.entryDelayRemainingMs = entryDelayRemainingMs;
      this.shadowForecast.reason = waitReason;
      return false;
    }
    if (evaluationDue && this.shadowForecast.ready) {
      this.processShadowEntry(start, now, read, this.shadowForecast);
    }
    if (!evaluationDue || !forecast.ready || !forecast.selectedSide) {
      const pendingSide = SIDES.find((side) => this.pendingEntries[side]);
      if (pendingSide) {
        const pending = this.pendingEntries[pendingSide];
        this.forecast.status = 'ENTRY_PENDING_NEXT_TICK';
        this.forecast.reason = `${pendingSide} is waiting for the next Polymarket ask tick to confirm all ${pending.shares} shares.`;
      }
      return false;
    }

    const side = forecast.selectedSide;
    if (!forecast.candidateBySide[side]?.qualifies) return false;
    if (this.pendingEntries[side]) {
      this.forecast.status = 'ENTRY_PENDING_NEXT_TICK';
      this.forecast.reason = `${side} is waiting for the next Polymarket ask tick to confirm all ${this.pendingEntries[side].shares} shares.`;
      return false;
    }
    const lastSideEntryAt = this.lastEntryAtBySide[side];
    const cooldownRemaining = config.PRESSURE_ENTRY_COOLDOWN_MS
      - (now - Number(lastSideEntryAt || 0));
    if (lastSideEntryAt != null && cooldownRemaining > 0) {
      this.forecast.status = 'ENTRY_COOLDOWN';
      this.forecast.reason = `${side} signal qualifies; another ${side} entry is available in ${Math.ceil(cooldownRemaining / 1000)} seconds. The other side has its own cooldown.`;
      return false;
    }

    const candidate = forecast.candidateBySide[side];
    const requestedShares = Number(candidate?.requestedShares) || config.PRESSURE_ENTRY_SHARES;
    const triggerQuote = read.quotes[side];
    this.pendingEntries[side] = {
      side,
      shares: requestedShares,
      windowStart: start,
      triggerPrice: Number(triggerQuote.bestAsk),
      quoteUpdateSequence: Number(this.quoteUpdateSequence[side] || 0),
      triggeredAt: now,
      signalScore: read.binanceScore,
      candidate,
    };
    this.forecast.status = 'ENTRY_PENDING_NEXT_TICK';
    this.forecast.reason = `${side} signal qualifies; waiting for its next Polymarket ask tick to confirm all ${requestedShares} shares.`;
    this.signal = { side, action: 'BUY_ENTRY_PENDING', reason: this.forecast.reason };
    return true;
  }

  processShadowEntry(start, now, read, forecast) {
    const side = forecast.selectedSide;
    if (!forecast.ready || !side || !forecast.candidateBySide[side]?.qualifies) return false;

    const lastSideEntryAt = this.shadowLastEntryAtBySide[side];
    const cooldownRemaining = config.PRESSURE_ENTRY_COOLDOWN_MS
      - (now - Number(lastSideEntryAt || 0));
    if (lastSideEntryAt != null && cooldownRemaining > 0) {
      forecast.status = 'ENTRY_COOLDOWN';
      forecast.reason = `Shadow ${side} signal qualifies; another ${side} entry is available in ${Math.ceil(cooldownRemaining / 1000)} seconds.`;
      return false;
    }

    const candidate = forecast.candidateBySide[side];
    const requestedShares = Number(candidate?.requestedShares) || config.PRESSURE_ENTRY_SHARES;
    const execution = sweepBook(
      read.quotes[side]?.askLevels,
      requestedShares,
      'BUY',
      this.market,
      { maximumPrice: config.PRESSURE_MAX_BUY_PRICE },
    );
    if (!execution.complete) {
      forecast.status = 'SHADOW_SKIPPED_DEPTH';
      forecast.reason = `Shadow entry skipped because the full ${requestedShares} shares were not available below the $${config.PRESSURE_MAX_BUY_PRICE.toFixed(2)} cap.`;
      return false;
    }
    if (execution.totalCost > this.shadowCash + EPSILON) {
      forecast.status = 'SHADOW_INSUFFICIENT_CASH';
      forecast.reason = 'Shadow entry skipped because its independent paper cash cannot cover the full order and fees.';
      return false;
    }

    const position = {
      id: `shadow-${this.market?.start || start}-${side.toLowerCase()}-${++this.shadowSequence}`,
      shadowOnly: true,
      asset: 'BTC',
      timeframe: '5m',
      windowMs: this.windowMs,
      windowStart: this.market?.start ?? start,
      marketId: this.market?.id ?? null,
      slug: this.market?.slug ?? null,
      title: this.market?.title ?? null,
      side,
      outcome: side,
      tokenId: this.market?.tokens?.[side] ?? null,
      shares: execution.filledShares,
      initialShares: execution.filledShares,
      avgEntry: execution.averagePrice,
      averagePrice: execution.averagePrice,
      cost: execution.gross,
      totalCost: execution.totalCost,
      fees: execution.fees,
      entryFees: execution.fees,
      exitFees: 0,
      status: 'OPEN',
      submittedAt: now,
      openedAt: now,
      filledAt: now,
      markBid: read.quotes[side]?.bestBid ?? null,
      markUpdatedAt: read.quotes[side]?.updatedAt || now,
      markStatus: 'LIVE',
      entryFills: execution.fills.map((fill) => ({ ...fill, at: now })),
      signalScore: read.binanceScore,
      settlementBasis: 'ADAPTIVE_SAMPLE_SHADOW',
    };
    this.shadowCash -= execution.totalCost;
    this.shadowPositions.unshift(position);
    this.shadowLastEntryAt = now;
    this.shadowLastEntryAtBySide[side] = now;
    forecast.status = 'SHADOW_ENTRY';
    forecast.reason = `Shadow only: simulated a ${position.shares}-share ${side} entry; the trading portfolio was not changed.`;
    return true;
  }

  freshSamples(now, sampleLimit = config.PRESSURE_SAMPLE_COUNT) {
    return this.pressureSamples
      .filter((sample) => now - Number(sample.at)
        <= config.PRESSURE_SAMPLE_INTERVAL_MS * sampleLimit + 500)
      .slice(-sampleLimit);
  }

  createForecast(read, now, start, requiredSamples = config.PRESSURE_SAMPLE_COUNT) {
    const samples = this.freshSamples(now, requiredSamples);
    const secondsRemaining = Math.max(0, (start + this.windowMs - now) / 1000);
    const candidateBySide = { UP: this.emptyCandidate('Waiting for enough fresh pressure samples.'), DOWN: this.emptyCandidate('Waiting for enough fresh pressure samples.') };
    const trend = pressureTrend(samples, requiredSamples);
    const currentPrice = Number(read.feed.price);
    const candle = read.feed.currentCandle;
    const windowOpenPrice = Number(candle?.start) === start ? Number(candle.open) : null;
    const closedCandle = read.feed.previousClosedCandle;
    const hasPreviousClosedCandle = Number(candle?.start) === start
      && Number(closedCandle?.start) === start - this.windowMs
      && Number(closedCandle.close) > 0;
    const previousCandleClose = hasPreviousClosedCandle
      ? Number(closedCandle.close)
      : windowOpenPrice;
    const previousCloseSource = hasPreviousClosedCandle
      ? 'PREVIOUS_CLOSED_CANDLE'
      : windowOpenPrice > 0 ? 'WINDOW_OPEN_FALLBACK' : null;
    const btcMoveFromOpenPct = currentPrice > 0 && windowOpenPrice > 0
      ? ((currentPrice - windowOpenPrice) / windowOpenPrice) * 100
      : null;
    const volatility = volatilityPerSecond(samples, requiredSamples);
    const ready = samples.length >= requiredSamples
      && Number.isFinite(Number(trend.pressureImpulse))
      && currentPrice > 0
      && windowOpenPrice > 0
      && previousCandleClose > 0
      && volatility != null
      && secondsRemaining > 0;
    if (!ready) {
      return {
        ...this.emptyForecast(
          `Collecting ${requiredSamples} fresh Binance pressure samples (${samples.length}/${requiredSamples}).`,
          'COLLECTING_SAMPLES',
        ),
        sampleCount: samples.length,
        requiredSamples,
        btcMoveFromOpenPct,
        volatilityPerSecond: volatility,
        pressureScore: read.binanceScore ?? null,
        previousCandleClose,
        previousCloseSource,
        secondsRemaining,
        pressureTrendSlope: trend.pressureTrendSlope,
        pressurePersistence: trend.pressurePersistence,
        pressureAcceleration: trend.pressureAcceleration,
        candidateBySide,
      };
    }

    const projection = projectPressureClose({
      currentPrice,
      previousClose: previousCandleClose,
      pressureImpulse: trend.pressureImpulse,
      volatilityPerSecond: volatility,
      secondsRemaining,
    });
    const selectedSide = projection?.side || null;
    for (const side of SIDES) {
      candidateBySide[side] = evaluatePressureCandidate(
        side,
        selectedSide,
        read.quotes?.[side],
      );
    }

    const selectedCandidate = selectedSide ? candidateBySide[selectedSide] : null;
    const status = !selectedSide
      ? 'NO_PRESSURE_SIGNAL'
      : selectedCandidate.qualifies
        ? 'QUALIFIED'
        : selectedCandidate.bestAsk == null
          ? 'SIGNAL_WAITING_FOR_EXECUTION_QUOTE'
          : 'SIGNAL_PRICE_FILTER';
    const reason = !selectedSide
      ? 'The projected BTC close is equal to the previous candle close; no side is selected.'
      : `${selectedSide} selected: projected BTC close $${projection.projectedClose.toFixed(2)} is ${selectedSide === 'UP' ? 'above' : 'below'} the previous close $${previousCandleClose.toFixed(2)} with ${Math.floor(secondsRemaining)} seconds left. ${selectedCandidate.reason}`;
    return {
      ready: true,
      calibrated: false,
      signalSource: 'BINANCE_PRESSURE_CLOSE_PROJECTION',
      status,
      reason,
      pressureScore: read.binanceScore ?? null,
      selectedSide,
      previousCandleClose,
      previousCloseSource,
      projectedClose: projection?.projectedClose ?? null,
      projectedMoveFromPreviousPct: projection?.projectedMoveFromPreviousPct ?? null,
      executionPriceCap: config.PRESSURE_MAX_BUY_PRICE,
      entryShares: config.PRESSURE_ENTRY_SHARES,
      sampleCount: samples.length,
      requiredSamples,
      pressureTrendSlope: trend.pressureTrendSlope,
      pressurePersistence: trend.pressurePersistence,
      pressureAcceleration: trend.pressureAcceleration,
      pressureImpulse: trend.pressureImpulse,
      btcMoveFromOpenPct,
      volatilityPerSecond: volatility,
      secondsRemaining,
      candidateBySide,
    };
  }

  executeBuy(side, shares, now, {
    kind,
    candidate,
    signal,
    fillQuote,
    fillPrice,
    triggerPrice,
  } = {}) {
    const quote = fillQuote || this.freshQuote(side, now);
    const executionPrice = Number(fillPrice ?? quote?.bestAsk);
    const quoteAgeMs = Number.isFinite(Number(quote?.updatedAt))
      ? Math.max(0, now - Number(quote.updatedAt))
      : Infinity;
    if (!quote || quote.stale || quoteAgeMs > config.PRESSURE_MAX_QUOTE_AGE_MS
      || !Number.isFinite(executionPrice) || executionPrice <= 0) return null;
    const modeledAskLevels = [{ price: executionPrice, size: shares }];
    const preview = sweepBook(
      modeledAskLevels,
      shares,
      'BUY',
      this.market,
      { maximumPrice: config.PRESSURE_MAX_BUY_PRICE },
    );
    const order = this.createOrder(kind || 'BUY_ENTRY', side, shares, now, preview);
    if (!preview.complete) {
      order.status = 'SKIPPED_PRICE_CAP_OR_DEPTH';
      order.error = `Full requested size was not available at or below $${config.PRESSURE_MAX_BUY_PRICE.toFixed(2)}.`;
      return null;
    }
    if (preview.totalCost > this.cash + EPSILON) {
      order.status = 'REJECTED_INSUFFICIENT_CASH';
      order.error = 'Insufficient paper cash for the full taker buy and fee.';
      return null;
    }
    const execution = sweepBook(
      modeledAskLevels,
      shares,
      'BUY',
      this.market,
      { maximumPrice: config.PRESSURE_MAX_BUY_PRICE, consume: true },
    );
    if (!execution.complete) {
      order.status = 'CANCELLED_BOOK_CHANGED';
      order.error = 'Visible asks changed between the paper check and fill.';
      return null;
    }

    const position = {
      id: order.id,
      asset: 'BTC',
      timeframe: '5m',
      windowMs: this.windowMs,
      windowStart: this.market.start,
      marketId: this.market.id,
      slug: this.market.slug,
      title: this.market.title,
      side,
      outcome: side,
      tokenId: this.market.tokens[side],
      entryKey: order.id,
      entryLabel: `Pressure entry · ${side}`,
      entryType: 'PAPER_TAKER_PRESSURE',
      orderType: 'PAPER_TAKER_MARKET',
      fillModel: 'NEXT_CLOB_ASK_TICK_FULL_REQUESTED_SIZE',
      triggerPrice: Number.isFinite(Number(triggerPrice)) ? Number(triggerPrice) : null,
      shares: execution.filledShares,
      initialShares: execution.filledShares,
      avgEntry: execution.averagePrice,
      averagePrice: execution.averagePrice,
      cost: execution.gross,
      totalCost: execution.totalCost,
      fees: execution.fees,
      entryFees: execution.fees,
      exitFees: 0,
      status: 'OPEN',
      submittedAt: now,
      openedAt: now,
      filledAt: now,
      markBid: quote.bestBid,
      markUpdatedAt: quote.updatedAt,
      markStatus: 'LIVE',
      entryFills: execution.fills.map((fill) => ({ ...fill, at: now })),
      signalScore: signal?.binancePressureScore ?? null,
    };
    this.cash -= execution.totalCost;
    this.positions.unshift(position);
    order.status = 'FILLED';
    order.filledAt = now;
    order.positionId = position.id;
    order.fee = execution.fees;
    order.grossCost = execution.gross;
    order.totalCost = execution.totalCost;
    order.fills = execution.fills;
    order.maxPrice = config.PRESSURE_MAX_BUY_PRICE;
    order.triggerPrice = Number.isFinite(Number(triggerPrice)) ? Number(triggerPrice) : null;
    order.fillConfirmation = 'NEXT_CLOB_ASK_TICK';
    this.log('PAPER_PRESSURE_ENTRY_FILLED', {
      orderId: order.id,
      positionId: position.id,
      side,
      shares: position.shares,
      averagePrice: position.avgEntry,
      fees: position.fees,
      signalScore: position.signalScore,
    });
    return position;
  }

  createOrder(kind, side, shares, now, execution) {
    const order = {
      id: `btc-5m-${this.market?.start || now}-${kind.toLowerCase()}-${side.toLowerCase()}-${++this.actionSequence}`,
      timeframe: '5m',
      slug: this.market?.slug || null,
      windowStart: this.market?.start ?? null,
      kind,
      action: kind.startsWith('SELL') ? 'SELL' : 'BUY',
      side,
      outcome: side,
      shares,
      requestedShares: shares,
      matchedShares: execution?.complete ? execution.filledShares : 0,
      price: execution?.averagePrice ?? null,
      orderType: 'PAPER_TAKER_MARKET',
      maxPrice: kind.startsWith('BUY') ? config.PRESSURE_MAX_BUY_PRICE : null,
      status: 'SUBMITTED',
      createdAt: now,
      fee: 0,
      paperOnly: true,
    };
    this.windowOrders.unshift(order);
    this.orders.unshift(order);
    if (this.orders.length > 1000) this.orders.length = 1000;
    this.persistenceDirty = true;
    return order;
  }

  finalizePosition(position, payout, reason, now, triggerPrice, takeProfitHit, triggerField, quote) {
    if (position.status !== 'OPEN') return;
    const shares = Number(position.shares);
    const grossPayout = Number(payout) * shares;
    position.exitTriggerPrice = Number(triggerPrice);
    position.exitPrice = Number(triggerPrice);
    position.exitTriggerField = triggerField;
    position.exitQuote = {
      bestBid: quote?.bestBid ?? null,
      mid: quote?.mid ?? null,
      bestAsk: quote?.bestAsk ?? null,
    };
    position.payoutPerShare = Number(payout);
    position.exitProceeds = grossPayout;
    position.proceeds = grossPayout;
    position.realizedPnl = grossPayout - Number(position.totalCost || 0);
    position.status = 'SETTLED_EXIT';
    position.exitReason = reason;
    position.settlementBasis = 'PAPER_PRICE_THRESHOLD';
    position.closedAt = now;
    position.settledAt = now;
    this.cash += grossPayout;
    const kind = takeProfitHit ? 'SELL_TAKE_PROFIT' : 'SELL_STOP_LOSS';
    this.recordThresholdOrder(position, now, kind, payout, triggerPrice, triggerField);
    this.log(takeProfitHit ? 'PAPER_PRESSURE_TAKE_PROFIT' : 'PAPER_PRESSURE_STOP_LOSS', {
      positionId: position.id,
      side: position.side,
      status: position.realizedPnl > 0 ? 'WIN' : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN',
      shares,
      triggerPrice,
      triggerField,
      quote: position.exitQuote,
      payoutPerShare: payout,
      realizedPnl: position.realizedPnl,
      reason,
    });
  }

  finalizeShadowPosition(position, payout, reason, now, resolved = false, triggerPrice = payout, triggerField = null) {
    if (!['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status)) return;
    const grossPayout = Number(payout) * Number(position.shares);
    position.exitTriggerPrice = Number(triggerPrice);
    position.exitPrice = Number(triggerPrice);
    position.exitTriggerField = triggerField;
    position.payoutPerShare = Number(payout);
    position.exitProceeds = grossPayout;
    position.proceeds = grossPayout;
    position.realizedPnl = grossPayout - Number(position.totalCost || 0);
    position.status = resolved
      ? (Number(payout) === 1 ? 'SETTLED_WIN' : 'SETTLED_LOSS')
      : 'SETTLED_EXIT';
    position.exitReason = reason;
    position.settlementBasis = resolved ? 'POLYMARKET_RESOLUTION' : reason;
    position.closedAt = now;
    position.settledAt = now;
    if (resolved) {
      position.resolvedAt = now;
      position.resolvedOutcome = Number(payout) === 1
        ? position.side
        : (position.side === 'UP' ? 'DOWN' : 'UP');
    }
    this.shadowCash += grossPayout;
  }

  recordThresholdOrder(position, now, kind, payout, triggerPrice = payout, triggerField = null) {
    const order = this.createOrder(kind, position.side, position.initialShares || position.shares, now, {
      complete: true,
      filledShares: position.initialShares || position.shares,
      averagePrice: triggerPrice,
    });
    order.status = 'FILLED';
    order.matchedShares = order.shares;
    order.price = triggerPrice;
    order.triggerField = triggerField;
    order.payoutPerShare = payout;
    order.exitProceeds = Number(payout) * Number(order.shares);
    order.positionId = position.id;
    order.exitReason = position.exitReason;
    order.filledAt = now;
    order.fee = 0;
    order.fillConfirmation = 'PAPER_QUOTE_THRESHOLD_TOUCHED';
  }

  async completeWindow(windowStart, triggerPosition, triggerReason, now = this.now()) {
    if (this.completedWindows.has(windowStart)) return;
    this.completedWindows.set(windowStart, now);
    if (this.completedWindows.size > 100) {
      this.completedWindows.delete(this.completedWindows.keys().next().value);
    }
    this.cancelWindowOrders(windowStart, now, triggerReason);
    const positions = this.positions.filter((position) =>
      position.windowStart === windowStart && position.status === 'OPEN');
    for (const position of positions) {
      position.status = 'PENDING_CLOB_RESULT';
      position.markStatus = 'PENDING_CLOB_RESULT';
      position.pendingResolutionAt = now;
      position.exitReason = 'WAITING_FOR_OFFICIAL_RESOLUTION';
      position.settlementBasis = 'POLYMARKET_RESOLUTION_PENDING';
    }
    const shadowPositions = this.shadowPositions.filter((position) =>
      position.windowStart === windowStart && position.status === 'OPEN');
    for (const position of shadowPositions) {
      position.status = 'PENDING_CLOB_RESULT';
      position.markStatus = 'PENDING_CLOB_RESULT';
      position.pendingResolutionAt = now;
      position.exitReason = 'WAITING_FOR_OFFICIAL_RESOLUTION';
      position.settlementBasis = 'POLYMARKET_RESOLUTION_PENDING';
    }
    this.log('PAPER_PRESSURE_WINDOW_ENDED', {
      windowStart,
      pendingResolutionCount: positions.length,
      shadowPendingResolutionCount: shadowPositions.length,
      triggerReason,
    });
  }

  async closePreviousWindows(currentStart, now) {
    await super.closePreviousWindows(currentStart, now);
    const shadowWindows = new Set(this.shadowPositions
      .filter((position) => position.windowStart < currentStart && position.status === 'OPEN')
      .map((position) => position.windowStart));
    for (const windowStart of shadowWindows) {
      if (!this.completedWindows.has(windowStart)) {
        await this.completeWindow(windowStart, null, 'WINDOW_ROLLOVER', now);
      }
    }
  }

  async resolvePendingPositions(now) {
    const pendingByMarket = new Map();
    for (const position of [...this.positions, ...this.shadowPositions]) {
      const lastCheckedAt = this.lastResolutionCheckAt.get(position.id);
      if (position.status !== 'PENDING_CLOB_RESULT'
        || !position.marketId
        || (lastCheckedAt != null
          && now - Number(lastCheckedAt) < config.RESOLUTION_POLL_MS)) continue;
      this.lastResolutionCheckAt.set(position.id, now);
      if (!pendingByMarket.has(position.marketId)) pendingByMarket.set(position.marketId, []);
      pendingByMarket.get(position.marketId).push(position);
    }

    for (const [marketId, positions] of pendingByMarket) {
      try {
        const market = await this.marketData.getMarket(marketId);
        for (const position of positions) {
          const payout = resolvedPayout(market, position);
          if (payout == null) continue;
          if (position.shadowOnly) {
            this.finalizeShadowPosition(
              position,
              payout,
              'OFFICIAL_POLYMARKET_RESOLUTION',
              now,
              true,
            );
            continue;
          }
          const grossPayout = payout * Number(position.shares);
          position.resolvedOutcome = payout === 1 ? position.side : (position.side === 'UP' ? 'DOWN' : 'UP');
          position.exitPrice = payout;
          position.exitProceeds = grossPayout;
          position.proceeds = grossPayout;
          position.realizedPnl = grossPayout - Number(position.totalCost || 0);
          position.status = payout === 1 ? 'SETTLED_WIN' : 'SETTLED_LOSS';
          position.exitReason = 'OFFICIAL_POLYMARKET_RESOLUTION';
          position.settlementBasis = 'POLYMARKET_RESOLUTION';
          position.resolvedAt = now;
          position.settledAt = now;
          position.closedAt = now;
          this.cash += grossPayout;
          this.resolutions.unshift({
            slug: position.slug,
            outcome: position.resolvedOutcome,
            status: 'RESOLVED',
            pnl: position.realizedPnl,
            resolvedAt: now,
            marketId: position.marketId,
          });
          this.log('PAPER_PRESSURE_RESOLVED', {
            positionId: position.id,
            side: position.side,
            winningSide: position.resolvedOutcome,
            payout,
            shares: position.shares,
            realizedPnl: position.realizedPnl,
          });
        }
      } catch (error) {
        for (const position of positions) {
          position.resolutionError = error.message || String(error);
        }
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.priceFeed.start?.();
    this.log('PAPER_PRESSURE_BOT_STARTED', {
      note: 'Paper-only 5-minute pressure forecast. Real-order modules are not loaded.',
      entryShares: config.PRESSURE_ENTRY_SHARES,
    });
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) {
        try {
          await this.persistState();
        } catch (error) {
          this.running = false;
          this.status = 'history_persistence_error';
          this.error = `Paper history could not be saved: ${error.message || String(error)}`;
          this.priceFeed.stop?.();
          console.error(`[paper-state] ${this.error}`);
          return;
        }
      }
      if (this.running) {
        this.timer = setTimeout(() => {
          this.loopPromise = loop();
        }, config.POLL_INTERVAL_MS);
      }
    };
    this.loopPromise = loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.priceFeed.stop?.();
    this.clobFeed?.stop?.();
    this.clobFeed = null;
    this.clobFeedMarketKey = null;
  }

  async stopAndFlush() {
    this.stop();
    await this.loopPromise?.catch(() => {});
    await this.persistState(true);
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const windowStart = this.market?.start ?? null;
    const windowEnd = this.market?.end ?? (windowStart == null ? null : windowStart + this.windowMs);
    const quotes = {
      UP: { ...this.liveQuotes.UP },
      DOWN: { ...this.liveQuotes.DOWN },
    };
    const currentOrders = this.orders.filter((order) => Number(order.windowStart) === Number(windowStart));
    const accumulatedPositions = summarizeWindowPositions(this.positions, windowStart);
    const outcomeCalculator = summarizeWindowOutcomeScenarios(this.positions, windowStart);
    const positions = this.positions.map((position) => ({
      ...position,
      avgPrice: position.avgEntry,
      currentValue: position.status === 'OPEN' && position.markBid != null
        ? position.markBid * position.shares
        : position.status === 'PENDING_CLOB_RESULT' ? null : position.proceeds ?? 0,
      pnl: position.realizedPnl ?? position.unrealizedPnl,
      status: position.status,
    }));
    const marketState = {
      slug: this.market?.slug || null,
      title: this.market?.title || 'BTC 5-minute UP/DOWN',
      windowStart,
      windowEnd,
      quotes,
      forecast: this.forecast,
      orders: currentOrders,
      accumulatedPositions,
      outcomeCalculator,
    };
    const settledEquityCurve = state.account.equityCurve || [];
    return {
      ...state,
      now,
      mode: 'DEMO ONLY',
      status: this.status,
      clobFeed: this.clobFeed?.snapshot?.() || {
        source: 'Polymarket CLOB market WebSocket',
        status: 'WAITING',
        connected: false,
        error: null,
        assetCount: 0,
        lastMessageAt: null,
        lastMessageAgeMs: null,
        reconnectCount: 0,
        quoteAgesMs: {},
      },
      strategy: {
        ...state.strategy,
        name: this.strategyName,
        execution: 'PAPER ONLY',
        markets: ['BTC 5m'],
        orderType: 'NEXT_CLOB_ASK_TICK_FULL_SIZE',
        exit: 'Paper TP triggers when the held-side best bid, midpoint, or best ask reaches $0.99 and counts as $1/share; SL triggers at best bid $0.01 and counts as $0; otherwise official resolution.',
        liveTradingEnabled: false,
        realOrderModulesLoaded: false,
        entryShares: config.PRESSURE_ENTRY_SHARES,
        maxBuyPrice: config.PRESSURE_MAX_BUY_PRICE,
        maxSignalSidePrice: config.PRESSURE_MAX_SIGNAL_SIDE_PRICE,
        signal: 'Projects the BTC 5-minute close relative to the previous candle close using ten one-second Binance pressure scores, recent volatility, and time remaining. Polymarket quotes are used only for execution.',
        signalState: this.forecast,
        orders: {
          type: 'Full requested-size paper fill at the next Polymarket ask tick',
          initialShares: config.PRESSURE_ENTRY_SHARES,
          maxBuyPrice: config.PRESSURE_MAX_BUY_PRICE,
          maxSignalSidePrice: config.PRESSURE_MAX_SIGNAL_SIDE_PRICE,
          entryCooldownMs: config.PRESSURE_ENTRY_COOLDOWN_MS,
          maxEntriesPerWindow: 'No fixed cap; limited by qualifying signals and available cash.',
        },
        entryDelayMs: config.PRESSURE_ENTRY_DELAY_MS,
        repeatEntryRule: `Ignore entry signals for the first ${config.PRESSURE_ENTRY_DELAY_MS / 1000} seconds of each window, then use the pressure-weighted close projection. Projected close above the previous candle close selects UP; below selects DOWN. Buy only if the signalled side's ask is below $${config.PRESSURE_MAX_SIGNAL_SIDE_PRICE.toFixed(2)} at signal and next-tick confirmation. Each side has its own 15-second entry cooldown; entries are ${config.PRESSURE_ENTRY_SHARES} shares.`,
        priceFeed: this.priceFeed?.snapshot?.() || null,
        exits: {
          mode: 'ANY_CLOB_QUOTE_TP_BID_SL_THEN_OFFICIAL_RESOLUTION',
          takeProfit: config.PRESSURE_TAKE_PROFIT_TRIGGER,
          takeProfitTriggerFields: ['BEST_BID', 'MIDPOINT', 'BEST_ASK'],
          takeProfitPayout: 1,
          stopLoss: config.PRESSURE_STOP_LOSS_TRIGGER,
          stopLossTriggerField: 'BEST_BID',
          stopLossPayout: 0,
          resolutionPollMs: config.RESOLUTION_POLL_MS,
          otherwise: 'Hold positions until the original Polymarket market officially resolves.',
        },
      },
      forecast: this.forecast,
      marketForecast: this.forecast,
      markets: { '5m': marketState },
      window: this.market ? {
        title: this.market.title,
        slug: this.market.slug,
        start: windowStart,
        end: windowEnd,
      } : null,
      shadowComparison: {
        mode: 'SHADOW_ONLY',
        updatedAt: now,
        activeSampleCount: this.shadowSamplesRequired,
        baseSampleCount: config.PRESSURE_SAMPLE_COUNT,
        minimumSampleCount: config.PRESSURE_SHADOW_MIN_SAMPLE_COUNT,
        stepMs: config.PRESSURE_SHADOW_STEP_MS,
        currentForecast: this.shadowForecast,
        baseline: summarizePortfolio(this.positions, this.cash, this.capital),
        adaptive: summarizePortfolio(
          this.shadowPositions,
          this.shadowCash,
          this.shadowInitialCapital,
          this.shadowStatsOffset,
        ),
        assumptions: `Separate paper cash; entries start after ${config.PRESSURE_ENTRY_DELAY_MS / 1000} seconds, with a Binance-pressure projection, fixed ${config.PRESSURE_ENTRY_SHARES}-share entries, independent 15-second cooldowns, signalled-side ask below $${config.PRESSURE_MAX_SIGNAL_SIDE_PRICE.toFixed(2)} at signal and next-tick confirmation, the $${config.PRESSURE_MAX_BUY_PRICE.toFixed(2)} hard cap, visible ask-depth sweep and modeled taker fees. Best-bid $0.99/$0.01 exits are accounted as $1/$0 per share; otherwise positions settle at official resolution.`,
      },
      portfolioAnalytics: {
        equityCurve: settledEquityCurve,
        maxDrawdown: state.account.maxDrawdown,
        maxDrawdownPercent: state.account.maxDrawdownPercent,
        combinedResults: summarizeCombinedResults(this.positions),
        maxWindowExposure: maximumConcurrentWindowExposure(this.positions, now),
      },
      quotes,
      account: {
        ...state.account,
        accountReady: false,
        collateral: null,
        equity: this.cash + Number(state.account.markedValue || 0),
        cash: this.cash,
        asOf: now,
        positions,
      },
      positions,
      orders: currentOrders,
      resolutions: this.resolutions.slice(0, 100),
      liveTrading: {
        enabled: false,
        status: 'inactive',
        detail: 'Real-order execution modules are not loaded by this demo runner.',
      },
      events: this.events.slice(0, 100).map((event) => ({
        at: event.ts,
        type: event.event || 'PAPER_ACTIVITY',
        message: event.message || event.reason || event.error
          || [event.side, event.shares && `${event.shares} shares`, event.realizedPnl != null
            && `P&L $${Number(event.realizedPnl).toFixed(2)}`].filter(Boolean).join(' · ')
          || 'Paper strategy state updated.',
        ...event,
      })),
      error: this.error || null,
    };
  }
}

PressureForecastBot._test = {
  clamp,
  pressureTrend,
  projectPressureClose,
  volatilityPerSecond,
  adaptiveShadowSampleCount,
  summarizePortfolio,
  summarizeWindowPositions,
  summarizeWindowOutcomeScenarios,
  sweepBook,
  evaluatePressureCandidate,
  resolvedPayout,
};

module.exports = PressureForecastBot;
