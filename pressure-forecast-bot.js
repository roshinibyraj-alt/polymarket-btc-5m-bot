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
const DUAL_ENGINE_STRATEGY_VERSION = 'BTC_DUAL_ENGINE_071_030_SWAP_065_V1';

function oppositeSide(side) {
  if (side === 'UP') return 'DOWN';
  if (side === 'DOWN') return 'UP';
  return null;
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
      strategyMode: 'dual-engine',
      priceFeed: feed,
    });
    this.now = now;
    this.marketData = marketData;
    this.clobFeedFactory = clobFeedFactory;
    this.clobFeed = null;
    this.clobFeedMarketKey = null;
    this.initialCapital = initialCapital;
    this.strategyName = 'BTC 5-minute dual-engine paper bot';
    this.strategyMode = 'dual-engine';
    this.downProfitCarry = 0;
    this.downSharesThisWindow = config.ENGINE_BASE_SHARES;
    this.upEngine = this.emptyEngine('UP');
    this.downEngine = this.emptyEngine('DOWN');
    this.sideSwaps = [];
    this.lastObservedMidBySide = { UP: null, DOWN: null };
    this.lastObservedAtBySide = { UP: null, DOWN: null };
    this.forecast = this.emptyForecast('Waiting for the current BTC 5-minute market.');
    this.lastEntryAt = null;
    this.lastEntryAtBySide = { UP: null, DOWN: null };
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
      strategyVersion: DUAL_ENGINE_STRATEGY_VERSION,
      forecast: this.forecast,
      downProfitCarry: this.downProfitCarry,
      downSharesThisWindow: this.downSharesThisWindow,
      upEngine: this.upEngine,
      downEngine: this.downEngine,
      sideSwaps: this.sideSwaps,
      lastObservedMidBySide: this.lastObservedMidBySide,
      lastObservedAtBySide: this.lastObservedAtBySide,
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
    this.downProfitCarry = Math.max(0, Number(state.downProfitCarry) || 0);
    this.downSharesThisWindow = Number(state.downSharesThisWindow) || config.ENGINE_BASE_SHARES;
    this.upEngine = { ...this.emptyEngine('UP'), ...(state.upEngine || {}) };
    this.downEngine = { ...this.emptyEngine('DOWN'), ...(state.downEngine || {}) };
    if (!SIDES.includes(this.upEngine.side) || !SIDES.includes(this.downEngine.side)
      || this.upEngine.side === this.downEngine.side) {
      this.upEngine.side = 'UP';
      this.downEngine.side = 'DOWN';
    }
    this.sideSwaps = Array.isArray(state.sideSwaps) ? state.sideSwaps.slice(-100) : [];
    this.lastObservedMidBySide = {
      UP: Number.isFinite(Number(state.lastObservedMidBySide?.UP))
        ? Number(state.lastObservedMidBySide.UP) : null,
      DOWN: Number.isFinite(Number(state.lastObservedMidBySide?.DOWN))
        ? Number(state.lastObservedMidBySide.DOWN) : null,
    };
    this.lastObservedAtBySide = {
      UP: Number.isFinite(Number(state.lastObservedAtBySide?.UP))
        ? Number(state.lastObservedAtBySide.UP) : null,
      DOWN: Number.isFinite(Number(state.lastObservedAtBySide?.DOWN))
        ? Number(state.lastObservedAtBySide.DOWN) : null,
    };
    this.forecast = this.emptyForecast('Collecting fresh Polymarket quotes after restart.', 'WAITING_FOR_CLOB');
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
      const signalSide = SIDES.includes(position.signalSide) ? position.signalSide : position.side;
      if (Number.isFinite(filledAt)) {
        lastEntryAtBySide[signalSide] = Math.max(lastEntryAtBySide[signalSide] || 0, filledAt);
      }
    }
    for (const order of orders) {
      if (Number(order.windowStart) !== windowStart || !SIDES.includes(order.side)) continue;
      if (order.action !== 'BUY' || order.status !== 'FILLED') continue;
      const filledAt = Number(order.filledAt ?? order.createdAt);
      const signalSide = SIDES.includes(order.signalSide) ? order.signalSide : order.side;
      if (Number.isFinite(filledAt)) {
        lastEntryAtBySide[signalSide] = Math.max(lastEntryAtBySide[signalSide] || 0, filledAt);
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

  emptyEngine(side, extra = {}) {
    return {
      side,
      status: side === 'DOWN' ? 'WAITING_FOR_WINDOW' : 'ARMED',
      fillStatus: 'NOT FILLED',
      shares: config.ENGINE_BASE_SHARES,
      orderId: null,
      positionId: null,
      triggerAt: null,
      takeProfitAt: null,
      ...extra,
    };
  }

  emptyForecast(reason, status = 'WAITING_FOR_DATA') {
    return {
      ready: false,
      status,
      reason,
      strategyVersion: DUAL_ENGINE_STRATEGY_VERSION,
      signalSource: 'POLYMARKET_CLOB_PRICE_ONLY_TWO_ENGINE',
      secondsIntoWindow: null,
      secondsRemaining: null,
      baseShares: config.ENGINE_BASE_SHARES,
      downProfitCarry: this.downProfitCarry,
      up: this.upEngine,
      down: this.downEngine,
      sideSwaps: this.sideSwaps,
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
    this.signal = null;
    const downShares = config.ENGINE_BASE_SHARES + this.downProfitCarry / config.ENGINE_DOWN_SHARE_PRICE;
    this.downSharesThisWindow = Math.round(downShares * 100) / 100;
    this.upEngine = this.emptyEngine('UP', {
      status: 'ARMED',
      fillStatus: 'NOT FILLED',
      shares: config.ENGINE_BASE_SHARES,
      triggerPrice: config.ENGINE_UP_TRIGGER_ASK,
      maxSweepPrice: config.ENGINE_UP_MAX_SWEEP_PRICE,
    });
    this.downEngine = this.emptyEngine('DOWN', {
      status: 'RESTING',
      fillStatus: 'RESTING',
      shares: this.downSharesThisWindow,
      limitPrice: config.ENGINE_DOWN_LIMIT_PRICE,
      profitCarry: this.downProfitCarry,
      profitCarryShares: Math.round((this.downProfitCarry / config.ENGINE_DOWN_SHARE_PRICE) * 100) / 100,
    });
    this.lastObservedMidBySide = { UP: null, DOWN: null };
    this.lastObservedAtBySide = { UP: null, DOWN: null };
    this.forecast = this.emptyForecast('UP waits for its trigger; the DOWN limit is being placed.', 'ENGINES_ARMING');
    this.placeDownLimitOrder(start, now);
    this.log('PAPER_ENGINES_WINDOW_STARTED', {
      windowStart: start,
      upShares: this.upEngine.shares,
      upTriggerAsk: config.ENGINE_UP_TRIGGER_ASK,
      downLimitPrice: config.ENGINE_DOWN_LIMIT_PRICE,
      downShares: this.downEngine.shares,
      downProfitCarry: this.downProfitCarry,
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
       this.processEngineTriggers(now);
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
        this.log('PAPER_DUAL_ENGINE_SCAN_ERROR', { error: this.error });
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
    this.updatePositionMarks(side, this.liveQuotes[side], now);
    this.applyTakeProfitExits(now);
    this.processEngineTriggers(now);
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
    }
    for (const side of SIDES) {
      this.updatePositionMarks(side, this.liveQuotes[side], now);
    }
    this.applyTakeProfitExits(now);
    this.processEngineTriggers(now);
  }

  updatePositionMarks(side, quote, now) {
    for (const position of this.positions) {
      if (position.windowStart !== this.market?.start
        || position.side !== side
        || position.status !== 'OPEN') continue;
      position.markBid = quote?.bestBid ?? null;
      position.markUpdatedAt = quote?.updatedAt || now;
      position.markStatus = quote?.bestBid == null || quote.stale ? 'MISSING' : 'LIVE';
      position.unrealizedPnl = position.markStatus === 'LIVE'
        ? Number(position.markBid) * Number(position.shares) - Number(position.totalCost || 0)
        : null;
    }
  }

  applyTakeProfitExits(now) {
    if (!this.market || now >= Number(this.market.end)) return;
    for (const position of this.positions) {
      if (position.windowStart !== this.market.start || position.status !== 'OPEN') continue;
      const quote = this.liveQuotes[position.side];
      if (!this.isTakeProfitQuote(quote, now, position)) continue;
      this.finalizeTakeProfit(position, Number(quote.updatedAt));
    }
    this.updateEngineForecast(now);
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
       && bestBid >= config.ENGINE_TAKE_PROFIT_BID_TRIGGER;
  }

  finalizeTakeProfit(position, now) {
    if (position.status !== 'OPEN') return;
    const payout = config.ENGINE_TAKE_PROFIT_PAYOUT;
    const grossPayout = payout * Number(position.shares);
    position.exitPrice = payout;
    position.exitProceeds = grossPayout;
    position.proceeds = grossPayout;
    position.exitFees = 0;
    position.realizedPnl = grossPayout - Number(position.totalCost || 0);
    position.status = 'SETTLED_EXIT';
    position.exitReason = `TAKE_PROFIT_BID_AT_${config.ENGINE_TAKE_PROFIT_BID_TRIGGER.toFixed(2)}`;
    position.settlementBasis = 'PAPER_TAKE_PROFIT';
    position.closedAt = now;
    position.settledAt = now;
    this.cash += grossPayout;
    this.recordThresholdOrder(position, now, 'SELL_TAKE_PROFIT', payout);
    this.log('PAPER_ENGINE_TAKE_PROFIT_HIT', {
      positionId: position.id,
      engine: position.engine || position.side,
      side: position.side,
      triggerBid: config.ENGINE_TAKE_PROFIT_BID_TRIGGER,
      payoutPerShare: payout,
      shares: position.shares,
      proceeds: grossPayout,
      realizedPnl: position.realizedPnl,
    });
    this.applyEngineTakeProfit(position, now);
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

  placeDownLimitOrder(start, now) {
    const side = this.downEngine.side;
    const shares = Number(this.downEngine.shares) || this.downSharesThisWindow;
    const order = this.createOrder('BUY_DOWN_LIMIT', side, shares, now, {
      complete: false,
      filledShares: 0,
      averagePrice: config.ENGINE_DOWN_LIMIT_PRICE,
      fees: 0,
    });
    order.status = 'LIVE';
    order.orderType = 'PAPER_LIMIT_RESTING';
    order.price = config.ENGINE_DOWN_LIMIT_PRICE;
    order.limitPrice = config.ENGINE_DOWN_LIMIT_PRICE;
    order.maxPrice = null;
    order.matchedShares = 0;
    order.fee = 0;
    order.engine = 'DOWN';
    order.signalSide = side;
    order.fillModel = 'ASSUMED_PAIRED_FILL_WHEN_EITHER_ENTRY_TRIGGERS';
    this.downEngine.orderId = order.id;
    this.downEngine.status = 'RESTING';
    this.log('PAPER_DOWN_LIMIT_PLACED', {
      orderId: order.id,
      windowStart: start,
      limitPrice: order.limitPrice,
      side,
      engine: 'DOWN',
      shares,
      downProfitCarry: this.downProfitCarry,
    });
    return order;
  }

  updateEngineForecast(now) {
    const start = this.market?.start;
    if (!Number.isFinite(Number(start))) return;
    const upSide = this.upEngine.side;
    const downSide = this.downEngine.side;
    const upQuote = this.liveQuotes[upSide] || {};
    const downQuote = this.liveQuotes[downSide] || {};
    const elapsed = Number(now) - Number(start);
    const downPosition = this.downEngine.positionId
      ? this.positions.find((position) => position.id === this.downEngine.positionId)
      : null;
    const upPosition = this.upEngine.positionId
      ? this.positions.find((position) => position.id === this.upEngine.positionId) || null
      : null;
    const upOrder = this.upEngine.orderId
      ? this.orders.find((order) => order.id === this.upEngine.orderId) || null
      : null;
    const downOrder = this.downEngine.orderId
      ? this.orders.find((order) => order.id === this.downEngine.orderId) || null
      : null;
    this.forecast = {
      ready: Boolean(this.freshQuote('UP', now) && this.freshQuote('DOWN', now)),
      status: elapsed >= this.windowMs ? 'WINDOW_CLOSED'
        : this.upEngine.status === 'OPEN' || this.downEngine.status === 'OPEN' ? 'POSITION_OPEN'
          : this.upEngine.status === 'TAKE_PROFIT' || this.downEngine.status === 'TAKE_PROFIT' ? 'TAKE_PROFIT_HIT'
            : 'ENGINES_ACTIVE',
      reason: `UP engine is assigned to ${upSide}; DOWN engine is assigned to ${downSide}. Unfilled engines swap when either midpoint crosses $${config.ENGINE_SIDE_SWAP_TRIGGER_MID.toFixed(2)}.`,
      strategyVersion: DUAL_ENGINE_STRATEGY_VERSION,
      signalSource: 'POLYMARKET_CLOB_PRICE_ONLY_TWO_ENGINE',
      secondsIntoWindow: Math.max(0, elapsed / 1000),
      secondsRemaining: Math.max(0, (Number(this.market?.end) - now) / 1000),
      baseShares: config.ENGINE_BASE_SHARES,
      downProfitCarry: this.downProfitCarry,
      downSharesThisWindow: this.downSharesThisWindow,
      downSharesNextWindow: Math.round(
        (config.ENGINE_BASE_SHARES + this.downProfitCarry / config.ENGINE_DOWN_SHARE_PRICE) * 100,
      ) / 100,
      sideSwapTriggerMid: config.ENGINE_SIDE_SWAP_TRIGGER_MID,
      sideAssignments: { UP: upSide, DOWN: downSide },
      sideSwaps: this.sideSwaps.filter((swap) => Number(swap.windowStart) === Number(start)),
      sideSwapCount: this.sideSwaps.filter((swap) => Number(swap.windowStart) === Number(start)).length,
      upQuote: { ...upQuote },
      downQuote: { ...downQuote },
      pairedEntry: {
        active: Boolean(upPosition && downPosition),
        pairId: upPosition?.pairId || downPosition?.pairId || null,
        triggerSide: upPosition?.pairedTriggerSide || downPosition?.pairedTriggerSide || null,
        assumption: 'If either entry triggers, both paper legs are recorded filled.',
      },
      up: {
        ...this.upEngine,
        orderStatus: upOrder?.status || null,
        fillStatus: upPosition ? 'FILLED · PAIRED' : this.upEngine.fillStatus || 'NOT FILLED',
        capitalCommitted: upPosition && ['OPEN', 'PENDING_CLOB_RESULT'].includes(upPosition.status)
          ? Number(upPosition.totalCost || 0)
          : 0,
        floatingPnl: upPosition?.status === 'OPEN' && upPosition.markStatus === 'LIVE'
          && Number.isFinite(Number(upPosition.markBid))
          ? Number(upPosition.markBid) * Number(upPosition.shares) - Number(upPosition.totalCost || 0)
          : null,
        position: upPosition,
      },
      down: {
        ...this.downEngine,
        orderStatus: downOrder?.status || null,
        fillStatus: downPosition ? 'FILLED · PAIRED'
          : this.downEngine.fillStatus || (downOrder?.status === 'LIVE' ? 'RESTING' : 'NOT FILLED'),
        capitalCommitted: downPosition && ['OPEN', 'PENDING_CLOB_RESULT'].includes(downPosition.status)
          ? Number(downPosition.totalCost || 0)
          : 0,
        floatingPnl: downPosition?.status === 'OPEN' && downPosition.markStatus === 'LIVE'
          && Number.isFinite(Number(downPosition.markBid))
          ? Number(downPosition.markBid) * Number(downPosition.shares) - Number(downPosition.totalCost || 0)
          : null,
        position: downPosition,
      },
    };
  }

  swapUnfilledEngineSides({ triggerSide, triggerMid, now }) {
    const start = Number(this.market?.start);
    if (!Number.isFinite(start)
      || this.upEngine.positionId || this.downEngine.positionId
      || this.positions.some((position) => Number(position.windowStart) === start
        && ['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status))) return false;

    const oldUpSide = this.upEngine.side;
    const oldDownSide = this.downEngine.side;
    if (!SIDES.includes(oldUpSide) || !SIDES.includes(oldDownSide) || oldUpSide === oldDownSide) return false;

    const canceledOrders = [];
    for (const order of this.orders) {
      if (Number(order.windowStart) !== start || order.action !== 'BUY' || order.status !== 'LIVE') continue;
      order.status = 'CANCELLED_SIDE_SWAP';
      order.closedAt = now;
      order.cancelReason = 'Unfilled engine sides swapped at the $0.65 midpoint threshold.';
      canceledOrders.push(order.id);
    }

    // Engine sizing travels with its strategy role as the assigned outcome changes.
    this.upEngine.side = oldDownSide;
    this.downEngine.side = oldUpSide;
    this.upEngine.orderId = null;
    this.upEngine.positionId = null;
    this.upEngine.status = 'ARMED';
    this.upEngine.fillStatus = 'NOT FILLED';
    this.upEngine.triggerAt = null;
    this.downEngine.orderId = null;
    this.downEngine.positionId = null;
    this.downEngine.status = 'RESTING';
    this.downEngine.fillStatus = 'RESTING';
    this.downEngine.triggerAt = null;

    const swap = {
      id: `side-swap-${start}-${this.sideSwaps.length + 1}`,
      windowStart: start,
      at: now,
      triggerSide,
      triggerMid: Number(triggerMid),
      from: { UP: oldUpSide, DOWN: oldDownSide },
      to: { UP: this.upEngine.side, DOWN: this.downEngine.side },
      engineShares: {
        UP: Number(this.upEngine.shares) || config.ENGINE_BASE_SHARES,
        DOWN: Number(this.downEngine.shares) || this.downSharesThisWindow,
      },
      canceledOrderIds: canceledOrders,
    };
    this.sideSwaps.push(swap);
    if (this.sideSwaps.length > 100) this.sideSwaps.splice(0, this.sideSwaps.length - 100);
    this.placeDownLimitOrder(start, now);
    this.log('PAPER_ENGINE_SIDE_SWAP', {
      ...swap,
      thresholdMid: config.ENGINE_SIDE_SWAP_TRIGGER_MID,
      restingLimitSide: this.downEngine.side,
      restingLimitPrice: config.ENGINE_DOWN_LIMIT_PRICE,
      carriedStakeWithEngine: true,
    });
    this.forecast = this.emptyForecast(
      `${triggerSide} midpoint reached $${Number(triggerMid).toFixed(3)}; the unfilled engine sides and stakes were swapped.`,
      'ENGINE_SIDES_SWAPPED',
    );
    this.updateEngineForecast(now);
    return true;
  }

  processEngineTriggers(now) {
    if (!this.market || !Number.isFinite(Number(this.market.start))) return false;
    const start = Number(this.market.start);
    const elapsed = now - start;
    if (elapsed < 0 || elapsed >= this.windowMs) {
      this.updateEngineForecast(now);
      return false;
    }

    const outcomeQuotes = {
      UP: this.freshQuote('UP', now),
      DOWN: this.freshQuote('DOWN', now),
    };
    const upSide = this.upEngine.side;
    const downSide = this.downEngine.side;
    const upQuote = outcomeQuotes[upSide];
    const downQuote = outcomeQuotes[downSide];
    const downOrder = this.downEngine.orderId
      ? this.orders.find((order) => order.id === this.downEngine.orderId)
      : null;

    const hasWindowEntry = Boolean(this.upEngine.positionId || this.downEngine.positionId)
      || this.positions.some((position) => Number(position.windowStart) === start
        && ['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status));
    const thresholdCrossings = [];
    for (const side of SIDES) {
      const quote = outcomeQuotes[side];
      if (!quote || Number(quote.updatedAt) < start || Number(quote.updatedAt) >= Number(this.market.end)) continue;
      const updatedAt = Number(quote.updatedAt);
      if (updatedAt <= Number(this.lastObservedAtBySide[side] ?? -Infinity)) continue;
      const mid = Number(quote.mid);
      if (!Number.isFinite(mid)) continue;
      const previousMid = this.lastObservedMidBySide[side];
      if (!hasWindowEntry
        && mid + EPSILON >= config.ENGINE_SIDE_SWAP_TRIGGER_MID
        && (previousMid == null || !Number.isFinite(Number(previousMid))
          || Number(previousMid) < config.ENGINE_SIDE_SWAP_TRIGGER_MID)) {
        thresholdCrossings.push({ side, mid, updatedAt });
      }
      this.lastObservedMidBySide[side] = mid;
      this.lastObservedAtBySide[side] = updatedAt;
    }
    if (thresholdCrossings.length) {
      thresholdCrossings.sort((a, b) => a.updatedAt - b.updatedAt);
      const crossing = thresholdCrossings[thresholdCrossings.length - 1];
      if (this.swapUnfilledEngineSides({
        triggerSide: crossing.side,
        triggerMid: crossing.mid,
        now,
      })) return true;
    }

    const upTriggered = this.upEngine.status === 'ARMED'
      && upQuote
      && Number(upQuote.updatedAt) >= start
      && Number(upQuote.bestAsk) + EPSILON >= config.ENGINE_UP_TRIGGER_ASK;
    const downTriggered = this.downEngine.status === 'RESTING'
      && downOrder?.status === 'LIVE'
      && downQuote
      && Number(downQuote.updatedAt) > Number(downOrder.createdAt)
      && Number(downQuote.updatedAt) < Number(this.market.end)
      && Number(downQuote.mid) < config.ENGINE_DOWN_LIMIT_PRICE - EPSILON;

    let changed = false;
    if (!hasWindowEntry && (upTriggered || downTriggered)) {
      const triggerSide = upTriggered ? upSide : downSide;
      this.log('PAPER_ENGINE_ENTRY_TRIGGERED', {
        windowStart: start,
        triggerSide,
        upEngineSide: upSide,
        downEngineSide: downSide,
        upAsk: upQuote?.bestAsk ?? null,
        downMid: downQuote?.mid ?? null,
        upTriggerAsk: config.ENGINE_UP_TRIGGER_ASK,
        downLimitPrice: config.ENGINE_DOWN_LIMIT_PRICE,
        sideAssignments: { UP: upSide, DOWN: downSide },
        requestedUpShares: Number(this.upEngine.shares) || config.ENGINE_BASE_SHARES,
        requestedDownShares: Number(downOrder?.shares) || this.downSharesThisWindow,
      });
      changed = this.fillPairedEnginePositions({
        triggerSide,
        now,
        upQuote,
        downQuote,
        downOrder,
      });
      if (!changed && upTriggered && !this.upEngine.positionId) {
        this.upEngine.status = 'NO_FILL';
        this.upEngine.fillStatus = 'NOT FILLED';
      }
    }

    this.updateEngineForecast(now);
    return changed;
  }

  fillPairedEnginePositions({ triggerSide, now, upQuote, downQuote, downOrder }) {
    if (!upQuote || !downQuote || !downOrder || downOrder.status !== 'LIVE') {
      this.log('PAPER_PAIRED_ENTRY_WAITING_FOR_QUOTES', {
        triggerSide,
        upQuoteStatus: upQuote?.status || 'MISSING',
        downQuoteStatus: downQuote?.status || 'MISSING',
        downOrderStatus: downOrder?.status || 'MISSING',
      });
      return false;
    }

    const upSide = this.upEngine.side;
    const downSide = this.downEngine.side;
    const upShares = Number(this.upEngine.shares) || config.ENGINE_BASE_SHARES;
    const downShares = Number(downOrder.shares);
    const downCost = downShares * config.ENGINE_DOWN_LIMIT_PRICE;
    const upPreview = sweepBook(
      upQuote.askLevels,
      upShares,
      'BUY',
      this.market,
      { maximumPrice: config.ENGINE_UP_MAX_SWEEP_PRICE },
    );
    if (!upPreview.complete || upPreview.totalCost + downCost > this.cash + EPSILON) {
      const reason = !upPreview.complete
        ? `The paired UP engine cannot sweep ${upShares} ${upSide} shares through $${config.ENGINE_UP_MAX_SWEEP_PRICE.toFixed(2)}.`
        : 'Insufficient paper cash to record both sides of the paired entry.';
      const failedOrder = this.createOrder('BUY_UP_MARKET', upSide, upShares, now, upPreview);
      failedOrder.engine = 'UP';
      failedOrder.signalSide = triggerSide;
      failedOrder.pairedTriggerSide = triggerSide;
      failedOrder.orderType = 'PAPER_TAKER_MARKET';
      failedOrder.maxPrice = config.ENGINE_UP_MAX_SWEEP_PRICE;
      failedOrder.status = upPreview.complete ? 'REJECTED_INSUFFICIENT_CASH' : 'SKIPPED_SLIPPAGE_OR_DEPTH';
      failedOrder.error = reason;
      this.upEngine.orderId = failedOrder.id;
      this.upEngine.triggerAt = now;
      this.upEngine.status = 'NO_FILL';
      this.upEngine.fillStatus = 'NOT FILLED';
      this.log('PAPER_PAIRED_ENTRY_BLOCKED', {
        triggerSide,
        reason,
        upEngineSide: upSide,
        upShares,
        upAverageAsk: upPreview.averagePrice,
        upCostWithFees: upPreview.totalCost,
        downEngineSide: downSide,
        downShares,
        downCost,
        availableCash: this.cash,
      });
      return false;
    }

    this.upEngine.status = 'ORDER_ATTEMPTED';
    this.upEngine.triggerAt = now;
    this.downEngine.status = 'ORDER_ATTEMPTED';
    this.downEngine.triggerAt = now;
    const upPosition = this.executeBuy(upSide, upShares, now, {
      kind: 'BUY_UP_MARKET',
      engine: 'UP',
      signalSide: triggerSide,
      maximumPrice: config.ENGINE_UP_MAX_SWEEP_PRICE,
      pairedTriggerSide: triggerSide,
    });
    if (!upPosition) {
      this.upEngine.orderId = this.orders[0]?.windowStart === Number(this.market.start)
        && this.orders[0]?.side === upSide ? this.orders[0].id : null;
      this.upEngine.status = 'NO_FILL';
      this.upEngine.fillStatus = 'NOT FILLED';
      this.downEngine.status = 'RESTING';
      this.downEngine.fillStatus = 'RESTING';
      return false;
    }

    const pairId = downOrder.id;
    const downPosition = this.fillDownLimitOrder(downOrder, downQuote, {
      now,
      pairId,
      pairedTriggerSide: triggerSide,
    });
    if (!downPosition) {
      // The preflight above makes this path defensive; keep the pair atomic if
      // cash or order state changed unexpectedly before the DOWN ledger write.
      this.positions = this.positions.filter((position) => position.id !== upPosition.id);
      this.cash += Number(upPosition.totalCost || 0);
      const upOrder = this.orders.find((order) => order.id === upPosition.id);
      if (upOrder) {
        upOrder.status = 'CANCELLED_PAIRED_FILL';
        upOrder.error = 'The paired DOWN leg could not be recorded; neither leg is counted as filled.';
      }
      this.upEngine.positionId = null;
      this.upEngine.status = 'NO_FILL';
      this.upEngine.fillStatus = 'NOT FILLED';
      this.downEngine.status = 'RESTING';
      this.downEngine.fillStatus = 'RESTING';
      return false;
    }

    const upOrder = this.orders.find((order) => order.id === upPosition.id);
    for (const item of [upPosition, downPosition, upOrder, downOrder]) {
      if (item) {
        item.pairId = pairId;
        item.pairedTriggerSide = triggerSide;
        item.pairedFillAssumption = 'BOTH_LEGS_FILLED_WHEN_EITHER_ENTRY_TRIGGERS';
      }
    }
    this.upEngine.orderId = upPosition.id;
    this.upEngine.positionId = upPosition.id;
    this.upEngine.status = 'OPEN';
    this.upEngine.fillStatus = 'FILLED · PAIRED';
    this.upEngine.shares = upPosition.shares;
    this.downEngine.orderId = downOrder.id;
    this.downEngine.positionId = downPosition.id;
    this.downEngine.status = 'OPEN';
    this.downEngine.fillStatus = 'FILLED · PAIRED';
    this.downEngine.shares = downPosition.shares;
    this.lastEntryAtBySide.UP = now;
    this.lastEntryAtBySide.DOWN = now;
    this.log('PAPER_ENGINE_PAIRED_ENTRY_FILLED', {
      pairId,
      triggerSide,
      filledAt: now,
      upPositionId: upPosition.id,
      upShares: upPosition.shares,
      upAveragePrice: upPosition.avgEntry,
      upFees: upPosition.fees,
      downPositionId: downPosition.id,
      downShares: downPosition.shares,
      downLimitPrice: downPosition.avgEntry,
      downFees: downPosition.fees,
    });
    return true;
  }

  fillDownLimitOrder(order, quote, { now = Number(quote?.updatedAt), pairId = null, pairedTriggerSide = null } = {}) {
    const shares = Number(order.shares);
    const price = Number(order.limitPrice);
    const cost = shares * price;
    if (!(shares > 0) || cost > this.cash + EPSILON) {
      order.status = 'REJECTED_INSUFFICIENT_CASH';
      order.error = 'Insufficient paper cash to fill the full DOWN limit order.';
      this.downEngine.status = 'REJECTED';
      this.log('PAPER_DOWN_LIMIT_REJECTED', {
        orderId: order.id,
        shares,
        requiredCash: cost,
        availableCash: this.cash,
      });
      return false;
    }
    const filledAt = Number(now);
    const position = {
      id: order.id,
      asset: 'BTC',
      timeframe: '5m',
      windowMs: this.windowMs,
      windowStart: this.market.start,
      marketId: this.market.id,
      slug: this.market.slug,
      title: this.market.title,
      side: order.side,
      outcome: order.side,
      engine: 'DOWN',
      signalSide: pairedTriggerSide || order.side,
      tokenId: this.market.tokens[order.side],
      entryKey: order.id,
      entryLabel: `${order.side} resting limit at $${price.toFixed(2)}`,
      entryType: 'PAPER_LIMIT_DOWN_ENGINE',
      strategyVersion: DUAL_ENGINE_STRATEGY_VERSION,
      orderType: 'PAPER_LIMIT_RESTING',
      fillModel: pairedTriggerSide
        ? 'ASSUMED_PAIRED_FILL_WHEN_EITHER_ENTRY_TRIGGERS'
        : 'FULL_FILL_ON_POST_ORDER_MIDPOINT_TICK_THROUGH',
      pairId,
      pairedTriggerSide,
      pairedFillAssumption: pairedTriggerSide
        ? 'BOTH_LEGS_FILLED_WHEN_EITHER_ENTRY_TRIGGERS'
        : null,
      shares,
      initialShares: shares,
      avgEntry: price,
      averagePrice: price,
      cost,
      totalCost: cost,
      fees: 0,
      entryFees: 0,
      exitFees: 0,
      status: 'OPEN',
      submittedAt: Number(order.createdAt),
      openedAt: filledAt,
      filledAt,
      markBid: quote.bestBid,
      markUpdatedAt: quote.updatedAt,
      markStatus: 'LIVE',
      entryFills: [{ price, shares, at: filledAt }],
      limitPrice: price,
      triggerMid: Number(quote.mid),
      signalSource: pairedTriggerSide
        ? 'POLYMARKET_CLOB_PAIRED_ENTRY_TRIGGER'
        : 'POLYMARKET_CLOB_ENGINE_LIMIT_TICK_THROUGH',
    };
    this.cash -= cost;
    this.positions.unshift(position);
    order.status = 'FILLED';
    order.filledAt = filledAt;
    order.matchedShares = shares;
    order.price = price;
    order.grossCost = cost;
    order.totalCost = cost;
    order.fee = 0;
    order.positionId = position.id;
    order.triggerMid = Number(quote.mid);
    order.pairId = pairId;
    order.pairedTriggerSide = pairedTriggerSide;
    order.pairedFillAssumption = pairedTriggerSide
      ? 'BOTH_LEGS_FILLED_WHEN_EITHER_ENTRY_TRIGGERS'
      : null;
    order.fills = [{ price, shares }];
    this.downEngine.status = 'OPEN';
    this.downEngine.fillStatus = pairedTriggerSide ? 'FILLED · PAIRED' : 'FILLED';
    this.downEngine.positionId = position.id;
    this.downEngine.triggerAt = filledAt;
    this.lastEntryAtBySide.DOWN = filledAt;
    this.log('PAPER_DOWN_LIMIT_FILLED', {
      orderId: order.id,
      positionId: position.id,
      engine: 'DOWN',
      side: position.side,
      triggerMid: Number(quote.mid),
      limitPrice: price,
      shares,
      fees: 0,
      pairId,
      pairedTriggerSide,
    });
    return position;
  }

  applyEngineTakeProfit(position, now) {
    if (position.engine === 'UP') {
      this.upEngine.status = 'TAKE_PROFIT';
      this.upEngine.takeProfitAt = now;
      const addedProfit = Math.max(0, Number(position.realizedPnl) || 0);
      this.downProfitCarry += addedProfit;
      this.log('PAPER_UP_PROFIT_ADDED_TO_DOWN_STAKE', {
        positionId: position.id,
        realizedProfit: position.realizedPnl,
        addedProfit,
        nextDownShares: Math.round(
          (config.ENGINE_BASE_SHARES + this.downProfitCarry / config.ENGINE_DOWN_SHARE_PRICE) * 100,
        ) / 100,
      });
    } else if (position.engine === 'DOWN') {
      this.downEngine.status = 'TAKE_PROFIT';
      this.downEngine.takeProfitAt = now;
      this.downProfitCarry = 0;
      this.log('PAPER_DOWN_TP_RESET_BOTH_ENGINES_TO_BASE', {
        positionId: position.id,
        realizedProfit: position.realizedPnl,
        nextUpShares: config.ENGINE_BASE_SHARES,
        nextDownShares: config.ENGINE_BASE_SHARES,
      });
    }
    this.updateEngineForecast(now);
  }

  buildDipCandidate(side, now, start, tradeOpen) {
    const signalSide = side;
    const entrySide = oppositeSide(signalSide);
    const signalQuote = this.freshQuote(signalSide, now);
    const entryQuote = this.freshQuote(entrySide, now);
    const analysis = analyzeDipRebound(this.dipHistory[side] || [], now);
    const candidate = {
      ...this.emptyCandidate(analysis.reason),
      ...analysis,
      signalSide,
      entrySide,
      qualifies: false,
      ready: analysis.ready && Boolean(signalQuote) && Boolean(entryQuote),
      signalBestAsk: signalQuote?.bestAsk ?? null,
      bestAsk: entryQuote?.bestAsk ?? null,
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
        ? 'Entry window is closed; the bot is attempting a timed bid-sweep exit, then falls back to official resolution if it cannot fill.'
        : 'Waiting for this five-minute market window to start.';
      return candidate;
    }
    if (!signalQuote) {
      candidate.reason = `Waiting for a fresh ${signalSide} signal-side CLOB quote.`;
      return candidate;
    }
    if (!entryQuote) {
      candidate.reason = `Waiting for a fresh ${entrySide} entry-side CLOB quote for the reversed signal.`;
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
      candidate.reason = `${signalSide} signals have reached their ${config.DIP_MAX_ENTRIES_PER_SIDE}-entry limit for this window.`;
      return candidate;
    }
    if (cooldownRemaining > 0) {
      candidate.reason = `${signalSide} signal is cooling down for ${Math.ceil(cooldownRemaining / 1000)} more seconds.`;
      return candidate;
    }
    if (Number(entryQuote.bestAsk) > config.DIP_MAX_BUY_PRICE + EPSILON) {
      candidate.reason = `${entrySide} entry ask is above the $${config.DIP_MAX_BUY_PRICE.toFixed(2)} ceiling; the ${signalSide} signal cannot enter.`;
      return candidate;
    }
    if (!analysis.qualifies) return candidate;

    candidate.qualifies = true;
    candidate.reason = `${analysis.reason} Reversed signal: buy ${config.DIP_ENTRY_SHARES} ${entrySide} shares at that side's ask.`;
    return candidate;
  }

  createDipForecast(now, start) {
    const elapsed = Number(now) - Number(start);
    const tradeOpen = elapsed >= 0 && elapsed < config.DIP_TRADE_WINDOW_MS;
    const candidateBySide = Object.fromEntries(SIDES.map((side) => [
      side,
      this.buildDipCandidate(side, now, start, tradeOpen),
    ]));
    const qualifyingSignalSides = SIDES.filter((side) => candidateBySide[side].qualifies);
    const qualifyingSides = qualifyingSignalSides.map(oppositeSide);
    const ready = SIDES.some((side) => this.freshQuote(side, now));
    let status = 'SCANNING_FOR_DIP';
    let reason = 'UP and DOWN dip signals are checked independently; each qualifying signal buys the opposite side.';
    if (elapsed >= config.DIP_TRADE_WINDOW_MS) {
      status = 'TRADE_WINDOW_CLOSED';
      reason = `Entries close after ${config.DIP_TRADE_WINDOW_MS / 1000} seconds; remaining shares are swept at executable bids or sent to official resolution if a full exit is unavailable.`;
    } else if (!ready) {
      status = 'WAITING_FOR_CLOB';
      reason = 'Waiting for fresh Polymarket quotes; no Binance or model signal is required.';
    } else if (qualifyingSides.length) {
      status = 'DIP_REBOUND_READY';
      reason = qualifyingSignalSides
        .map((signalSide) => `${signalSide} signal → buy ${oppositeSide(signalSide)}`)
        .join(' · ');
    }

    return {
      ready,
      status,
      reason,
      signalSource: 'POLYMARKET_CLOB_PRICE_ONLY_REVERSED_SIDE',
      selectedSide: null,
      qualifyingSides,
      qualifyingSignalSides,
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

    for (const signalSide of sides) {
      const candidate = forecast.candidateBySide[signalSide];
      if (!candidate?.qualifies) continue;
      const entrySide = candidate.entrySide || oppositeSide(signalSide);
      this.lastDipAttemptAtBySide[signalSide] = now;
      const opened = this.executeBuy(entrySide, config.DIP_ENTRY_SHARES, now, {
        kind: 'BUY_DIP',
        candidate,
        signal: candidate,
        signalSide,
      });
      if (!opened) {
        candidate.qualifies = false;
        candidate.reason = this.windowOrders[0]?.error
          || `${signalSide} signal could not buy ${entrySide}; the next setup remains independent.`;
        continue;
      }

      this.lastEntryAt = now;
      this.lastEntryAtBySide[signalSide] = now;
      this.dipEntryCountBySide[signalSide] = Number(this.dipEntryCountBySide[signalSide] || 0) + 1;
      this.dipArmedBySide[signalSide] = false;
      this.dipRearmPriceBySide[signalSide] = Math.min(
        0.99,
        Number(candidate.currentMid) + config.DIP_REARM_RECOVERY,
      );
      candidate.qualifies = false;
      candidate.entriesThisWindow = this.dipEntryCountBySide[signalSide];
      candidate.armed = false;
      candidate.reason = `${signalSide} dip signal bought ${opened.shares} ${entrySide} shares. This signal rearms after ${signalSide} recovers to $${this.dipRearmPriceBySide[signalSide].toFixed(3)}.`;
      this.signal = {
        side: entrySide,
        signalSide,
        action: 'BUY_REVERSED_DIP',
        reason: candidate.reason,
      };
      changed = true;
    }

    forecast.qualifyingSignalSides = SIDES.filter((side) => forecast.candidateBySide[side].qualifies);
    forecast.qualifyingSides = forecast.qualifyingSignalSides.map(oppositeSide);
    if (changed) {
      forecast.status = 'DIP_ENTRY_FILLED';
      forecast.reason = 'Paper reversed-signal entry recorded. Trigger history remains separate by signal side; positions and exits follow the side bought.';
    }
    return changed;
  }

  processSpikeExit(side, now) {
    if (!SIDES.includes(side) || !this.market) return false;
    const windowStart = Number(this.market.start);
    const tradeCutoff = windowStart + config.DIP_TRADE_WINDOW_MS;
    if (now >= tradeCutoff) return false;

    const positions = this.openDipPositions(windowStart, side);
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
    return this.executeSideExit({
      side,
      now,
      positions,
      execution,
      kind: 'SELL_SPIKE',
      exitReason: 'PROFITABLE_SPIKE_TAKER_SWEEP',
      settlementBasis: 'PAPER_TAKER_SPIKE_EXIT',
      event: 'PAPER_DIP_SPIKE_EXIT_FILLED',
      logData: {
        netProfit,
        positions: positions.length,
      },
    });
  }

  openDipPositions(windowStart, side) {
    return this.positions.filter((position) =>
      Number(position.windowStart) === Number(windowStart)
      && position.side === side
      && isDipPosition(position)
      && position.status === 'OPEN');
  }

  processSideLossStop(side, now) {
    if (!SIDES.includes(side) || !this.market) return false;
    const windowStart = Number(this.market.start);
    const positions = this.openDipPositions(windowStart, side);
    if (!positions.length) return false;

    const quote = this.freshQuote(side, now);
    if (!quote) return false;
    const shares = positions.reduce((total, position) => total + Number(position.shares || 0), 0);
    const openCost = positions.reduce((total, position) => total + Number(position.totalCost || 0), 0);
    if (!(shares > 0)) return false;

    const preview = sweepBook(quote.bidLevels, shares, 'SELL', this.market);
    if (!preview.complete) return false;
    const realizedEarlierThisWindow = this.positions
      .filter((position) =>
        Number(position.windowStart) === windowStart
        && position.side === side
        && isDipPosition(position)
        && position.status !== 'OPEN'
        && position.status !== 'PENDING_CLOB_RESULT')
      .reduce((total, position) => total + Number(position.realizedPnl || 0), 0);
    const sideWindowPnl = realizedEarlierThisWindow + preview.netProceeds - openCost;
    if (sideWindowPnl > -config.DIP_MAX_SIDE_LOSS + EPSILON) return false;

    const execution = sweepBook(quote.bidLevels, shares, 'SELL', this.market, { consume: true });
    if (!execution.complete) return false;

    // A side that reaches its loss budget cannot re-enter during this window.
    const blockedSignalSide = oppositeSide(side);
    this.dipEntryCountBySide[blockedSignalSide] = config.DIP_MAX_ENTRIES_PER_SIDE;
    this.dipArmedBySide[blockedSignalSide] = false;
    this.dipRearmPriceBySide[blockedSignalSide] = null;
    return this.executeSideExit({
      side,
      now,
      positions,
      execution,
      kind: 'SELL_RISK_STOP',
      exitReason: 'MAX_SIDE_LOSS_STOP',
      settlementBasis: 'PAPER_TAKER_RISK_STOP',
      event: 'PAPER_DIP_SIDE_LOSS_STOP_FILLED',
      logData: {
        sideWindowPnlBeforeExit: sideWindowPnl,
        lossLimit: config.DIP_MAX_SIDE_LOSS,
        realizedEarlierThisWindow,
        blockedSignalSide,
      },
    });
  }

  processTimeCutoffExit(side, now) {
    if (!SIDES.includes(side) || !this.market) return false;
    const positions = this.openDipPositions(this.market.start, side);
    if (!positions.length) return false;
    const quote = this.freshQuote(side, now);
    if (!quote) return false;
    const shares = positions.reduce((total, position) => total + Number(position.shares || 0), 0);
    if (!(shares > 0)) return false;
    const execution = sweepBook(quote.bidLevels, shares, 'SELL', this.market, { consume: true });
    if (!execution.complete) return false;
    return this.executeSideExit({
      side,
      now,
      positions,
      execution,
      kind: 'SELL_TIME_CUTOFF',
      exitReason: 'TRADE_WINDOW_CUTOFF_EXIT',
      settlementBasis: 'PAPER_TAKER_TIME_CUTOFF_EXIT',
      event: 'PAPER_DIP_TIME_CUTOFF_EXIT_FILLED',
      logData: {
        cutoffSeconds: config.DIP_TRADE_WINDOW_MS / 1000,
      },
    });
  }

  executeSideExit({
    side,
    now,
    positions,
    execution,
    kind,
    exitReason,
    settlementBasis,
    event,
    logData = {},
  }) {
    const shares = positions.reduce((total, position) => total + Number(position.shares || 0), 0);
    const order = this.createOrder(kind, side, shares, now, execution);
    order.status = 'FILLED';
    order.filledAt = now;
    order.matchedShares = execution.filledShares;
    order.price = execution.averagePrice;
    order.fee = execution.fees;
    order.grossProceeds = execution.gross;
    order.netProceeds = execution.netProceeds;
    order.positionIds = positions.map((position) => position.id);
    order.exitReason = exitReason;
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
      position.exitReason = exitReason;
      position.settlementBasis = settlementBasis;
      position.closedAt = now;
      position.settledAt = now;
      position.exitOrderId = order.id;
    }
    this.log(event, {
      orderId: order.id,
      side,
      shares,
      averageExit: execution.averagePrice,
      grossProceeds: execution.gross,
      fees: execution.fees,
      netProceeds: execution.netProceeds,
      positions: positions.length,
      ...logData,
    });
    return true;
  }

  executeBuy(side, shares, now, {
    kind = 'BUY_UP_MARKET',
    engine = side,
    signalSide = side,
    maximumPrice = config.ENGINE_UP_MAX_SWEEP_PRICE,
    pairedTriggerSide = null,
  } = {}) {
    const quote = this.freshQuote(side, now);
    if (!quote) return null;
    const preview = sweepBook(
      quote.askLevels,
      shares,
      'BUY',
      this.market,
      { maximumPrice },
    );
    const order = this.createOrder(kind, side, shares, now, preview);
    order.engine = engine;
    order.signalSide = signalSide;
    order.maxPrice = maximumPrice;
    if (!preview.complete) {
      order.status = 'SKIPPED_SLIPPAGE_OR_DEPTH';
      order.error = `Full requested size was not available at or below $${maximumPrice.toFixed(2)}.`;
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
       { maximumPrice, consume: true },
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
      engine,
      signalSide,
      tokenId: this.market.tokens[side],
      entryKey: order.id,
      entryLabel: `${engine} engine market entry`,
      entryType: 'PAPER_TAKER_UP_ENGINE',
      strategyVersion: DUAL_ENGINE_STRATEGY_VERSION,
      orderType: 'PAPER_TAKER_MARKET',
      fillModel: pairedTriggerSide
        ? 'VISIBLE_ASK_SWEEP_WITH_CONFIGURED_MAX_PRICE_AS_PAIRED_ENTRY'
        : 'VISIBLE_ASK_SWEEP_WITH_CONFIGURED_MAX_PRICE',
      pairedTriggerSide,
      pairedFillAssumption: pairedTriggerSide
        ? 'BOTH_LEGS_FILLED_WHEN_EITHER_ENTRY_TRIGGERS'
        : null,
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
      triggerPrice: config.ENGINE_UP_TRIGGER_ASK,
      signalSource: pairedTriggerSide === 'DOWN'
        ? 'POLYMARKET_CLOB_PAIRED_DOWN_TRIGGER'
        : 'POLYMARKET_CLOB_UP_ASK_TRIGGER',
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
    order.maxPrice = maximumPrice;
    order.signalSide = signalSide;
    order.signalSource = pairedTriggerSide === 'DOWN'
      ? 'POLYMARKET_CLOB_PAIRED_DOWN_TRIGGER'
      : 'POLYMARKET_CLOB_UP_ASK_TRIGGER';
    order.engine = engine;
    this.log('PAPER_UP_TAKER_ENTRY_FILLED', {
      orderId: order.id,
      positionId: position.id,
      side,
      engine,
      signalSide,
      shares: position.shares,
      averagePrice: position.avgEntry,
      fees: position.fees,
      triggerAsk: quote.bestAsk,
      triggerPrice: config.ENGINE_UP_TRIGGER_ASK,
      maxSweepPrice: maximumPrice,
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
      maxPrice: kind === 'BUY_UP_MARKET' ? config.ENGINE_UP_MAX_SWEEP_PRICE : null,
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
      if (position.engine === 'UP') this.upEngine.status = 'RESOLUTION_PENDING';
      if (position.engine === 'DOWN') this.downEngine.status = 'RESOLUTION_PENDING';
    }
    if (this.downEngine.orderId) {
      const downOrder = this.orders.find((order) => order.id === this.downEngine.orderId);
      if (downOrder && downOrder.status.startsWith('EXPIRED') && !this.downEngine.positionId) {
        this.downEngine.status = 'EXPIRED_UNFILLED';
        this.downEngine.fillStatus = 'EXPIRED · NOT FILLED';
      }
    }
    this.log('PAPER_DUAL_ENGINE_WINDOW_ENDED', {
      windowStart,
      pendingResolutionCount: pendingPositions.length,
      triggerReason,
      downOrderStatus: this.downEngine.status,
    });
    this.updateEngineForecast(now);
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
          this.log('PAPER_ENGINE_RESOLVED', {
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
    this.log('PAPER_DUAL_ENGINE_BOT_STARTED', {
      note: 'Paper-only UP taker threshold engine and DOWN resting-limit engine. Real-order modules are not loaded.',
      baseShares: config.ENGINE_BASE_SHARES,
      upTriggerAsk: config.ENGINE_UP_TRIGGER_ASK,
      downLimitPrice: config.ENGINE_DOWN_LIMIT_PRICE,
      takeProfitBid: config.ENGINE_TAKE_PROFIT_BID_TRIGGER,
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
      capitalCommitted: ['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status)
        ? Number(position.totalCost || 0)
        : 0,
      unrealizedPnl: position.status === 'OPEN' && position.markStatus === 'LIVE'
        && Number.isFinite(Number(position.markBid))
        ? Number(position.markBid) * Number(position.shares) - Number(position.totalCost || 0)
        : null,
      pnl: position.realizedPnl ?? (position.status === 'OPEN' && position.markStatus === 'LIVE'
        ? Number(position.markBid) * Number(position.shares) - Number(position.totalCost || 0)
        : null),
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
        orderType: 'PAPER_UP_ENGINE_TAKER_AND_DOWN_ENGINE_RESTING_LIMIT',
        exit: `Take profit when the held side's best bid reaches $${config.ENGINE_TAKE_PROFIT_BID_TRIGGER.toFixed(2)}; count payout as $${config.ENGINE_TAKE_PROFIT_PAYOUT.toFixed(2)} per share. Otherwise, hold for official resolution.`,
        liveTradingEnabled: false,
        realOrderModulesLoaded: false,
        entryShares: config.ENGINE_BASE_SHARES,
        baseShares: config.ENGINE_BASE_SHARES,
        upTriggerAsk: config.ENGINE_UP_TRIGGER_ASK,
        upMaxSweepPrice: config.ENGINE_UP_MAX_SWEEP_PRICE,
        downLimitPrice: config.ENGINE_DOWN_LIMIT_PRICE,
        takeProfitBidTrigger: config.ENGINE_TAKE_PROFIT_BID_TRIGGER,
        takeProfitPayout: config.ENGINE_TAKE_PROFIT_PAYOUT,
        downProfitCarry: this.downProfitCarry,
        downSharesThisWindow: this.downSharesThisWindow,
        sideSwapTriggerMid: config.ENGINE_SIDE_SWAP_TRIGGER_MID,
        sideAssignments: { UP: this.upEngine.side, DOWN: this.downEngine.side },
        sideSwaps: this.sideSwaps.slice(-100),
        downSharesNextWindow: Math.round(
          (config.ENGINE_BASE_SHARES + this.downProfitCarry / config.ENGINE_DOWN_SHARE_PRICE) * 100,
        ) / 100,
        signal: `UP engine triggers at a $0.71 ask and DOWN engine rests at $0.30; either trigger records both paper legs as filled. Before a fill, either side crossing a $${config.ENGINE_SIDE_SWAP_TRIGGER_MID.toFixed(2)} midpoint swaps engine sides and carries each engine's stake.`,
        signalMapping: 'Either entry trigger records both UP and DOWN paper legs as filled.',
        pairedFillAssumption: 'Both sides are recorded filled together when either side triggers; this is a paper assumption, not an exchange fill guarantee.',
        signalState: this.forecast,
        orders: {
          type: 'UP-engine taker sweep and DOWN-engine resting limit; sides can swap before a fill',
          fillAssumption: 'Either entry trigger fills both paper sides at the same event time.',
          initialShares: config.ENGINE_BASE_SHARES,
          upTriggerAsk: config.ENGINE_UP_TRIGGER_ASK,
          upMaxSweepPrice: config.ENGINE_UP_MAX_SWEEP_PRICE,
          downLimitPrice: config.ENGINE_DOWN_LIMIT_PRICE,
          downSharesThisWindow: this.downSharesThisWindow,
          sideSwapTriggerMid: config.ENGINE_SIDE_SWAP_TRIGGER_MID,
          sideAssignments: { UP: this.upEngine.side, DOWN: this.downEngine.side },
        },
        repeatEntryRule: `One paired entry per window: UP engine starts at 50 shares and sweeps its assigned side at a $${config.ENGINE_UP_TRIGGER_ASK.toFixed(2)} ask; DOWN engine rests at $${config.ENGINE_DOWN_LIMIT_PRICE.toFixed(2)} on its assigned side. Before either fills, each new side midpoint crossing at $${config.ENGINE_SIDE_SWAP_TRIGGER_MID.toFixed(2)} cancels the resting order, swaps the engine side assignments, and carries each engine's stake. Either entry trigger records both paper legs as filled. Positive UP-engine TP profit increases next-window DOWN-engine shares by profit / $${config.ENGINE_DOWN_SHARE_PRICE.toFixed(2)}. A DOWN-engine TP resets both stakes to base.`,
        priceFeed: this.priceFeed?.snapshot?.() || null,
        exits: {
          mode: 'TAKE_PROFIT_OR_OFFICIAL_RESOLUTION',
          takeProfit: true,
          takeProfitTrigger: config.ENGINE_TAKE_PROFIT_BID_TRIGGER,
          takeProfitPayout: config.ENGINE_TAKE_PROFIT_PAYOUT,
          stopLoss: false,
          timedExitAtSeconds: null,
          tradeWindowMs: null,
          resolutionPollMs: config.RESOLUTION_POLL_MS,
           otherwise: 'If neither paired trigger fills, the DOWN limit expires at window end. Open shares remain for official resolution, checked every 10 seconds.',
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
  sweepBook,
  resolvedPayout,
};

module.exports = PressureForecastBot;
