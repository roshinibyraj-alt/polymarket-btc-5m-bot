'use strict';

const config = require('./config');
const DipBounceBot = require('./dip-bounce-bot');
const BinanceMinuteFeed = require('./binance-minute-feed');
const {
  STRATEGY,
  candleColor,
  classifyMinuteEntry,
  isEntryAskWithinBand,
} = require('./minute-candle-strategy');

const SIDES = ['UP', 'DOWN'];
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

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
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
  const filledShares = Math.max(0, Number(requestedShares) - remaining);
  return {
    requestedShares: Number(requestedShares),
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
    && now - Number(quote.updatedAt) <= STRATEGY.maximumQuoteAgeMs
    && now - Number(quote.receivedAt) <= STRATEGY.maximumQuoteAgeMs
    && Number(quote.bestAsk) > 0
    && Number(quote.bestBid) >= 0
    && Array.isArray(quote.asks)
    && Array.isArray(quote.bids);
}

function midpointIsFresh(quote, now) {
  return Number.isFinite(Number(quote?.updatedAt))
    && Number.isFinite(Number(quote?.receivedAt))
    && now - Number(quote.updatedAt) <= STRATEGY.maximumQuoteAgeMs
    && now - Number(quote.receivedAt) <= STRATEGY.maximumQuoteAgeMs
    && quote?.mid != null
    && Number.isFinite(Number(quote.mid));
}

function positionSideAverage(positions) {
  const shares = positions.reduce((sum, position) => sum + Number(position.shares || 0), 0);
  const cost = positions.reduce((sum, position) => sum + Number(position.totalCost || 0), 0);
  const fees = positions.reduce((sum, position) => sum + Number(position.fees || 0), 0);
  return {
    shares,
    cost,
    fees,
    averageCost: shares > 0 ? cost / shares : null,
    allInAverageCost: shares > 0 ? (cost + fees) / shares : null,
  };
}

class MinuteColorBot extends DipBounceBot {
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
    this.binanceFeed = binanceFeed || new BinanceMinuteFeed({ now, WebSocketImpl });
    this.processedCandleKeys = new Set();
    this.pendingSignals = [];
    this.entryTakenCandleKeys = new Set();
    this.latestReview = null;
    this.reviews = [];
  }

  start() {
    if (this.running) return;
    Promise.resolve(this.binanceFeed.start()).catch((error) => {
      this.status = 'WAITING_FOR_BINANCE';
      this.statusReason = error?.message || 'Could not start the Binance one-minute feed.';
      this.log(this.statusReason, { asset: 'BTC', timeframe: '5m', type: 'BINANCE_FEED_ERROR' });
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
      this.processClosedCandles(now);
      this.updateAccountMetrics(now);
    } catch (error) {
      this.status = 'ERROR';
      this.statusReason = error?.message || 'The one-minute color strategy failed during evaluation.';
      this.log(this.statusReason, { asset: 'BTC', timeframe: '5m', outcome: 'bad', type: 'STRATEGY_ERROR', now });
      return;
    }

    const feed = this.binanceFeed.snapshot();
    const binanceReady = feed.status === 'CONNECTED'
      && feed.messageAgeMs != null
      && Number.isFinite(Number(feed.messageAgeMs))
      && Number(feed.messageAgeMs) <= STRATEGY.maximumSignalDelayMs;
    if (!binanceReady) {
      this.status = 'WAITING_FOR_BINANCE';
      this.statusReason = 'Waiting for a fresh Binance BTC one-minute WebSocket update; no alternate price feed is used.';
    } else if (this.websocket.status !== 'CONNECTED') {
      this.status = 'WAITING_FOR_CLOB';
      this.statusReason = 'Binance one-minute candles are live; waiting for Polymarket CLOB quotes to execute signals.';
    } else {
      this.status = 'RUNNING';
      this.statusReason = 'Using each previous closed BTC one-minute candle to trigger one buy at the next minute start; candle signals do not sell positions.';
    }
  }

  processSide() {}

  checkTakeProfits(record, side, quote, now) {
    if (!record?.market || record.marketStatus !== 'OPEN' || !midpointIsFresh(quote, now)) return;
    if (Number(quote.mid) < STRATEGY.takeProfitMid) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.side !== side || position.status !== 'OPEN') continue;
      const netResult = Number(position.partialRealizedPnl || 0)
        + Number(position.shares || 0)
          - Number(position.totalCost || 0)
          - Number(position.fees || 0);
      if (netResult < -EPSILON) {
        this.log(
          `${side} reached the $0.99 midpoint TP, but closing would still realize a net loss after fees; keeping it open.`,
          { asset: 'BTC', timeframe: '5m', side, outcome: 'neutral', type: 'TAKE_PROFIT_HELD_LOSS', now },
        );
        continue;
      }
      this.closePositionAtTrigger(position, {
        status: 'TAKE_PROFIT',
        exitPrice: STRATEGY.takeProfitMid,
        payoutPerShare: 1,
        exitReason: 'TAKE_PROFIT_MID_099',
        message: `${side} take-profit hit at a $0.99 midpoint; credited $1.00 per share.`,
        outcome: 'good',
        eventType: 'TAKE_PROFIT',
      }, quote, now);
    }
  }

  checkStopLosses(record, side, quote, now) {
    // Losing positions are held for a later profitable exit or official resolution.
  }

  closePositionAtTrigger(position, trigger, quote, now) {
    const shares = Number(position.shares || 0);
    const payout = shares * trigger.payoutPerShare;
    this.cash += payout;
    position.status = trigger.status;
    position.exitAt = now;
    position.exitPrice = trigger.exitPrice;
    position.exitPayout = trigger.payoutPerShare;
    position.exitProceeds = payout;
    position.exitReason = trigger.exitReason;
    position.closedAt = now;
    position.closedShares = shares;
    position.realizedPnl = Number(position.partialRealizedPnl || 0)
      + payout - Number(position.totalCost || 0) - Number(position.fees || 0);
    position.markBid = Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null;
    position.markUpdatedAt = quote.updatedAt;
    position.markStatus = 'CLOSED';
    position.unrealizedPnl = null;
    const record = this.records.get(`${position.asset}:${position.timeframe}`);
    const sideState = record?.sideStates?.[position.side];
    if (sideState) {
      sideState.orderStatus = trigger.status;
      sideState.reason = trigger.message;
    }
    this.log(trigger.message, {
      asset: 'BTC',
      timeframe: '5m',
      side: position.side,
      outcome: position.realizedPnl >= 0 ? 'good' : trigger.outcome,
      type: trigger.eventType,
      now,
    });
    this.updateAccountMetrics(now, true);
  }

  processClosedCandles(now) {
    const record = this.records.get('BTC:5m');
    const market = record?.market;
    if (!market || record.marketStatus !== 'OPEN' || now < Number(market.start) || now >= Number(market.end)) {
      this.processPendingSignals(now);
      return;
    }

    const feed = this.binanceFeed.snapshot();
    const closedCandles = [...(feed.closedCandles || [])]
      .filter((candle) => Number.isFinite(Number(candle.start)) && Number.isFinite(Number(candle.closeAt)))
      .sort((a, b) => Number(a.start) - Number(b.start));
    const start = Number(market.start);
    const end = Number(market.end);
    const elapsed = now - start;
    const candleNumber = Math.floor(elapsed / STRATEGY.candleIntervalMs) + 1;
    if (candleNumber < STRATEGY.firstSignalCandle || candleNumber > STRATEGY.lastSignalCandle) {
      this.processPendingSignals(now);
      return;
    }
    const targetCandleStart = start + (candleNumber - 1) * STRATEGY.candleIntervalMs;
    const key = `${start}:${targetCandleStart}`;
    if (this.processedCandleKeys.has(key)) {
      this.processPendingSignals(now);
      return;
    }

    const previousCandle = closedCandles.find((item) =>
      Number(item.start) === targetCandleStart - STRATEGY.candleIntervalMs);
    const transition = classifyMinuteEntry({
      previousCandle,
      targetCandleStart,
      windowStart: start,
    });
    const signalDelayMs = Math.max(0, now - targetCandleStart);
    const feedFresh = feed.status === 'CONNECTED'
      && feed.messageAgeMs != null
      && Number.isFinite(Number(feed.messageAgeMs))
      && Number(feed.messageAgeMs) <= STRATEGY.maximumSignalDelayMs;
    const referenceIsFresh = previousCandle?.source === 'BINANCE_1M_WEBSOCKET'
      && previousCandle?.closed !== false
      && Number.isFinite(Number(previousCandle?.closeAt))
      && Number(previousCandle.closeAt) <= targetCandleStart;

    // Give the Binance kline stream up to the normal signal-latency budget to
    // deliver the candle that just closed at this minute boundary.
    if ((!referenceIsFresh || !feedFresh) && signalDelayMs <= STRATEGY.maximumSignalDelayMs) {
      this.processPendingSignals(now);
      return;
    }
    this.processedCandleKeys.add(key);

    const currentCandle = feed.currentCandle
      && Number(feed.currentCandle.start) === targetCandleStart
      ? feed.currentCandle
      : null;
    const review = {
      id: `minute-review-${start}-${targetCandleStart}`,
      at: now,
      windowStart: start,
      windowEnd: end,
      candleNumber: transition.candleNumber,
      targetCandleStart,
      candle: currentCandle ? { ...currentCandle, color: candleColor(currentCandle) } : null,
      previousCandle: previousCandle
        ? { ...previousCandle, color: transition.referenceColor }
        : null,
      referenceColor: transition.referenceColor,
      currentColor: currentCandle ? candleColor(currentCandle) : null,
      previousColor: transition.referenceColor,
      signalSide: transition.side,
      signalReason: transition.reason,
      signalDelayMs,
      closeDelayMs: signalDelayMs,
      actions: [],
    };

    if (transition.side) {
      if (signalDelayMs > STRATEGY.maximumSignalDelayMs) {
        review.signalReason += ` Entry skipped because the minute boundary was ${signalDelayMs} ms late.`;
      } else if (!referenceIsFresh) {
        review.signalReason += ' Entry skipped because the previous candle was not confirmed by the live Binance WebSocket.';
      } else if (!feedFresh) {
        review.signalReason += ' Entry skipped because the Binance WebSocket is not fresh.';
      } else if (this.hasEntryForCandle(start, targetCandleStart)) {
        review.signalReason += ' This one-minute candle already used its entry.';
      } else {
        review.signalReason += ' Signal remains active until the next minute starts while waiting for a fresh CLOB quote.';
        this.pendingSignals.push({
          reviewId: review.id,
          windowStart: start,
          targetCandleStart,
          referenceCandle: previousCandle,
          transition,
          expiresAt: targetCandleStart + STRATEGY.signalValidityMs,
        });
      }
    }

    this.latestReview = review;
    this.reviews.unshift(review);
    if (this.reviews.length > 100) this.reviews.length = 100;
    const actionText = review.actions.length
      ? ` Actions: ${review.actions.map((action) => `${action.type} ${action.side} ${action.shares.toFixed(2)} shares`).join(', ')}.`
      : ' No order placed yet.';
    this.log(
      `Minute ${transition.candleNumber} opened; previous closed candle ${transition.referenceColor}. ${review.signalReason}${actionText}`,
      {
        asset: 'BTC',
        timeframe: '5m',
        side: transition.side,
        outcome: review.actions.length ? 'good' : transition.side ? 'bad' : 'neutral',
        type: 'MINUTE_CANDLE_REVIEW',
        now,
      },
    );
    this.scheduleLedgerSave();
    this.processPendingSignals(now);
  }

  processPendingSignals(now) {
    const keep = [];
    let ledgerChanged = false;
    for (const pending of this.pendingSignals) {
      const record = this.records.get('BTC:5m');
      const review = this.reviews.find((item) => item.id === pending.reviewId);
      if (!review) {
        ledgerChanged = true;
        continue;
      }
      if (!record?.market
        || Number(record.market.start) !== Number(pending.windowStart)
        || record.marketStatus !== 'OPEN'
        || now >= Number(record.market.end)) {
        review.signalReason += ' Signal expired because its market window ended.';
        ledgerChanged = true;
        continue;
      }
      if (now >= Number(pending.expiresAt)) {
        review.signalReason += ' Signal expired when the next one-minute candle started.';
        ledgerChanged = true;
        continue;
      }
      if (this.hasEntryForCandle(pending.windowStart, Number(pending.targetCandleStart))) {
        review.signalReason += ' Signal expired because this one-minute candle already used its entry.';
        ledgerChanged = true;
        continue;
      }
      const targetQuote = record.quotes[pending.transition.side];
      if (this.websocket.status !== 'CONNECTED'
        || !quoteIsFresh(targetQuote, now)) {
        keep.push(pending);
        continue;
      }
      const hasEligibleAskDepth = (targetQuote.asks || []).some((level) =>
        Number(level.price) > 0 && Number(level.price) < 1 && Number(level.size) > 0);
      if (!hasEligibleAskDepth) {
        keep.push(pending);
        continue;
      }
      const execution = this.executeColorSignal(
        record,
        pending.transition,
        pending.referenceCandle,
        pending.targetCandleStart,
        now,
      );
      review.actions.push(...execution.actions);
      review.signalReason = review.signalReason.replace(' Signal remains active until the next minute starts while waiting for a fresh CLOB quote.', ` ${execution.reason}`);
      if (!execution.actions.length && now < Number(pending.expiresAt)) keep.push(pending);
      ledgerChanged = true;
    }
    this.pendingSignals = keep;
    if (ledgerChanged) this.scheduleLedgerSave();
  }

  executeColorSignal(record, transition, referenceCandle, targetCandleStart, now) {
    const marketId = String(record.market.id || record.market.slug);
    const targetSide = transition.side;
    const fee = normalizeFeeRate(record.market);
    const candidate = {
      feeRate: fee.rate,
      feeSource: fee.source,
      signalCandleStart: Number(targetCandleStart),
      signalCandleNumber: transition.candleNumber,
      signalColor: transition.referenceColor,
      referenceColor: transition.referenceColor,
      referenceCandleStart: Number(referenceCandle?.start),
    };
    const actions = [];
    const windowStart = Number(record.market.start);
    if (this.hasEntryForCandle(windowStart, Number(targetCandleStart))) {
      return { actions, reason: 'Signal ignored because this one-minute candle already used its entry.' };
    }
    const targetQuote = record.quotes[targetSide];
    if (!quoteIsFresh(targetQuote, now)) {
      this.log(
        `${targetSide} minute-color signal was not entered because its CLOB quote is stale.`,
        { asset: 'BTC', timeframe: '5m', side: targetSide, outcome: 'bad', type: 'SIGNAL_ENTRY_SKIPPED', now },
      );
      return { actions, reason: 'Signal remains active while waiting for a fresh CLOB quote.' };
    }
    const bestAsk = Number(targetQuote.bestAsk);
    if (!isEntryAskWithinBand(bestAsk)) {
      const reason = Number.isFinite(bestAsk)
        ? `${targetSide} best ask is $${bestAsk.toFixed(2)}, outside the $${STRATEGY.minimumEntryAsk.toFixed(2)}–$${STRATEGY.maximumEntryAsk.toFixed(2)} entry band; waiting for a qualifying price.`
        : `${targetSide} best ask is unavailable; waiting for a qualifying price.`;
      return { actions, reason };
    }
    const eligibleAsks = targetQuote.asks
      .filter((level) => Number(level.price) >= STRATEGY.minimumEntryAsk
        && Number(level.price) <= STRATEGY.maximumEntryAsk
        && Number(level.size) > 0)
      .sort((a, b) => Number(a.price) - Number(b.price));
    const buySweep = sweep(
      eligibleAsks,
      STRATEGY.sharesPerTrigger,
      fee.rate,
      'BUY',
      STRATEGY.maximumEntryAsk,
    );
    if (!(buySweep.filledShares > 0)) {
      const reason = `${targetSide} signal found no visible ask depth at a valid market price.`;
      this.log(reason,
        { asset: 'BTC', timeframe: '5m', side: targetSide, outcome: 'bad', type: 'SIGNAL_ENTRY_SKIPPED', now },
      );
      return { actions, reason: 'Signal remains active while waiting for visible ask depth.' };
    }
    const order = this.buyPosition(record, targetSide, buySweep, now, candidate);
    if (order?.filledShares > 0) {
      actions.push({ type: 'BUY', side: targetSide, orderId: order.id, shares: order.filledShares });
      this.entryTakenCandleKeys.add(`${windowStart}:${Number(targetCandleStart)}`);
      if (this.entryTakenCandleKeys.size > 300) {
        this.entryTakenCandleKeys = new Set([...this.entryTakenCandleKeys].slice(-300));
      }
      this.pendingSignals = this.pendingSignals.filter((pending) =>
        Number(pending.windowStart) !== windowStart
        || Number(pending.targetCandleStart) !== Number(targetCandleStart));
    }
    return {
      actions,
      reason: actions.length
        ? `Signal executed; this one-minute candle’s ${STRATEGY.sharesPerTrigger}-share entry is recorded.`
        : 'Signal remains active because available paper cash could not cover the fill.',
    };
  }

  hasEntryForCandle(windowStart, candleStart) {
    const start = Number(windowStart);
    const key = `${start}:${Number(candleStart)}`;
    return this.entryTakenCandleKeys.has(key)
      || this.orders.some((order) => Number(order.windowStart) === start
        && Number(order.signalCandleStart) === Number(candleStart)
        && String(order.action).startsWith('BUY')
        && Number(order.filledShares) > 0);
  }

  buyPosition(record, side, result, now, signal) {
    if (!(result?.filledShares > 0)) return null;
    const totalCost = result.notional + result.fees;
    if (this.availableCash() + EPSILON < totalCost) {
      this.log(
        `${side} candle signal was skipped because paper cash cannot cover the filled shares and fees.`,
        { asset: 'BTC', timeframe: '5m', side, outcome: 'bad', type: 'SIGNAL_ENTRY_SKIPPED', now },
      );
      return null;
    }
    const market = record.market;
    const order = {
      id: `color-order-${++this.orderSequence}`,
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
      cost: result.notional,
      fees: result.fees,
      feeRate: signal.feeRate,
      feeSource: signal.feeSource,
      fills: result.fills,
      fillRule: `Immediate visible-ask sweep from $${STRATEGY.minimumEntryAsk.toFixed(2)} to $${STRATEGY.maximumEntryAsk.toFixed(2)}; partial fills reflect displayed book depth.`,
      signalCandleStart: signal.signalCandleStart,
      signalCandleNumber: signal.signalCandleNumber,
      signalColor: signal.signalColor,
      referenceColor: signal.referenceColor,
      referenceCandleStart: signal.referenceCandleStart,
      previousColor: signal.referenceColor,
    };
    this.orders.unshift(order);
    this.cash -= totalCost;
    const position = {
      id: `color-position-${++this.positionSequence}`,
      orderId: order.id,
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
      totalCost: result.notional,
      fees: result.fees,
      totalEntryFees: result.fees,
      exitFees: 0,
      soldShares: 0,
      resolvedShares: 0,
      closedShares: 0,
      exitProceeds: 0,
      partialRealizedPnl: 0,
      estimatedMakerRebate: 0,
      entryAt: now,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      markBid: Number.isFinite(Number(record.quotes[side].bestBid))
        ? Number(record.quotes[side].bestBid) : null,
      markUpdatedAt: record.quotes[side].updatedAt,
      markStatus: 'LIVE',
      unrealizedPnl: Number.isFinite(Number(record.quotes[side].bestBid))
        ? Number(record.quotes[side].bestBid) * result.filledShares - result.notional - result.fees
        : null,
      realizedPnl: null,
      exitPrice: null,
      exitPayout: null,
      exitReason: null,
      signalCandleStart: signal.signalCandleStart,
      signalCandleNumber: signal.signalCandleNumber,
      signalColor: signal.signalColor,
      referenceColor: signal.referenceColor,
      referenceCandleStart: signal.referenceCandleStart,
      previousColor: signal.referenceColor,
    };
    this.positions.unshift(position);
    this.log(
      `${side} buy: ${result.filledShares.toFixed(2)} of ${STRATEGY.sharesPerTrigger} requested shares at $${result.averagePrice.toFixed(4)} average; minute ${signal.signalCandleNumber} used the previous ${signal.referenceColor} candle.`,
      { asset: 'BTC', timeframe: '5m', side, outcome: 'good', type: 'CANDLE_SIGNAL_BUY', now },
    );
    this.updateAccountMetrics(now, true);
    return order;
  }

  settleMarket(marketId, winner, now) {
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'PENDING_RESOLUTION') continue;
      const won = position.side === winner;
      const payout = won ? Number(position.shares || 0) : 0;
      this.cash += payout;
      position.status = won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
      position.resolvedAt = now;
      position.resolutionWinner = winner;
      position.resolvedShares = Number(position.shares || 0);
      position.closedShares = Number(position.soldShares || 0) + position.resolvedShares;
      position.exitProceeds = Number(position.exitProceeds || 0) + payout;
      position.exitPrice = position.closedShares > EPSILON
        ? position.exitProceeds / position.closedShares
        : won ? 1 : 0;
      position.exitPayout = won ? 1 : 0;
      position.exitReason = Number(position.soldShares || 0) > 0
        ? 'CANDLE_FLIP_AND_OFFICIAL_RESOLUTION'
        : 'OFFICIAL_RESOLUTION';
      position.closedAt = now;
      position.realizedPnl = Number(position.partialRealizedPnl || 0)
        + payout - Number(position.totalCost || 0) - Number(position.fees || 0);
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      this.log(`${position.side} resolved ${won ? 'WIN' : 'LOSS'}; official market result settled remaining shares.`, {
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
    this.processedCandleKeys = new Set(Array.isArray(savedModel.processedCandleKeys)
      ? savedModel.processedCandleKeys.slice(-60)
      : []);
    this.reviews = Array.isArray(savedModel.reviews) ? savedModel.reviews.slice(0, 100) : [];
    this.latestReview = this.reviews[0] || null;
    this.pendingSignals = Array.isArray(savedModel.pendingSignals)
      ? savedModel.pendingSignals.slice(0, 10)
      : [];
    this.entryTakenCandleKeys = new Set(Array.isArray(savedModel.entryTakenCandleKeys)
      ? savedModel.entryTakenCandleKeys.slice(-300).map(String)
      : []);
    this.strategyId = STRATEGY.id;
    this.strategyName = STRATEGY.name;
  }

  exportLedger() {
    const snapshot = this.snapshot();
    snapshot.positions = this.positions.map((position) => ({ ...position }));
    snapshot.orders = this.orders.map((order) => ({ ...order }));
    snapshot.events = this.events.map((event) => ({ ...event }));
    snapshot.modelEngine = {
      processedCandleKeys: [...this.processedCandleKeys].slice(-60),
      pendingSignals: this.pendingSignals.slice(0, 10),
      entryTakenCandleKeys: [...this.entryTakenCandleKeys].slice(-300),
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
    const feed = this.binanceFeed.snapshot();
    const windowStart = Number(market?.start);
    const windowEnd = Number(market?.end);
    const closedCandles = feed.closedCandles || [];
    const previousWindowCandle = Number.isFinite(windowStart)
      ? closedCandles.find((candle) =>
        Number(candle.start) === windowStart - STRATEGY.candleIntervalMs)
      : null;
    const windowCandles = Number.isFinite(windowStart) && Number.isFinite(windowEnd)
      ? closedCandles.filter((candle) =>
        Number(candle.start) >= windowStart && Number(candle.start) < windowEnd)
        .map((candle) => ({
          ...candle,
          minute: Math.floor((Number(candle.start) - windowStart) / STRATEGY.candleIntervalMs) + 1,
          color: candleColor(candle),
        }))
      : [];
    const current = feed.currentCandle;
    if (current && Number(current.start) >= windowStart && Number(current.start) < windowEnd
      && !windowCandles.some((candle) => Number(candle.start) === Number(current.start))) {
      windowCandles.push({
        ...current,
        minute: Math.floor((Number(current.start) - windowStart) / STRATEGY.candleIntervalMs) + 1,
        color: candleColor(current),
      });
    }
    windowCandles.sort((a, b) => Number(a.start) - Number(b.start));
    const currentReview = this.reviews.find((review) => Number(review.windowStart) === windowStart) || null;
    const positions = this.positions.filter((position) =>
      position.marketId === String(market?.id || market?.slug)
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
        entryFees: round(aggregate.fees, 4),
        unrealizedPnl: round(unrealizedPnl, 4),
        openPositionCount: sidePositions.length,
        positions: sidePositions.map((position) => ({ ...position })),
      }];
    }));

    state.mode = 'PAPER ONLY';
    state.status = this.status;
    state.statusReason = this.statusReason;
    state.strategy = {
      ...STRATEGY,
      summary: `At the start of minutes 1–3 in each BTC five-minute market, use the immediately previous closed Binance candle: RED buys UP; GREEN buys DOWN. Minute 1 uses the prior window’s final candle. Entries require the signalled side’s best ask to be $${STRATEGY.minimumEntryAsk.toFixed(2)}–$${STRATEGY.maximumEntryAsk.toFixed(2)} inclusive. Minutes 4–5 do not trade. Candle signals never sell positions.`,
      execution: 'PAPER ONLY — no real orders or wallet signing.',
      entry: `At the start of minutes 1–3, request ${STRATEGY.sharesPerTrigger} shares based only on the previous closed candle: RED buys UP; GREEN buys DOWN. Minute 1 uses the prior window’s final candle; minutes 2–3 use the previous candle in this window. Entries are allowed only when the signalled side’s best ask is between $${STRATEGY.minimumEntryAsk.toFixed(2)} and $${STRATEGY.maximumEntryAsk.toFixed(2)}, inclusive; the simulated ask sweep is capped at $${STRATEGY.maximumEntryAsk.toFixed(2)}. A signal waits for a qualifying fresh quote until the next minute begins. Minutes 4–5 are skipped. Doji or unavailable reference candles do not create a directional entry.`,
      exit: `Candle signals never sell positions, including on color changes. The $${STRATEGY.takeProfitMid.toFixed(2)} midpoint take-profit credits $1/share only if the remaining position still closes without a net loss. No stop-loss is active; positions not closed by take-profit are held to official resolution.`,
      takeProfit: `At a held-side midpoint of $${STRATEGY.takeProfitMid.toFixed(2)}, close only if the resulting net position P&L after fees is not negative; credit $1 per remaining share.`,
      stopLoss: 'Disabled: candle signals never sell; unresolved positions remain open for take-profit or official resolution.',
      timing: 'One buy decision is scheduled at the start of minutes 1, 2, and 3 only. RED on the previous closed candle buys UP; GREEN buys DOWN. Minute 1 carries over the previous five-minute window’s final candle. Minutes 4 and 5 are skipped. Candle color changes do not sell existing positions.',
    };
    state.scanner = {
      ...state.scanner,
      assets: ['BTC'],
      timeframes: ['5m'],
      totalMarkets: 1,
      marketData: 'Binance BTCUSDT one-minute kline WebSocket supplies candles; Polymarket CLOB WebSocket supplies execution quotes.',
    };
    state.markets = state.markets
      .filter((item) => item.asset === 'BTC' && item.timeframe === '5m')
      .map((item) => ({
        ...item,
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
      status: feed.status,
      tickStreamStatus: feed.status,
      historyStatus: feed.historyStatus,
      error: feed.error,
      reconnectCount: feed.reconnectCount,
      price: feed.price,
      tickAt: feed.tickAt,
      messageAgeMs: feed.messageAgeMs,
      currentCandle: feed.currentCandle,
      closedCandles: closedCandles.map((candle) => ({ ...candle, color: candleColor(candle) })),
      previousWindowCandle: previousWindowCandle
        ? { ...previousWindowCandle, color: candleColor(previousWindowCandle) }
        : null,
      windowCandles,
      candleCounts: feed.candleCounts,
      candleIntervalMs: STRATEGY.candleIntervalMs,
      firstSignalCandle: STRATEGY.firstSignalCandle,
      lastSignalCandle: STRATEGY.lastSignalCandle,
      minimumEntryAsk: STRATEGY.minimumEntryAsk,
      maximumEntryAsk: STRATEGY.maximumEntryAsk,
      sharesPerTrigger: STRATEGY.sharesPerTrigger,
      latestReview: currentReview,
      recentReviews: this.reviews.slice(0, 20),
      sides: sidePositions,
      tradeHistory: this.positions
        .filter((position) => ['SIGNAL_SOLD', 'TAKE_PROFIT', 'STOP_LOSS', 'RESOLVED_WIN', 'RESOLVED_LOSS'].includes(position.status))
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
        sharesPerTrigger: STRATEGY.sharesPerTrigger,
        maximumEntriesPerWindow: STRATEGY.maximumEntriesPerWindow,
        firstSignalCandle: STRATEGY.firstSignalCandle,
        lastSignalCandle: STRATEGY.lastSignalCandle,
        minimumEntryAsk: STRATEGY.minimumEntryAsk,
        maximumEntryAsk: STRATEGY.maximumEntryAsk,
      },
    };
    state.sizingByAsset = undefined;
    return state;
  }
}

MinuteColorBot.STRATEGY = STRATEGY;
MinuteColorBot._test = {
  normalizeFeeRate,
  sweep,
  quoteIsFresh,
  positionSideAverage,
  candleColor,
  isEntryAskWithinBand,
  classifyMinuteEntry,
};

module.exports = MinuteColorBot;
