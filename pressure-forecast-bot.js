'use strict';

const config = require('./config');
const WickBot = require('./wick-bot');
const BinanceTickFeed = require('./binance-tick-feed');
const defaultMarketData = require('./wick-market-data');
const { feeFor, quoteFromBook } = WickBot._test;

const EPSILON = 1e-9;
const SIDES = ['UP', 'DOWN'];

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return Math.max(0, Math.min(1, 0.5 * (1 + erf)));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pressureTrend(samples) {
  const values = samples.map((sample) => Number(sample.score))
    .filter(Number.isFinite)
    .slice(-config.PRESSURE_SAMPLE_COUNT);
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

function volatilityPerSecond(samples) {
  const prices = samples.slice(-config.PRESSURE_SAMPLE_COUNT)
    .map((sample) => Number(sample.price))
    .filter((price) => price > 0);
  if (prices.length < 3) return null;
  const returns = [];
  for (let index = 1; index < prices.length; index += 1) {
    returns.push(Math.log(prices[index] / prices[index - 1]));
  }
  return Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0) / returns.length);
}

function bookPressure(quote) {
  const bids = (quote?.bidLevels || []).slice(0, config.PRESSURE_DEPTH_LEVELS);
  const asks = (quote?.askLevels || []).slice(0, config.PRESSURE_DEPTH_LEVELS);
  const bidDepth = bids.reduce((sum, level) => sum + Number(level.size || 0), 0);
  const askDepth = asks.reduce((sum, level) => sum + Number(level.size || 0), 0);
  const total = bidDepth + askDepth;
  const depthImbalance = total > 0 ? (bidDepth - askDepth) / total : 0;
  const bestBid = bids[0];
  const bestAsk = asks[0];
  let micropriceImbalance = 0;
  if (bestBid && bestAsk && bestAsk.price > bestBid.price) {
    const bidSize = Number(bestBid.size) || 0;
    const askSize = Number(bestAsk.size) || 0;
    const combined = bidSize + askSize;
    if (combined > 0) {
      const midpoint = (bestBid.price + bestAsk.price) / 2;
      const microprice = (bestAsk.price * bidSize + bestBid.price * askSize) / combined;
      micropriceImbalance = clamp(
        (microprice - midpoint) / ((bestAsk.price - bestBid.price) / 2),
      );
    }
  }
  return {
    score: clamp(0.65 * depthImbalance + 0.35 * micropriceImbalance),
    depthImbalance: clamp(depthImbalance),
    micropriceImbalance,
    bidDepth,
    askDepth,
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
    this.strategyName = 'BTC 5-minute pressure and price forecast paper bot';
    this.strategyMode = 'pressure-forecast';
    this.pressureSamples = [];
    this.lastSampleAt = null;
    this.forecast = this.emptyForecast('Waiting for Binance and Polymarket data.');
    this.lastEntryAt = null;
    this.lastResolutionCheckAt = new Map();
    this.actionSequence = 0;
    this.resolutions = [];
  }

  emptyForecast(reason, status = 'WAITING_FOR_DATA') {
    return {
      ready: false,
      calibrated: false,
      status,
      reason,
      estimateUp: null,
      estimateDown: null,
      marketImpliedUp: null,
      marketImpliedDown: null,
      laggingSide: null,
      selectedSide: null,
      expectedNetEdgePerShare: null,
      minRequiredEdgePerShare: config.PRESSURE_MIN_NET_EDGE_PER_SHARE,
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
      estimatedProbability: null,
      bestAsk: null,
      allInCostPerShare: null,
      expectedNetEdgePerShare: null,
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
    this.pressureSamples = [];
    this.lastSampleAt = null;
    this.lastEntryAt = null;
    this.signal = null;
    this.forecast = this.emptyForecast('Collecting ten fresh one-second pressure samples.', 'COLLECTING_SAMPLES');
    this.log('PAPER_PRESSURE_WINDOW_STARTED', {
      windowStart: start,
      samplesRequired: config.PRESSURE_SAMPLE_COUNT,
      entryShares: config.PRESSURE_ENTRY_SHARES,
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
      await this.refreshLiveQuotes(now);
      this.processPressureStrategy(start, now);
      this.processThresholdExits(start, now);
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

  async refreshLiveQuotes(now) {
    if (!this.market) return;
    const results = await Promise.allSettled(SIDES.map((side) =>
      this.marketData.getBook(this.market.tokens[side])));
    SIDES.forEach((side, index) => {
      const result = results[index];
      if (result.status === 'fulfilled') {
        this.liveQuotes[side] = quoteFromBook(result.value, now);
      } else {
        const previous = this.liveQuotes[side] || {};
        const stale = !previous.updatedAt || now - previous.updatedAt > config.PRESSURE_MAX_QUOTE_AGE_MS;
        this.liveQuotes[side] = {
          ...previous,
          status: stale ? 'STALE' : 'LIVE',
          stale,
          attemptedAt: now,
          error: result.reason?.message || 'CLOB book unavailable',
        };
      }
    });
    for (const position of this.positions) {
      if (position.windowStart !== this.market.start || position.status !== 'OPEN') continue;
      const quote = this.liveQuotes[position.side];
      position.markBid = quote?.bestBid ?? null;
      position.markUpdatedAt = quote?.updatedAt || now;
      position.markStatus = quote?.bestBid == null ? 'MISSING' : 'LIVE';
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
    const clobReady = SIDES.every((side) => quotes[side]);
    if (!binanceReady || !clobReady) {
      return {
        ready: false,
        status: 'WAITING_FOR_DATA',
        reason: !binanceReady
          ? 'Waiting for fresh Binance trades and a current tick.'
          : 'Waiting for fresh two-sided Polymarket books.',
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
    const upBook = bookPressure(quotes.UP);
    const downBook = bookPressure(quotes.DOWN);
    const clobScore = clamp((upBook.score - downBook.score) / 2);
    const combinedScore = clamp((binanceScore + clobScore) / 2);
    return {
      ready: true,
      status: 'READY',
      reason: 'Combined Binance trade flow and Polymarket book pressure are fresh.',
      feed,
      flow,
      quotes,
      tickAgeMs,
      binanceScore,
      binanceImbalance,
      momentum,
      clobScore,
      combinedScore,
      upBook,
      downBook,
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
        score: read.combinedScore,
        price: Number(read.feed.price),
        windowOpenPrice: openPrice,
        marketImpliedUp: Number(read.quotes.UP.mid),
      });
      this.pressureSamples = this.pressureSamples.slice(-config.PRESSURE_SAMPLE_COUNT);
    }

    const forecast = this.createForecast(read, now, start);
    this.forecast = forecast;
    if (!evaluationDue || !forecast.ready || !forecast.selectedSide) return false;

    const cooldownRemaining = config.PRESSURE_ENTRY_COOLDOWN_MS
      - (now - Number(this.lastEntryAt || 0));
    if (this.lastEntryAt != null && cooldownRemaining > 0) {
      this.forecast.status = 'ENTRY_COOLDOWN';
      this.forecast.reason = `${forecast.selectedSide} signal qualifies; next entry is available in ${Math.ceil(cooldownRemaining / 1000)} seconds.`;
      return false;
    }

    const candidate = forecast.candidateBySide[forecast.selectedSide];
    const opened = this.executeBuy(forecast.selectedSide, config.PRESSURE_ENTRY_SHARES, now, {
      kind: 'BUY_ENTRY',
      candidate,
      signal: read,
    });
    if (opened) {
      this.lastEntryAt = now;
      this.forecast.status = 'ENTRY_FILLED';
      this.forecast.reason = `Bought another 100-share ${forecast.selectedSide} position; existing positions remain open. The next entry can occur after the 15-second cooldown if a signal qualifies.`;
      this.signal = { side: forecast.selectedSide, action: 'BUY_ENTRY', reason: this.forecast.reason };
      return true;
    }
    return false;
  }

  freshSamples(now) {
    return this.pressureSamples
      .filter((sample) => now - Number(sample.at) <= config.PRESSURE_SAMPLE_INTERVAL_MS
        * config.PRESSURE_SAMPLE_COUNT + 500)
      .slice(-config.PRESSURE_SAMPLE_COUNT);
  }

  createForecast(read, now, start) {
    const samples = this.freshSamples(now);
    const secondsRemaining = Math.max(0, (start + this.windowMs - now) / 1000);
    const marketImpliedUp = Number(read.quotes.UP.mid);
    const marketImpliedDown = Number(read.quotes.DOWN.mid);
    const candidateBySide = { UP: this.emptyCandidate('Waiting for enough fresh pressure samples.'), DOWN: this.emptyCandidate('Waiting for enough fresh pressure samples.') };
    const trend = pressureTrend(samples);
    const currentPrice = Number(read.feed.price);
    const candle = read.feed.currentCandle;
    const windowOpenPrice = Number(candle?.start) === start ? Number(candle.open) : null;
    const btcMoveFromOpenPct = currentPrice > 0 && windowOpenPrice > 0
      ? ((currentPrice - windowOpenPrice) / windowOpenPrice) * 100
      : null;
    const volatility = volatilityPerSecond(samples);
    const ready = samples.length >= config.PRESSURE_SAMPLE_COUNT
      && marketImpliedUp > 0 && marketImpliedUp < 1
      && marketImpliedDown > 0 && marketImpliedDown < 1
      && windowOpenPrice > 0
      && currentPrice > 0
      && volatility != null
      && secondsRemaining > 0;
    if (!ready) {
      return {
        ...this.emptyForecast(
          `Collecting ten fresh one-second samples (${samples.length}/${config.PRESSURE_SAMPLE_COUNT}); no forecast is used yet.`,
          'COLLECTING_SAMPLES',
        ),
        sampleCount: samples.length,
        marketImpliedUp,
        marketImpliedDown,
        btcMoveFromOpenPct,
        volatilityPerSecond: volatility,
        secondsRemaining,
        pressureTrendSlope: trend.pressureTrendSlope,
        pressurePersistence: trend.pressurePersistence,
        pressureAcceleration: trend.pressureAcceleration,
        candidateBySide,
      };
    }

    const remainingVolatility = Math.max(1e-8, volatility * Math.sqrt(secondsRemaining));
    const zScore = Math.log(currentPrice / windowOpenPrice) / remainingVolatility;
    const priceModelUp = normalCdf(zScore);
    const pressureProbabilityUp = Math.max(0.05, Math.min(0.95, 0.5 + 0.45 * trend.pressureImpulse));
    const estimateUp = Math.max(0.01, Math.min(0.99,
      0.50 * priceModelUp + 0.30 * marketImpliedUp + 0.20 * pressureProbabilityUp));
    const estimateDown = 1 - estimateUp;
    const askUp = Number(read.quotes.UP.bestAsk);
    const askDown = Number(read.quotes.DOWN.bestAsk);
    const laggingSide = Math.min(askUp, askDown) < 0.5
      ? (askUp <= askDown ? 'UP' : 'DOWN')
      : null;

    for (const side of SIDES) {
      const quote = read.quotes[side];
      const probability = side === 'UP' ? estimateUp : estimateDown;
      const entry = sweepBook(
        quote.askLevels,
        config.PRESSURE_ENTRY_SHARES,
        'BUY',
        this.market,
        { maximumPrice: config.PRESSURE_MAX_BUY_PRICE },
      );
      const allInCostPerShare = entry.complete
        ? entry.totalCost / config.PRESSURE_ENTRY_SHARES
        : null;
      const edge = allInCostPerShare == null ? null : probability - allInCostPerShare;
      let reason = 'Not the lagging side below $0.50.';
      if (side !== laggingSide) reason = 'Only the cheaper side below $0.50 is eligible.';
      else if (!(probability > 0.5)) reason = 'The estimate does not put this side above 50%.';
      else if (!entry.complete) reason = 'Insufficient visible ask depth below the $0.90 cap.';
      else if (edge < config.PRESSURE_MIN_NET_EDGE_PER_SHARE) {
        reason = `Net edge is below the required $${config.PRESSURE_MIN_NET_EDGE_PER_SHARE.toFixed(2)} per share after taker fees.`;
      } else reason = 'Lagging-side estimate clears the net edge and taker price cap.';
      candidateBySide[side] = {
        estimatedProbability: probability,
        bestAsk: quote.bestAsk,
        allInCostPerShare,
        expectedNetEdgePerShare: edge,
        qualifies: side === laggingSide
          && probability > 0.5
          && entry.complete
          && edge >= config.PRESSURE_MIN_NET_EDGE_PER_SHARE,
        reason,
        requestedShares: config.PRESSURE_ENTRY_SHARES,
      };
    }

    const qualifying = SIDES
      .filter((side) => candidateBySide[side].qualifies)
      .sort((a, b) => candidateBySide[b].expectedNetEdgePerShare
        - candidateBySide[a].expectedNetEdgePerShare);
    const selectedSide = qualifying[0] || null;
    const status = selectedSide ? 'QUALIFIED' : 'NO_EDGE';
    const reason = selectedSide
      ? `${selectedSide} is the lagging side; its experimental estimate clears $${config.PRESSURE_MIN_NET_EDGE_PER_SHARE.toFixed(2)} net edge per share.`
      : 'No lagging side currently clears the 50% estimate and net-edge filters.';
    return {
      ready: true,
      calibrated: false,
      status,
      reason,
      estimateUp,
      estimateDown,
      priceModelUp,
      pressureProbabilityUp,
      marketImpliedUp,
      marketImpliedDown,
      laggingSide,
      selectedSide,
      expectedNetEdgePerShare: selectedSide
        ? candidateBySide[selectedSide].expectedNetEdgePerShare
        : null,
      minRequiredEdgePerShare: config.PRESSURE_MIN_NET_EDGE_PER_SHARE,
      sampleCount: samples.length,
      requiredSamples: config.PRESSURE_SAMPLE_COUNT,
      pressureTrendSlope: trend.pressureTrendSlope,
      pressurePersistence: trend.pressurePersistence,
      pressureAcceleration: trend.pressureAcceleration,
      pressureImpulse: trend.pressureImpulse,
      btcMoveFromOpenPct,
      volatilityPerSecond: volatility,
      secondsRemaining,
      zScore,
      candidateBySide,
    };
  }

  executeBuy(side, shares, now, { kind, candidate, signal } = {}) {
    const quote = this.freshQuote(side, now);
    if (!quote) return null;
    const preview = sweepBook(
      quote.askLevels,
      shares,
      'BUY',
      this.market,
      { maximumPrice: config.PRESSURE_MAX_BUY_PRICE },
    );
    const order = this.createOrder(kind || 'BUY_ENTRY', side, shares, now, preview);
    if (!preview.complete) {
      order.status = 'SKIPPED_PRICE_CAP_OR_DEPTH';
      order.error = 'Full requested size was not available at or below $0.90.';
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
      fillModel: 'VISIBLE_ASK_SWEEP_TO_0_90',
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
      takeProfitEnabled: false,
      takeProfitPrice: config.PRESSURE_TAKE_PROFIT_TRIGGER,
      stopLossPrice: config.PRESSURE_STOP_LOSS_TRIGGER,
      entryFills: execution.fills.map((fill) => ({ ...fill, at: now })),
      expectedProbability: candidate?.estimatedProbability ?? null,
      expectedNetEdgePerShare: candidate?.expectedNetEdgePerShare ?? null,
      signalScore: signal?.combinedScore ?? null,
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
    this.log('PAPER_PRESSURE_ENTRY_FILLED', {
      orderId: order.id,
      positionId: position.id,
      side,
      shares: position.shares,
      averagePrice: position.avgEntry,
      fees: position.fees,
      expectedNetEdgePerShare: position.expectedNetEdgePerShare,
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
      minPrice: kind.startsWith('SELL') ? config.PRESSURE_MIN_SELL_PRICE : null,
      status: 'SUBMITTED',
      createdAt: now,
      fee: 0,
      paperOnly: true,
    };
    this.windowOrders.unshift(order);
    this.orders.unshift(order);
    if (this.orders.length > 1000) this.orders.length = 1000;
    return order;
  }

  processThresholdExits(start, now) {
    for (const position of this.positions) {
      if (position.status !== 'OPEN' || Number(position.windowStart) !== Number(start)) continue;
      const quote = this.freshQuote(position.side, now);
      if (!quote) continue;
      if (Number(quote.bestBid) >= config.PRESSURE_TAKE_PROFIT_TRIGGER) {
        this.finalizeExit(position, config.PRESSURE_TAKE_PROFIT_PAYOUT, 'TAKE_PROFIT_0_99_COUNTS_AS_1');
        this.recordThresholdOrder(position, now, 'SELL_TAKE_PROFIT', config.PRESSURE_TAKE_PROFIT_PAYOUT);
      } else if (Number(quote.bestBid) <= config.PRESSURE_STOP_LOSS_TRIGGER) {
        this.finalizeExit(position, config.PRESSURE_STOP_LOSS_PAYOUT, 'STOP_LOSS_0_01_COUNTS_AS_0');
        this.recordThresholdOrder(position, now, 'SELL_STOP_LOSS', config.PRESSURE_STOP_LOSS_PAYOUT);
      }
    }
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
    for (const position of positions) {
      position.status = 'PENDING_CLOB_RESULT';
      position.markStatus = 'PENDING_CLOB_RESULT';
      position.pendingResolutionAt = now;
      position.exitReason = 'WAITING_FOR_OFFICIAL_RESOLUTION';
      position.settlementBasis = 'POLYMARKET_RESOLUTION_PENDING';
    }
    this.log('PAPER_PRESSURE_WINDOW_ENDED', {
      windowStart,
      pendingResolutionCount: positions.length,
      triggerReason,
    });
  }

  async resolvePendingPositions(now) {
    for (const position of this.positions) {
      if (position.status !== 'PENDING_CLOB_RESULT'
        || !position.marketId
        || now - Number(this.lastResolutionCheckAt.get(position.id) || 0) < config.RESOLUTION_POLL_MS) continue;
      this.lastResolutionCheckAt.set(position.id, now);
      try {
        const market = await this.marketData.getMarket(position.marketId);
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
        this.log('PAPER_PRESSURE_RESOLVED', {
          positionId: position.id,
          side: position.side,
          winningSide: position.resolvedOutcome,
          payout,
          shares: position.shares,
          realizedPnl: position.realizedPnl,
        });
      } catch (error) {
        position.resolutionError = error.message || String(error);
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
      if (this.running) this.timer = setTimeout(loop, config.POLL_INTERVAL_MS);
    };
    void loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.priceFeed.stop?.();
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
    return {
      ...state,
      now,
      mode: 'DEMO ONLY',
      status: this.status,
      strategy: {
        ...state.strategy,
        name: this.strategyName,
        execution: 'PAPER ONLY',
        markets: ['BTC 5m'],
        orderType: 'VISIBLE_BOOK_TAKER_SWEEP',
        liveTradingEnabled: false,
        realOrderModulesLoaded: false,
        entryShares: config.PRESSURE_ENTRY_SHARES,
        maxBuyPrice: config.PRESSURE_MAX_BUY_PRICE,
        minSellPrice: config.PRESSURE_MIN_SELL_PRICE,
        minNetEdgePerShare: config.PRESSURE_MIN_NET_EDGE_PER_SHARE,
        signal: 'Uncalibrated resolution estimate blends BTC price/volatility, current Polymarket odds, and ten one-second pressure samples.',
        signalState: this.forecast,
        orders: {
          type: 'Visible-book taker-style paper sweeps',
          initialShares: config.PRESSURE_ENTRY_SHARES,
          maxBuyPrice: config.PRESSURE_MAX_BUY_PRICE,
          minSellPrice: config.PRESSURE_MIN_SELL_PRICE,
          entryCooldownMs: config.PRESSURE_ENTRY_COOLDOWN_MS,
          maxEntriesPerWindow: 'No fixed cap; limited by qualifying signals and available cash.',
        },
        repeatEntryRule: 'After each successful entry, wait 15 seconds. A new qualifying signal on either side opens another independent 100-share position; existing positions are not sold on signal reversals.',
        priceFeed: this.priceFeed?.snapshot?.() || null,
        exits: {
          takeProfit: `${config.PRESSURE_TAKE_PROFIT_TRIGGER} best bid counts as $${config.PRESSURE_TAKE_PROFIT_PAYOUT} per share`,
          stopLoss: `${config.PRESSURE_STOP_LOSS_TRIGGER} best bid counts as $${config.PRESSURE_STOP_LOSS_PAYOUT} per share`,
          otherwise: 'Wait for official resolution of the original Polymarket window.',
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
  normalCdf,
  pressureTrend,
  volatilityPerSecond,
  bookPressure,
  sweepBook,
  resolvedPayout,
};

module.exports = PressureForecastBot;
