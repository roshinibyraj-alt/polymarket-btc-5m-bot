'use strict';

const ClobMarketFeed = require('./clob-feed');
const { MAX_HORIZON_MS } = require('./gamma-market-scanner');

const STRATEGY_VERSION = 'non-crypto-near-resolution-v1';
const ENTRY_MIN_ASK = 0.80;
const ENTRY_MAX_ASK = 0.90;
const ENTRY_SHARES = 100;
const TAKE_PROFIT_BID = 0.99;
const STOP_LOSS_BID = 0.60;
const DEFAULT_CAPITAL = 10_000;
const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const DEFAULT_RESOLUTION_POLL_MS = 10_000;
const MAX_PUBLIC_EVENTS = 300;
const MAX_VISIBLE_MARKETS = 100;

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedLevels(levels, descending = false) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: Number(level?.price), size: Number(level?.size) }))
    .filter((level) => Number.isFinite(level.price)
      && level.price > 0 && level.price <= 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((left, right) => descending
      ? right.price - left.price
      : left.price - right.price);
}

function sweep(levels, requestedShares, {
  side = 'buy',
  minPrice = 0,
  maxPrice = 1,
} = {}) {
  const descending = side === 'sell';
  const ordered = normalizedLevels(levels, descending);
  let remaining = Math.max(0, Number(requestedShares) || 0);
  let shares = 0;
  let notional = 0;
  const fills = [];

  for (const level of ordered) {
    if (level.price < minPrice || level.price > maxPrice) continue;
    const quantity = Math.min(remaining, level.size);
    if (quantity <= 0) continue;
    fills.push({ price: level.price, shares: quantity });
    shares += quantity;
    notional += level.price * quantity;
    remaining -= quantity;
    if (remaining <= 1e-9) break;
  }

  return {
    requestedShares: Math.max(0, Number(requestedShares) || 0),
    shares,
    remainingShares: Math.max(0, remaining),
    notional,
    averagePrice: shares > 0 ? notional / shares : null,
    fills,
  };
}

function feeRate(market, side = 'taker') {
  const schedule = market?.feeSchedule || {};
  const rawRate = side === 'maker'
    ? (schedule.makerRate ?? market?.makerFeeRate ?? market?.makerBaseFee)
    : (schedule.rate ?? market?.takerFeeRate ?? market?.takerBaseFee);
  if (rawRate == null || rawRate === '') return null;
  let rate = Number(rawRate);
  if (!Number.isFinite(rate) || rate < 0) return null;
  if (rate > 1) rate /= 10_000;
  return {
    rate,
    exponent: safeNumber(schedule.exponent, 1),
  };
}

function estimatedTakerFee(market, fills) {
  const feesEnabled = market?.feesEnabled === true
    || String(market?.feesEnabled).toLowerCase() === 'true';
  if (!feesEnabled) return { amount: 0, known: true };
  const schedule = feeRate(market, 'taker');
  if (!schedule) return { amount: null, known: false };
  const amount = fills.reduce((total, fill) => (
    total + fill.shares * schedule.rate
      * Math.pow(fill.price * (1 - fill.price), schedule.exponent)
  ), 0);
  return { amount, known: Number.isFinite(amount) };
}

function resultPayout(rawMarket, outcomeIndex) {
  const values = rawMarket?.outcomePrices ?? rawMarket?.outcome_prices;
  let prices = values;
  if (typeof values === 'string') {
    try { prices = JSON.parse(values); } catch (_) { return null; }
  }
  if (!Array.isArray(prices)) return null;
  const payout = Number(prices[outcomeIndex]);
  return Number.isFinite(payout) && payout >= 0 && payout <= 1 ? payout : null;
}

function compactMarket(market, quotes, enteredTokens, stopped, now) {
  const outcomes = market.outcomes.map((outcome) => {
    const quote = quotes.get(outcome.tokenId) || null;
    const ask = Number(quote?.bestAsk);
    const bid = Number(quote?.bestBid);
    const eligible = Number.isFinite(ask) && ask >= ENTRY_MIN_ASK && ask <= ENTRY_MAX_ASK;
    return {
      label: outcome.label,
      tokenId: outcome.tokenId,
      lastPrice: outcome.lastPrice,
      bestBid: Number.isFinite(bid) ? bid : null,
      bestAsk: Number.isFinite(ask) ? ask : null,
      bidSize: safeNumber(quote?.bidSize),
      askSize: safeNumber(quote?.askSize),
      updatedAt: quote?.updatedAt ?? null,
      eligible,
    };
  });
  return {
    id: market.id,
    slug: market.slug,
    title: market.title,
    eventTitle: market.eventTitle,
    endAt: market.endAt,
    secondsRemaining: Math.max(0, Math.round((market.endAt - now) / 1000)),
    outcomes,
    status: stopped.has(market.id)
      ? 'STOPPED'
      : outcomes.some((outcome) => enteredTokens.has(outcome.tokenId)) ? 'TRADED' : 'WATCHING',
    eligibleOutcomes: outcomes.filter((outcome) => outcome.eligible).length,
  };
}

class NearResolutionMarketBot {
  constructor({
    marketScanner,
    feedFactory = (options) => new ClobMarketFeed(options),
    now = Date.now,
    initialCapital = DEFAULT_CAPITAL,
    horizonMs = MAX_HORIZON_MS,
    scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
    resolutionPollMs = DEFAULT_RESOLUTION_POLL_MS,
    maxPages = 100,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (!marketScanner || typeof marketScanner.scanMarkets !== 'function') {
      throw new Error('A Gamma market scanner is required');
    }
    this.marketScanner = marketScanner;
    this.feedFactory = feedFactory;
    this.now = now;
    this.initialCapital = Number(initialCapital);
    this.horizonMs = Math.min(MAX_HORIZON_MS, Number(horizonMs));
    this.scanIntervalMs = scanIntervalMs;
    this.resolutionPollMs = resolutionPollMs;
    this.maxPages = maxPages;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    if (!Number.isFinite(this.initialCapital) || this.initialCapital <= 0) {
      throw new Error('Initial paper capital must be greater than zero');
    }
    this.persistenceStrategyVersion = STRATEGY_VERSION;
    this.strategyName = 'Non-crypto near-resolution odds';
    this.capital = this.initialCapital;
    this.cash = this.initialCapital;
    this.realizedPnl = 0;
    this.totalFees = 0;
    this.totalEntries = 0;
    this.totalSettledTrades = 0;
    this.peakEquity = this.initialCapital;
    this.positions = [];
    this.trades = [];
    this.events = [];
    this.enteredTokenIds = new Set();
    this.stoppedMarketIds = new Set();
    this.markets = new Map();
    this.tokenBindings = new Map();
    this.quotes = new Map();
    this.entryAttemptAt = new Map();
    this.lastResolutionCheckAt = new Map();
    this.persistenceStore = null;
    this.persistenceDirty = false;
    this.lastPersistedAt = 0;
    this.running = false;
    this.status = 'starting';
    this.error = null;
    this.scanPromise = null;
    this.scanHealthy = false;
    this.scannerState = {
      status: 'STARTING',
      source: 'Polymarket Gamma API',
      lastScanAt: null,
      ageMs: null,
      pages: 0,
      rowsSeen: 0,
      marketsFound: 0,
      cryptoExcluded: 0,
      invalidMarkets: 0,
      complete: false,
      error: null,
    };
    this.paperHistoryResetVersion = null;
    this.scanTimer = null;
    this.resolutionTimer = null;
    this.persistenceTimer = null;
    this.feed = this.feedFactory({
      assetIds: [],
      onQuote: (tokenId, quote) => this.handleQuote(tokenId, quote),
      onStatus: (state) => this.handleFeedStatus(state),
    });
  }

  attachPersistenceStore(store) {
    this.persistenceStore = store;
  }

  serializePersistentState() {
    return {
      schemaVersion: 1,
      paperStrategyVersion: this.persistenceStrategyVersion,
      paperHistoryResetVersion: this.paperHistoryResetVersion,
      capital: this.capital,
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      totalFees: this.totalFees,
      totalEntries: this.totalEntries,
      totalSettledTrades: this.totalSettledTrades,
      peakEquity: this.peakEquity,
      positions: this.positions,
      trades: this.trades.slice(0, MAX_PUBLIC_EVENTS),
      events: this.events.slice(0, MAX_PUBLIC_EVENTS),
      enteredTokenIds: [...this.enteredTokenIds],
      stoppedMarketIds: [...this.stoppedMarketIds],
    };
  }

  restorePersistentState(state) {
    if (!state || state.paperStrategyVersion !== this.persistenceStrategyVersion) {
      throw new Error('Saved paper history belongs to a different strategy version');
    }
    if (!Array.isArray(state.positions) || !Number.isFinite(Number(state.cash))) {
      throw new Error('Saved paper history has an invalid portfolio');
    }
    this.paperHistoryResetVersion = state.paperHistoryResetVersion || null;
    this.capital = safeNumber(state.capital, this.initialCapital);
    this.cash = safeNumber(state.cash, this.initialCapital);
    this.realizedPnl = safeNumber(state.realizedPnl);
    this.totalFees = safeNumber(state.totalFees);
    this.totalEntries = safeNumber(state.totalEntries);
    this.totalSettledTrades = safeNumber(state.totalSettledTrades);
    this.peakEquity = safeNumber(state.peakEquity, this.initialCapital);
    this.positions = state.positions.map((position) => ({ ...position }));
    this.trades = Array.isArray(state.trades) ? state.trades.slice(0, MAX_PUBLIC_EVENTS) : [];
    this.events = Array.isArray(state.events) ? state.events.slice(0, MAX_PUBLIC_EVENTS) : [];
    this.enteredTokenIds = new Set((state.enteredTokenIds || []).map(String));
    this.stoppedMarketIds = new Set((state.stoppedMarketIds || []).map(String));
  }

  async persistState(force = false) {
    if (!this.persistenceStore) return;
    if (!force && !this.persistenceDirty && this.now() - this.lastPersistedAt < 30_000) return;
    await this.persistenceStore.save(this.serializePersistentState());
    this.persistenceDirty = false;
    this.lastPersistedAt = this.now();
  }

  markDirty() {
    this.persistenceDirty = true;
  }

  log(kind, message, detail = {}) {
    const event = {
      id: `${this.now()}-${this.events.length}`,
      at: this.now(),
      kind,
      message,
      ...detail,
    };
    this.events.unshift(event);
    if (this.events.length > MAX_PUBLIC_EVENTS) this.events.length = MAX_PUBLIC_EVENTS;
    console.log(`[paper-market] ${kind}: ${message}`);
    this.markDirty();
    return event;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.status = 'running';
    this.feed.start();
    this.scanNow();
    this.scanTimer = this.setIntervalImpl(() => this.scanNow(), this.scanIntervalMs);
    this.resolutionTimer = this.setIntervalImpl(
      () => this.resolveMaturedPositions(),
      this.resolutionPollMs,
    );
    this.persistenceTimer = this.setIntervalImpl(() => {
      this.persistState().catch((error) => {
        this.error = `Paper history save failed: ${error.message || String(error)}`;
        this.log('PERSISTENCE_ERROR', this.error);
      });
    }, 5_000);
    this.scanTimer?.unref?.();
    this.resolutionTimer?.unref?.();
    this.persistenceTimer?.unref?.();
  }

  stop() {
    this.running = false;
    for (const timer of [this.scanTimer, this.resolutionTimer, this.persistenceTimer]) {
      if (timer) this.clearIntervalImpl(timer);
    }
    this.scanTimer = null;
    this.resolutionTimer = null;
    this.persistenceTimer = null;
    this.feed.stop();
  }

  async stopAndFlush() {
    this.stop();
    await this.persistState(true);
  }

  handleFeedStatus(state) {
    this.feedState = state;
  }

  isFeedConnected() {
    return this.feed?.snapshot?.().connected === true;
  }

  async scanNow() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      try {
        const now = this.now();
        const result = await this.marketScanner.scanMarkets({
          now,
          horizonMs: this.horizonMs,
          maxPages: this.maxPages,
        });
        if (!result || !Array.isArray(result.markets)) {
          throw new Error('Gamma market scan did not return a market list');
        }

        const active = result.markets
          .filter((market) => !this.stoppedMarketIds.has(String(market.id)))
          .filter((market) => market.endAt > now && market.endAt <= now + this.horizonMs);
        this.markets = new Map(active.map((market) => [String(market.id), market]));
        this.tokenBindings = new Map();
        for (const market of active) {
          for (const outcome of market.outcomes) {
            this.tokenBindings.set(String(outcome.tokenId), { market, outcome });
          }
        }

        const openTokens = this.positions
          .filter((position) => position.remainingShares > 0
            && position.status === 'OPEN'
            && position.endAt > now)
          .map((position) => position.tokenId);
        const tokenIds = [...new Set([
          ...[...this.tokenBindings.keys()],
          ...openTokens,
        ])];
        this.feed.updateAssetIds(tokenIds);

        this.scannerState = {
          status: result.complete ? 'LIVE' : 'INCOMPLETE',
          source: 'Polymarket Gamma API',
          lastScanAt: result.scannedAt || now,
          ageMs: 0,
          pages: safeNumber(result.pageCount),
          rowsSeen: safeNumber(result.rowsSeen),
          marketsFound: active.length,
          cryptoExcluded: safeNumber(result.cryptoExcluded),
          invalidMarkets: safeNumber(result.invalidMarkets),
          complete: result.complete === true,
          error: result.complete === true
            ? null : 'The discovery page limit was reached; only returned markets are being scanned.',
        };
        this.scanHealthy = result.complete === true || active.length > 0;
        this.error = result.complete === true ? null : this.scannerState.error;
        this.status = 'running';
        this.markDirty();
        this.resolveMaturedPositions();
      } catch (error) {
        this.scanHealthy = false;
        this.scannerState = {
          ...this.scannerState,
          status: 'ERROR',
          ageMs: this.scannerState.lastScanAt == null
            ? null : Math.max(0, this.now() - this.scannerState.lastScanAt),
          error: error.message || String(error),
        };
        this.error = `Market scan unavailable: ${error.message || String(error)}`;
        this.log('SCAN_ERROR', this.error);
      } finally {
        this.scanPromise = null;
      }
    })();
    return this.scanPromise;
  }

  handleQuote(tokenId, quote) {
    const id = String(tokenId);
    if (!quote) {
      this.quotes.delete(id);
      return;
    }
    this.quotes.set(id, quote);
    const binding = this.tokenBindings.get(id);
    if (!binding) return;

    const position = this.positions.find((entry) => (
      entry.tokenId === id
      && entry.remainingShares > 0
      && entry.status === 'OPEN'
    ));
    if (position) {
      this.markPosition(position, quote);
      if (!this.isFeedConnected()) return;
      const bid = Number(quote.bestBid);
      if (Number.isFinite(bid) && bid >= TAKE_PROFIT_BID) {
        this.executeExit(position, quote, 'TAKE_PROFIT', TAKE_PROFIT_BID);
      } else if (Number.isFinite(bid) && bid <= STOP_LOSS_BID) {
        this.executeExit(position, quote, 'STOP_LOSS', 0);
        this.excludeStoppedMarket(binding.market);
      }
      return;
    }

    if (!this.scanHealthy || !this.isFeedConnected()) return;
    this.tryEntry(binding, quote);
  }

  markPosition(position, quote) {
    const bid = Number(quote?.bestBid);
    if (Number.isFinite(bid) && bid >= 0 && bid <= 1) {
      position.markBid = bid;
      position.markUpdatedAt = quote.updatedAt ?? this.now();
      position.markValue = bid * position.remainingShares;
      position.unrealizedPnl = position.markValue - position.remainingCostBasis;
      this.markDirty();
    }
  }

  tryEntry({ market, outcome }, quote) {
    const marketId = String(market.id);
    const tokenId = String(outcome.tokenId);
    if (this.enteredTokenIds.has(tokenId) || this.stoppedMarketIds.has(marketId)) return;
    const ask = Number(quote?.bestAsk);
    if (!Number.isFinite(ask) || ask < ENTRY_MIN_ASK || ask > ENTRY_MAX_ASK) return;
    const now = this.now();
    if (market.endAt <= now || market.endAt > now + this.horizonMs) return;
    const lastAttempt = this.entryAttemptAt.get(tokenId) || 0;
    if (now - lastAttempt < 2_000) return;
    this.entryAttemptAt.set(tokenId, now);

    const execution = sweep(quote.askLevels, ENTRY_SHARES, {
      side: 'buy',
      maxPrice: ENTRY_MAX_ASK,
    });
    if (execution.shares <= 0) {
      this.log('ENTRY_NO_LIQUIDITY', `${market.title} · ${outcome.label}: no ask size to fill`, {
        marketId,
        outcome: outcome.label,
        bestAsk: ask,
      });
      return;
    }

    const fees = estimatedTakerFee(market, execution.fills);
    if (!fees.known) {
      this.log('ENTRY_FEE_UNKNOWN', `${market.title} · ${outcome.label}: fee schedule unavailable`, {
        marketId,
        outcome: outcome.label,
      });
      return;
    }
    const totalCost = execution.notional + fees.amount;
    if (totalCost > this.cash) {
      this.log('ENTRY_INSUFFICIENT_CASH', `${market.title} · ${outcome.label}: paper cash is insufficient`, {
        marketId,
        outcome: outcome.label,
        required: totalCost,
        cash: this.cash,
      });
      return;
    }

    const position = {
      id: `${marketId}:${outcome.tokenId}:${now}`,
      marketId,
      marketSlug: market.slug,
      marketTitle: market.title,
      eventTitle: market.eventTitle,
      outcomeLabel: outcome.label,
      outcomeIndex: outcome.index,
      tokenId: outcome.tokenId,
      endAt: market.endAt,
      version: market.version,
      feesEnabled: market.feesEnabled,
      takerBaseFee: market.takerBaseFee,
      feeSchedule: market.feeSchedule,
      takerFeeRate: market.takerFeeRate,
      requestedShares: ENTRY_SHARES,
      initialShares: execution.shares,
      remainingShares: execution.shares,
      shares: execution.shares,
      entryNotional: execution.notional,
      entryFees: fees.amount,
      totalCost,
      remainingCostBasis: totalCost,
      averageEntryPrice: execution.averagePrice,
      markBid: Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null,
      markUpdatedAt: quote.updatedAt ?? now,
      markValue: Number.isFinite(Number(quote.bestBid))
        ? Number(quote.bestBid) * execution.shares : 0,
      unrealizedPnl: Number.isFinite(Number(quote.bestBid))
        ? Number(quote.bestBid) * execution.shares - totalCost : -totalCost,
      status: 'OPEN',
      entryAt: now,
      exitAt: null,
      exitPrice: null,
      realizedPnl: 0,
      stopLossTriggered: false,
    };
    this.cash -= totalCost;
    this.totalFees += fees.amount;
    this.positions.unshift(position);
    this.enteredTokenIds.add(tokenId);
    this.trades.unshift({
      id: position.id,
      at: now,
      kind: 'BUY_ENTRY',
      marketId,
      marketTitle: market.title,
      outcome: outcome.label,
      requestedShares: ENTRY_SHARES,
      filledShares: execution.shares,
      price: execution.averagePrice,
      notional: execution.notional,
      fees: fees.amount,
      status: execution.shares + 1e-8 >= ENTRY_SHARES ? 'FILLED' : 'PARTIAL',
      pnl: null,
    });
    this.totalEntries += 1;
    this.trimHistory();
    this.log('BUY_ENTRY', `${market.title} · ${outcome.label}: bought ${execution.shares.toFixed(2)} shares`, {
      marketId,
      outcome: outcome.label,
      requestedShares: ENTRY_SHARES,
      filledShares: execution.shares,
      averagePrice: execution.averagePrice,
      fees: fees.amount,
    });
  }

  executeExit(position, quote, reason, minimumBid) {
    if (position.remainingShares <= 0 || position.status !== 'OPEN') return;
    const execution = sweep(quote.bidLevels, position.remainingShares, {
      side: 'sell',
      minPrice: minimumBid,
      maxPrice: 1,
    });
    if (execution.shares <= 0) {
      if (reason === 'STOP_LOSS') {
        position.stopLossTriggered = true;
        position.status = 'STOPPED_PENDING_RESOLUTION';
        position.stopTriggeredAt = this.now();
        position.markBid = Number.isFinite(Number(quote.bestBid))
          ? Number(quote.bestBid) : position.markBid;
        this.excludeStoppedMarket({ id: position.marketId });
        this.log('STOP_NO_LIQUIDITY', `${position.marketTitle}: stop reached but no bid shares were available`, {
          marketId: position.marketId,
          outcome: position.outcomeLabel,
        });
      }
      return;
    }

    const fees = reason === 'TAKE_PROFIT'
      ? { amount: 0, known: true }
      : estimatedTakerFee(position, execution.fills);
    if (!fees.known) {
      if (reason === 'STOP_LOSS') {
        position.stopLossTriggered = true;
        position.status = 'STOPPED_PENDING_RESOLUTION';
        position.stopTriggeredAt = this.now();
        this.excludeStoppedMarket({ id: position.marketId });
      }
      this.log('EXIT_FEE_UNKNOWN', `${position.marketTitle}: exit fee schedule unavailable`, {
        marketId: position.marketId,
        outcome: position.outcomeLabel,
      });
      return;
    }
    const previousShares = position.remainingShares;
    const allocatedCost = position.remainingCostBasis * (execution.shares / previousShares);
    const netProceeds = execution.notional - fees.amount;
    const pnl = netProceeds - allocatedCost;

    this.cash += netProceeds;
    this.realizedPnl += pnl;
    this.totalFees += fees.amount;
    position.remainingShares = Math.max(0, previousShares - execution.shares);
    position.shares = position.remainingShares;
    position.remainingCostBasis = Math.max(0, position.remainingCostBasis - allocatedCost);
    position.realizedPnl += pnl;
    position.lastExitAt = this.now();
    position.lastExitPrice = execution.averagePrice;
    position.lastExitReason = reason;
    position.lastExitPnl = pnl;
    position.markBid = Number.isFinite(Number(quote.bestBid))
      ? Number(quote.bestBid) : position.markBid;
    position.markValue = (position.markBid || 0) * position.remainingShares;
    position.unrealizedPnl = position.markValue - position.remainingCostBasis;

    if (reason === 'STOP_LOSS') {
      position.stopLossTriggered = true;
      position.stopTriggeredAt = this.now();
      position.status = position.remainingShares > 1e-8
        ? 'STOPPED_PENDING_RESOLUTION' : 'STOP_LOSS';
      this.excludeStoppedMarket({ id: position.marketId });
    } else if (position.remainingShares <= 1e-8) {
      position.remainingShares = 0;
      position.shares = 0;
      position.remainingCostBasis = 0;
      position.status = 'TAKE_PROFIT';
      position.exitAt = this.now();
      position.exitPrice = execution.averagePrice;
    }

    this.trades.unshift({
      id: `${position.id}:${reason}:${this.now()}`,
      at: this.now(),
      kind: reason,
      marketId: position.marketId,
      marketTitle: position.marketTitle,
      outcome: position.outcomeLabel,
      requestedShares: previousShares,
      filledShares: execution.shares,
      price: execution.averagePrice,
      notional: execution.notional,
      fees: fees.amount,
      status: position.remainingShares > 1e-8 ? 'PARTIAL' : 'FILLED',
      pnl,
    });
    this.trimHistory();
    this.log(reason, `${position.marketTitle} · ${position.outcomeLabel}: sold ${execution.shares.toFixed(2)} shares · ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, {
      marketId: position.marketId,
      outcome: position.outcomeLabel,
      filledShares: execution.shares,
      exitPrice: execution.averagePrice,
      pnl,
    });
    this.markDirty();
  }

  excludeStoppedMarket(market) {
    const id = String(market?.id || '');
    if (!id || this.stoppedMarketIds.has(id)) return;
    this.stoppedMarketIds.add(id);
    this.markets.delete(id);
    for (const [tokenId, binding] of this.tokenBindings.entries()) {
      if (String(binding.market.id) === id) {
        this.tokenBindings.delete(tokenId);
        this.quotes.delete(tokenId);
      }
    }
    const stillOpenTokens = this.positions
      .filter((position) => position.remainingShares > 0
        && position.status === 'OPEN'
        && position.endAt > this.now())
      .map((position) => position.tokenId);
    const trackedTokens = [...new Set([
      ...[...this.tokenBindings.keys()],
      ...stillOpenTokens,
    ])];
    this.feed.updateAssetIds(trackedTokens);
    this.markDirty();
  }

  async resolveMaturedPositions() {
    const now = this.now();
    const due = this.positions.filter((position) => (
      position.remainingShares > 0
      && ['OPEN', 'STOPPED_PENDING_RESOLUTION'].includes(position.status)
      && position.endAt <= now
      && now - (this.lastResolutionCheckAt.get(position.marketId) || 0)
        >= this.resolutionPollMs
    ));

    for (const position of due) {
      this.lastResolutionCheckAt.set(position.marketId, now);
      try {
        const market = await this.marketScanner.getMarket(position.marketId);
        if (market?.closed !== true) continue;
        const payout = resultPayout(market, position.outcomeIndex);
        if (payout == null) continue;
        const settledShares = position.remainingShares;
        const proceeds = settledShares * payout;
        const pnl = proceeds - position.remainingCostBasis;
        this.cash += proceeds;
        this.realizedPnl += pnl;
        position.realizedPnl += pnl;
        position.settlementPayout = payout;
        position.settledAt = now;
        position.exitAt = now;
        position.exitPrice = payout;
        position.remainingShares = 0;
        position.shares = 0;
        position.remainingCostBasis = 0;
        position.markValue = 0;
        position.unrealizedPnl = 0;
        position.status = 'RESOLVED';
        this.totalSettledTrades += 1;
        this.trades.unshift({
          id: `${position.id}:RESOLUTION:${now}`,
          at: now,
          kind: 'RESOLUTION',
          marketId: position.marketId,
          marketTitle: position.marketTitle,
          outcome: position.outcomeLabel,
          requestedShares: settledShares,
          filledShares: settledShares,
          price: payout,
          notional: proceeds,
          fees: 0,
          status: 'SETTLED',
          pnl,
        });
        this.trimHistory();
        this.log('RESOLUTION', `${position.marketTitle} · ${position.outcomeLabel}: settled at $${payout.toFixed(2)} · ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, {
          marketId: position.marketId,
          outcome: position.outcomeLabel,
          payout,
          pnl,
        });
      } catch (error) {
        this.error = `Resolution check failed: ${error.message || String(error)}`;
        this.log('RESOLUTION_CHECK_ERROR', this.error, { marketId: position.marketId });
      }
    }
  }

  trimHistory() {
    if (this.trades.length > MAX_PUBLIC_EVENTS) this.trades.length = MAX_PUBLIC_EVENTS;
    if (this.positions.length > MAX_PUBLIC_EVENTS) {
      const active = this.positions.filter((position) => position.remainingShares > 1e-8);
      const closed = this.positions
        .filter((position) => position.remainingShares <= 1e-8)
        .slice(0, MAX_PUBLIC_EVENTS);
      this.positions = [...active, ...closed];
    }
  }

  currentEquity() {
    return this.cash + this.positions.reduce((total, position) => {
      if (position.remainingShares <= 0) return total;
      const quote = this.quotes.get(position.tokenId);
      const bid = Number(quote?.bestBid ?? position.markBid);
      return total + (Number.isFinite(bid) && bid >= 0 ? bid * position.remainingShares : 0);
    }, 0);
  }

  snapshot() {
    const now = this.now();
    const equity = this.currentEquity();
    this.peakEquity = Math.max(this.peakEquity, equity);
    this.scannerState.ageMs = this.scannerState.lastScanAt == null
      ? null : Math.max(0, now - this.scannerState.lastScanAt);
    const openPositions = this.positions
      .filter((position) => position.remainingShares > 1e-8
        && ['OPEN', 'STOPPED_PENDING_RESOLUTION'].includes(position.status))
      .map((position) => {
        const quote = this.quotes.get(position.tokenId);
        const bid = Number(quote?.bestBid ?? position.markBid);
        const ask = Number(quote?.bestAsk);
        const markValue = Number.isFinite(bid) ? bid * position.remainingShares : 0;
        return {
          ...position,
          bestBid: Number.isFinite(bid) ? bid : null,
          bestAsk: Number.isFinite(ask) ? ask : null,
          currentValue: markValue,
          unrealizedPnl: markValue - position.remainingCostBasis,
          secondsRemaining: Math.max(0, Math.round((position.endAt - now) / 1000)),
          quoteStatus: quote ? 'LIVE' : 'WAITING',
        };
      });
    const liveMarkets = [...this.markets.values()]
      .sort((left, right) => left.endAt - right.endAt)
      .slice(0, MAX_VISIBLE_MARKETS)
      .map((market) => compactMarket(
        market,
        this.quotes,
        this.enteredTokenIds,
        this.stoppedMarketIds,
        now,
      ));
    const eligibleOutcomeCount = [...this.markets.values()].reduce((count, market) => (
      count + market.outcomes.reduce((outcomeCount, outcome) => {
        const quote = this.quotes.get(outcome.tokenId);
        const ask = Number(quote?.bestAsk);
        return outcomeCount + (Number.isFinite(ask)
          && ask >= ENTRY_MIN_ASK && ask <= ENTRY_MAX_ASK ? 1 : 0);
      }, 0)
    ), 0);
    const positionsValue = openPositions.reduce((sum, position) => (
      sum + safeNumber(position.currentValue)
    ), 0);
    return {
      now,
      mode: 'DEMO ONLY',
      status: this.status,
      error: this.error,
      strategy: {
        version: STRATEGY_VERSION,
        name: this.strategyName,
        mode: 'PAPER ONLY',
        liveTradingEnabled: false,
        realOrderModulesLoaded: false,
        markets: 'All active non-crypto outcomes expiring within two hours',
        entryRule: `Buy ${ENTRY_SHARES} shares when an outcome's CLOB best ask is $${ENTRY_MIN_ASK.toFixed(2)}–$${ENTRY_MAX_ASK.toFixed(2)}.`,
        takeProfitRule: `Rest a limit sell at $${TAKE_PROFIT_BID.toFixed(2)}; confirm it from best bids.`,
        stopLossRule: `At a best bid of $${STOP_LOSS_BID.toFixed(2)} or lower, sweep available bids; remove that market from active scanning.`,
        resolutionRule: 'Any remaining shares stay paper-open until Gamma reports the official market result.',
        entryPerMarket: 'One entry per qualifying outcome token.',
      },
      marketScan: {
        ...this.scannerState,
        eligibleOutcomeCount,
        displayedMarkets: liveMarkets.length,
        displayLimit: MAX_VISIBLE_MARKETS,
        stoppedMarkets: this.stoppedMarketIds.size,
      },
      clobFeed: this.feed?.snapshot?.() || {
        status: 'STOPPED',
        connected: false,
        assetCount: 0,
      },
      account: {
        capital: this.capital,
        cash: this.cash,
        equity,
        realizedPnl: this.realizedPnl,
        unrealizedPnl: positionsValue - openPositions.reduce(
          (sum, position) => sum + safeNumber(position.remainingCostBasis),
          0,
        ),
        openPositionValue: positionsValue,
        openPositionCount: openPositions.length,
        settledTrades: this.totalSettledTrades,
        totalTrades: this.totalEntries,
        totalFees: this.totalFees,
        peakEquity: this.peakEquity,
        drawdownFromPeak: this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0,
      },
      positions: openPositions,
      markets: liveMarkets,
      recentTrades: this.trades.slice(0, 100),
      logs: this.events.slice(0, 100),
      stoppedMarketIds: [...this.stoppedMarketIds],
    };
  }
}

module.exports = NearResolutionMarketBot;
module.exports._test = {
  STRATEGY_VERSION,
  compactMarket,
  estimatedTakerFee,
  feeRate,
  normalizedLevels,
  resultPayout,
  sweep,
};
