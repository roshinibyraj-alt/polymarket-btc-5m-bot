'use strict';

const config = require('./config');
const PressureForecastBot = require('./pressure-forecast-bot');
const WickBot = require('./wick-bot');
const RewardsMarketClient = require('./rewards-market-client');

const STRATEGY_VERSION = 'BTC_5M_EDGE_GATED_VOLUME_V1';
const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_VOLUME_MS = 30 * DAY_MS;
const SIDES = ['UP', 'DOWN'];
const ENTRY_TYPE = 'PAPER_TAKER_VOLUME';

const tiers = [
  { name: 'None', threshold: 0, rate: 0 },
  { name: 'Gold', threshold: 200_000, rate: 0.10 },
  { name: 'Platinum', threshold: 1_000_000, rate: 0.25 },
  { name: 'Diamond', threshold: 4_000_000, rate: 0.40 },
  { name: 'Obsidian', threshold: 10_000_000, rate: 0.50 },
  { name: 'Onyx', threshold: 75_000_000, rate: 0.60 },
];

function tierFor(weightedVolume) {
  let selected = tiers[0];
  for (const tier of tiers) {
    if (weightedVolume >= tier.threshold) selected = tier;
  }
  const next = tiers[tiers.indexOf(selected) + 1] || null;
  return {
    name: selected.name,
    rate: selected.rate,
    threshold: selected.threshold,
    nextName: next?.name || null,
    nextThreshold: next?.threshold || null,
  };
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalCdf(value) {
  return Math.min(1, Math.max(0, (1 + erf(value / Math.SQRT2)) / 2));
}

function estimateVolatility(samples, now) {
  const usable = (Array.isArray(samples) ? samples : [])
    .filter((sample) => Number.isFinite(Number(sample.ts))
      && Number(sample.price) > 0
      && now - Number(sample.ts) <= 60_000
      && now >= Number(sample.ts))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (usable.length < config.VOLUME_MIN_BINANCE_SAMPLES) {
    return { ready: false, reason: 'Collecting enough fresh Binance ticks.', sampleCount: usable.length };
  }
  const spanMs = Number(usable.at(-1).ts) - Number(usable[0].ts);
  if (spanMs < config.VOLUME_MIN_BINANCE_SPAN_MS) {
    return { ready: false, reason: 'Waiting for a longer live volatility sample.', sampleCount: usable.length };
  }
  const prices = usable.map((sample) => Number(sample.price));
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const spanSeconds = spanMs / 1000;
  const sigmaPerSecond = Math.log(high / low)
    / Math.sqrt(4 * Math.log(2) * spanSeconds);
  if (!Number.isFinite(sigmaPerSecond) || sigmaPerSecond <= 0) {
    return { ready: false, reason: 'Binance volatility estimate is not usable.', sampleCount: usable.length };
  }
  return {
    ready: true,
    sigmaPerSecond,
    sampleCount: usable.length,
    spanMs,
    rangeHigh: high,
    rangeLow: low,
  };
}

function utcDayStart(timestamp) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function utcDayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class VolumeBot extends PressureForecastBot {
  constructor(options = {}) {
    super(options);
    this.strategyName = 'BTC 5-minute edge-gated volume paper bot';
    this.strategyMode = 'edge-gated-volume';
    this.rewardsClient = options.rewardsClient || new RewardsMarketClient({ now: this.now });
    this.volumeTradeEvents = [];
    this.volumeEntryCountBySide = { UP: 0, DOWN: 0 };
    this.lastVolumeEntryAtBySide = { UP: null, DOWN: null };
    this.volumeWindowStart = null;
    this.tierDay = utcDayKey(this.now());
    this.activeTakerTier = tierFor(0);
    this.estimatedRebateAccrued = 0;
    this.estimatedRebatePaid = 0;
    this.rewardSettings = { status: 'WAITING_FOR_MARKET' };
    this.rewardLookupSlug = null;
    this.volumeStatus = 'WAITING_FOR_MARKET';
    this.forecast = this.emptyForecast('Waiting for the current market and fresh price data.');
  }

  emptyForecast(reason, status = 'WAITING_FOR_DATA') {
    return {
      ready: false,
      status,
      reason,
      strategyVersion: STRATEGY_VERSION,
      signalSource: 'BINANCE_5M_VOLATILITY_AND_POLYMARKET_CLOB',
      secondsRemaining: null,
      estimatedUpProbability: null,
      estimatedDownProbability: null,
      volatilityPerSecond: null,
      flowImbalance: null,
      candidates: {},
      selectedSide: null,
      minNetEdge: config.VOLUME_MIN_NET_EDGE,
      basisRiskBuffer: config.VOLUME_BASIS_BUFFER,
    };
  }

  serializePersistentState() {
    const state = super.serializePersistentState();
    state.strategyVersion = STRATEGY_VERSION;
    state.volumeBot = {
      version: STRATEGY_VERSION,
      volumeTradeEvents: this.volumeTradeEvents,
      volumeEntryCountBySide: this.volumeEntryCountBySide,
      lastVolumeEntryAtBySide: this.lastVolumeEntryAtBySide,
      volumeWindowStart: this.volumeWindowStart,
      tierDay: this.tierDay,
      activeTakerTier: this.activeTakerTier,
      estimatedRebateAccrued: this.estimatedRebateAccrued,
      estimatedRebatePaid: this.estimatedRebatePaid,
      rewardSettings: this.rewardSettings,
      rewardLookupSlug: this.rewardLookupSlug,
      volumeStatus: this.volumeStatus,
    };
    return state;
  }

  restorePersistentState(state) {
    super.restorePersistentState(state);
    const saved = state.volumeBot;
    if (saved?.version === STRATEGY_VERSION) {
      this.volumeTradeEvents = Array.isArray(saved.volumeTradeEvents)
        ? saved.volumeTradeEvents : [];
      this.volumeEntryCountBySide = {
        UP: safeNumber(saved.volumeEntryCountBySide?.UP),
        DOWN: safeNumber(saved.volumeEntryCountBySide?.DOWN),
      };
      this.lastVolumeEntryAtBySide = {
        UP: saved.lastVolumeEntryAtBySide?.UP != null
          && Number.isFinite(Number(saved.lastVolumeEntryAtBySide.UP))
          ? Number(saved.lastVolumeEntryAtBySide.UP) : null,
        DOWN: saved.lastVolumeEntryAtBySide?.DOWN != null
          && Number.isFinite(Number(saved.lastVolumeEntryAtBySide.DOWN))
          ? Number(saved.lastVolumeEntryAtBySide.DOWN) : null,
      };
      this.volumeWindowStart = saved.volumeWindowStart != null
        && Number.isFinite(Number(saved.volumeWindowStart))
        ? Number(saved.volumeWindowStart) : null;
      this.tierDay = saved.tierDay || utcDayKey(this.now());
      this.activeTakerTier = saved.activeTakerTier || tierFor(0);
      this.estimatedRebateAccrued = safeNumber(saved.estimatedRebateAccrued);
      this.estimatedRebatePaid = safeNumber(saved.estimatedRebatePaid);
      this.rewardSettings = saved.rewardSettings || { status: 'WAITING_FOR_MARKET' };
      this.rewardLookupSlug = saved.rewardLookupSlug || null;
      this.volumeStatus = saved.volumeStatus || 'STARTING';
    } else {
      // Carry the existing paper wallet, positions, orders, and ledger forward.
      // Only cancel unfilled orders from the strategy being replaced.
      const now = this.now();
      for (const order of this.orders) {
        if (Number(order.windowStart) === Number(this.orderWindowStart)
          && ['LIVE', 'PENDING', 'SUBMITTED'].includes(order.status)) {
          order.status = 'CANCELLED_STRATEGY_REPLACED';
          order.closedAt = now;
        }
      }
      this.volumeTradeEvents = [];
      this.volumeEntryCountBySide = { UP: 0, DOWN: 0 };
      this.lastVolumeEntryAtBySide = { UP: null, DOWN: null };
      this.volumeWindowStart = null;
      this.tierDay = utcDayKey(now);
      this.activeTakerTier = tierFor(0);
      this.estimatedRebateAccrued = 0;
      this.estimatedRebatePaid = 0;
      this.rewardSettings = { status: 'WAITING_FOR_MARKET' };
      this.rewardLookupSlug = null;
      this.volumeStatus = `MIGRATED_FROM_${state.strategyVersion || 'LEGACY'}`;
      this.orderWindowStart = null;
      this.quoteWindowStart = null;
      if (!this.market?.tokens?.UP || !this.market?.tokens?.DOWN) this.market = null;
      this.persistenceDirty = true;
    }
    this.forecast = this.emptyForecast('Waiting for fresh Binance and Polymarket data.');
  }

  openStrategyWindow(start, now) {
    this.orderWindowStart = start;
    this.quoteWindowStart = start;
    this.volumeWindowStart = start;
    this.volumeStatus = 'SCANNING_FOR_EDGE';
    this.windowOrders = [];
    this.liveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.lastEntryAt = null;
    this.lastEntryAtBySide = { UP: null, DOWN: null };
    this.volumeEntryCountBySide = { UP: 0, DOWN: 0 };
    this.lastVolumeEntryAtBySide = { UP: null, DOWN: null };
    this.upEngine = this.emptyEngine('UP', { status: 'INACTIVE', fillStatus: 'NOT USED' });
    this.downEngine = this.emptyEngine('DOWN', { status: 'INACTIVE', fillStatus: 'NOT USED' });
    this.rewardLookupSlug = null;
    this.rewardSettings = { status: 'LOOKING_UP' };
    this.forecast = this.emptyForecast('Waiting for live inputs.', 'SCANNING');
    this.scheduleRewardLookup();
    this.log('PAPER_VOLUME_WINDOW_STARTED', {
      windowStart: start,
      entryShares: config.VOLUME_ENTRY_SHARES,
      takerFeeRate: config.VOLUME_TAKER_FEE_RATE,
      maxEntriesPerSide: config.VOLUME_MAX_ENTRIES_PER_SIDE_PER_WINDOW,
    });
  }

  scheduleRewardLookup() {
    const slug = this.market?.slug;
    if (!slug || slug === this.rewardLookupSlug) return;
    this.rewardLookupSlug = slug;
    this.rewardSettings = { status: 'LOOKING_UP', marketSlug: slug };
    Promise.resolve(this.rewardsClient.getMarketRewards(this.market))
      .then((settings) => {
        if (this.market?.slug !== slug) return;
        this.rewardSettings = settings;
        this.persistenceDirty = true;
      })
      .catch((error) => {
        if (this.market?.slug !== slug) return;
        this.rewardSettings = {
          status: 'UNAVAILABLE',
          marketSlug: slug,
          reason: error.message || String(error),
        };
      });
  }

  updateTakerTier(now) {
    const today = utcDayKey(now);
    if (today === this.tierDay) return;

    if (this.estimatedRebateAccrued >= 1) {
      this.cash += this.estimatedRebateAccrued;
      this.estimatedRebatePaid += this.estimatedRebateAccrued;
      this.log('PAPER_VOLUME_REBATE_CREDITED', {
        amount: this.estimatedRebateAccrued,
        currency: 'pUSD estimate',
      });
      this.estimatedRebateAccrued = 0;
    }

    const dayStart = utcDayStart(now);
    const cutoff = dayStart - ROLLING_VOLUME_MS;
    const weightedVolume = this.volumeTradeEvents
      .filter((event) => Number(event.ts) >= cutoff && Number(event.ts) < dayStart)
      .reduce((sum, event) => sum + safeNumber(event.weightedVolume), 0);
    this.activeTakerTier = tierFor(weightedVolume);
    this.tierDay = today;
    this.volumeTradeEvents = this.volumeTradeEvents
      .filter((event) => Number(event.ts) >= cutoff);
    this.log('PAPER_VOLUME_TIER_UPDATED', {
      tier: this.activeTakerTier.name,
      weightedVolume30d: weightedVolume,
    });
  }

  buildForecast(now) {
    if (!this.market) return this.emptyForecast('Waiting for a Polymarket BTC 5-minute market.');
    const feed = this.priceFeed?.snapshot?.() || {};
    const candle = feed.currentCandle;
    const secondsRemaining = Math.max(0, (Number(this.market.end) - now) / 1000);
    if (secondsRemaining <= 0) {
      return { ...this.emptyForecast('The current market window has ended.', 'WINDOW_ENDED'), secondsRemaining: 0 };
    }
    if (feed.status !== 'CONNECTED'
      || !Number.isFinite(Number(feed.tickAgeMs))
      || Number(feed.tickAgeMs) > config.VOLUME_MAX_BINANCE_TICK_AGE_MS) {
      return {
        ...this.emptyForecast('Waiting for a fresh Binance BTC tick.', 'WAITING_FOR_BINANCE'),
        secondsRemaining,
        binanceTickAgeMs: feed.tickAgeMs ?? null,
      };
    }
    if (!candle || Number(candle.start) !== Number(this.market.start)
      || !(Number(candle.open) > 0)) {
      return {
        ...this.emptyForecast('Waiting for the Binance candle matching this Polymarket window.', 'WAITING_FOR_CANDLE'),
        secondsRemaining,
      };
    }

    const volatility = estimateVolatility(feed.priceSamples, now);
    if (!volatility.ready) {
      return {
        ...this.emptyForecast(volatility.reason, 'COLLECTING_VOLATILITY'),
        secondsRemaining,
        sampleCount: volatility.sampleCount,
        binancePrice: Number(feed.price) || null,
        candleOpen: Number(candle.open),
      };
    }

    const spot = Number(feed.price || candle.close);
    const sigmaHorizon = volatility.sigmaPerSecond * Math.sqrt(Math.max(1, secondsRemaining));
    const zScore = sigmaHorizon > 0 ? Math.log(spot / Number(candle.open)) / sigmaHorizon : 0;
    const estimatedUpProbability = Math.min(0.999, Math.max(0.001, normalCdf(zScore)));
    const estimatedDownProbability = 1 - estimatedUpProbability;
    const candidates = {};
    for (const side of SIDES) {
      const quote = this.freshQuote(side, now);
      if (!quote) {
        candidates[side] = {
          ready: false,
          qualifies: false,
          reason: 'Waiting for a fresh Polymarket order book.',
          bestAsk: null,
          bestBid: null,
          probability: side === 'UP' ? estimatedUpProbability : estimatedDownProbability,
        };
        continue;
      }
      const probability = side === 'UP' ? estimatedUpProbability : estimatedDownProbability;
      const execution = PressureForecastBot._test.sweepBook(
        quote.askLevels,
        config.VOLUME_ENTRY_SHARES,
        'BUY',
        this.market,
        { maximumPrice: config.VOLUME_MAX_ENTRY_PRICE },
      );
      const fee = execution.fees;
      const expectedRebate = fee * this.activeTakerTier.rate;
      const edgePerShare = execution.filledShares > 0
        ? (probability * execution.filledShares - execution.totalCost
          + expectedRebate) / execution.filledShares - config.VOLUME_BASIS_BUFFER
        : null;
      const minimumFilledShares = Math.min(
        config.VOLUME_MIN_SHARES,
        config.VOLUME_ENTRY_SHARES,
      );
      const candidateReady = execution.filledShares >= minimumFilledShares
        && execution.gross >= 1
        && Number.isFinite(edgePerShare);
      candidates[side] = {
        ready: candidateReady,
        qualifies: candidateReady && edgePerShare >= config.VOLUME_MIN_NET_EDGE,
        reason: execution.filledShares < minimumFilledShares
          ? `Less than ${minimumFilledShares} shares are available below $${config.VOLUME_MAX_ENTRY_PRICE.toFixed(2)}.`
          : execution.gross < 1
            ? 'The simulated order is below the $1 minimum notional.'
            : null,
        bestAsk: quote.bestAsk,
        bestBid: quote.bestBid,
        probability,
        requestedShares: config.VOLUME_ENTRY_SHARES,
        filledShares: execution.filledShares,
        averageFillPrice: execution.averagePrice,
        grossCost: execution.gross,
        modeledFee: fee,
        rebateAtCurrentTier: expectedRebate,
        allInCost: execution.totalCost,
        edgePerShare,
        askDepthShares: quote.askLevels.reduce((sum, level) => sum + Number(level.size || 0), 0),
        quoteUpdatedAt: quote.updatedAt,
      };
    }
    const selected = SIDES
      .filter((side) => candidates[side]?.qualifies)
      .sort((a, b) => candidates[b].edgePerShare - candidates[a].edgePerShare)[0] || null;
    const quoteReady = SIDES.some((side) => candidates[side]?.ready);
    return {
      ready: quoteReady,
      status: selected ? 'EDGE_FOUND' : quoteReady ? 'WAITING_FOR_EDGE' : 'WAITING_FOR_BOOKS',
      reason: selected
        ? `${selected} has the best estimated net edge after taker fees and the Binance–Chainlink basis buffer.`
        : quoteReady
          ? 'No side currently clears the minimum net-edge requirement.'
          : 'Waiting for at least one fresh, executable Polymarket order book.',
      strategyVersion: STRATEGY_VERSION,
      signalSource: 'BINANCE_5M_VOLATILITY_AND_POLYMARKET_CLOB',
      secondsRemaining,
      binancePrice: spot,
      candleOpen: Number(candle.open),
      candleMovePct: (spot / Number(candle.open) - 1) * 100,
      volatilityPerSecond: volatility.sigmaPerSecond,
      volatilitySampleCount: volatility.sampleCount,
      volatilitySampleSpanMs: volatility.spanMs,
      zScore,
      estimatedUpProbability,
      estimatedDownProbability,
      flowImbalance: feed.tradeFlow?.imbalance ?? null,
      flowTradeCount: feed.tradeFlow?.tradeCount ?? 0,
      candidates,
      selectedSide: selected,
      minNetEdge: config.VOLUME_MIN_NET_EDGE,
      basisRiskBuffer: config.VOLUME_BASIS_BUFFER,
      modelNote: 'Uncalibrated Binance proxy for a Chainlink-resolved market; displayed as an estimate, not a guaranteed probability.',
    };
  }

  updateEngineForecast(now) {
    this.forecast = this.buildForecast(now);
    return this.forecast;
  }

  isTakeProfitQuote(quote, now, position = null) {
    if (position?.entryType === ENTRY_TYPE) return false;
    return super.isTakeProfitQuote(quote, now, position);
  }

  applyTakeProfitExits(now) {
    // Preserve the old exit behavior only for positions carried over during
    // migration. New volume positions use fee-aware visible-bid sweeps.
    for (const position of this.positions) {
      if (position.entryType === ENTRY_TYPE || position.status !== 'OPEN'
        || position.windowStart !== this.market?.start) continue;
      const quote = this.liveQuotes[position.side];
      if (this.isTakeProfitQuote(quote, now, position)) {
        this.finalizeTakeProfit(position, Number(quote.updatedAt));
      }
    }
    this.updateEngineForecast(now);
  }

  processEngineTriggers(now) {
    if (!this.market || now >= Number(this.market.end)) return;
    this.updateTakerTier(now);
    this.forecast = this.buildForecast(now);
    this.processVolumeTakeProfits(now);

    const selectedSide = this.forecast.selectedSide;
    if (!selectedSide) {
      this.volumeStatus = this.forecast.status;
      return;
    }
    const candidate = this.forecast.candidates?.[selectedSide];
    const blocked = this.entryBlockReason(selectedSide, candidate, now);
    if (blocked) {
      this.volumeStatus = blocked;
      return;
    }

    const position = this.executeVolumeBuy(selectedSide, candidate, now);
    if (!position) {
      this.volumeStatus = 'ENTRY_NOT_FILLED';
      return;
    }
    const order = this.orders.find((item) => item.id === position.id);
    position.entryType = ENTRY_TYPE;
    position.strategyVersion = STRATEGY_VERSION;
    position.orderType = 'PAPER_TAKER_VISIBLE_ASK_SWEEP';
    position.entryLabel = 'Edge-qualified 10-share taker sweep';
    position.signalSource = 'BINANCE_5M_VOLATILITY_AND_POLYMARKET_CLOB';
    position.signalProbability = candidate.probability;
    position.netEdgePerShare = candidate.edgePerShare;
    position.feeModel = 'POLYMARKET_CRYPTO_TAKER_FEE';
    if (order) {
      order.kind = 'BUY_VOLUME_TAKER';
      order.orderType = 'PAPER_TAKER_VISIBLE_ASK_SWEEP';
      order.signalSource = position.signalSource;
      order.signalProbability = candidate.probability;
      order.netEdgePerShare = candidate.edgePerShare;
    }
    this.volumeEntryCountBySide[selectedSide] += 1;
    this.lastVolumeEntryAtBySide[selectedSide] = now;
    this.lastEntryAtBySide[selectedSide] = now;
    this.lastEntryAt = now;
    this.recordTakerFills(position.entryFills, 'BUY', selectedSide, now);
    this.volumeStatus = `ENTERED_${selectedSide}`;
    this.forecast = this.buildForecast(now);
  }

  executeVolumeBuy(side, candidate, now) {
    const quote = this.freshQuote(side, now);
    if (!quote) return null;
    const options = { maximumPrice: config.VOLUME_MAX_ENTRY_PRICE };
    const preview = PressureForecastBot._test.sweepBook(
      quote.askLevels,
      config.VOLUME_ENTRY_SHARES,
      'BUY',
      this.market,
      options,
    );
    const minShares = Math.min(config.VOLUME_MIN_SHARES, config.VOLUME_ENTRY_SHARES);
    if (preview.filledShares < minShares || preview.gross < 1) return null;
    const previewEdge = (candidate.probability * preview.filledShares - preview.totalCost
      + preview.fees * this.activeTakerTier.rate) / preview.filledShares
      - config.VOLUME_BASIS_BUFFER;
    if (previewEdge < config.VOLUME_MIN_NET_EDGE || preview.totalCost > this.cash) return null;

    const execution = PressureForecastBot._test.sweepBook(
      quote.askLevels,
      config.VOLUME_ENTRY_SHARES,
      'BUY',
      this.market,
      { ...options, consume: true },
    );
    if (execution.filledShares < minShares || execution.gross < 1
      || execution.totalCost > this.cash) return null;
    const actualEdge = (candidate.probability * execution.filledShares - execution.totalCost
      + execution.fees * this.activeTakerTier.rate) / execution.filledShares
      - config.VOLUME_BASIS_BUFFER;
    if (actualEdge < config.VOLUME_MIN_NET_EDGE) return null;

    const order = this.createOrder('BUY_VOLUME_TAKER', side, config.VOLUME_ENTRY_SHARES, now, execution);
    order.status = 'FILLED';
    order.orderType = 'PAPER_TAKER_VISIBLE_ASK_SWEEP_FAK';
    order.requestedShares = config.VOLUME_ENTRY_SHARES;
    order.matchedShares = execution.filledShares;
    order.fillStatus = execution.filledShares < config.VOLUME_ENTRY_SHARES
      ? 'PARTIAL_FAK_REMAINDER_CANCELLED'
      : 'FULL_FAK_FILL';
    order.price = execution.averagePrice;
    order.fee = execution.fees;
    order.grossCost = execution.gross;
    order.totalCost = execution.totalCost;
    order.fills = execution.fills;
    order.filledAt = now;
    order.maxPrice = config.VOLUME_MAX_ENTRY_PRICE;

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
      engine: 'VOLUME',
      signalSide: side,
      tokenId: this.market.tokens[side],
      entryKey: order.id,
      entryLabel: 'Edge-qualified taker-volume entry',
      entryType: ENTRY_TYPE,
      strategyVersion: STRATEGY_VERSION,
      orderType: order.orderType,
      fillModel: 'VISIBLE_ASK_SWEEP_FAK',
      shares: execution.filledShares,
      initialShares: execution.filledShares,
      requestedShares: config.VOLUME_ENTRY_SHARES,
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
      signalSource: 'BINANCE_5M_VOLATILITY_AND_POLYMARKET_CLOB',
      signalProbability: candidate.probability,
      netEdgePerShare: actualEdge,
      feeModel: 'POLYMARKET_CRYPTO_TAKER_FEE',
    };
    this.cash -= execution.totalCost;
    this.positions.unshift(position);
    order.positionId = position.id;
    order.signalSource = position.signalSource;
    order.signalProbability = candidate.probability;
    order.netEdgePerShare = actualEdge;
    this.log('PAPER_VOLUME_TAKER_ENTRY_FILLED', {
      orderId: order.id,
      positionId: position.id,
      side,
      requestedShares: config.VOLUME_ENTRY_SHARES,
      filledShares: position.shares,
      averagePrice: position.avgEntry,
      modeledFee: position.fees,
      estimatedProbability: candidate.probability,
      estimatedNetEdgePerShare: actualEdge,
      activeTakerTier: this.activeTakerTier.name,
      remainderCancelled: position.shares < config.VOLUME_ENTRY_SHARES,
    });
    return position;
  }

  entryBlockReason(side, candidate, now) {
    if (!candidate?.qualifies) return 'WAITING_FOR_EDGE';
    if (this.volumeEntryCountBySide[side] >= config.VOLUME_MAX_ENTRIES_PER_SIDE_PER_WINDOW) {
      return `MAX_${side}_ENTRIES_REACHED`;
    }
    const lastEntryAt = Number(this.lastVolumeEntryAtBySide[side]);
    if (Number.isFinite(lastEntryAt) && now - lastEntryAt < config.VOLUME_ENTRY_COOLDOWN_MS) {
      return 'ENTRY_COOLDOWN';
    }
    const windowSpend = this.orders
      .filter((order) => Number(order.windowStart) === Number(this.market.start)
        && order.kind === 'BUY_VOLUME_TAKER' && order.status === 'FILLED')
      .reduce((sum, order) => sum + safeNumber(order.totalCost), 0);
    if (windowSpend + safeNumber(candidate.allInCost) > config.VOLUME_MAX_SPEND_PER_WINDOW) {
      return 'WINDOW_SPEND_CAP';
    }
    const openCost = this.positions
      .filter((position) => ['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status))
      .reduce((sum, position) => sum + safeNumber(position.totalCost), 0);
    if (openCost + safeNumber(candidate.allInCost) > config.VOLUME_MAX_OPEN_COST) {
      return 'OPEN_EXPOSURE_CAP';
    }
    const dayStart = utcDayStart(now);
    const dailyRealized = this.positions
      .filter((position) => position.entryType === ENTRY_TYPE
        && Number(position.settledAt || position.closedAt || position.resolvedAt) >= dayStart)
      .reduce((sum, position) => sum + safeNumber(position.realizedPnl), 0);
    if (dailyRealized <= -config.VOLUME_MAX_DAILY_LOSS) return 'DAILY_LOSS_LIMIT';
    if (this.cash < safeNumber(candidate.allInCost)) return 'INSUFFICIENT_PAPER_CASH';
    return null;
  }

  processVolumeTakeProfits(now) {
    for (const side of SIDES) {
      const positions = this.positions.filter((position) =>
        position.entryType === ENTRY_TYPE
        && position.windowStart === this.market.start
        && position.side === side
        && position.status === 'OPEN');
      if (!positions.length) continue;
      const quote = this.freshQuote(side, now);
      if (!quote) continue;
      const shares = positions.reduce((sum, position) => sum + safeNumber(position.shares), 0);
      if (!(shares > 0)) continue;
      const execution = PressureForecastBot._test.sweepBook(
        quote.bidLevels,
        shares,
        'SELL',
        this.market,
      );
      if (!execution.complete) continue;
      const totalCost = positions.reduce((sum, position) => sum + safeNumber(position.totalCost), 0);
      const netProfit = execution.netProceeds - totalCost;
      if (netProfit + 1e-8 < config.VOLUME_TAKE_PROFIT_NET_PER_SHARE * shares) continue;

      this.executeSideExit({
        side,
        now,
        positions,
        execution,
        kind: 'SELL_VOLUME_TAKE_PROFIT',
        exitReason: 'NET_TAKE_PROFIT_AFTER_ENTRY_AND_EXIT_FEES',
        settlementBasis: 'PAPER_TAKER_VISIBLE_BID_SWEEP',
        event: 'PAPER_VOLUME_TAKE_PROFIT_FILLED',
        logData: {
          shares,
          averageExitPrice: execution.averagePrice,
          entryAndExitFeesIncluded: true,
          netProfit,
        },
      });
      const order = this.orders.find((item) => item.createdAt === now
        && item.kind === 'SELL_VOLUME_TAKE_PROFIT');
      if (order) order.orderType = 'PAPER_TAKER_VISIBLE_BID_SWEEP';
      this.recordTakerFills(execution.fills, 'SELL', side, now);
      this.lastVolumeEntryAtBySide[side] = now;
      this.lastEntryAtBySide[side] = now;
      this.volumeStatus = `TAKE_PROFIT_${side}`;
    }
  }

  recordTakerFills(fills, action, side, timestamp) {
    const feeFor = WickBot._test.feeFor;
    for (const fill of Array.isArray(fills) ? fills : []) {
      const price = Number(fill.price);
      const shares = Number(fill.shares);
      if (!(price > 0 && price < 1 && shares > 0)) continue;
      const fee = feeFor(this.market, price, shares);
      const notional = price * shares;
      const weightedVolume = fee > 0 ? notional * (1 - price) : 0;
      const rebate = fee > 0 ? fee * this.activeTakerTier.rate : 0;
      this.volumeTradeEvents.push({
        ts: timestamp,
        marketSlug: this.market?.slug || null,
        action,
        side,
        shares,
        price,
        notional,
        fee,
        weightedVolume,
        estimatedRebate: rebate,
        tier: this.activeTakerTier.name,
      });
      this.estimatedRebateAccrued += rebate;
    }
    const cutoff = timestamp - 31 * DAY_MS;
    this.volumeTradeEvents = this.volumeTradeEvents
      .filter((event) => Number(event.ts) >= cutoff)
      .slice(-25_000);
    this.persistenceDirty = true;
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
      const quote = this.market?.start === windowStart ? this.liveQuotes[position.side] : null;
      if (position.entryType !== ENTRY_TYPE
        && this.isTakeProfitQuote(quote, now, position)) {
        this.finalizeTakeProfit(position, Number(quote.updatedAt));
        continue;
      }
      position.status = 'PENDING_CLOB_RESULT';
      position.markStatus = 'PENDING_CLOB_RESULT';
      position.pendingResolutionAt = now;
      position.exitReason = 'WAITING_FOR_OFFICIAL_RESOLUTION';
      position.settlementBasis = 'POLYMARKET_RESOLUTION_PENDING';
    }
    this.log('PAPER_VOLUME_WINDOW_ENDED', {
      windowStart,
      pendingResolutionCount: positions.filter((position) =>
        position.status === 'PENDING_CLOB_RESULT').length,
      triggerReason,
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.priceFeed.start?.();
    this.log('PAPER_VOLUME_BOT_STARTED', {
      note: 'Paper-only, edge-gated taker-volume simulator. No live order modules are loaded.',
      entryShares: config.VOLUME_ENTRY_SHARES,
      minimumNetEdge: config.VOLUME_MIN_NET_EDGE,
      takerFeeRate: config.VOLUME_TAKER_FEE_RATE,
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

  volumeStats(now) {
    const cutoff = now - ROLLING_VOLUME_MS;
    const recent = this.volumeTradeEvents.filter((event) => Number(event.ts) >= cutoff);
    const weightedVolume30d = recent.reduce((sum, event) => sum + safeNumber(event.weightedVolume), 0);
    const grossNotional30d = recent.reduce((sum, event) => sum + safeNumber(event.notional), 0);
    const modeledFees30d = recent.reduce((sum, event) => sum + safeNumber(event.fee), 0);
    const marketEntryCount = this.orders.filter((order) =>
      order.kind === 'BUY_VOLUME_TAKER' && order.status === 'FILLED').length;
    return {
      entryShares: config.VOLUME_ENTRY_SHARES,
      maxEntriesPerSidePerWindow: config.VOLUME_MAX_ENTRIES_PER_SIDE_PER_WINDOW,
      entryCooldownMs: config.VOLUME_ENTRY_COOLDOWN_MS,
      minimumNetEdgePerShare: config.VOLUME_MIN_NET_EDGE,
      basisRiskBuffer: config.VOLUME_BASIS_BUFFER,
      maxEntryPrice: config.VOLUME_MAX_ENTRY_PRICE,
      maxSpendPerWindow: config.VOLUME_MAX_SPEND_PER_WINDOW,
      maxOpenCost: config.VOLUME_MAX_OPEN_COST,
      maxDailyLoss: config.VOLUME_MAX_DAILY_LOSS,
      entryCounts: { ...this.volumeEntryCountBySide },
      lastEntryAtBySide: { ...this.lastVolumeEntryAtBySide },
      grossTakerNotional30d: grossNotional30d,
      eligibleWeightedVolume30d: weightedVolume30d,
      modeledTakerFees30d: modeledFees30d,
      activeTakerTier: this.activeTakerTier,
      estimatedRebateRate: this.activeTakerTier.rate,
      estimatedRebateAccrued: this.estimatedRebateAccrued,
      estimatedRebatePaid: this.estimatedRebatePaid,
      rebateMinimumPayout: 1,
      directLiquidityRewards: this.rewardSettings,
      feeRate: config.VOLUME_TAKER_FEE_RATE,
      feeFormula: 'shares × feeRate × price × (1 − price)',
      weightedVolumeFormula: 'dollar trade size × (1 − entry price), for fee-paying taker fills',
      filledVolumeEntries: marketEntryCount,
      status: this.volumeStatus,
      rewardDisclaimer: 'Paper tier estimates only; no wallet tier is connected and rebates are not guaranteed.',
    };
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const market = this.market;
    const windowStart = market?.start ?? null;
    const windowEnd = market?.end ?? (windowStart == null ? null : windowStart + this.windowMs);
    const quotes = { UP: { ...this.liveQuotes.UP }, DOWN: { ...this.liveQuotes.DOWN } };
    const windowOrders = this.orders.filter((order) =>
      Number(order.windowStart) === Number(windowStart));
    const recentOrders = this.orders.slice(0, 100);
    const positions = this.positions.map((position) => ({
      ...position,
      avgPrice: position.avgEntry,
      currentValue: position.status === 'OPEN' && position.markBid != null
        ? position.markBid * position.shares
        : position.status === 'PENDING_CLOB_RESULT' ? null : position.proceeds ?? 0,
      capitalCommitted: ['OPEN', 'PENDING_CLOB_RESULT'].includes(position.status)
        ? Number(position.totalCost || 0) : 0,
      unrealizedPnl: position.status === 'OPEN' && position.markStatus === 'LIVE'
        && Number.isFinite(Number(position.markBid))
        ? Number(position.markBid) * Number(position.shares) - Number(position.totalCost || 0)
        : null,
      pnl: position.realizedPnl ?? (position.status === 'OPEN' && position.markStatus === 'LIVE'
        ? Number(position.markBid) * Number(position.shares) - Number(position.totalCost || 0)
        : null),
    }));
    const result = {
      ...state,
      now,
      mode: 'DEMO ONLY',
      status: this.status,
      strategy: {
        ...state.strategy,
        name: this.strategyName,
        mode: 'PAPER ONLY',
        execution: 'PAPER ONLY',
        markets: ['BTC 5m'],
        orderType: 'VISIBLE_BOOK_TAKER_SWEEP',
        signal: 'Estimate BTC window resolution probability from live Binance price, candle open, and realized volatility; buy only when the executable Polymarket ask has positive net edge after taker fees and a basis-risk buffer.',
        entryRule: `One ${config.VOLUME_ENTRY_SHARES}-share taker clip per qualifying check, at least ${Math.round(config.VOLUME_ENTRY_COOLDOWN_MS / 1000)} seconds apart per side; max ask $${config.VOLUME_MAX_ENTRY_PRICE.toFixed(2)}.`,
        exitRule: `Sweep visible bids only when the full position can be sold for at least $${config.VOLUME_TAKE_PROFIT_NET_PER_SHARE.toFixed(2)} net profit per share after entry and exit fees; otherwise hold for official resolution.`,
        liveTradingEnabled: false,
        realOrderModulesLoaded: false,
        takerFeeRate: config.VOLUME_TAKER_FEE_RATE,
        minNetEdge: config.VOLUME_MIN_NET_EDGE,
        volume: this.volumeStats(now),
        priceFeed: this.priceFeed?.snapshot?.() || null,
        model: {
          name: 'Volatility-scaled BTC resolution probability',
          data: 'Binance BTCUSDT aggregate trades and current 5-minute candle',
          comparison: 'Polymarket CLOB ask and visible ask depth',
          resolutionReference: 'Polymarket market resolution (Chainlink-based)',
          limitation: 'An uncalibrated paper estimate; Binance–Chainlink basis and price movement can create forecast error.',
        },
      },
      forecast: this.forecast,
      marketForecast: this.forecast,
      markets: {
        '5m': {
          slug: market?.slug || null,
          title: market?.title || 'BTC 5-minute UP/DOWN',
          windowStart,
          windowEnd,
          quotes,
          forecast: this.forecast,
          orders: windowOrders,
        },
      },
      window: market ? {
        title: market.title,
        slug: market.slug,
        start: windowStart,
        end: windowEnd,
      } : null,
      quotes,
      positions,
      orders: recentOrders,
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
      liveTrading: {
        enabled: false,
        status: 'inactive',
        detail: 'This artifact runs paper trades only; live order modules are not loaded.',
      },
      volumeMetrics: this.volumeStats(now),
      error: this.error || null,
    };
    return result;
  }
}

VolumeBot._test = {
  tierFor,
  normalCdf,
  estimateVolatility,
  utcDayStart,
  STRATEGY_VERSION,
};

module.exports = VolumeBot;
