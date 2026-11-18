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

function analyzeDipRebound(samples, now) {
  const lookback = samples
    .filter((sample) => Number(sample.at) >= now - config.DIP_LOOKBACK_MS
      && Number(sample.at) <= now
      && Number(sample.mid) > 0
      && Number(sample.mid) < 1)
    .sort((a, b) => Number(a.at) - Number(b.at));
  const empty = {
    ready: false,
    qualifies: false,
    sampleCount: lookback.length,
    referenceHigh: null,
    trough: null,
    currentMid: lookback.length ? Number(lookback.at(-1).mid) : null,
    dipAmount: null,
    reboundAmount: null,
    reason: 'Collecting fresh Polymarket price history.',
  };
  if (lookback.length < config.DIP_MIN_HISTORY_SAMPLES
    || Number(lookback.at(-1).at) - Number(lookback[0].at) < config.DIP_MIN_HISTORY_SPAN_MS) {
    return empty;
  }

  const troughStart = now - config.DIP_TROUGH_WINDOW_MS;
  const reference = lookback.filter((sample) => Number(sample.at) < troughStart);
  const troughSamples = lookback.filter((sample) => Number(sample.at) >= troughStart);
  if (reference.length < 3 || troughSamples.length < 2) {
    return { ...empty, reason: 'Waiting for enough older prices to define a dip and a recent trough.' };
  }

  const referenceHigh = Math.max(...reference.map((sample) => Number(sample.mid)));
  const trough = Math.min(...troughSamples.map((sample) => Number(sample.mid)));
  const currentMid = Number(lookback.at(-1).mid);
  const previous = Number(lookback.at(-2)?.mid);
  const previousPrevious = Number(lookback.at(-3)?.mid);
  const dipAmount = referenceHigh - trough;
  const reboundAmount = currentMid - trough;
  const hasTurn = previousPrevious < previous && previous < currentMid;
  const qualifies = dipAmount + EPSILON >= config.DIP_DROP_FROM_REFERENCE
    && reboundAmount + EPSILON >= config.DIP_REBOUND_FROM_TROUGH
    && hasTurn;

  let reason = 'No confirmed dip-and-rebound setup yet.';
  if (dipAmount + EPSILON < config.DIP_DROP_FROM_REFERENCE) {
    reason = `Waiting for a $${config.DIP_DROP_FROM_REFERENCE.toFixed(2)} dip from the recent reference high.`;
  } else if (reboundAmount + EPSILON < config.DIP_REBOUND_FROM_TROUGH || !hasTurn) {
    reason = `Dip detected; waiting for a $${config.DIP_REBOUND_FROM_TROUGH.toFixed(2)} rebound with two rising quotes.`;
  } else {
    reason = `Dip-and-rebound confirmed: $${dipAmount.toFixed(3)} below the recent high, then $${reboundAmount.toFixed(3)} off the trough.`;
  }

  return {
    ready: true,
    qualifies,
    sampleCount: lookback.length,
    referenceHigh,
    trough,
    currentMid,
    dipAmount,
    reboundAmount,
    reason,
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
      strategyMode: 'dip-rebound',
      priceFeed: feed,
    });
    this.now = now;
    this.marketData = marketData;
    this.clobFeedFactory = clobFeedFactory;
    this.clobFeed = null;
    this.clobFeedMarketKey = null;
    this.initialCapital = initialCapital;
    this.strategyName = 'BTC 5-minute independent dip-and-spike paper bot';
    this.strategyMode = 'dip-rebound';
    this.forecast = this.emptyForecast('Waiting for fresh Polymarket UP and DOWN quotes.');
    this.lastEntryAt = null;
    this.lastEntryAtBySide = { UP: null, DOWN: null };
    this.lastDipAttemptAtBySide = { UP: null, DOWN: null };
    this.dipHistory = { UP: [], DOWN: [] };
    this.lastHistoryQuoteAtBySide = { UP: null, DOWN: null };
    this.dipEntryCountBySide = { UP: 0, DOWN: 0 };
    this.dipArmedBySide = { UP: true, DOWN: true };
    this.dipRearmPriceBySide = { UP: null, DOWN: null };
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
      lastEntryAt: this.lastEntryAt,
      lastEntryAtBySide: this.lastEntryAtBySide,
      lastDipAttemptAtBySide: this.lastDipAttemptAtBySide,
      dipEntryCountBySide: this.dipEntryCountBySide,
      dipArmedBySide: this.dipArmedBySide,
      dipRearmPriceBySide: this.dipRearmPriceBySide,
      strategyVersion: 'DIP_REBOUND_V1',
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
    this.lastEntryAt = Number.isFinite(Number(state.lastEntryAt)) ? Number(state.lastEntryAt) : null;
    this.lastEntryAtBySide = state.lastEntryAtBySide || { UP: null, DOWN: null };
    this.lastDipAttemptAtBySide = state.lastDipAttemptAtBySide || { ...this.lastEntryAtBySide };
    this.dipHistory = { UP: [], DOWN: [] };
    this.lastHistoryQuoteAtBySide = { UP: null, DOWN: null };
    const currentWindowPositions = this.positions.filter((position) =>
      Number(position.windowStart) === Number(this.orderWindowStart)
      && position.strategyVersion === 'DIP_REBOUND_V1');
    this.dipEntryCountBySide = state.dipEntryCountBySide || Object.fromEntries(
      SIDES.map((side) => [side, currentWindowPositions.filter((position) => position.side === side).length]),
    );
    this.dipArmedBySide = state.dipArmedBySide || Object.fromEntries(
      SIDES.map((side) => [side, currentWindowPositions.every((position) => position.side !== side)]),
    );
    this.dipRearmPriceBySide = state.dipRearmPriceBySide || Object.fromEntries(
      SIDES.map((side) => {
        const latest = currentWindowPositions
          .filter((position) => position.side === side)
          .sort((a, b) => Number(b.filledAt || b.openedAt || 0) - Number(a.filledAt || a.openedAt || 0))[0];
        return [side, latest
          ? Math.min(0.99, Number(latest.dipTriggerMid ?? latest.avgEntry ?? 0) + config.DIP_REARM_RECOVERY)
          : null];
      }),
    );
    this.forecast = this.emptyForecast(
      'Collecting fresh Polymarket quotes after restart.',
      'COLLECTING_PRICE_HISTORY',
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
      lastEntryAt: Math.max(...Object.values(lastEntryAtBySide).filter(Number.isFinite), 0) || null,
      lastEntryAtBySide,
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
      status,
      reason,
      signalSource: 'POLYMARKET_CLOB_PRICE_ONLY',
      selectedSide: null,
      qualifyingSides: [],
      secondsIntoWindow: null,
      secondsRemaining: null,
      tradeWindowMs: config.DIP_TRADE_WINDOW_MS,
      candidateBySide: {
        UP: this.emptyCandidate('Waiting for fresh UP quotes.'),
        DOWN: this.emptyCandidate('Waiting for fresh DOWN quotes.'),
      },
    };
  }

  emptyCandidate(reason) {
    return {
      ready: false,
      currentMid: null,
      bestAsk: null,
      referenceHigh: null,
      trough: null,
      dipAmount: null,
      reboundAmount: null,
      sampleCount: 0,
      entriesThisWindow: 0,
      maxEntries: config.DIP_MAX_ENTRIES_PER_SIDE,
      requestedShares: config.DIP_ENTRY_SHARES,
      armed: true,
      qualifies: false,
      reason,
    };
  }

  openStrategyWindow(start, now) {
    this.orderWindowStart = start;
    this.windowOrders = [];
    this.windowFiredEntries = 0;
    this.lastFiredEntryShares = 0;
    this.initialEntrySide = null;
    this.initialEntryAt = null;
    this.quoteWindowStart = start;
    this.liveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.lastEntryAt = null;
    this.lastEntryAtBySide = { UP: null, DOWN: null };
    this.lastDipAttemptAtBySide = { UP: null, DOWN: null };
    this.dipHistory = { UP: [], DOWN: [] };
    this.lastHistoryQuoteAtBySide = { UP: null, DOWN: null };
    this.dipEntryCountBySide = { UP: 0, DOWN: 0 };
    this.dipArmedBySide = { UP: true, DOWN: true };
    this.dipRearmPriceBySide = { UP: null, DOWN: null };
    this.signal = null;
    this.forecast = this.emptyForecast('Collecting a fresh rolling UP and DOWN price history.', 'COLLECTING_PRICE_HISTORY');
    this.log('PAPER_DIP_WINDOW_STARTED', {
      windowStart: start,
      entryShares: config.DIP_ENTRY_SHARES,
      maxEntriesPerSide: config.DIP_MAX_ENTRIES_PER_SIDE,
      tradeWindowMs: config.DIP_TRADE_WINDOW_MS,
    });
  }

  async tick() {
    const now = this.now();
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    try {
      await this.closePreviousWindows(start, now);
      await this.resolvePendingPositions(now);
      if (!this.market || this.market.start !== start) {
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
      this.processDipStrategy(start, now);
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
        this.log('PAPER_DIP_SCAN_ERROR', { error: this.error });
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

    const now = this.now();
    const ageMs = Math.max(0, now - Number(quote.updatedAt));
    this.liveQuotes[side] = {
      ...quote,
      status: ageMs <= config.CLOB_MAX_QUOTE_AGE_MS ? quote.status : 'STALE',
      stale: ageMs > config.CLOB_MAX_QUOTE_AGE_MS,
    };
    this.recordDipQuote(side, this.liveQuotes[side]);
    this.updatePositionMarks(side, this.liveQuotes[side], now);
    this.applyTakeProfitExits(now);
    this.processDipStrategy(this.market?.start, now, side);
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
          status: ageMs <= config.CLOB_MAX_QUOTE_AGE_MS ? quote.status : 'STALE',
          stale: ageMs > config.CLOB_MAX_QUOTE_AGE_MS,
        };
      } else {
        const previous = this.liveQuotes[side] || {};
        const quoteAge = Number.isFinite(Number(previous.updatedAt))
          ? Math.max(0, now - Number(previous.updatedAt))
          : Infinity;
        this.liveQuotes[side] = {
          ...previous,
          status: quoteAge > config.CLOB_MAX_QUOTE_AGE_MS ? 'STALE' : previous.status || 'MISSING',
          stale: quoteAge > config.CLOB_MAX_QUOTE_AGE_MS,
          source: 'POLYMARKET_CLOB_WEBSOCKET',
          error: this.clobFeed?.snapshot?.().error || null,
        };
      }
      this.recordDipQuote(side, this.liveQuotes[side]);
    }
    for (const side of SIDES) {
      this.updatePositionMarks(side, this.liveQuotes[side], now);
    }
    this.applyTakeProfitExits(now);
  }

  recordDipQuote(side, quote) {
    if (!quote || quote.status !== 'LIVE' || quote.stale) return false;
    const updatedAt = Number(quote.updatedAt);
    if (!Number.isFinite(updatedAt)
      || updatedAt === this.lastHistoryQuoteAtBySide[side]) return false;
    const mid = Number.isFinite(Number(quote.mid))
      ? Number(quote.mid)
      : (Number(quote.bestBid) + Number(quote.bestAsk)) / 2;
    if (!(mid > 0 && mid < 1)) return false;
    this.lastHistoryQuoteAtBySide[side] = updatedAt;
    this.dipHistory[side].push({ at: updatedAt, mid });
    this.dipHistory[side] = this.dipHistory[side].filter((sample) =>
      sample.at >= updatedAt - config.DIP_LOOKBACK_MS);
    return true;
  }

  updatePositionMarks(side, quote, now) {
    for (const position of this.positions) {
      if (position.windowStart !== this.market?.start
        || position.side !== side
        || position.status !== 'OPEN') continue;
      position.markBid = quote?.bestBid ?? null;
      position.markUpdatedAt = quote?.updatedAt || now;
      position.markStatus = quote?.bestBid == null || quote.stale ? 'MISSING' : 'LIVE';
    }
  }

  applyTakeProfitExits(now) {
    if (!this.market || now >= Number(this.market.end)) return;
    for (const position of this.positions) {
      if (position.windowStart !== this.market.start || position.status !== 'OPEN') continue;
      const quote = this.liveQuotes[position.side];
      if (position.strategyVersion === 'DIP_REBOUND_V1') {
        this.processSpikeExit(position.side, now);
        continue;
      }
      if (!this.isTakeProfitQuote(quote, now, position)) continue;
      this.finalizeTakeProfit(position, Number(quote.updatedAt));
    }
  }

  isTakeProfitQuote(quote, now, position = null) {
    const updatedAt = Number(quote?.updatedAt);
    const ageMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : Infinity;
    const bestBid = Number(quote?.bestBid);
    const windowStart = Number(position?.windowStart);
    const windowEnd = Number.isFinite(windowStart)
      ? windowStart + (Number(position.windowMs) || this.windowMs)
      : null;
    return quote?.status === 'LIVE'
      && !quote.stale
      && Number.isFinite(updatedAt)
      && updatedAt <= now
      && ageMs <= config.CLOB_MAX_QUOTE_AGE_MS
      && (windowEnd == null || (updatedAt >= windowStart && updatedAt < windowEnd))
      && Number.isFinite(bestBid)
      && bestBid >= config.LEGACY_TAKE_PROFIT_TRIGGER;
  }

  finalizeTakeProfit(position, now) {
    if (position.status !== 'OPEN') return;
    const payout = config.LEGACY_TAKE_PROFIT_PAYOUT;
    const grossPayout = payout * Number(position.shares);
    position.exitPrice = payout;
    position.exitProceeds = grossPayout;
    position.proceeds = grossPayout;
    position.exitFees = 0;
    position.realizedPnl = grossPayout - Number(position.totalCost || 0);
    position.status = 'SETTLED_EXIT';
    position.exitReason = `TAKE_PROFIT_BID_AT_${config.LEGACY_TAKE_PROFIT_TRIGGER.toFixed(2)}`;
    position.settlementBasis = 'PAPER_TAKE_PROFIT';
    position.closedAt = now;
    position.settledAt = now;
    this.cash += grossPayout;
    this.recordThresholdOrder(position, now, 'SELL_TAKE_PROFIT', payout);
    this.log('PAPER_LEGACY_TAKE_PROFIT_HIT', {
      positionId: position.id,
      side: position.side,
      triggerBid: config.LEGACY_TAKE_PROFIT_TRIGGER,
      payoutPerShare: payout,
      shares: position.shares,
      proceeds: grossPayout,
      realizedPnl: position.realizedPnl,
    });
  }

  freshQuote(side, now) {
    const quote = this.liveQuotes[side];
    if (!quote || quote.status !== 'LIVE' || quote.stale
      || !Number.isFinite(Number(quote.updatedAt))
      || now < Number(quote.updatedAt)
      || now - Number(quote.updatedAt) > config.CLOB_MAX_QUOTE_AGE_MS
      || !(Number(quote.bestBid) > 0 && Number(quote.bestAsk) < 1)
      || !Array.isArray(quote.bidLevels) || !Array.isArray(quote.askLevels)) return null;
    return quote;
  }

  buildDipCandidate(side, now, start, tradeOpen) {
    const quote = this.freshQuote(side, now);
    const analysis = analyzeDipRebound(this.dipHistory[side] || [], now);
    const candidate = {
      ...this.emptyCandidate(analysis.reason),
      ...analysis,
      qualifies: false,
      ready: analysis.ready && Boolean(quote),
      bestAsk: quote?.bestAsk ?? null,
      entriesThisWindow: Number(this.dipEntryCountBySide[side] || 0),
      armed: this.dipArmedBySide[side] !== false,
      requestedShares: config.DIP_ENTRY_SHARES,
      maxEntries: config.DIP_MAX_ENTRIES_PER_SIDE,
    };
    const elapsed = Number(now) - Number(start);
    const cooldownAt = Number(this.lastDipAttemptAtBySide[side] ?? this.lastEntryAtBySide[side]);
    const cooldownRemaining = cooldownAt
      ? config.DIP_ENTRY_COOLDOWN_MS - (now - cooldownAt)
      : 0;

    if (!tradeOpen) {
      candidate.reason = elapsed >= config.DIP_TRADE_WINDOW_MS
        ? 'Entry and spike-trading window is closed; remaining shares wait for official resolution.'
        : 'Waiting for this five-minute market window to start.';
      return candidate;
    }
    if (!quote) {
      candidate.reason = `Waiting for a fresh ${side} CLOB quote. The other side is evaluated independently.`;
      return candidate;
    }

    if (this.dipArmedBySide[side] === false
      && Number.isFinite(Number(this.dipRearmPriceBySide[side]))
      && candidate.currentMid >= Number(this.dipRearmPriceBySide[side])) {
      this.dipArmedBySide[side] = true;
      this.dipRearmPriceBySide[side] = null;
      candidate.armed = true;
      this.log('PAPER_DIP_SIDE_REARMED', {
        side,
        mid: candidate.currentMid,
        windowStart: start,
      });
    }

    if (!analysis.ready) return candidate;
    if (!this.dipArmedBySide[side]) {
      candidate.reason = `Waiting for ${side} to recover to $${Number(this.dipRearmPriceBySide[side]).toFixed(3)} before another dip can trigger.`;
      return candidate;
    }
    if (candidate.entriesThisWindow >= config.DIP_MAX_ENTRIES_PER_SIDE) {
      candidate.reason = `${side} has reached its ${config.DIP_MAX_ENTRIES_PER_SIDE}-entry limit for this window.`;
      return candidate;
    }
    if (cooldownRemaining > 0) {
      candidate.reason = `${side} is cooling down for ${Math.ceil(cooldownRemaining / 1000)} more seconds.`;
      return candidate;
    }
    if (Number(quote.bestAsk) > config.DIP_MAX_BUY_PRICE + EPSILON) {
      candidate.reason = `${side} ask is above the $${config.DIP_MAX_BUY_PRICE.toFixed(2)} entry ceiling.`;
      return candidate;
    }
    if (!analysis.qualifies) return candidate;

    candidate.qualifies = true;
    candidate.reason = `${analysis.reason} Buy ${config.DIP_ENTRY_SHARES} ${side} shares at the ask.`;
    return candidate;
  }

  createDipForecast(now, start) {
    const elapsed = Number(now) - Number(start);
    const tradeOpen = elapsed >= 0 && elapsed < config.DIP_TRADE_WINDOW_MS;
    const candidateBySide = Object.fromEntries(SIDES.map((side) => [
      side,
      this.buildDipCandidate(side, now, start, tradeOpen),
    ]));
    const qualifyingSides = SIDES.filter((side) => candidateBySide[side].qualifies);
    const ready = SIDES.some((side) => this.freshQuote(side, now));
    let status = 'SCANNING_FOR_DIP';
    let reason = 'UP and DOWN are monitored separately for a dip followed by a confirmed rebound.';
    if (elapsed >= config.DIP_TRADE_WINDOW_MS) {
      status = 'TRADE_WINDOW_CLOSED';
      reason = 'Trading is limited to the first 240 seconds; open shares now wait for official resolution.';
    } else if (!ready) {
      status = 'WAITING_FOR_CLOB';
      reason = 'Waiting for fresh Polymarket quotes; no Binance or model signal is required.';
    } else if (qualifyingSides.length) {
      status = 'DIP_REBOUND_READY';
      reason = `${qualifyingSides.join(' and ')} ${qualifyingSides.length === 1 ? 'has' : 'have'} a confirmed dip-and-rebound setup. Each side may enter independently.`;
    }

    return {
      ready,
      status,
      reason,
      signalSource: 'POLYMARKET_CLOB_PRICE_ONLY',
      selectedSide: null,
      qualifyingSides,
      secondsIntoWindow: Math.max(0, elapsed / 1000),
      secondsRemaining: Math.max(0, (start + this.windowMs - now) / 1000),
      tradeWindowMs: config.DIP_TRADE_WINDOW_MS,
      entryShares: config.DIP_ENTRY_SHARES,
      maxEntriesPerSide: config.DIP_MAX_ENTRIES_PER_SIDE,
      candidateBySide,
    };
  }

  processDipStrategy(start, now, onlySide = null) {
    if (!Number.isFinite(Number(start)) || !this.market || this.market.start !== start) return false;
    const forecast = this.createDipForecast(now, start);
    this.forecast = forecast;
    const sides = onlySide && SIDES.includes(onlySide) ? [onlySide] : SIDES;
    let changed = false;

    for (const side of sides) {
      const candidate = forecast.candidateBySide[side];
      if (!candidate?.qualifies) continue;
      this.lastDipAttemptAtBySide[side] = now;
      const opened = this.executeBuy(side, config.DIP_ENTRY_SHARES, now, {
        kind: 'BUY_DIP',
        candidate,
        signal: candidate,
      });
      if (!opened) {
        candidate.qualifies = false;
        candidate.reason = this.windowOrders[0]?.error
          || `${side} paper order was not filled; the next dip setup can be evaluated independently.`;
        continue;
      }

      this.lastEntryAt = now;
      this.lastEntryAtBySide[side] = now;
      this.dipEntryCountBySide[side] = Number(this.dipEntryCountBySide[side] || 0) + 1;
      this.dipArmedBySide[side] = false;
      this.dipRearmPriceBySide[side] = Math.min(
        0.99,
        Number(candidate.currentMid) + config.DIP_REARM_RECOVERY,
      );
      candidate.qualifies = false;
      candidate.entriesThisWindow = this.dipEntryCountBySide[side];
      candidate.armed = false;
      candidate.reason = `Bought ${opened.shares} ${side} shares. This side rearms after recovering to $${this.dipRearmPriceBySide[side].toFixed(3)}; the other side remains independent.`;
      this.signal = { side, action: 'BUY_DIP', reason: candidate.reason };
      changed = true;
    }

    forecast.qualifyingSides = SIDES.filter((side) => forecast.candidateBySide[side].qualifies);
    if (changed) {
      forecast.status = 'DIP_ENTRY_FILLED';
      forecast.reason = 'Paper dip entry recorded. UP and DOWN have separate histories, cooldowns, and exposure limits.';
    }
    return changed;
  }

  processSpikeExit(side, now) {
    if (!SIDES.includes(side) || !this.market) return false;
    const windowStart = Number(this.market.start);
    const tradeCutoff = windowStart + config.DIP_TRADE_WINDOW_MS;
    if (now >= tradeCutoff) return false;

    const positions = this.positions.filter((position) =>
      position.windowStart === windowStart
      && position.side === side
      && position.strategyVersion === 'DIP_REBOUND_V1'
      && position.status === 'OPEN');
    if (!positions.length) return false;
    const quote = this.freshQuote(side, now);
    if (!quote || Number(quote.updatedAt) >= tradeCutoff) return false;

    const shares = positions.reduce((total, position) => total + Number(position.shares || 0), 0);
    const grossEntryCost = positions.reduce((total, position) =>
      total + Number(position.cost ?? position.totalCost ?? 0), 0);
    if (!(shares > 0)) return false;

    const preview = sweepBook(quote.bidLevels, shares, 'SELL', this.market);
    if (!preview.complete) return false;
    const averageEntry = grossEntryCost / shares;
    const netProfit = preview.netProceeds
      - positions.reduce((total, position) => total + Number(position.totalCost || 0), 0);
    const minimumProfit = shares * config.DIP_SPIKE_MIN_NET_PROFIT_PER_SHARE;
    if (preview.averagePrice + EPSILON < averageEntry + config.DIP_SPIKE_MIN_PRICE_MOVE
      || netProfit + EPSILON < minimumProfit) return false;

    const execution = sweepBook(quote.bidLevels, shares, 'SELL', this.market, { consume: true });
    if (!execution.complete) return false;
    const order = this.createOrder('SELL_SPIKE', side, shares, now, execution);
    order.status = 'FILLED';
    order.filledAt = now;
    order.matchedShares = execution.filledShares;
    order.price = execution.averagePrice;
    order.fee = execution.fees;
    order.grossProceeds = execution.gross;
    order.netProceeds = execution.netProceeds;
    order.positionIds = positions.map((position) => position.id);
    order.exitReason = 'NET_PROFITABLE_SPIKE';
    order.fills = execution.fills;
    this.cash += execution.netProceeds;

    let remainingGross = execution.gross;
    let remainingFees = execution.fees;
    for (const [index, position] of positions.entries()) {
      const last = index === positions.length - 1;
      const shareFraction = Number(position.shares) / shares;
      const gross = last ? remainingGross : execution.gross * shareFraction;
      const fees = last ? remainingFees : execution.fees * shareFraction;
      remainingGross -= gross;
      remainingFees -= fees;
      position.exitPrice = execution.averagePrice;
      position.exitProceeds = gross;
      position.proceeds = gross - fees;
      position.exitFees = fees;
      position.realizedPnl = gross - fees - Number(position.totalCost || 0);
      position.status = 'SETTLED_EXIT';
      position.exitReason = 'PROFITABLE_SPIKE_TAKER_SWEEP';
      position.settlementBasis = 'PAPER_TAKER_SPIKE_EXIT';
      position.closedAt = now;
      position.settledAt = now;
      position.exitOrderId = order.id;
    }
    this.log('PAPER_DIP_SPIKE_EXIT_FILLED', {
      orderId: order.id,
      side,
      shares,
      averageExit: execution.averagePrice,
      grossProceeds: execution.gross,
      fees: execution.fees,
      netProfit,
      positions: positions.length,
    });
    return true;
  }

  executeBuy(side, shares, now, { kind, candidate, signal } = {}) {
    const quote = this.freshQuote(side, now);
    if (!quote) return null;
    const preview = sweepBook(
      quote.askLevels,
      shares,
      'BUY',
      this.market,
      { maximumPrice: config.DIP_MAX_BUY_PRICE },
    );
    const order = this.createOrder(kind || 'BUY_ENTRY', side, shares, now, preview);
    if (!preview.complete) {
      order.status = 'SKIPPED_PRICE_CAP_OR_DEPTH';
      order.error = `Full requested size was not available at or below $${config.DIP_MAX_BUY_PRICE.toFixed(2)}.`;
      return null;
    }
    if (preview.totalCost > this.cash + EPSILON) {
      order.status = 'REJECTED_INSUFFICIENT_CASH';
      order.error = 'Insufficient paper cash for the full taker buy and fee.';
      return null;
    }
    const execution = sweepBook(
      quote.askLevels,
      shares,
      'BUY',
      this.market,
      { maximumPrice: config.DIP_MAX_BUY_PRICE, consume: true },
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
      entryLabel: `Dip-and-rebound entry · ${side}`,
      entryType: 'PAPER_TAKER_DIP_REBOUND',
      strategyVersion: 'DIP_REBOUND_V1',
      orderType: 'PAPER_TAKER_MARKET',
      fillModel: 'VISIBLE_ASK_SWEEP_WITH_CONFIGURED_MAX_PRICE',
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
      dipReferenceHigh: candidate?.referenceHigh ?? null,
      dipTrough: candidate?.trough ?? null,
      dipReboundAmount: candidate?.reboundAmount ?? null,
      dipTriggerMid: candidate?.currentMid ?? null,
      signalSource: 'POLYMARKET_CLOB_PRICE_ONLY',
      signalScore: null,
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
    order.maxPrice = config.DIP_MAX_BUY_PRICE;
    order.signalSource = 'POLYMARKET_CLOB_PRICE_ONLY';
    order.dipReferenceHigh = candidate?.referenceHigh ?? null;
    order.dipTrough = candidate?.trough ?? null;
    order.dipReboundAmount = candidate?.reboundAmount ?? null;
    order.dipTriggerMid = candidate?.currentMid ?? null;
    this.log('PAPER_DIP_ENTRY_FILLED', {
      orderId: order.id,
      positionId: position.id,
      side,
      shares: position.shares,
      averagePrice: position.avgEntry,
      fees: position.fees,
      dipReferenceHigh: position.dipReferenceHigh,
      dipTrough: position.dipTrough,
      dipReboundAmount: position.dipReboundAmount,
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
      maxPrice: kind.startsWith('BUY') ? config.DIP_MAX_BUY_PRICE : null,
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

  recordThresholdOrder(position, now, kind, payout) {
    const order = this.createOrder(kind, position.side, position.initialShares || position.shares, now, {
      complete: true,
      filledShares: position.initialShares || position.shares,
      averagePrice: payout,
    });
    order.status = 'FILLED';
    order.matchedShares = order.shares;
    order.price = payout;
    order.positionId = position.id;
    order.exitReason = position.exitReason;
    order.filledAt = now;
    order.fee = 0;
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
    const windowEnd = windowStart + this.windowMs;
    for (const position of positions) {
      if (position.strategyVersion === 'DIP_REBOUND_V1') continue;
      const quote = this.market?.start === windowStart
        ? this.liveQuotes[position.side]
        : null;
      if (Number(quote?.updatedAt) >= windowStart
        && Number(quote?.updatedAt) < windowEnd
        && this.isTakeProfitQuote(quote, now, position)) {
        this.finalizeTakeProfit(position, Number(quote.updatedAt));
      }
    }
    const pendingPositions = positions.filter((position) => position.status === 'OPEN');
    for (const position of pendingPositions) {
      position.status = 'PENDING_CLOB_RESULT';
      position.markStatus = 'PENDING_CLOB_RESULT';
      position.pendingResolutionAt = now;
      position.exitReason = 'WAITING_FOR_OFFICIAL_RESOLUTION';
      position.settlementBasis = 'POLYMARKET_RESOLUTION_PENDING';
    }
    this.log('PAPER_DIP_WINDOW_ENDED', {
      windowStart,
      pendingResolutionCount: pendingPositions.length,
      triggerReason,
    });
  }

  async resolvePendingPositions(now) {
    const pendingByMarket = new Map();
    for (const position of this.positions) {
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
          this.log('PAPER_DIP_RESOLVED', {
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
    this.log('PAPER_DIP_BOT_STARTED', {
      note: 'Paper-only CLOB dip-and-rebound entries with fee-aware spike exits. Real-order modules are not loaded.',
      entryShares: config.DIP_ENTRY_SHARES,
      maxEntriesPerSide: config.DIP_MAX_ENTRIES_PER_SIDE,
      tradingSeconds: config.DIP_TRADE_WINDOW_MS / 1000,
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
        orderType: 'VISIBLE_BOOK_TAKER_SWEEP',
        exit: `Within the first ${config.DIP_TRADE_WINDOW_MS / 1000} seconds, sell all current-window UP or DOWN shares together only when the executable bid sweep is at least $${config.DIP_SPIKE_MIN_PRICE_MOVE.toFixed(2)} above average entry and net profit after modeled taker fees is at least $${config.DIP_SPIKE_MIN_NET_PROFIT_PER_SHARE.toFixed(2)} per share. Otherwise hold for official resolution.`,
        liveTradingEnabled: false,
        realOrderModulesLoaded: false,
        entryShares: config.DIP_ENTRY_SHARES,
        maxEntriesPerSide: config.DIP_MAX_ENTRIES_PER_SIDE,
        maxBuyPrice: config.DIP_MAX_BUY_PRICE,
        tradeWindowMs: config.DIP_TRADE_WINDOW_MS,
        signal: 'CLOB midpoint only: a four-cent dip from the prior rolling high, followed by a one-cent rebound and two rising quote updates.',
        signalState: this.forecast,
        orders: {
          type: 'Visible-book taker-style paper sweeps',
          initialShares: config.DIP_ENTRY_SHARES,
          maxEntriesPerSide: config.DIP_MAX_ENTRIES_PER_SIDE,
          maxBuyPrice: config.DIP_MAX_BUY_PRICE,
          entryCooldownMs: config.DIP_ENTRY_COOLDOWN_MS,
          rearmRecovery: config.DIP_REARM_RECOVERY,
          maxEntriesPerWindow: `${config.DIP_MAX_ENTRIES_PER_SIDE} per side`,
        },
        repeatEntryRule: `UP and DOWN are independent. Each can buy ${config.DIP_ENTRY_SHARES} shares on up to ${config.DIP_MAX_ENTRIES_PER_SIDE} separate dip setups per window, with a ${config.DIP_ENTRY_COOLDOWN_MS / 1000}-second cooldown and a $${config.DIP_REARM_RECOVERY.toFixed(2)} recovery required before that side rearms.`,
        priceFeed: this.priceFeed?.snapshot?.() || null,
        exits: {
          mode: 'SPIKE_EXIT_OR_OFFICIAL_RESOLUTION',
          takeProfit: true,
          takeProfitTrigger: config.DIP_SPIKE_MIN_PRICE_MOVE,
          takeProfitPayout: null,
          stopLoss: false,
          tradeWindowMs: config.DIP_TRADE_WINDOW_MS,
          minimumNetProfitPerShare: config.DIP_SPIKE_MIN_NET_PROFIT_PER_SHARE,
          resolutionPollMs: config.RESOLUTION_POLL_MS,
          otherwise: 'After 240 seconds, stop strategy orders. Hold unsold shares until the original Polymarket market officially resolves.',
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
        startingCapital: this.capital,
        currentCapital: this.cash + Number(state.account.markedValue || 0),
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
  analyzeDipRebound,
  sweepBook,
  resolvedPayout,
};

module.exports = PressureForecastBot;
