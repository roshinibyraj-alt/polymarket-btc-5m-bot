'use strict';

const config = require('./config');
const DipBounceBot = require('./dip-bounce-bot');
const BinanceMinuteFeed = require('./binance-minute-feed');
const { STRATEGY, candleColor, classifyCandleTransition } = require('./minute-candle-strategy');

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
      this.statusReason = 'Monitoring closed BTC one-minute candle colors for minute 2–4 signals.';
    }
  }

  processSide() {}

  checkTakeProfits() {}

  checkStopLosses() {}

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
    const currentWindow = closedCandles.filter((candle) =>
      Number(candle.start) >= start && Number(candle.start) < end);

    for (const candle of currentWindow) {
      const key = `${start}:${Number(candle.start)}`;
      if (this.processedCandleKeys.has(key)) continue;
      const offset = Number(candle.start) - start;
      const candleNumber = Math.floor(offset / STRATEGY.candleIntervalMs) + 1;
      if (candleNumber < STRATEGY.firstSignalCandle || candleNumber > STRATEGY.lastSignalCandle) continue;
      if (now < Number(candle.closeAt)) continue;
      this.processedCandleKeys.add(key);

      const previousCandle = closedCandles.find((item) =>
        Number(item.start) === Number(candle.start) - STRATEGY.candleIntervalMs);
      const transition = classifyCandleTransition({
        candle,
        previousCandle,
        windowStart: start,
      });
      const closeDelayMs = Math.max(0, now - Number(candle.closeAt));
      const feedFresh = feed.status === 'CONNECTED'
        && feed.messageAgeMs != null
        && Number.isFinite(Number(feed.messageAgeMs))
        && Number(feed.messageAgeMs) <= STRATEGY.maximumSignalDelayMs;
      const review = {
        id: `minute-review-${start}-${Number(candle.start)}`,
        at: now,
        windowStart: start,
        windowEnd: end,
        candleNumber: transition.candleNumber,
        candle: { ...candle, color: transition.color },
        previousCandle: previousCandle
          ? { ...previousCandle, color: transition.previousColor }
          : null,
        currentColor: transition.color,
        previousColor: transition.previousColor,
        signalSide: transition.side,
        signalReason: transition.reason,
        closeDelayMs,
        actions: [],
      };

      if (transition.side) {
        if (closeDelayMs > STRATEGY.maximumSignalDelayMs) {
          review.signalReason += ` Signal ignored because its close arrived ${closeDelayMs} ms late.`;
        } else if (candle.source !== 'BINANCE_1M_WEBSOCKET') {
          review.signalReason += ' Signal ignored because this candle was not confirmed by the live Binance WebSocket.';
        } else if (!feedFresh) {
          review.signalReason += ' Signal ignored because the Binance WebSocket is not fresh.';
        } else {
          review.signalReason += ' Waiting briefly for a fresh Polymarket CLOB quote.';
          this.pendingSignals.push({
            reviewId: review.id,
            windowStart: start,
            candle,
            transition,
            expiresAt: Number(candle.closeAt) + STRATEGY.maximumSignalDelayMs,
          });
        }
      }

      this.latestReview = review;
      this.reviews.unshift(review);
      if (this.reviews.length > 100) this.reviews.length = 100;
      const actionText = review.actions.length
        ? ` Actions: ${review.actions.map((action) => `${action.type} ${action.side} ${action.shares.toFixed(2)} shares`).join(', ')}.`
        : ' No order placed.';
      this.log(
        `Minute ${transition.candleNumber} closed ${transition.color}; previous minute ${transition.previousColor}. ${review.signalReason}${actionText}`,
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
    }
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
      if (now > Number(pending.expiresAt)) {
        review.signalReason += ' Signal expired while waiting for a fresh CLOB quote.';
        ledgerChanged = true;
        continue;
      }
      const targetQuote = record.quotes[pending.transition.side];
      if (this.websocket.status !== 'CONNECTED' || !quoteIsFresh(targetQuote, now)) {
        keep.push(pending);
        continue;
      }
      review.actions = this.executeColorSignal(record, pending.transition, pending.candle, now);
      review.signalReason = review.signalReason.replace(
        'Waiting briefly for a fresh Polymarket CLOB quote.',
        review.actions.length ? 'Signal executed.' : 'No visible executable depth was available.',
      );
      ledgerChanged = true;
    }
    this.pendingSignals = keep;
    if (ledgerChanged) this.scheduleLedgerSave();
  }

  executeColorSignal(record, transition, candle, now) {
    const marketId = String(record.market.id || record.market.slug);
    const targetSide = transition.side;
    const oppositeSide = targetSide === 'UP' ? 'DOWN' : 'UP';
    const fee = normalizeFeeRate(record.market);
    const candidate = {
      feeRate: fee.rate,
      feeSource: fee.source,
      signalCandleStart: Number(candle.start),
      signalCandleNumber: transition.candleNumber,
      signalColor: transition.color,
      previousColor: transition.previousColor,
    };
    const actions = [];
    const oppositePositions = this.positions.filter((position) =>
      position.marketId === marketId
      && position.side === oppositeSide
      && position.status === 'OPEN');

    if (oppositePositions.length) {
      const quote = record.quotes[oppositeSide];
      if (quoteIsFresh(quote, now)) {
        try {
          const aggregate = positionSideAverage(oppositePositions);
          const sellSweep = sweep(quote.bids, aggregate.shares, fee.rate, 'SELL', 1);
          const order = this.sellPositions(record, oppositeSide, sellSweep, now, candidate);
          if (order?.filledShares > 0) {
            actions.push({ type: 'SELL', side: oppositeSide, orderId: order.id, shares: order.filledShares });
          }
        } catch (error) {
          this.log(
            `${oppositeSide} flip sale failed (${error?.message || 'unknown error'}); continuing with the independent ${targetSide} buy.`,
            { asset: 'BTC', timeframe: '5m', side: oppositeSide, outcome: 'bad', type: 'FLIP_SELL_FAILED', now },
          );
        }
      } else {
        this.log(
          `Candle flip signal is buying ${targetSide}, but the ${oppositeSide} book is stale; its open shares were not sold on this tick.`,
          { asset: 'BTC', timeframe: '5m', side: oppositeSide, outcome: 'bad', type: 'FLIP_SELL_SKIPPED', now },
        );
      }
    }

    const targetQuote = record.quotes[targetSide];
    if (!quoteIsFresh(targetQuote, now)) {
      this.log(
        `${targetSide} minute-color signal was not entered because its CLOB quote is stale.`,
        { asset: 'BTC', timeframe: '5m', side: targetSide, outcome: 'bad', type: 'SIGNAL_ENTRY_SKIPPED', now },
      );
      return actions;
    }

    const buySweep = sweep(
      targetQuote.asks,
      STRATEGY.sharesPerTrigger,
      fee.rate,
      'BUY',
      STRATEGY.maximumBuyPrice,
    );
    if (!(buySweep.filledShares > 0)) {
      this.log(
        `${targetSide} minute-color signal found no executable ask depth at or below $${STRATEGY.maximumBuyPrice.toFixed(2)}.`,
        { asset: 'BTC', timeframe: '5m', side: targetSide, outcome: 'bad', type: 'SIGNAL_ENTRY_SKIPPED', now },
      );
      return actions;
    }
    const order = this.buyPosition(record, targetSide, buySweep, now, candidate);
    if (order?.filledShares > 0) {
      actions.push({ type: 'BUY', side: targetSide, orderId: order.id, shares: order.filledShares });
    }
    return actions;
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
      fillRule: `Immediate visible-ask sweep up to $${STRATEGY.maximumBuyPrice.toFixed(2)}; partial fills reflect displayed book depth.`,
      signalCandleStart: signal.signalCandleStart,
      signalCandleNumber: signal.signalCandleNumber,
      signalColor: signal.signalColor,
      previousColor: signal.previousColor,
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
      previousColor: signal.previousColor,
    };
    this.positions.unshift(position);
    this.log(
      `${side} buy: ${result.filledShares.toFixed(2)} of ${STRATEGY.sharesPerTrigger} requested shares at $${result.averagePrice.toFixed(4)} average; minute ${signal.signalCandleNumber} changed to ${signal.signalColor}.`,
      { asset: 'BTC', timeframe: '5m', side, outcome: 'good', type: 'CANDLE_SIGNAL_BUY', now },
    );
    this.updateAccountMetrics(now, true);
    return order;
  }

  sellPositions(record, side, result, now, signal) {
    if (!(result?.filledShares > 0)) return null;
    const marketId = String(record.market.id || record.market.slug);
    const positions = this.positions
      .filter((position) => position.marketId === marketId
        && position.side === side
        && position.status === 'OPEN')
      .sort((a, b) => Number(a.entryAt) - Number(b.entryAt));
    const availableShares = positions.reduce((sum, position) => sum + Number(position.shares || 0), 0);
    const filledShares = Math.min(result.filledShares, availableShares);
    if (!(filledShares > 0)) return null;
    const fillRatio = filledShares / result.filledShares;
    const grossProceeds = result.notional * fillRatio;
    const exitFees = result.fees * fillRatio;
    const order = {
      id: `color-order-${++this.orderSequence}`,
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
      feeRate: signal.feeRate,
      feeSource: signal.feeSource,
      fills: result.fills.map((fill) => ({ ...fill, shares: fill.shares * fillRatio, fee: fill.fee * fillRatio })),
      fillRule: 'Sell sweep against visible bids on an opposite-color signal; any unavailable remainder stays open for resolution.',
      signalCandleStart: signal.signalCandleStart,
      signalCandleNumber: signal.signalCandleNumber,
      signalColor: signal.signalColor,
      previousColor: signal.previousColor,
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
      position.closedShares = Number(position.closedShares || 0) + soldShares;
      position.totalCost = Math.max(0, Number(position.totalCost || 0) - releasedCost);
      position.fees = Math.max(0, Number(position.fees || 0) - releasedEntryFees);
      position.shares = Math.max(0, beforeShares - soldShares);
      position.exitAt = now;
      position.exitPrice = Number(position.exitProceeds) / Number(position.soldShares);
      position.exitReason = position.shares <= EPSILON ? 'CANDLE_COLOR_FLIP' : 'PARTIAL_CANDLE_COLOR_FLIP';
      position.markUpdatedAt = record.quotes[side].updatedAt;
      position.markStatus = position.shares <= EPSILON ? 'CLOSED' : 'LIVE';
      position.unrealizedPnl = position.shares > EPSILON
        ? (Number(record.quotes[side].bestBid) || 0) * position.shares - position.totalCost - position.fees
        : null;
      if (position.shares <= EPSILON) {
        position.status = 'SIGNAL_SOLD';
        position.realizedPnl = position.partialRealizedPnl;
        position.closedAt = now;
      }
      leftToAllocate -= soldShares;
    }
    this.log(
      `${side} flip exit: sold ${filledShares.toFixed(2)} shares at $${order.fillPrice.toFixed(4)} average; net realized ${realizedTotal >= 0 ? 'profit' : 'loss'} $${Math.abs(realizedTotal).toFixed(2)} after modeled fees.`,
      {
        asset: 'BTC',
        timeframe: '5m',
        side,
        outcome: realizedTotal >= 0 ? 'good' : 'bad',
        type: 'CANDLE_FLIP_SELL',
        now,
      },
    );
    this.markPositions(now);
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
      summary: 'For each BTC five-minute market, compare closed one-minute candles 2–4 with the immediately prior candle. Same color means no trade; a color change buys the new color side.',
      execution: 'PAPER ONLY — no real orders or wallet signing.',
      entry: `Every eligible color change requests ${STRATEGY.sharesPerTrigger} shares with a taker-style visible-ask sweep capped at $${STRATEGY.maximumBuyPrice.toFixed(2)}; actual simulated fills use displayed depth.`,
      exit: 'On a color change against an open side, sweep that side’s visible bids to sell; buy the newly signaled side independently. Any unsold remainder goes to official resolution.',
      timing: 'Minute 1 is reference-only. Compare minute 2 to minute 1, minute 3 to minute 2, and minute 4 to minute 3. Minute 5 has no signal.',
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
      windowCandles,
      candleCounts: feed.candleCounts,
      candleIntervalMs: STRATEGY.candleIntervalMs,
      firstSignalCandle: STRATEGY.firstSignalCandle,
      lastSignalCandle: STRATEGY.lastSignalCandle,
      sharesPerTrigger: STRATEGY.sharesPerTrigger,
      maximumBuyPrice: STRATEGY.maximumBuyPrice,
      latestReview: currentReview,
      recentReviews: this.reviews.slice(0, 20),
      sides: sidePositions,
      tradeHistory: this.positions
        .filter((position) => ['SIGNAL_SOLD', 'RESOLVED_WIN', 'RESOLVED_LOSS'].includes(position.status))
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
        maximumBuyPrice: STRATEGY.maximumBuyPrice,
        firstSignalCandle: STRATEGY.firstSignalCandle,
        lastSignalCandle: STRATEGY.lastSignalCandle,
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
  classifyCandleTransition,
};

module.exports = MinuteColorBot;
