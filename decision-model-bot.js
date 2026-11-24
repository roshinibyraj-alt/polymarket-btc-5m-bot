'use strict';

const config = require('./config');
const DipBounceBot = require('./dip-bounce-bot');
const BinanceTickFeed = require('./binance-tick-feed');
const {
  STRATEGY,
  round,
  directionalEstimate,
  buildQuestion,
} = require('./model-decision-engine');

const SIDES = ['UP', 'DOWN'];
const MAX_QUOTE_AGE_MS = 2500;
const EPSILON = 1e-8;
const BASE_STRATEGY_ID = DipBounceBot._test.STRATEGY.id;

function normalizeFeeRate(market) {
  if (market?.feesEnabled === false) return { rate: 0, source: 'market-fees-disabled' };
  const advertised = Number(market?.feeSchedule?.rate ?? market?.takerFeeRate);
  if (Number.isFinite(advertised) && advertised >= 0) {
    return { rate: advertised, source: 'market-metadata' };
  }
  return {
    rate: Number(config.CRYPTO_TAKER_FEE_RATE),
    source: 'configured-crypto-fallback',
  };
}

function sweep(levels, requestedShares, feeRate, direction, priceCap = 1) {
  let remaining = Math.max(0, Number(requestedShares) || 0);
  let notional = 0;
  let fees = 0;
  const fills = [];
  for (const level of levels || []) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!(price > 0 && price < 1) || !(size > 0)) continue;
    if (direction === 'BUY' && price > priceCap) break;
    const shares = Math.min(remaining, size);
    if (!(shares > 0)) continue;
    const fee = shares * feeRate * price * (1 - price);
    fills.push({ price, shares, fee });
    notional += shares * price;
    fees += fee;
    remaining -= shares;
    if (remaining <= EPSILON) break;
  }
  const filledShares = requestedShares - remaining;
  return {
    requestedShares,
    filledShares,
    remainingShares: Math.max(0, remaining),
    notional,
    fees,
    totalCost: direction === 'BUY' ? notional + fees : notional - fees,
    averagePrice: filledShares > 0 ? notional / filledShares : null,
    averageNetPrice: filledShares > 0
      ? (direction === 'BUY' ? notional + fees : notional - fees) / filledShares
      : null,
    complete: remaining <= EPSILON,
    fills,
  };
}

function quoteIsFresh(quote, now) {
  return Number.isFinite(Number(quote?.updatedAt))
    && Number.isFinite(Number(quote?.receivedAt))
    && now - Number(quote.updatedAt) <= MAX_QUOTE_AGE_MS
    && now - Number(quote.receivedAt) <= MAX_QUOTE_AGE_MS
    && Number(quote.bestAsk) > 0
    && Number(quote.bestBid) >= 0
    && Array.isArray(quote.asks)
    && Array.isArray(quote.bids);
}

function positionSideAverage(positions) {
  const shares = positions.reduce((sum, position) => sum + Number(position.shares || 0), 0);
  const cost = positions.reduce((sum, position) => sum + Number(position.totalCost || 0), 0);
  const entryFees = positions.reduce((sum, position) => sum + Number(position.fees || 0), 0);
  return {
    shares,
    cost,
    entryFees,
    averageCost: shares > 0 ? cost / shares : null,
    allInAverageCost: shares > 0 ? (cost + entryFees) / shares : null,
  };
}

function estimateProfitableFifoExit(positions, sellSweep) {
  if (!(sellSweep?.filledShares > 0)) return null;
  let sharesToAllocate = sellSweep.filledShares;
  let allocatedBasis = 0;
  for (const position of [...positions].sort((a, b) => Number(a.entryAt) - Number(b.entryAt))) {
    if (sharesToAllocate <= EPSILON) break;
    const shares = Number(position.shares || 0);
    if (!(shares > 0)) continue;
    const allocatedShares = Math.min(shares, sharesToAllocate);
    const ratio = allocatedShares / shares;
    allocatedBasis += (Number(position.totalCost || 0) + Number(position.fees || 0)) * ratio;
    sharesToAllocate -= allocatedShares;
  }
  return sellSweep.totalCost - allocatedBasis;
}

class DecisionModelBot extends DipBounceBot {
  constructor({
    marketData,
    now = Date.now,
    initialCapital = config.DEMO_CAPITAL,
    WebSocketImpl = globalThis.WebSocket,
    ledgerStore = null,
    binanceFeed = null,
  } = {}) {
    super({
      marketData,
      now,
      initialCapital,
      WebSocketImpl,
      ledgerStore,
      assets: ['BTC'],
      timeframes: ['5m'],
    });
    this.strategyId = STRATEGY.id;
    this.strategyName = STRATEGY.name;
    this.binanceFeed = binanceFeed || new BinanceTickFeed({
      now,
      WebSocketImpl,
      includeTradeFlow: false,
    });
    this.lastDecisionAt = null;
    this.lastDecisionWindowStart = null;
    this.latestReview = null;
    this.reviews = [];
    this.modelErrors = [];
  }

  start() {
    if (this.running) return;
    Promise.resolve(this.binanceFeed.start()).catch((error) => {
      this.modelErrors.unshift({ at: this.now(), message: error?.message || 'Binance feed failed to start.' });
      this.modelErrors = this.modelErrors.slice(0, 10);
    });
    super.start();
  }

  stop() {
    super.stop();
    this.binanceFeed.stop();
  }

  async tick(now = this.now()) {
    await super.tick(now);
    if (!this.running || this.status === 'ERROR') return;
    try {
      this.resetForWindowChange();
      this.evaluateOnSchedule(now);
      this.updateAccountMetrics(now);
    } catch (error) {
      this.status = 'ERROR';
      this.statusReason = error?.message || 'The decision model failed during evaluation.';
      this.log(this.statusReason, { asset: 'BTC', timeframe: '5m', outcome: 'bad', type: 'MODEL_ERROR', now });
      return;
    }
    if (this.binanceFeed.historyStatus !== 'READY') {
      this.status = 'WAITING_FOR_CANDLE_HISTORY';
      this.statusReason = 'Waiting for 6 closed 5m, 4 closed 15m, and 2 closed 1h BTC candles.';
    } else if (this.websocket.status === 'CONNECTED') {
      this.status = 'RUNNING';
      this.statusReason = 'BTC closed-candle model active; reviewing both sides every 15 seconds.';
    } else {
      this.status = 'WAITING_FOR_CLOB';
      this.statusReason = 'Candle context is ready; waiting for the Polymarket CLOB connection.';
    }
  }

  resetForWindowChange() {
    const record = this.records.get('BTC:5m');
    const currentStart = record?.targetStart ?? null;
    if (currentStart == null || currentStart === this.lastDecisionWindowStart) return;
    this.lastDecisionWindowStart = currentStart;
    this.lastDecisionAt = null;
  }

  evaluateOnSchedule(now) {
    const record = this.records.get('BTC:5m');
    const market = record?.market;
    if (!market || record.marketStatus !== 'OPEN') return;
    if (now < Number(market.start) || now >= Number(market.end)) return;
    if (this.lastDecisionAt != null && now - this.lastDecisionAt < STRATEGY.reviewIntervalMs) return;
    this.lastDecisionAt = now;
    this.lastDecisionWindowStart = Number(market.start);
    const review = this.evaluateDecision(record, now);
    this.latestReview = review;
    this.reviews.unshift(review);
    if (this.reviews.length > 100) this.reviews.length = 100;
    const executed = review.actions.length
      ? ` Actions: ${review.actions.map((action) => `${action.type} ${action.side}`).join(', ')}.`
      : ' No order was placed.';
    const probabilitySummary = review.probabilityUp == null || review.probabilityDown == null
      ? 'probability unavailable; waiting for required inputs'
      : `UP ${Math.round(review.probabilityUp * 100)}%, DOWN ${Math.round(review.probabilityDown * 100)}%`;
    this.log(
      `Model review ${new Date(now).toISOString()}: ${probabilitySummary}.${executed}`,
      {
        asset: 'BTC',
        timeframe: '5m',
        outcome: review.actions.length ? 'good' : 'neutral',
        type: 'MODEL_REVIEW',
        now,
      },
    );
    this.scheduleLedgerSave();
  }

  evaluateDecision(record, now) {
    const market = record.market;
    const reviewId = `review-${market.start}-${now}`;
    this.pendingReviewId = reviewId;
    const feed = this.binanceFeed.snapshot();
    const remainingSeconds = Math.max(0, (Number(market.end) - now) / 1000);
    const quotes = Object.fromEntries(SIDES.map((side) => [side, record.quotes[side]]));
    const quoteFresh = Object.fromEntries(SIDES.map((side) => [side, quoteIsFresh(quotes[side], now)]));
    const bothQuotesFresh = quoteFresh.UP && quoteFresh.DOWN;
    const candleSets = feed.candleSets || { '5m': feed.candles || [], '15m': [], '1h': [] };
    const currentCandle = feed.currentCandle;
    const candleCounts = Object.fromEntries(Object.keys(STRATEGY.candleLookbacks)
      .map((timeframe) => [timeframe, (candleSets[timeframe] || []).length]));
    const estimate = directionalEstimate({
      candleSets,
    });
    const dataReady = estimate.ready && bothQuotesFresh;
    const fee = normalizeFeeRate(market);
    const probabilities = {
      UP: estimate.probabilityUp,
      DOWN: estimate.probabilityDown,
    };
    const openPositions = Object.fromEntries(SIDES.map((side) => [
      side,
      this.positions.filter((position) =>
        position.marketId === String(market.id || market.slug)
        && position.side === side && position.status === 'OPEN'),
    ]));
    const candidates = {};
    const questions = {};
    const actions = [];
    const sharedReadyReasons = [];
    for (const [timeframe, required] of Object.entries(STRATEGY.candleLookbacks)) {
      if (candleCounts[timeframe] < required) {
        sharedReadyReasons.push(`Waiting for ${required} fully closed BTC ${timeframe} candles; ${candleCounts[timeframe]} are ready.`);
      }
    }
    if (!bothQuotesFresh) sharedReadyReasons.push('Both Polymarket CLOB books are not fresh enough for a decision.');
    if (remainingSeconds <= STRATEGY.minimumTimeRemainingSeconds) {
      sharedReadyReasons.push('The window has 15 seconds or less remaining; no new entry is started this late.');
    }

    for (const side of SIDES) {
      const quote = quotes[side];
      const sideReady = dataReady && quoteFresh[side]
        && remainingSeconds > STRATEGY.minimumTimeRemainingSeconds;
      const buySweep = quoteFresh[side]
        ? sweep(quote.asks, STRATEGY.sharesPerBuyDecision, fee.rate, 'BUY', STRATEGY.maximumBuyPrice)
        : null;
      const edge = buySweep?.complete
        ? probabilities[side] - buySweep.averageNetPrice
        : null;
      const candidate = {
        side,
        estimatedProbability: probabilities[side],
        bestAsk: Number.isFinite(Number(quote?.bestAsk)) ? Number(quote.bestAsk) : null,
        bestBid: Number.isFinite(Number(quote?.bestBid)) ? Number(quote.bestBid) : null,
        expectedAverageEntry: buySweep?.averagePrice ?? null,
        expectedAverageAllInCost: buySweep?.averageNetPrice ?? null,
        netEdgePerShare: edge,
        feeRate: fee.rate,
        feeSource: fee.source,
        fullSizeVisible: Boolean(buySweep?.complete),
        sweep: buySweep,
      };
      candidates[side] = candidate;

      const currentPositions = openPositions[side];
      const aggregate = positionSideAverage(currentPositions);
      const sellSweep = aggregate.shares > 0 && quoteFresh[side]
        ? sweep(quote.bids, aggregate.shares, fee.rate, 'SELL', 1)
        : null;
      const liquidationValue = sellSweep?.filledShares > 0
        ? sellSweep.totalCost / sellSweep.filledShares
        : null;
      const sellEdge = liquidationValue == null
        ? null
        : probabilities[side] - liquidationValue;
      const sellProfit = sellSweep?.filledShares > 0
        ? estimateProfitableFifoExit(currentPositions, sellSweep)
        : null;
      const modelPrefersExit = aggregate.shares > 0
        && sellEdge != null
        && sellEdge <= -STRATEGY.exitAdvantagePerShare;
      const canExecuteSell = Boolean(sellSweep?.filledShares > 0);
      const profitableExit = sellProfit != null && sellProfit > EPSILON;
      const sellNow = modelPrefersExit && profitableExit && canExecuteSell;
      const buyQualifies = sideReady
        && candidate.fullSizeVisible
        && candidate.estimatedProbability >= STRATEGY.minimumProbability
        && candidate.netEdgePerShare >= STRATEGY.minimumNetEdgePerShare
        && this.availableCash() + EPSILON >= (buySweep?.totalCost || Infinity)
        && !sellNow;

      questions[`buy${side}`] = buildQuestion(
        `Why should I buy ${side}?`,
        buyQualifies ? 'YES' : 'NO',
        buyQualifies
          ? `Estimated ${side} probability is ${(candidate.estimatedProbability * 100).toFixed(1)}%; the full ${STRATEGY.sharesPerBuyDecision}-share ask sweep leaves $${candidate.netEdgePerShare.toFixed(3)} net edge per share after modeled fees.`
          : this.buyNoReason({ side, sideReady, candidate, sharedReadyReasons, buySweep, fee, now, sellNow }),
        {
          probability: candidate.estimatedProbability,
          edge: candidate.netEdgePerShare,
          requestedShares: STRATEGY.sharesPerBuyDecision,
        },
      );
      questions[`avoid${side}`] = buildQuestion(
        `Why should I not buy ${side}?`,
        buyQualifies ? 'NO' : 'YES',
        buyQualifies
          ? 'No current veto: feed readiness, full-size depth, confidence, net edge, and paper collateral all pass.'
          : questions[`buy${side}`].reason,
      );
      questions[`hold${side}`] = buildQuestion(
        `Why should I hold ${side}?`,
        (currentPositions.length > 0 && !sellNow) || buyQualifies ? 'YES' : 'NO',
        currentPositions.length === 0
          ? buyQualifies
            ? `After this 50-share buy, keep the ${side} position until the model finds a better exit or the window resolves.`
            : `There is no open ${side} position to hold.`
          : sellNow
            ? `Do not hold: modeled ${side} probability is ${(probabilities[side] * 100).toFixed(1)}%, below the estimated net bid liquidation value by $${Math.abs(sellEdge).toFixed(3)} per share.`
            : modelPrefersExit && !profitableExit
              ? `Hold the ${side} position: selling now would realize an estimated net loss of $${Math.abs(sellProfit || 0).toFixed(2)}. The opposite side can still enter independently.`
            : `Keep ${aggregate.shares.toFixed(2)} ${side} shares open; the model has not found a sufficiently better net value in selling now. Any unsold shares go to official resolution at window end.`,
        {
          openShares: aggregate.shares,
          averageCost: aggregate.allInAverageCost,
          estimatedNetBidValue: liquidationValue,
          probability: probabilities[side],
        },
      );
      questions[`sell${side}`] = buildQuestion(
        `Why should I sell ${side} now?`,
        sellNow ? 'YES' : 'NO',
        currentPositions.length === 0
          ? `No open ${side} shares exist.`
          : modelPrefersExit && !profitableExit
            ? `The directional model favors exiting, but a bid sweep would realize an estimated net loss of $${Math.abs(sellProfit || 0).toFixed(2)}. Hold this side; an opposite-side buy is still allowed.`
          : modelPrefersExit && !canExecuteSell
            ? 'The model prefers exiting, but the current bid book has no executable shares; the position remains open and is reviewed again.'
            : sellNow
              ? `A visible-bid sweep can exit now at an estimated net profit of $${sellProfit.toFixed(2)}; the model also values the ${side} shares below their net liquidation value by $${Math.abs(sellEdge).toFixed(3)} per share.`
              : `Hold to the next 15-second review or window resolution; the model does not see a profitable exit with a $${STRATEGY.exitAdvantagePerShare.toFixed(2)}-per-share advantage.`,
        {
          openShares: aggregate.shares,
          estimatedNetBidValue: liquidationValue,
          probability: probabilities[side],
          modelVsBid: sellEdge,
          estimatedNetExitProfit: sellProfit,
          profitableExit,
        },
      );

      if (sellNow) {
        const order = this.sellPositions(record, side, sellSweep, now, candidate, sellEdge);
        if (order?.filledShares > 0) actions.push({ type: 'SELL', side, orderId: order.id, shares: order.filledShares });
      } else if (buyQualifies) {
        const order = this.buyPosition(record, side, buySweep, now, candidate);
        if (order?.filledShares > 0) actions.push({ type: 'BUY', side, orderId: order.id, shares: order.filledShares });
      }
    }

    return {
      id: reviewId,
      at: now,
      windowStart: Number(market.start),
      windowEnd: Number(market.end),
      secondsRemaining: round(remainingSeconds, 1),
      probabilityUp: estimate.probabilityUp,
      probabilityDown: estimate.probabilityDown,
      combinedScore: estimate.combinedScore,
      estimate: {
        method: 'Uncalibrated directional score from fully closed Binance candle OHLC only: six 5m candles, four 15m candles, and two 1h candles, weighted 65% / 25% / 10%. CLOB prices are used for execution and position value, not directional pressure.',
        components: estimate.components,
        timeframes: estimate.timeframes,
        candleCounts,
        feeRate: fee.rate,
        feeSource: fee.source,
      },
      data: {
        ready: dataReady,
        reasons: sharedReadyReasons,
        binance: {
          status: feed.status,
          price: feed.price,
          tickAt: feed.tickAt,
          tickAgeMs: feed.tickAgeMs,
          currentCandleStart: currentCandle?.start ?? null,
          historyStatus: feed.historyStatus,
          candleCounts,
        },
        clob: {
          status: this.websocket.status,
          upFresh: quoteFresh.UP,
          downFresh: quoteFresh.DOWN,
          upAgeMs: quoteAgeMs(quotes.UP, now),
          downAgeMs: quoteAgeMs(quotes.DOWN, now),
        },
      },
      sides: candidates,
      questions,
      actions,
    };
  }

  processSide() {}

  buyNoReason({ side, sideReady, candidate, sharedReadyReasons, buySweep, fee, now, sellNow }) {
    if (sellNow) return `The model is selling the existing ${side} position; it will not add to that side in the same review.`;
    if (!sideReady) {
      return sharedReadyReasons[0] || `The live inputs for ${side} are not ready.`;
    }
    if (!candidate.fullSizeVisible) {
      return `The current asks cannot fill all 50 shares at or below $${STRATEGY.maximumBuyPrice.toFixed(2)}; the engine does not invent a full fill.`;
    }
    if (candidate.estimatedProbability < STRATEGY.minimumProbability) {
      return `Estimated probability ${(candidate.estimatedProbability * 100).toFixed(1)}% is below the ${(STRATEGY.minimumProbability * 100).toFixed(0)}% direction threshold.`;
    }
    if (candidate.netEdgePerShare < STRATEGY.minimumNetEdgePerShare) {
      return `Estimated net edge $${candidate.netEdgePerShare.toFixed(3)} per share is below the required $${STRATEGY.minimumNetEdgePerShare.toFixed(2)} after fees.`;
    }
    if (this.availableCash() + EPSILON < (buySweep?.totalCost || Infinity)) {
      return 'Available paper cash cannot cover the full 50-share order and modeled fees.';
    }
    return `The ${side} buy conditions did not all pass (fee source: ${fee.source}; reviewed ${new Date(now).toISOString()}).`;
  }

  buyPosition(record, side, result, now, candidate) {
    if (!result?.filledShares) return null;
    const cost = result.notional;
    const totalCost = cost + result.fees;
    if (this.availableCash() + EPSILON < totalCost) return null;
    const market = record.market;
    const order = {
      id: `model-order-${++this.orderSequence}`,
      decisionId: this.pendingReviewId || null,
      marketId: String(market.id || market.slug),
      marketSlug: market.slug,
      marketTitle: market.title,
      asset: 'BTC',
      timeframe: '5m',
      windowStart: Number(market.start),
      windowEnd: Number(market.end),
      side,
      action: 'BUY_TAKER',
      status: result.complete ? 'FILLED' : 'PARTIALLY_FILLED',
      requestedShares: result.requestedShares,
      filledShares: result.filledShares,
      unfilledShares: result.remainingShares,
      placedAt: now,
      filledAt: now,
      fillPrice: result.averagePrice,
      cost,
      fees: result.fees,
      feeRate: candidate.feeRate,
      feeSource: candidate.feeSource,
      fills: result.fills,
      fillRule: `Sweep current visible asks up to $${STRATEGY.maximumBuyPrice.toFixed(2)}; record only displayed depth.`,
      modelProbability: candidate.estimatedProbability,
      estimatedNetEdgePerShare: candidate.netEdgePerShare,
    };
    this.orders.unshift(order);
    this.cash -= totalCost;
    const position = {
      id: `model-position-${++this.positionSequence}`,
      orderId: order.id,
      decisionId: order.decisionId,
      marketId: order.marketId,
      marketSlug: order.marketSlug,
      marketTitle: order.marketTitle,
      asset: 'BTC',
      timeframe: '5m',
      side,
      status: 'OPEN',
      shares: result.filledShares,
      requestedShares: result.requestedShares,
      entryPrice: result.averagePrice,
      totalCost: cost,
      fees: result.fees,
      totalEntryFees: result.fees,
      exitFees: 0,
      soldShares: 0,
      resolvedShares: 0,
      closedShares: 0,
      exitProceeds: 0,
      estimatedMakerRebate: 0,
      entryAt: now,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      markBid: Number.isFinite(Number(record.quotes[side].bestBid))
        ? Number(record.quotes[side].bestBid) : null,
      markUpdatedAt: record.quotes[side].updatedAt,
      markStatus: 'LIVE',
      unrealizedPnl: Number.isFinite(Number(record.quotes[side].bestBid))
        ? Number(record.quotes[side].bestBid) * result.filledShares - cost - result.fees
        : null,
      realizedPnl: null,
      partialRealizedPnl: 0,
      exitPrice: null,
      exitPayout: null,
      exitReason: null,
      modelProbabilityAtEntry: candidate.estimatedProbability,
      estimatedNetEdgePerShare: candidate.netEdgePerShare,
      feeSource: candidate.feeSource,
    };
    this.positions.unshift(position);
    this.log(
      `${side} model buy: ${result.filledShares.toFixed(2)} shares at $${result.averagePrice.toFixed(4)} average; all-in edge $${candidate.netEdgePerShare.toFixed(3)}/share.`,
      { asset: 'BTC', timeframe: '5m', side, outcome: 'good', type: 'MODEL_BUY', now },
    );
    this.updateAccountMetrics(now, true);
    return order;
  }

  sellPositions(record, side, result, now, candidate, sellEdge) {
    if (!result?.filledShares) return null;
    const marketId = String(record.market.id || record.market.slug);
    const positions = this.positions
      .filter((position) => position.marketId === marketId && position.side === side && position.status === 'OPEN')
      .sort((a, b) => Number(a.entryAt) - Number(b.entryAt));
    const filledShares = Math.min(result.filledShares, positions.reduce(
      (sum, position) => sum + Number(position.shares || 0), 0,
    ));
    if (!(filledShares > 0)) return null;
    const fillRatio = filledShares / result.filledShares;
    const grossProceeds = result.notional * fillRatio;
    const exitFees = result.fees * fillRatio;
    const order = {
      id: `model-order-${++this.orderSequence}`,
      decisionId: this.pendingReviewId || null,
      marketId,
      marketSlug: record.market.slug,
      marketTitle: record.market.title,
      asset: 'BTC',
      timeframe: '5m',
      windowStart: Number(record.market.start),
      windowEnd: Number(record.market.end),
      side,
      action: 'SELL_TAKER',
      status: filledShares + EPSILON >= result.requestedShares ? 'FILLED' : 'PARTIALLY_FILLED',
      requestedShares: result.requestedShares,
      filledShares,
      unfilledShares: Math.max(0, result.requestedShares - filledShares),
      placedAt: now,
      filledAt: now,
      fillPrice: result.notional / result.filledShares,
      proceeds: grossProceeds,
      fees: exitFees,
      feeRate: candidate.feeRate,
      feeSource: candidate.feeSource,
      fills: result.fills.map((fill) => ({ ...fill, shares: fill.shares * fillRatio, fee: fill.fee * fillRatio })),
      fillRule: 'Sweep current visible bids; any unavailable shares remain open for the next model review or resolution.',
      modelProbability: candidate.estimatedProbability,
      modelVsNetBidPerShare: sellEdge,
    };
    this.orders.unshift(order);
    this.cash += grossProceeds - exitFees;

    let leftToAllocate = filledShares;
    let realizedTotal = 0;
    for (const position of positions) {
      if (leftToAllocate <= EPSILON) break;
      const beforeShares = Number(position.shares);
      const soldShares = Math.min(beforeShares, leftToAllocate);
      const ratio = soldShares / beforeShares;
      const releasedCost = Number(position.totalCost || 0) * ratio;
      const releasedEntryFees = Number(position.fees || 0) * ratio;
      const proceeds = grossProceeds * (soldShares / filledShares);
      const allocatedExitFees = exitFees * (soldShares / filledShares);
      const realized = proceeds - allocatedExitFees - releasedCost - releasedEntryFees;

      realizedTotal += realized;
      position.partialRealizedPnl = Number(position.partialRealizedPnl || 0) + realized;
      position.soldShares = Number(position.soldShares || 0) + soldShares;
      position.exitProceeds = Number(position.exitProceeds || 0) + proceeds;
      position.exitFees = Number(position.exitFees || 0) + allocatedExitFees;
      position.totalCost = Math.max(0, Number(position.totalCost || 0) - releasedCost);
      position.fees = Math.max(0, Number(position.fees || 0) - releasedEntryFees);
      position.shares = Math.max(0, beforeShares - soldShares);
      position.exitAt = now;
      position.exitPrice = Number(position.exitProceeds) / Number(position.soldShares);
      position.exitReason = position.shares <= EPSILON ? 'MODEL_VALUE_REVERSAL' : 'MODEL_PARTIAL_VALUE_REVERSAL';
      position.markUpdatedAt = record.quotes[side].updatedAt;
      position.markStatus = position.shares <= EPSILON ? 'CLOSED' : 'LIVE';
      position.unrealizedPnl = position.shares > EPSILON
        ? (Number(record.quotes[side].bestBid) || 0) * position.shares
          - position.totalCost - position.fees
        : null;
      if (position.shares <= EPSILON) {
        position.status = 'MODEL_SOLD';
        position.realizedPnl = position.partialRealizedPnl;
      }
      leftToAllocate -= soldShares;
    }
    this.log(
      `${side} model exit: sold ${filledShares.toFixed(2)} shares at $${order.fillPrice.toFixed(4)} average; net realized ${realizedTotal >= 0 ? 'profit' : 'loss'} $${Math.abs(realizedTotal).toFixed(2)} after fees.`,
      {
        asset: 'BTC',
        timeframe: '5m',
        side,
        outcome: realizedTotal >= 0 ? 'good' : 'bad',
        type: 'MODEL_SELL',
        now,
      },
    );
    this.markPositions(now);
    this.updateAccountMetrics(now, true);
    return order;
  }

  checkTakeProfits() {}

  checkStopLosses() {}

  settleMarket(marketId, winner, now) {
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'PENDING_RESOLUTION') continue;
      const won = position.side === winner;
      const payout = won ? position.shares : 0;
      const remainingShares = Number(position.shares || 0);
      this.cash += payout;
      position.status = won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
      position.resolvedAt = now;
      position.resolutionWinner = winner;
      position.resolvedShares = remainingShares;
      position.exitPayout = won ? 1 : 0;
      position.exitProceeds = Number(position.exitProceeds || 0) + payout;
      position.closedShares = Number(position.soldShares || 0) + remainingShares;
      position.exitPrice = position.closedShares > EPSILON
        ? position.exitProceeds / position.closedShares
        : won ? 1 : 0;
      position.exitReason = Number(position.soldShares || 0) > EPSILON
        ? 'MODEL_EXIT_AND_OFFICIAL_RESOLUTION'
        : 'OFFICIAL_RESOLUTION';
      position.closedAt = now;
      position.realizedPnl = Number(position.partialRealizedPnl || 0)
        + payout - position.totalCost - position.fees + Number(position.estimatedMakerRebate || 0);
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      this.log(`${position.side} resolved ${won ? 'WIN' : 'LOSS'}; official result settled the remaining shares.`, {
        asset: 'BTC',
        timeframe: '5m',
        side: position.side,
        outcome: won ? 'good' : 'bad',
        type: 'RESOLUTION',
        now,
      });
    }
    this.updateAccountMetrics(now, true);
  }

  accountSnapshot() {
    const account = super.accountSnapshot();
    const partialRealized = this.positions
      .filter((position) => ['OPEN', 'PENDING_RESOLUTION'].includes(position.status))
      .reduce((sum, position) => sum + Number(position.partialRealizedPnl || 0), 0);
    return {
      ...account,
      realizedPnl: round(account.realizedPnl + partialRealized, 4),
      partialRealizedPnl: round(partialRealized, 4),
      totalFees: round(this.positions.reduce((sum, position) =>
        sum + Number(position.totalEntryFees ?? position.fees ?? 0)
          + Number(position.exitFees || 0), 0), 4),
    };
  }

  restoreLedger(ledger) {
    const originalSnapshot = ledger?.snapshot || ledger;
    if (!originalSnapshot || originalSnapshot.strategy?.id !== STRATEGY.id) {
      throw new Error('Saved paper ledger is invalid or belongs to another strategy.');
    }
    const compatible = ledger?.snapshot
      ? {
        ...ledger,
        strategyId: BASE_STRATEGY_ID,
        snapshot: {
          ...originalSnapshot,
          strategy: { ...originalSnapshot.strategy, id: BASE_STRATEGY_ID },
        },
      }
      : {
        ...originalSnapshot,
        strategy: { ...originalSnapshot.strategy, id: BASE_STRATEGY_ID },
      };
    super.restoreLedger(compatible);
    const savedModel = originalSnapshot.modelEngine || {};
    this.lastDecisionAt = Number.isFinite(Number(savedModel.lastDecisionAt))
      ? Number(savedModel.lastDecisionAt) : null;
    this.lastDecisionWindowStart = Number.isFinite(Number(savedModel.lastDecisionWindowStart))
      ? Number(savedModel.lastDecisionWindowStart) : null;
    this.reviews = Array.isArray(savedModel.reviews) ? savedModel.reviews.slice(0, 100) : [];
    this.latestReview = this.reviews[0] || null;
    this.strategyId = STRATEGY.id;
    this.strategyName = STRATEGY.name;
  }

  exportLedger() {
    const snapshot = this.snapshot();
    snapshot.positions = this.positions.map((position) => ({ ...position }));
    snapshot.orders = this.orders.map((order) => ({ ...order }));
    snapshot.events = this.events.map((event) => ({ ...event }));
    snapshot.modelEngine = {
      lastDecisionAt: this.lastDecisionAt,
      lastDecisionWindowStart: this.lastDecisionWindowStart,
      reviews: this.reviews.slice(0, 100),
    };
    return {
      schemaVersion: 1,
      strategyId: STRATEGY.id,
      savedAt: this.now(),
      snapshot,
    };
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const record = this.records.get('BTC:5m');
    const market = record?.market;
    const currentReview = this.reviews.find((review) =>
      Number(review.windowStart) === Number(market?.start)) || null;
    const feed = this.binanceFeed.snapshot();
    const candleEstimate = directionalEstimate({ candleSets: feed.candleSets || {} });
    const positions = this.positions
      .filter((position) => position.marketId === String(market?.id || market?.slug)
        && ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
    const sidePositions = Object.fromEntries(SIDES.map((side) => {
      const sidePositions = positions.filter((position) => position.side === side);
      const aggregate = positionSideAverage(sidePositions);
      const unrealizedPnl = sidePositions
        .filter((position) => position.status === 'OPEN' && Number.isFinite(Number(position.unrealizedPnl)))
        .reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
      return [side, {
        shares: round(aggregate.shares, 4),
        averageCost: aggregate.averageCost == null ? null : round(aggregate.averageCost, 4),
        allInAverageCost: aggregate.allInAverageCost == null ? null : round(aggregate.allInAverageCost, 4),
        totalCost: round(aggregate.cost, 4),
        entryFees: round(aggregate.entryFees, 4),
        unrealizedPnl: round(unrealizedPnl, 4),
        openPositionCount: sidePositions.length,
        positions: sidePositions.map((position) => ({ ...position })),
      }];
    }));
    const lastReviewAt = currentReview?.at ?? null;
    state.mode = 'PAPER ONLY';
    state.status = this.status;
    state.statusReason = this.statusReason;
    state.strategy = {
      ...STRATEGY,
      summary: 'At each 15-second review, estimate the next BTC 5-minute outcome from fully closed 5m, 15m, and 1h candle OHLC. CLOB prices are for execution and position valuation only; no trade pressure or volume signal is used.',
      execution: 'PAPER ONLY — no real orders or wallet signing.',
      entry: 'A qualifying side receives a 50-share visible-ask sweep (up to $0.99) at each review; only displayed depth is simulated and taker fees are included.',
      exit: 'Never sell a side at an estimated net loss. Sell only when the directional model favors exiting and the visible-bid sweep is profitable after fees. A losing side remains open while the opposite side may enter independently; unsold shares go to official resolution at window end.',
      decisions: 'The model records eight explicit answers per review: buy / avoid / hold / sell for UP and DOWN.',
      probability: 'Experimental, uncalibrated directional estimate; not a guarantee or proven predictive edge.',
    };
    state.scanner = {
      ...state.scanner,
      assets: ['BTC'],
      timeframes: ['5m'],
      totalMarkets: 1,
      marketData: 'BTC fully closed 5m, 15m, and 1h Binance candles drive direction. Polymarket CLOB UP/DOWN prices are used for execution and position valuation only.',
    };
    state.markets = state.markets
      .filter((item) => item.asset === 'BTC' && item.timeframe === '5m')
      .map((item) => ({
        ...item,
        triggeredSide: null,
        sideStates: Object.fromEntries(SIDES.map((side) => {
          const quote = item.sideStates?.[side] || {};
          return [side, {
            bestBid: quote.bestBid ?? null,
            bestAsk: quote.bestAsk ?? null,
            mid: quote.mid ?? null,
            updatedAt: quote.updatedAt ?? null,
            ageMs: quote.ageMs ?? null,
            fresh: Boolean(quote.fresh),
          }];
        })),
      }));
    state.account = this.accountSnapshot();
    state.modelEngine = {
      status: feed.historyStatus === 'READY' ? 'READY' : feed.status,
      tickStreamStatus: feed.status,
      error: feed.error,
      historyStatus: feed.historyStatus,
      reconnectCount: feed.reconnectCount,
      price: feed.price,
      tickAt: feed.tickAt,
      tickAgeMs: feed.tickAgeMs,
      currentCandle: feed.currentCandle,
      closedCandles: feed.candles,
      candleSets: feed.candleSets,
      candleCounts: feed.candleCounts,
      candleLookbacks: STRATEGY.candleLookbacks,
      candleWeights: STRATEGY.candleWeights,
      candleContexts: candleEstimate.timeframes,
      reviewIntervalMs: STRATEGY.reviewIntervalMs,
      nextReviewAt: lastReviewAt == null
        ? (market?.start ?? null)
        : lastReviewAt + STRATEGY.reviewIntervalMs,
      latestReview: currentReview,
      recentReviews: this.reviews.slice(0, 30),
      sides: sidePositions,
      tradeHistory: this.positions
        .filter((position) => ['MODEL_SOLD', 'RESOLVED_WIN', 'RESOLVED_LOSS'].includes(position.status))
        .sort((a, b) => Number(b.closedAt || b.resolvedAt || b.exitAt || 0) - Number(a.closedAt || a.resolvedAt || a.exitAt || 0))
        .slice(0, 30)
        .map((position) => ({
          id: position.id,
          side: position.side,
          status: position.status,
          result: Number(position.realizedPnl) >= 0 ? 'WIN' : 'LOSS',
          shares: Number(position.closedShares || position.soldShares || position.requestedShares || 0),
          entryPrice: position.entryPrice,
          exitPrice: position.exitPrice,
          realizedPnl: position.realizedPnl,
          entryFees: position.totalEntryFees ?? position.fees,
          exitFees: position.exitFees || 0,
          entryAt: position.entryAt,
          exitAt: position.closedAt || position.resolvedAt || position.exitAt,
          exitReason: position.exitReason,
        })),
      rules: {
        sharesPerBuyDecision: STRATEGY.sharesPerBuyDecision,
        minimumProbability: STRATEGY.minimumProbability,
        minimumNetEdgePerShare: STRATEGY.minimumNetEdgePerShare,
        exitAdvantagePerShare: STRATEGY.exitAdvantagePerShare,
        maximumBuyPrice: STRATEGY.maximumBuyPrice,
        minimumTimeRemainingSeconds: STRATEGY.minimumTimeRemainingSeconds,
      },
    };
    state.sizingByAsset = undefined;
    return state;
  }

}

function quoteAgeMs(quote, now) {
  const timestamp = Number.isFinite(Number(quote?.updatedAt))
    ? Math.min(Number(quote.updatedAt), Number(quote.receivedAt) || Number(quote.updatedAt))
    : null;
  return timestamp == null ? null : Math.max(0, now - timestamp);
}

DecisionModelBot.STRATEGY = STRATEGY;
DecisionModelBot._test = {
  normalizeFeeRate,
  sweep,
  quoteIsFresh,
  positionSideAverage,
  quoteAgeMs,
};

module.exports = DecisionModelBot;
