'use strict';

const DipBounceBot = require('./dip-bounce-bot');
const EdgePriceFeed = require('./edge-price-feed');
const defaultMarketData = require('./wick-market-data');
const { RULES, forecast, candidate, freshQuote, marketFee } = require('./edge-model');
const BASE_ID = DipBounceBot._test.STRATEGY.id;
const ACTIVE = new Set(['OPEN', 'PENDING_RESOLUTION']);

const STRATEGY = Object.freeze({
  ...RULES,
  execution: 'PAPER ONLY. Delayed visible-ask sweeps, maximum 50% of displayed depth, actual market fee metadata. No rebates or invented $1 early exits.',
  entry: 'Value entries: once per second from seconds 20–240, require two consecutive fresh same-side checks, conservative probability at least 52% with a 3-percentage-point haircut and net edge at least $0.005 after fees and a $0.01 reserve. Ask $0.05–$0.95; spread ≤$0.03. No forced-entry path; windows may be skipped. Maximum one entry per window.',
  risk: 'No martingale. At most 50 shares and min($15, 0.5% of available capital) per window; all unsettled cost capped at 2% of starting capital. A 5% drawdown stops new entries. Settlement continues.',
  resolution: 'Hold to official Polymarket resolution; check every 5 seconds after expiry. Winners pay $1, losers $0. No artificial TP or empty-book stop.',
  limitations: 'Experimental and uncalibrated. Looser entry gates may increase trade frequency, but do not guarantee a trade in every window or profitability. Binance USD(T) is not the Chainlink settlement oracle.',
});

class SelectiveEdgeBot extends DipBounceBot {
  constructor(options = {}) {
    super({ ...options, assets: ['BTC'], timeframes: ['5m'] });
    this.binanceFeed = options.binanceFeed || new EdgePriceFeed({ now: this.now, WebSocketImpl: this.WebSocketImpl });
    this.hydrated = new Set();
    // Never carry a prior connection's book through a reconnect.
    const data = options.marketData || defaultMarketData;
    this.marketData = { ...data, connectMarketStream: (tokens, handlers) => data.connectMarketStream(tokens, {
      ...handlers,
      onStatus: status => {
        if (status.status !== 'CONNECTED') this.hydrated.clear();
        handlers.onStatus(status);
      },
    }) };
    this.latestDecision = null;
    this.recentDecisions = [];
    this.decisionCount = 0;
    this.skipCounts = {};
    this.windowSummaries = [];
    this.lastDecisionAt = null;
    this.confirmation = null;
    this.pendingEntry = null;
    this.riskStopped = false;
    this.startedAt = this.now();
  }

  start() {
    if (this.running) return;
    this.binanceFeed.start().catch(error => {
      this.log(error.message, { type: 'BINANCE_ERROR', outcome: 'bad' });
    });
    super.start();
  }

  stop() {
    super.stop();
    this.binanceFeed.stop();
  }

  async tick(now = this.now()) {
    if (!this.running || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await Promise.all([...this.records.values()].map(r => this.refreshMarket(r, now)));
      this.syncMarketStream();
      this.markPositions(now);
      // Resolution requests may take seconds. They must not freeze current-window checks.
      void this.checkResolutions(now);
      this.updateAccountMetrics(now);
      this.evaluate(this.now());
    } catch (error) {
      this.status = 'ERROR';
      this.statusReason = error.message;
      this.log(error.message, { type: 'EDGE_ERROR', outcome: 'bad', now });
    } finally {
      this.tickInFlight = false;
      this.scheduleLedgerSave();
    }
  }

  processSide() {}
  checkTakeProfits() {}
  checkStopLosses() {}
  updateSizingAfterClose() {} // No inherited loss progression.
  applyRestoredWindowConsumption() {} // Entry deduplication uses the full persisted orders below.

  handleMarketMessage(message) {
    if (Array.isArray(message)) return message.forEach(m => this.handleMarketMessage(m));
    if (!message || typeof message !== 'object') return;
    const at = Number(message.timestamp);
    const now = this.now();
    if (!Number.isFinite(at) || at < now - 2000 || at > now + 1000) return;
    const type = message.event_type;
    const valid = change => {
      const token = String(change.asset_id || message.asset_id || '');
      const ref = this.tokenRefs.get(token);
      const record = ref && this.records.get(ref.recordKey);
      const quote = record?.quotes[ref?.side];
      return record?.market && now < record.market.end
        && (quote.updatedAt == null || at >= quote.updatedAt)
        && (type === 'book' || this.hydrated.has(token));
    };
    if (type === 'book' && valid(message)) {
      this.hydrated.add(String(message.asset_id));
      super.handleMarketMessage(message);
    } else if (type === 'price_change') {
      const changes = (message.price_changes || [message]).filter(valid);
      if (changes.length) super.handleMarketMessage({ ...message, price_changes: changes });
    }
  }

  riskSnapshot() {
    const openCost = this.positions.filter(p => ACTIVE.has(p.status))
      .reduce((sum, p) => sum + p.totalCost + p.fees, 0);
    const maxOpenCost = this.initialCapital * RULES.maximumOpenFraction;
    const drawdownLimitUsd = this.initialCapital * RULES.drawdownLimitFraction;
    if (this.maxDrawdown >= drawdownLimitUsd) this.riskStopped = true;
    return {
      perWindowBudget: Math.max(0, Math.min(RULES.perWindowDollarCap,
        Math.min(this.cash, this.accountSnapshot().equity) * RULES.perWindowFraction,
        maxOpenCost - openCost)),
      openCost, maxOpenCost, drawdownLimitUsd, riskStopped: this.riskStopped,
    };
  }

  recordDecision(code, reason, now, extra = {}) {
    const decision = { at: now, code, reason, confirmationCount: this.confirmation?.count || 0, ...extra };
    this.latestDecision = decision;
    this.decisionCount += 1;
    this.status = code === 'RISK_STOP' ? 'RISK_PAUSED' : 'RUNNING';
    this.statusReason = reason;
    this.skipCounts[code] = (this.skipCounts[code] || 0) + 1;
    // One audit sample per changed reason or 15 seconds; raw checks remain counted.
    if (this.recentDecisions[0]?.code !== code
      || now - (this.recentDecisions[0]?.at || 0) >= 15_000) {
      this.recentDecisions.unshift(decision);
      this.recentDecisions = this.recentDecisions.slice(0, 150);
    }
    return decision;
  }

  evaluate(now) {
    const record = this.records.get('BTC:5m');
    const market = record?.market;
    // Revalidate pending paper orders after latency using a NEW book update.
    if (this.pendingEntry && now >= this.pendingEntry.executeAfter) {
      this.confirmEntry(record, now);
    }
    if (this.lastDecisionAt != null && now - this.lastDecisionAt < RULES.decisionIntervalMs) return;
    this.lastDecisionAt = now;
    const skip = (code, reason, extra) => {
      this.confirmation = null;
      return this.recordDecision(code, reason, now, extra);
    };
    if (!market || record.marketStatus !== 'OPEN' || now >= market.end) return skip('MARKET_WAIT', 'Waiting for the current BTC market.');
    const risk = this.riskSnapshot();
    if (risk.riskStopped) return skip('RISK_STOP', 'Drawdown limit reached. New entries paused; official settlement continues.');
    const elapsed = (now - market.start) / 1000;
    if (elapsed < RULES.minimumElapsedSeconds) return skip('OPENING_WAIT', 'Observing the first 20 seconds; no forced opening entry.');
    if (elapsed > RULES.lastEntrySecond) return skip('LATE_WINDOW', 'Entry cut-off reached. No new positions after second 240.');
    if (this.orders.some(o => o.marketId === String(market.id) && o.filledShares > 0)) {
      return skip('WINDOW_USED', 'This window already has its one entry. Holding to official resolution.');
    }
    if (this.pendingEntry) return this.recordDecision('ORDER_PENDING', 'Waiting for a fresh post-latency book; no duplicate entry.', now);
    if (risk.perWindowBudget < 1) return skip('EXPOSURE_CAP', 'Unsettled exposure or available capital leaves no entry budget.');
    const feed = this.binanceFeed.snapshot();
    const model = forecast({ feed, market, now });
    if (!model.ready) return skip('MODEL_WAIT', model.reason, { model });
    if (this.websocket.status !== 'CONNECTED') return skip('CLOB_WAIT', 'Polymarket disconnected; new entries paused.', { model });
    const candidates = ['UP', 'DOWN'].map(side =>
      candidate({ model, quote: record.quotes[side], market, side, now, budget: risk.perWindowBudget }));
    let best = candidates.filter(c => c.eligible).sort((a, b) => b.netEdge - a.netEdge)[0];
    if (!best) return skip('NO_EDGE', candidates.map(c => `${c.side}: ${c.reason}`).join(' '), { model, candidates });
    if (this.confirmation?.side === best.side && this.confirmation.marketId === String(market.id)
      && feed.tickAt > this.confirmation.tickAt && now - this.confirmation.at <= 2500) {
      this.confirmation.count += 1;
      this.confirmation.tickAt = feed.tickAt;
      this.confirmation.at = now;
    } else this.confirmation = { side: best.side, marketId: String(market.id), count: 1,
      tickAt: feed.tickAt, at: now };
    this.recordDecision('CONFIRMING',
      `${best.side} qualifies; ${this.confirmation.count}/${RULES.confirmations} fresh consecutive checks.`,
      now, { model, candidates, side: best.side });
    if (this.confirmation.count >= RULES.confirmations) {
      this.pendingEntry = {
        marketId: String(market.id), side: best.side, requestedAt: now,
        executeAfter: now + RULES.fillLatencyMs, expiresAt: now + 2000,
        sequence: record.quotes[best.side].sequence,
      };
      this.scheduleLedgerSave();
    }
  }

  confirmEntry(record, now) {
    const pending = this.pendingEntry;
    const market = record?.market;
    const cancel = reason => {
      this.pendingEntry = null;
      this.confirmation = null;
      this.recordDecision('ORDER_CANCELLED', reason, now);
    };
    if (!market || String(market.id) !== pending.marketId || now >= pending.expiresAt
      || now >= market.end || (now - market.start) / 1000 > RULES.lastEntrySecond) {
      return cancel('Paper order expired or its window changed before execution.');
    }
    if (record.quotes[pending.side].sequence <= pending.sequence) return;
    const risk = this.riskSnapshot();
    const model = forecast({ feed: this.binanceFeed.snapshot(), market, now });
    if (!model.ready || risk.riskStopped || this.websocket.status !== 'CONNECTED') return cancel('Data or risk checks failed during execution delay.');
    const fill = candidate({ model, quote: record.quotes[pending.side], market, side: pending.side, now,
      budget: risk.perWindowBudget });
    if (!fill.eligible) return cancel(`Price moved before execution: ${fill.reason}`);
    if (this.orders.some(o => o.marketId === pending.marketId && o.filledShares > 0)) return cancel('Duplicate window entry rejected.');
    this.pendingEntry = null;
    this.confirmation = null;
    const order = {
      id: `edge-order-${++this.orderSequence}`, marketId: String(market.id), marketSlug: market.slug,
      marketTitle: market.title, asset: 'BTC', timeframe: '5m', side: pending.side, action: 'BUY_TAKER',
      status: fill.filledShares < fill.requestedShares ? 'PARTIALLY_FILLED' : 'FILLED',
      windowStart: market.start, windowEnd: market.end, requestedShares: fill.requestedShares,
      filledShares: fill.filledShares, unfilledShares: fill.requestedShares - fill.filledShares,
      placedAt: pending.requestedAt, filledAt: now, fillPrice: fill.averagePrice, fees: fill.fees,
      feeRate: fill.feeRate, cost: fill.cost, fills: fill.fills, latencyMs: now - pending.requestedAt,
      bookSequence: record.quotes[pending.side].sequence,
      fillRule: 'Fresh post-delay asks; max 50% displayed depth per level. Remainder cancelled.',
    };
    this.cash -= fill.cost + fill.fees;
    this.orders.unshift(order);
    this.positions.unshift({
      id: `edge-position-${++this.positionSequence}`, orderId: order.id,
      marketId: order.marketId, marketSlug: market.slug, marketTitle: market.title,
      asset: 'BTC', timeframe: '5m', side: pending.side, status: 'OPEN',
      shares: fill.filledShares, requestedShares: fill.requestedShares,
      entryAt: now, entryPrice: fill.averagePrice, totalCost: fill.cost, fees: fill.fees,
      totalEntryFees: fill.fees, estimatedMakerRebate: 0, windowStart: market.start, windowEnd: market.end,
      markBid: record.quotes[pending.side].bestBid, markStatus: 'LIVE', markUpdatedAt: now,
      unrealizedPnl: null, realizedPnl: null, exitPrice: null,
      entryForecast: { estimate: fill.estimate, conservativeProbability: fill.conservativeProbability,
        netEdge: fill.netEdge, allInCost: fill.allInCost, model },
    });
    this.markPositions(now);
    this.updateAccountMetrics(now, true);
    this.recordDecision('BOUGHT',
      `${pending.side}: ${fill.filledShares.toFixed(2)} shares at $${fill.averagePrice.toFixed(4)}, fees $${fill.fees.toFixed(3)}.`,
      now, { model, side: pending.side, candidates: [fill] });
    this.log(this.latestDecision.reason, { side: pending.side, type: 'EDGE_BUY', now });
  }

  markPositions(now) {
    for (const p of this.positions) {
      if (p.status !== 'OPEN') continue;
      const record = this.records.get('BTC:5m');
      const market = record?.market;
      const q = record?.quotes[p.side];
      if (!market || market.id !== p.marketId || now >= market.end
        || !freshQuote(q, market, p.side, now)) {
        p.markStatus = 'LAST_KNOWN_ESTIMATE';
        p.unrealizedPnl = null;
        continue;
      }
      // Net executable bid VWAP, not a midpoint windfall. Missing depth is
      // valued at zero for the unliquidatable remainder, without closing it.
      let remaining = p.shares;
      let value = 0;
      const rate = marketFee(market)?.rate;
      if (rate == null) { p.markStatus = 'FEE_UNKNOWN'; continue; }
      for (const level of [...q.bids].sort((a, b) => b.price - a.price)) {
        const n = Math.min(remaining, level.size * RULES.depthParticipation);
        value += n * (level.price - rate * level.price * (1 - level.price));
        remaining -= n;
        if (remaining <= 1e-8) break;
      }
      p.markBid = value / p.shares;
      p.markStatus = remaining > 1e-8 ? 'THIN_BOOK_ESTIMATE' : 'LIVE';
      p.markUpdatedAt = now;
      p.unrealizedPnl = value - p.totalCost - p.fees;
    }
  }

  expireMarket(record, now) {
    const market = record.market;
    if (market && !this.windowSummaries.some(w => w.marketId === String(market.id))) {
      const positions = this.positions.filter(p => p.marketId === String(market.id));
      this.windowSummaries.push({ marketId: String(market.id), end: market.end,
        start: market.start, traded: positions.length > 0,
        lastReason: this.latestDecision?.reason || 'No eligible entry.' });
    }
    super.expireMarket(record, now);
  }

  settleMarket(marketId, winner, now) {
    super.settleMarket(marketId, winner, now);
    this.scheduleLedgerSave();
  }

  statistics() {
    const settled = this.positions.filter(p => p.resolutionWinner);
    const brier = settled.length ? settled.reduce((sum, p) =>
      sum + (p.entryForecast.estimate - (p.side === p.resolutionWinner ? 1 : 0)) ** 2, 0) / settled.length : null;
    return {
      decisionCount: this.decisionCount, skipCounts: this.skipCounts,
      skippedWindows: this.windowSummaries.filter(w => !w.traded).length,
      tradedWindows: new Set(this.positions.map(p => p.marketId)).size,
      historicalFallbackEntries: this.positions.filter(p => p.cadenceFallback).length,
      settledWindows: new Set(settled.map(p => p.marketId)).size,
      brierScore: brier,
      meanForecast: settled.length ? settled.reduce((s, p) => s + p.entryForecast.estimate, 0) / settled.length : null,
      observedWinRate: settled.length ? settled.filter(p => p.side === p.resolutionWinner).length / settled.length : null,
      sampleLabel: 'unproven',
    };
  }

  snapshot() {
    const state = super.snapshot();
    const feed = this.binanceFeed.snapshot();
    return {
      ...state, mode: 'PAPER ONLY', strategy: STRATEGY, sizingByAsset: undefined,
      markets: state.markets.map(m => ({ ...m,
        sideStates: Object.fromEntries(['UP', 'DOWN'].map(side => {
          const q = this.records.get('BTC:5m').quotes[side];
          return [side, { bestBid: q.bestBid, bestAsk: q.bestAsk, mid: q.mid,
            fresh: Boolean(this.records.get('BTC:5m').market
              && freshQuote(q, this.records.get('BTC:5m').market, side, state.now)),
            ageMs: q.updatedAt == null ? null : Math.max(0, state.now - q.updatedAt) }];
        })) })),
      edgeEngine: {
        phase: this.latestDecision?.code || 'WARMING_UP', reason: this.statusReason,
        latestDecision: this.latestDecision, recentDecisions: this.recentDecisions,
        risk: this.riskSnapshot(), statistics: this.statistics(),
        feed: { status: feed.status, historyStatus: feed.historyStatus,
          price: feed.price, tickAt: feed.tickAt, messageAgeMs: feed.messageAgeMs,
          closedCandles: feed.closedCandles?.slice(-10) || [] },
      },
    };
  }

  exportLedger() {
    const snapshot = this.snapshot();
    snapshot.positions = this.positions;
    snapshot.orders = this.orders;
    snapshot.windowSummaries = this.windowSummaries;
    return { strategyId: RULES.id, schemaVersion: 1, savedAt: this.now(), snapshot };
  }

  restoreLedger(ledger) {
    const snapshot = ledger?.snapshot;
    if (snapshot?.strategy?.id !== RULES.id) throw new Error('Incompatible edge paper ledger.');
    super.restoreLedger({ snapshot: { ...snapshot, strategy: { id: BASE_ID } } });
    this.windowSummaries = snapshot.windowSummaries || [];
    this.riskStopped = Boolean(snapshot.edgeEngine?.risk?.riskStopped);
    this.decisionCount = Number(snapshot.edgeEngine?.statistics?.decisionCount || 0);
    this.skipCounts = snapshot.edgeEngine?.statistics?.skipCounts || {};
    this.recentDecisions = snapshot.edgeEngine?.recentDecisions || [];
    this.latestDecision = null;
    this.pendingEntry = null; // Never replay an unexecuted paper signal after a restart.
    this.confirmation = null;
  }
}

SelectiveEdgeBot.STRATEGY = STRATEGY;
module.exports = SelectiveEdgeBot;
