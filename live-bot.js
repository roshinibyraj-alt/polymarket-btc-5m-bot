'use strict';

const cfg = require('./config');
const {
  WINDOW_CONFIG,
  STRATEGY_TIMEFRAMES,
  ENTRY_RUNGS,
  TAKE_PROFIT_BID,
  STOP_LOSS_BID,
  EXIT_START_SECONDS,
  STRATEGY_VERSION,
  evaluateWindow,
  evaluateSourceExit,
  resolvedMarketPayout,
  quoteFromBook,
  windowStartFor,
} = require('./live-strategy');

const TIMEFRAMES = STRATEGY_TIMEFRAMES;
const TERMINAL = new Set(['MATCHED', 'FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED']);
const ACTIVE = new Set(['LIVE', 'OPEN', 'PENDING', 'PARTIALLY FILLED', 'PARTIALLY MATCHED']);
const MIN_SELL_SHARES = Number(cfg.LIVE_MIN_SELL_SHARES || 5);
// Continue managing already-open orders from the retired two-sided strategy.
const LEGACY_WINDOW_START_ENTRY_PRICE = Number(cfg.LIVE_WINDOW_START_ENTRY_PRICE || 0.30);
const LEGACY_WINDOW_START_ENTRY_SHARES = Number(cfg.LIVE_WINDOW_START_ENTRY_SHARES || 20);
const LEGACY_WINDOW_START_TAKE_PROFIT_PRICE = Number(cfg.LIVE_WINDOW_START_TAKE_PROFIT_PRICE || 0.99);
const LEGACY_ENTRY_RUNGS = [
  { price: 0.25, takeProfitPrice: 0.75 },
  { price: 0.15, takeProfitPrice: 0.85 },
];
const CANCEL_FINAL_FILL_CHECKS = Math.max(1, Number(cfg.LIVE_CANCEL_FINAL_FILL_CHECKS || 3));
const ORDER_POLL_MS = Number(cfg.LIVE_ORDER_POLL_MS || 500);
const ACCOUNT_REFRESH_MS = Number(cfg.LIVE_BALANCE_REFRESH_MS || 15_000);
const RESOLUTION_RETRY_MS = 10_000;
const FLOW_TEST_BUY_PRICE = Number(cfg.LIVE_FLOW_TEST_BUY_PRICE || 0.70);
const FLOW_TEST_TAKE_PROFIT_PRICE = Number(cfg.LIVE_FLOW_TEST_TAKE_PROFIT_PRICE || 0.75);
const FLOW_TEST_SHARES = Number(cfg.LIVE_FLOW_TEST_SHARES || MIN_SELL_SHARES);

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function orderStatus(order) {
  return String(order?.status || order?.state || 'UNKNOWN').toUpperCase().replaceAll('_', ' ');
}

function isTerminalStatus(status) {
  const normalized = String(status || '').toUpperCase().replaceAll('_', ' ');
  return TERMINAL.has(normalized)
    || normalized.startsWith('CANCELED ')
    || normalized.startsWith('CANCELLED ')
    || normalized.includes('MARKET RESOLVED');
}

function needsFillConfirmation(order) {
  const status = orderStatus(order);
  return (['MATCHED', 'FILLED'].includes(status)
    && numeric(order?.matchedShares) < numeric(order?.shares))
    || numeric(order?.pendingFinalFillChecks) > 0;
}

function resolvedMarketSlugs(orders) {
  return new Set([...orders]
    .filter(order => /MARKET RESOLVED/i.test(String(order.status || '')))
    .map(order => order.slug)
    .filter(Boolean));
}

function matchedSize(order) {
  return Math.max(0, numeric(
    order?.sizeMatched ?? order?.size_matched ?? order?.matchedSize ?? order?.matched_size,
    0,
  ));
}

function orderId(order) {
  return order?.id || order?.orderId || order?.order_id || null;
}

function retryAfterMs(error) {
  return Math.max(0, numeric(error?.retryAfterMs, 0));
}

function isInsufficientBalance(error) {
  return /insufficient|not enough balance|allowance/i.test(String(error?.message || error));
}

function normalizedSlug(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.slug || value.question || value.title || '';
  return '';
}

function windowFromSlug(slug) {
  const match = String(slug || '').match(/btc-updown-(5m|15m)-(\d+)/i);
  if (!match) return null;
  const timeframe = match[1].toLowerCase();
  const start = Number(match[2]) * 1000;
  return { timeframe, start, end: start + WINDOW_CONFIG[timeframe] };
}

function recoveredOrder(raw) {
  const id = orderId(raw);
  const side = String(raw?.side || '').toUpperCase();
  const price = numeric(raw?.price, NaN);
  const size = numeric(raw?.originalSize ?? raw?.original_size ?? raw?.size, NaN);
  const matched = matchedSize(raw);
  const tokenId = raw?.assetId || raw?.asset_id || raw?.tokenId || raw?.token_id || null;
  const slug = normalizedSlug(raw?.market) || raw?.slug || raw?.marketSlug || raw?.market_slug || '';
  const window = windowFromSlug(slug);
  let kind = null;
  let takeProfitPrice = null;
  let entryType = null;
  let pairedEntryGroup = null;
  if (side === 'BUY') {
    const rung = ENTRY_RUNGS.find(item => Math.abs(item.price - price) < 0.000001);
    const legacyRung = LEGACY_ENTRY_RUNGS.find(item => Math.abs(item.price - price) < 0.000001);
    const openingPair = Math.abs(price - LEGACY_WINDOW_START_ENTRY_PRICE) < 0.000001
      && Math.abs(size - LEGACY_WINDOW_START_ENTRY_SHARES) < 0.000001;
    if (openingPair) {
      kind = 'ENTRY';
      entryType = 'WINDOW_START_PAIR';
      pairedEntryGroup = `window-start-pair:${slug}`;
      takeProfitPrice = LEGACY_WINDOW_START_TAKE_PROFIT_PRICE;
    } else if (rung) {
      kind = 'ENTRY';
      entryType = 'MIDPOINT_TRIGGER_LADDER';
    } else if (legacyRung) {
      kind = 'ENTRY';
      entryType = 'LEGACY_MIDPOINT_LADDER';
      takeProfitPrice = legacyRung.takeProfitPrice;
    }
  } else if (side === 'SELL') {
    if ([TAKE_PROFIT_BID, LEGACY_WINDOW_START_TAKE_PROFIT_PRICE, 0.75, 0.85, 0.999]
      .some(value => Math.abs(value - price) < 0.000001)) {
      kind = 'TAKE_PROFIT';
    } else if (Math.abs(STOP_LOSS_BID - price) < 0.000001) {
      kind = 'STOP_LOSS';
    }
  }
  if (!id || !tokenId || !kind || !Number.isFinite(size)) return null;
  return {
    id,
    clientKey: `recovered:${id}`,
    kind,
    entryType,
    pairedEntryGroup,
    side,
    tokenId: String(tokenId),
    marketId: raw?.marketId || raw?.market_id || null,
    price,
    shares: size,
    matchedShares: matched,
    fillConfirmedAt: raw?.fillConfirmedAt === null || raw?.fillConfirmedAt === undefined
      ? null
      : numeric(raw.fillConfirmedAt, null),
    takeProfitPrice,
    slug,
    timeframe: window?.timeframe || null,
    outcome: raw?.outcome || raw?.outcomeName || raw?.outcome_name || null,
    windowStart: window?.start ?? null,
    windowEnd: window?.end ?? null,
    status: orderStatus(raw),
    pendingFinalFillChecks: 0,
    recovered: true,
    exits: [],
    exitSubmittingShares: 0,
    retryAt: 0,
    error: null,
    createdAt: numeric(raw?.createdAt ?? raw?.created_at, Date.now()),
  };
}

class LiveBot {
  constructor({
    trader = null,
    marketData,
    stateStore = null,
    requirePersistentState = false,
    tradingEnabled = false,
    flowTestEnabled = false,
    clock = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    marketPollMs = 1_000,
    accountRefreshMs = ACCOUNT_REFRESH_MS,
    orderPollMs = ORDER_POLL_MS,
  } = {}) {
    if (!marketData?.getBtcMarket || !marketData?.getBook) {
      throw new Error('LiveBot requires BTC market and order-book providers');
    }
    this.trader = trader;
    this.marketData = marketData;
    this.stateStore = stateStore;
    this.requirePersistentState = requirePersistentState === true;
    this.tradingEnabled = tradingEnabled === true;
    this.flowTestEnabled = flowTestEnabled === true;
    this.clock = clock;
    this.setInterval = setIntervalFn;
    this.clearInterval = clearIntervalFn;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.marketPollMs = marketPollMs;
    this.accountRefreshMs = accountRefreshMs;
    this.orderPollMs = orderPollMs;
    this.startedAt = this.clock();
    this.running = false;
    this.stateReady = !this.tradingEnabled;
    this.authenticated = false;
    this.bootstrapping = false;
    this.marketScanInFlight = false;
    this.orderScanInFlight = false;
    this.accountScanInFlight = false;
    this.marketTimer = null;
    this.orderTimer = null;
    this.accountTimer = null;
    this.markets = Object.fromEntries(TIMEFRAMES.map(timeframe => [timeframe, this.newMarketState(timeframe)]));
    this.ordersById = new Map();
    this.entryKeys = new Set();
    this.flowTestState = {
      status: this.flowTestEnabled ? 'armed' : 'disabled',
      armedAt: null,
      windowStart: null,
      windowEnd: null,
      slug: null,
      side: null,
      orderClientKey: null,
      orderId: null,
      takeProfitOrderId: null,
      result: null,
      error: null,
      completedAt: null,
    };
    this.account = {
      status: this.tradingEnabled ? 'reconciling' : 'live_trading_disabled',
      accountReady: false,
      snapshotHealthy: false,
      snapshotError: null,
      error: null,
      failures: 0,
      collateral: null,
      positionValue: null,
      equity: null,
      positions: [],
      openOrders: [],
      untrackedOpenOrders: 0,
      asOf: null,
      lastSuccessAt: null,
      nextRetryAt: null,
    };
    this.orderError = null;
    this.halted = false;
    this.events = [];
    this.lastError = null;
    this.resolutionPollAt = new Map();
  }

  async restoreState(document) {
    this.entryKeys = new Set(document.entryKeys || []);
    const savedFlowTest = document.flowTest;
    if (savedFlowTest && typeof savedFlowTest === 'object') {
      this.flowTestState = { ...this.flowTestState, ...savedFlowTest };
    }
    if (this.flowTestEnabled
      && (!savedFlowTest || ['disabled', 'not_armed'].includes(this.flowTestState.status))) {
      this.flowTestState = {
        ...this.flowTestState,
        status: 'armed',
        armedAt: this.startedAt,
        result: null,
        error: null,
        completedAt: null,
      };
    } else if (!this.flowTestEnabled
      && !['disabled', 'complete'].includes(this.flowTestState.status)) {
      this.flowTestState.status = 'disabled';
      this.flowTestState.result = 'disabled_by_configuration';
    }
    for (const timeframe of TIMEFRAMES) {
      const saved = document.markets?.[timeframe];
      if (!saved || saved.windowStart === null || saved.windowStart === undefined
        || saved.windowEnd === null || saved.windowEnd === undefined
        || !Number.isFinite(Number(saved.windowStart))
        || !Number.isFinite(Number(saved.windowEnd)) || Number(saved.windowEnd) <= this.clock()) continue;
      const pendingTrigger = saved.pendingTrigger;
      const validPendingTrigger = pendingTrigger?.evaluation?.eligible === true
        && pendingTrigger.evaluation.strategyVersion === STRATEGY_VERSION
        && pendingTrigger.windowStart !== null && pendingTrigger.windowStart !== undefined
        && pendingTrigger.windowEnd !== null && pendingTrigger.windowEnd !== undefined
        && Number(pendingTrigger.windowStart) === Number(saved.windowStart)
        && Number(pendingTrigger.windowEnd) === Number(saved.windowEnd)
        ? pendingTrigger
        : null;
      const restored = this.newMarketState(timeframe);
      restored.windowStart = Number(saved.windowStart);
      restored.windowEnd = Number(saved.windowEnd);
      restored.slug = typeof saved.slug === 'string' ? saved.slug : null;
      restored.title = typeof saved.title === 'string' ? saved.title : null;
      restored.pendingTrigger = validPendingTrigger;
      restored.legacyWindowStartPairStatus = saved.windowStartPairPending === true
        ? 'retired_by_strategy'
        : typeof saved.windowStartPairStatus === 'string'
          ? saved.windowStartPairStatus
          : 'not_applicable';
      restored.triggeredAt = saved.triggeredAt !== null && saved.triggeredAt !== undefined
        && Number.isFinite(Number(saved.triggeredAt)) ? Number(saved.triggeredAt) : null;
      restored.orderIds = Array.isArray(saved.orderIds) ? saved.orderIds.map(String) : [];
      if (saved.signal && typeof saved.signal === 'object') restored.signal = saved.signal;
      this.markets[timeframe] = restored;
    }
    const byReference = new Map();
    for (const saved of document.orders || []) {
      const { exitRefs = [], ...fields } = saved;
      const order = { ...fields, exits: [] };
      order.pendingFinalFillChecks = Math.max(0, numeric(order.pendingFinalFillChecks));
      const reference = order.id || order.clientKey;
      if (!reference) continue;
      this.ordersById.set(String(reference), order);
      byReference.set(String(reference), order);
      order._exitRefs = exitRefs;
      if (!order.id && ['SUBMITTING', 'SUBMISSION_UNCERTAIN'].includes(order.status)) {
        order.status = 'SUBMISSION_UNCERTAIN';
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = 'Persisted order submission has no exchange ID; manual reconciliation is required';
      }
    }
    for (const order of this.ordersById.values()) {
      if (order.kind === 'ENTRY'
        && order.matchedShares > 0
        && (order.fillConfirmedAt === null || order.fillConfirmedAt === undefined
          || !Number.isFinite(Number(order.fillConfirmedAt)))) {
        order.fillConfirmedAt = this.clock();
      }
      order.exits = (order._exitRefs || []).map(reference => byReference.get(String(reference))).filter(Boolean);
      delete order._exitRefs;
    }
  }

  async persistState() {
    if (!this.stateStore) {
      if (this.requirePersistentState) throw new Error('Persistent live-order storage is not configured');
      return;
    }
    const orders = [...this.ordersById.values()].map(order => {
      const { exits = [], ...fields } = order;
      return {
        ...fields,
        exitRefs: exits.map(exit => String(exit.id || exit.clientKey)).filter(Boolean),
      };
    });
    await this.stateStore.save({
      version: 1,
      updatedAt: this.clock(),
      entryKeys: [...this.entryKeys],
      orders,
      flowTest: {
        ...this.flowTestState,
        enabled: this.flowTestEnabled,
      },
      markets: Object.fromEntries(TIMEFRAMES.map(timeframe => {
        const state = this.markets[timeframe];
        return [timeframe, {
          windowStart: state.windowStart,
          windowEnd: state.windowEnd,
          slug: state.slug,
          title: state.title,
          pendingTrigger: state.pendingTrigger,
          triggeredAt: state.triggeredAt,
          legacyWindowStartPairStatus: state.legacyWindowStartPairStatus,
          orderIds: state.orderIds,
          signal: state.signal,
        }];
      })),
    });
  }

  flowTestPausesStrategy() {
    return this.flowTestEnabled
      && !['disabled', 'complete'].includes(this.flowTestState.status);
  }

  async completeFlowTest(result, error = null, order = null, exit = null) {
    if (!this.flowTestEnabled || this.flowTestState.status === 'complete') return;
    this.flowTestState.status = 'complete';
    this.flowTestState.result = result;
    this.flowTestState.error = error ? String(error) : null;
    this.flowTestState.completedAt = this.clock();
    if (order?.id) this.flowTestState.orderId = String(order.id);
    if (exit?.id) this.flowTestState.takeProfitOrderId = String(exit.id);
    try {
      await this.persistState();
    } catch (persistError) {
      this.halted = true;
      this.account.accountReady = false;
      this.account.status = 'state_store_error';
      this.account.error = `Could not persist smoke-test completion: ${persistError.message || persistError}`;
    }
    this.log('TEST', 'One-shot live order-flow test finished', {
      result,
      orderId: this.flowTestState.orderId,
      takeProfitOrderId: this.flowTestState.takeProfitOrderId,
      error: this.flowTestState.error,
    });
  }

  async maybeRunFlowTest(state, now) {
    if (!this.flowTestEnabled || state.timeframe !== '5m'
      || !this.flowTestPausesStrategy() || this.halted
      || !this.account.accountReady || !this.trader) return;

    const flowTest = this.flowTestState;
    if (!['armed', 'waiting_for_next_window', 'waiting_for_quote'].includes(flowTest.status)) return;
    if (!Number.isFinite(Number(flowTest.armedAt))) flowTest.armedAt = this.startedAt;
    if (state.windowStart < flowTest.armedAt) {
      flowTest.status = 'waiting_for_next_window';
      return;
    }

    if (flowTest.windowStart === null || flowTest.windowStart === undefined) {
      flowTest.windowStart = state.windowStart;
      flowTest.windowEnd = state.windowEnd;
      flowTest.slug = state.slug;
      flowTest.status = 'waiting_for_quote';
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.status = 'state_store_error';
        this.account.error = `Could not persist the smoke-test window: ${error.message || error}`;
        flowTest.status = 'state_store_error';
        flowTest.error = this.account.error;
        return;
      }
    } else if (Number(flowTest.windowStart) !== Number(state.windowStart)) {
      await this.completeFlowTest('window_ended_without_fillable_quote');
      return;
    }

    if (now >= Number(flowTest.windowEnd)) {
      await this.completeFlowTest('window_ended_without_fillable_quote');
      return;
    }

    for (const outcome of ['UP', 'DOWN']) {
      const quote = state.quotes[outcome];
      const ask = Number(quote?.bestAsk);
      const askSize = Number(quote?.askSize);
      const updatedAt = Number(quote?.updatedAt);
      const fresh = quote?.status === 'LIVE' && quote?.stale !== true
        && Number.isFinite(updatedAt) && updatedAt <= now && now - updatedAt <= 5_000;
      if (!fresh || !Number.isFinite(ask) || ask <= 0 || ask > FLOW_TEST_BUY_PRICE
        || !Number.isFinite(askSize) || askSize < FLOW_TEST_SHARES) continue;

      const tokenId = state.market?.tokens?.[outcome];
      if (!tokenId) continue;
      const clientKey = `${state.slug}:FLOW_TEST:${outcome}`;
      const order = {
        id: null,
        clientKey,
        kind: 'ENTRY',
        side: 'BUY',
        outcome,
        tokenId: String(tokenId),
        price: FLOW_TEST_BUY_PRICE,
        shares: FLOW_TEST_SHARES,
        matchedShares: 0,
        takeProfitPrice: FLOW_TEST_TAKE_PROFIT_PRICE,
        slug: state.slug,
        timeframe: '5m',
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        status: 'SUBMITTING',
        recovered: false,
        testOnly: true,
        exits: [],
        exitSubmittingShares: 0,
        retryAt: 0,
        error: null,
        createdAt: now,
      };

      flowTest.status = 'submitting';
      flowTest.side = outcome;
      flowTest.orderClientKey = clientKey;
      flowTest.orderId = null;
      flowTest.error = null;
      state.triggeredAt = now;
      state.orderIds.push(clientKey);
      state.signal = {
        eligible: false,
        status: 'flow_test_submitting',
        reason: `Submitting one ${FLOW_TEST_SHARES}-share diagnostic BUY at $${FLOW_TEST_BUY_PRICE.toFixed(2)}`,
      };
      this.ordersById.set(clientKey, order);
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.status = 'state_store_error';
        this.account.error = `Could not persist the smoke-test order before submission: ${error.message || error}`;
        flowTest.status = 'state_store_error';
        flowTest.error = this.account.error;
        return;
      }

      await this.submitEntry(order);
      flowTest.orderId = order.id || null;
      if (order.status === 'REJECTED') {
        await this.completeFlowTest('entry_rejected', order.error, order);
      } else if (order.status === 'SUBMISSION_UNCERTAIN') {
        flowTest.status = 'submission_uncertain';
        flowTest.error = order.error || 'The exchange did not confirm whether the test BUY was accepted';
        await this.persistState();
      } else {
        flowTest.status = 'awaiting_fill';
        await this.persistState();
      }
      this.log('TEST', 'Submitted one-shot live smoke-test BUY', {
        slug: order.slug,
        outcome,
        limitPrice: order.price,
        shares: order.shares,
        maxNotional: Number((order.price * order.shares).toFixed(2)),
        orderId: order.id,
      });
      return;
    }
  }

  newMarketState(timeframe) {
    return {
      timeframe,
      windowMs: WINDOW_CONFIG[timeframe],
      windowStart: null,
      windowEnd: null,
      slug: null,
      title: null,
      market: null,
      quotes: { UP: null, DOWN: null },
      signal: { eligible: false, status: 'starting', reason: 'Waiting for market data' },
      pendingTrigger: null,
      triggeredAt: null,
      legacyWindowStartPairStatus: 'not_applicable',
      orderIds: [],
      lastMarketLookupAt: 0,
      lastQuoteAt: null,
      error: null,
    };
  }

  log(type, message, data = {}) {
    const event = { at: this.clock(), type, message, ...data };
    this.events.unshift(event);
    if (this.events.length > 100) this.events.length = 100;
    return event;
  }

  refreshOrderReadiness() {
    this.account.accountReady = this.tradingEnabled && this.authenticated && !this.halted;
    if (this.account.accountReady) this.account.status = 'ready';
    else if (this.halted) this.account.status = 'halted_reconciliation_required';
    else if (!this.tradingEnabled) this.account.status = 'live_trading_disabled';
    else if (this.account.status !== 'error') this.account.status = 'reconciling';
    return this.account.accountReady;
  }

  start() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.startedAt = this.clock();
    this.marketTimer = this.setInterval(() => { void this.scanMarkets(); }, this.marketPollMs);
    this.orderTimer = this.setInterval(() => { void this.reconcileOrders(); }, this.orderPollMs);
    if (this.tradingEnabled) {
      void this.bootstrapTrading().finally(() => { void this.scanMarkets(); });
    } else {
      void this.scanMarkets();
      this.log('INFO', 'Live order execution is disabled by configuration');
    }
    return this.snapshot();
  }

  stop() {
    this.running = false;
    if (this.marketTimer) this.clearInterval(this.marketTimer);
    if (this.orderTimer) this.clearInterval(this.orderTimer);
    if (this.accountTimer) this.clearTimeout(this.accountTimer);
    this.marketTimer = this.orderTimer = this.accountTimer = null;
  }

  async bootstrapTrading() {
    if (this.bootstrapping || !this.tradingEnabled) return;
    this.bootstrapping = true;
    this.stateReady = false;
    if (!this.trader) {
      this.account.status = 'error';
      this.account.error = 'Live trading is enabled but no exchange client is configured';
      this.lastError = this.account.error;
      this.bootstrapping = false;
      return;
    }
    try {
      if (this.requirePersistentState && this.stateStore?.durable !== true) {
        throw new Error('Persistent live-order storage is required before real trading can start');
      }
      if (this.stateStore) {
        const saved = await this.stateStore.load();
        if (saved) await this.restoreState(saved);
        await this.persistState();
      }
      this.stateReady = true;
      await this.trader.authenticate();
      this.authenticated = true;
      this.refreshOrderReadiness();
      await this.recoverOpenOrders();
      await this.refreshAccountSnapshot();
      if (this.account.accountReady) {
        const resolvedSlugs = resolvedMarketSlugs(this.ordersById.values());
        for (const order of this.ordersById.values()) {
          if (order.kind === 'ENTRY'
            && order.matchedShares > 0
            && !resolvedSlugs.has(order.slug)) {
            if (order.pairedEntryGroup) await this.cancelPairedEntryOrders(order);
            if (order.entryType === 'MIDPOINT_TRIGGER_LADDER') {
              await this.maybeSubmitSourceExit(order);
            } else if (order.testOnly) {
              await this.maybeSubmitTakeProfit(order);
            }
          }
        }
      }
    } catch (error) {
      this.account.error = error.message || String(error);
      this.refreshOrderReadiness();
      if (!this.account.accountReady && !this.halted) this.account.status = 'error';
      this.lastError = this.account.error;
      this.log('ERROR', 'Live account initialization failed', { error: this.account.error });
      this.scheduleAccountRefresh(Math.max(1_000, retryAfterMs(error)));
    } finally {
      this.bootstrapping = false;
    }
  }

  scheduleAccountRefresh(delayMs = this.accountRefreshMs) {
    if (!this.running || !this.tradingEnabled) return;
    if (this.accountTimer) this.clearTimeout(this.accountTimer);
    this.accountTimer = this.setTimeout(() => {
      this.accountTimer = null;
      void this.refreshAccountSnapshot();
    }, Math.max(250, delayMs));
  }

  async recoverOpenOrders() {
    if (!this.trader?.listOpenOrders) return;
    try {
      const response = await this.trader.listOpenOrders();
      const rows = Array.isArray(response) ? response : (response?.orders || []);
      let untracked = 0;
      for (const raw of rows) {
        const id = orderId(raw);
        if (!id || this.ordersById.has(String(id))) continue;
        const restored = recoveredOrder(raw);
        if (!restored || !restored.slug || (restored.kind === 'ENTRY' && !restored.windowEnd)) {
          untracked++;
          continue;
        }
        this.ordersById.set(String(id), restored);
        if (restored.kind === 'ENTRY' && restored.matchedShares > 0
          && (restored.fillConfirmedAt === null || restored.fillConfirmedAt === undefined)) {
          restored.fillConfirmedAt = this.clock();
        }
        this.log('RECOVERY', 'Recovered an exchange order after process start', {
          orderId: String(id),
          side: restored.side,
          kind: restored.kind,
          price: restored.price,
        });
      }
      this.account.untrackedOpenOrders = untracked;
      this.account.openOrders = rows;
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        throw error;
      }
      if (untracked) {
        this.account.error = `${untracked} open exchange order(s) could not be classified safely`;
      }
      this.refreshOrderReadiness();
    } catch (error) {
      this.account.error = `Open-order recovery failed: ${error.message || error}`;
      this.refreshOrderReadiness();
      this.lastError = this.account.error;
      this.log('WARNING', 'Open-order recovery failed; account snapshot does not gate the order path', {
        error: this.account.error,
      });
    }
  }

  async refreshAccountSnapshot() {
    if (!this.running || !this.tradingEnabled || !this.authenticated) return;
    if (this.accountScanInFlight) return;
    this.accountScanInFlight = true;
    try {
      const snapshot = await this.trader.getEquitySnapshot();
      const rows = Array.isArray(snapshot?.orders) ? snapshot.orders : [];
      let untracked = 0;
      for (const raw of rows) {
        const id = orderId(raw);
        if (!id || this.ordersById.has(String(id))) continue;
        const restored = recoveredOrder(raw);
        if (!restored || !restored.slug || (restored.kind === 'ENTRY' && !restored.windowEnd)) {
          untracked++;
          continue;
        }
        this.ordersById.set(String(id), restored);
        if (restored.kind === 'ENTRY' && restored.matchedShares > 0
          && (restored.fillConfirmedAt === null || restored.fillConfirmedAt === undefined)) {
          restored.fillConfirmedAt = this.clock();
        }
        this.log('RECOVERY', 'Recovered an exchange order from the account snapshot', {
          orderId: String(id),
          side: restored.side,
          kind: restored.kind,
          price: restored.price,
        });
      }
      this.account.collateral = snapshot.collateral ?? null;
      this.account.positionValue = snapshot.positionValue ?? null;
      this.account.equity = snapshot.equity ?? null;
      this.account.positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
      this.account.openOrders = rows;
      this.account.untrackedOpenOrders = untracked;
      this.account.asOf = snapshot.asOf || new Date(this.clock()).toISOString();
      this.account.lastSuccessAt = this.clock();
      this.account.snapshotHealthy = true;
      this.account.snapshotError = null;
      this.account.failures = 0;
      this.account.nextRetryAt = null;
      this.account.error = untracked
        ? `${untracked} open exchange order(s) could not be classified safely`
        : this.orderError || null;
      this.refreshOrderReadiness();
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        throw error;
      }
      if (this.account.accountReady && !this.account.error) this.lastError = null;
      this.log('ACCOUNT', 'Account snapshot refreshed; CLOB order readiness is independent', {
        openOrders: rows.length,
        untrackedOpenOrders: untracked,
      });
      this.scheduleAccountRefresh(this.accountRefreshMs);
    } catch (error) {
      this.account.snapshotHealthy = false;
      this.account.snapshotError = error.message || String(error);
      this.account.failures++;
      this.account.error = this.orderError || this.account.snapshotError;
      this.refreshOrderReadiness();
      this.lastError = this.account.error;
      if (!this.account.accountReady && !this.halted) this.account.status = 'error';
      const backoff = Math.min(15_000, 1_000 * (2 ** Math.min(this.account.failures - 1, 4)));
      const delay = Math.max(backoff, retryAfterMs(error));
      this.account.nextRetryAt = this.clock() + delay;
      this.log('WARNING', 'Account snapshot failed; authenticated CLOB order readiness remains independent', {
        error: this.account.error,
        retryInMs: delay,
        failures: this.account.failures,
      });
      this.scheduleAccountRefresh(delay);
    } finally {
      this.accountScanInFlight = false;
    }
  }

  async scanMarkets() {
    if (!this.running || this.marketScanInFlight || (this.tradingEnabled && !this.stateReady)) return;
    this.marketScanInFlight = true;
    try {
      const now = this.clock();
      for (const timeframe of TIMEFRAMES) {
        await this.scanTimeframe(timeframe, now);
      }
    } catch (error) {
      this.lastError = error.message || String(error);
      this.log('ERROR', 'Market scan failed', { error: this.lastError });
    } finally {
      this.marketScanInFlight = false;
    }
  }

  async scanTimeframe(timeframe, now) {
    if (!TIMEFRAMES.includes(timeframe)) return;
    if (this.tradingEnabled && !this.stateReady) return;
    const state = this.markets[timeframe];
    const windowStart = windowStartFor(now, timeframe);
    if (state.windowStart !== windowStart) {
      const next = this.newMarketState(timeframe);
      next.windowStart = windowStart;
      next.windowEnd = windowStart + WINDOW_CONFIG[timeframe];
      next.slug = `btc-updown-${timeframe}-${Math.floor(windowStart / 1000)}`;
      next.signal = {
        eligible: false,
        status: windowStart < this.startedAt ? 'skipped_restart_window' : 'watching',
        reason: windowStart < this.startedAt
          ? 'Window was already open when this process started'
          : 'Waiting for market data',
      };
      this.markets[timeframe] = next;
      this.log('WINDOW', `${timeframe} window changed`, { slug: next.slug, windowStart });
    }

    const current = this.markets[timeframe];
    if (!current.market && now - current.lastMarketLookupAt >= 5_000) {
      current.lastMarketLookupAt = now;
      try {
        current.market = await this.marketData.getBtcMarket(windowStart, WINDOW_CONFIG[timeframe]);
        if (current.market) {
          current.slug = current.market.slug || current.slug;
          current.title = current.market.title || current.slug;
        }
      } catch (error) {
        current.error = error.message || String(error);
      }
    }

    if (!current.market) {
      current.signal = {
        eligible: false,
        status: 'waiting_for_market',
        reason: current.error || 'Waiting for BTC market discovery',
      };
      return;
    }

    const results = await Promise.allSettled([
      this.marketData.getBook(current.market.tokens.UP),
      this.marketData.getBook(current.market.tokens.DOWN),
    ]);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 'UP' : 'DOWN';
      const result = results[i];
      if (result.status === 'fulfilled') {
        current.quotes[side] = quoteFromBook(result.value, now);
      } else {
        const previous = current.quotes[side];
        current.quotes[side] = previous
          ? { ...previous, stale: true, error: result.reason?.message || String(result.reason) }
          : {
            status: 'ERROR', bestBid: null, bestAsk: null, mid: null,
            bidSize: 0, askSize: 0, updatedAt: null, stale: true,
            error: result.reason?.message || String(result.reason),
          };
      }
    }
    current.lastQuoteAt = now;
    current.error = null;
    const evaluation = evaluateWindow({
      now,
      market: current.market,
      quotes: current.quotes,
      startedAt: current.pendingTrigger ? null : this.startedAt,
    });
    if (this.flowTestPausesStrategy()) {
      if (timeframe === '5m') await this.maybeRunFlowTest(current, now);
      if (this.flowTestPausesStrategy()) {
        const waitingForFill = ['awaiting_fill', 'submitting'].includes(this.flowTestState.status);
        current.signal = {
          ...evaluation,
          eligible: false,
          status: waitingForFill ? 'flow_test_order_pending' : 'flow_test_paused',
          reason: this.flowTestState.error
            || (waitingForFill
              ? 'Normal entries are paused while the diagnostic BUY and confirmed-fill SELL are checked'
              : 'Normal entries are paused for the one-shot live order-flow test'),
        };
        if (now >= current.windowEnd) await this.cancelWindowEntryOrders(current);
        return;
      }
    }
    if (evaluation.eligible && !current.pendingTrigger && !current.triggeredAt
      && this.tradingEnabled && !this.flowTestPausesStrategy()) {
      current.pendingTrigger = {
        observedAt: now,
        windowStart: current.windowStart,
        windowEnd: current.windowEnd,
        slug: current.slug,
        evaluation: { ...evaluation },
      };
      current.signal = {
        ...evaluation,
        status: 'trigger_latched',
        reason: 'The first qualifying fresh-price tick is saved until this window ends',
      };
      this.log('SIGNAL', 'Qualifying midpoint tick latched for this window', {
        slug: current.slug,
        timeframe,
        windowStart: current.windowStart,
        windowEnd: current.windowEnd,
        qualifyingSides: evaluation.qualifyingSides,
        upMid: evaluation.upMid,
        downMid: evaluation.downMid,
      });
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.refreshOrderReadiness();
        this.account.status = 'state_store_error';
        this.account.error = `Could not persist the qualifying trigger: ${error.message || error}`;
        current.signal = { ...evaluation, status: 'state_store_error', reason: this.account.error };
        this.log('ERROR', 'Qualifying trigger was not submitted because it could not be saved', {
          slug: current.slug,
          error: this.account.error,
        });
        return;
      }
    }

    const triggerEvaluation = current.pendingTrigger?.evaluation || evaluation;
    if (current.triggeredAt) {
      current.signal = {
        ...triggerEvaluation,
        eligible: true,
        status: 'triggered_once',
        reason: 'Order set already triggered for this window; entry rearm is disabled',
      };
    } else if (current.pendingTrigger) {
      current.signal = {
        ...triggerEvaluation,
        status: 'trigger_latched',
        reason: 'A qualifying price tick is saved until this window ends',
      };
      if (!this.tradingEnabled) {
        current.signal = { ...current.signal, status: 'eligible_live_disabled', reason: 'Signal is saved, but live trading is disabled' };
      } else if (this.flowTestPausesStrategy()) {
        current.signal = { ...current.signal, status: 'flow_test_paused', reason: 'Normal entries are paused for the live order-flow test' };
      } else if (!this.account.accountReady || this.halted) {
        current.signal = {
          ...current.signal,
          status: 'trigger_latched_waiting_order_path',
          reason: this.account.error || 'Waiting for Polymarket authentication or safe order recovery',
        };
      } else {
        await this.fireWindowOrders(current, triggerEvaluation);
      }
    } else if (evaluation.eligible && !this.tradingEnabled) {
      current.signal = { ...evaluation, status: 'eligible_live_disabled', reason: 'Signal is eligible, but live trading is disabled' };
    } else if (evaluation.eligible && this.flowTestPausesStrategy()) {
      current.signal = { ...evaluation, status: 'flow_test_paused', reason: 'Normal entries are paused for the live order-flow test' };
    } else {
      current.signal = evaluation;
    }

    if (now >= current.windowEnd) {
      await this.cancelWindowEntryOrders(current);
    }
  }

  async queueWindowStartPair(state, now) {
    return true;
    if (state.windowStartPairStatus !== 'waiting_for_window_start') return true;
    if (state.windowStart < this.startedAt) {
      state.windowStartPairStatus = 'skipped_restart_window';
      return true;
    }
    if (!this.tradingEnabled) {
      state.windowStartPairStatus = 'live_disabled';
      return true;
    }
    if (now >= state.windowEnd) {
      state.windowStartPairStatus = 'expired';
      return true;
    }

    state.windowStartPairPending = true;
    state.windowStartPairStatus = 'pending';
    try {
      await this.persistState();
      this.log('SIGNAL', 'Window-start paired entry queued for this BTC window', {
        slug: state.slug,
        timeframe: state.timeframe,
        windowStart: state.windowStart,
      });
      return true;
    } catch (error) {
      this.halted = true;
      this.refreshOrderReadiness();
      this.account.status = 'state_store_error';
      this.account.error = `Could not persist the window-start entry intent: ${error.message || error}`;
      state.windowStartPairPending = false;
      state.windowStartPairStatus = 'state_store_error';
      this.log('ERROR', 'Window-start orders were not submitted because their intent could not be saved', {
        slug: state.slug,
        error: this.account.error,
      });
      return false;
    }
  }

  async fireWindowStartPair(state) {
    return;
    if (!state.windowStartPairPending || state.windowStartPairTriggeredAt) return;
    if (this.flowTestPausesStrategy()) {
      state.windowStartPairStatus = 'paused_for_flow_test';
      return;
    }
    if (!this.tradingEnabled) {
      state.windowStartPairStatus = 'live_disabled';
      return;
    }
    if (!this.account.accountReady || this.halted) {
      state.windowStartPairStatus = 'waiting_for_order_path';
      return;
    }
    if (this.clock() >= state.windowEnd) {
      state.windowStartPairPending = false;
      state.windowStartPairStatus = 'expired';
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.refreshOrderReadiness();
        this.account.status = 'state_store_error';
        this.account.error = `Could not persist expired window-start intent: ${error.message || error}`;
        state.windowStartPairStatus = 'state_store_error';
      }
      return;
    }

    const group = `window-start-pair:${state.slug}`;
    const entries = [];
    state.windowStartPairPending = false;
    state.windowStartPairTriggeredAt = this.clock();
    state.windowStartPairStatus = 'submitting';
    for (const outcome of ['UP', 'DOWN']) {
      const clientKey = `${state.slug}:WINDOW_START_PAIR:${outcome}:${WINDOW_START_ENTRY_PRICE.toFixed(2)}`;
      if (this.entryKeys.has(clientKey)) continue;
      this.entryKeys.add(clientKey);
      state.orderIds.push(clientKey);
      const order = {
        id: null,
        clientKey,
        kind: 'ENTRY',
        entryType: 'WINDOW_START_PAIR',
        pairedEntryGroup: group,
        side: 'BUY',
        outcome,
        tokenId: String(state.market.tokens[outcome]),
        price: WINDOW_START_ENTRY_PRICE,
        shares: WINDOW_START_ENTRY_SHARES,
        matchedShares: 0,
        pendingFinalFillChecks: 0,
        takeProfitPrice: WINDOW_START_TAKE_PROFIT_PRICE,
        slug: state.slug,
        timeframe: state.timeframe,
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        status: 'SUBMITTING',
        recovered: false,
        exits: [],
        exitSubmittingShares: 0,
        retryAt: 0,
        error: null,
        createdAt: this.clock(),
      };
      this.ordersById.set(clientKey, order);
      entries.push(order);
    }

    try {
      await this.persistState();
    } catch (error) {
      this.halted = true;
      this.account.accountReady = false;
      this.account.status = 'state_store_error';
      this.account.error = error.message || String(error);
      state.windowStartPairStatus = 'state_store_error';
      this.log('ERROR', 'Window-start buy orders were not sent because the order ledger could not be saved', {
        slug: state.slug,
        error: this.account.error,
      });
      return;
    }

    if (!entries.length) {
      state.windowStartPairStatus = 'already_submitted';
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.status = 'state_store_error';
        this.account.error = `Could not persist the already-submitted window-start pair: ${error.message || error}`;
        state.windowStartPairStatus = 'state_store_error';
      }
      return;
    }
    await Promise.all(entries.map(order => this.submitEntry(order)));
    const uncertain = entries.some(order => order.status === 'SUBMISSION_UNCERTAIN');
    const rejected = entries.some(order => order.status === 'REJECTED');
    state.windowStartPairStatus = uncertain
      ? 'submission_uncertain'
      : rejected ? 'partially_submitted' : 'orders_submitted';
    try {
      await this.persistState();
    } catch (error) {
      this.halted = true;
      this.account.accountReady = false;
      this.account.status = 'state_store_error';
      this.account.error = `Could not persist window-start submission results: ${error.message || error}`;
      state.windowStartPairStatus = 'state_store_error';
    }
    this.log('SIGNAL', 'Window-start paired limit buys submitted', {
      slug: state.slug,
      timeframe: state.timeframe,
      buyPrice: WINDOW_START_ENTRY_PRICE,
      sharesPerSide: WINDOW_START_ENTRY_SHARES,
      takeProfitPrice: WINDOW_START_TAKE_PROFIT_PRICE,
      orderIds: entries.map(order => order.id || order.clientKey),
      status: state.windowStartPairStatus,
    });
  }

  async fireWindowOrders(state, evaluation) {
    if (this.flowTestPausesStrategy()) return;
    if (state.triggeredAt) return;
    if (evaluation?.strategyVersion !== STRATEGY_VERSION) {
      state.signal = {
        ...evaluation,
        eligible: false,
        status: 'stale_strategy_signal',
        reason: 'The saved signal was produced by a different strategy version',
      };
      return;
    }
    const selectedSide = evaluation?.selectedSide;
    if (!['UP', 'DOWN'].includes(selectedSide)) {
      state.signal = {
        ...evaluation,
        eligible: false,
        status: 'invalid_signal',
        reason: 'The trigger did not identify a valid outcome side',
      };
      return;
    }
    if (!state.pendingTrigger) {
      state.pendingTrigger = {
        observedAt: this.clock(),
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        slug: state.slug,
        evaluation: { ...evaluation },
      };
    }
    if (Math.max(this.clock(), Number(state.pendingTrigger.observedAt) || 0) >= state.windowEnd) {
      state.pendingTrigger = null;
      state.signal = {
        ...evaluation,
        status: 'trigger_expired',
        reason: 'The window ended before the latched signal could be submitted',
      };
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.refreshOrderReadiness();
        this.account.status = 'state_store_error';
        this.account.error = `Could not persist expired trigger state: ${error.message || error}`;
        state.signal = { ...evaluation, status: 'state_store_error', reason: this.account.error };
      }
      this.log('WARNING', 'Latched trigger expired before orders could be submitted', {
        slug: state.slug,
        timeframe: state.timeframe,
      });
      return;
    }
    state.triggeredAt = this.clock();
    state.signal = { ...evaluation, status: 'orders_submitting' };
    this.log('SIGNAL', 'Midpoint threshold trigger fired; submitting the selected-side limit ladder once', {
      slug: state.slug,
      selectedSide,
      triggeringPrice: evaluation.triggeringPrice,
      qualifyingSides: evaluation.qualifyingSides,
      upMid: evaluation.upMid,
      downMid: evaluation.downMid,
    });

    const entries = [];
    for (const rung of ENTRY_RUNGS) {
      const clientKey = `${state.slug}:${selectedSide}:${rung.price.toFixed(2)}`;
      if (this.entryKeys.has(clientKey)) continue;
      this.entryKeys.add(clientKey);
      const order = {
        id: null,
        clientKey,
        kind: 'ENTRY',
        entryType: 'MIDPOINT_TRIGGER_LADDER',
        side: 'BUY',
        outcome: selectedSide,
        tokenId: String(state.market.tokens[selectedSide]),
        marketId: String(state.market.id),
        price: rung.price,
        shares: rung.shares,
        matchedShares: 0,
        fillConfirmedAt: null,
        sourceExitKind: null,
        sourceExitLimitPrice: null,
        sourceExitTriggeredAt: null,
        sourceExitTriggerBid: null,
        resolutionStatus: null,
        resolutionLastCheckedAt: null,
        resolutionError: null,
        slug: state.slug,
        timeframe: state.timeframe,
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        status: 'SUBMITTING',
        recovered: false,
        exits: [],
        exitSubmittingShares: 0,
        retryAt: 0,
        error: null,
        createdAt: this.clock(),
      };
      state.orderIds.push(clientKey);
      this.ordersById.set(clientKey, order);
      entries.push(order);
    }
    try {
      await this.persistState();
    } catch (error) {
      this.halted = true;
      this.account.accountReady = false;
      this.account.status = 'state_store_error';
      this.account.error = error.message || String(error);
      state.signal = { ...evaluation, status: 'state_store_error', reason: this.account.error };
      this.log('ERROR', 'Entry orders were not sent because the order ledger could not be saved', { error: this.account.error });
      return;
    }
    await Promise.all(entries.map(order => this.submitEntry(order)));
    state.signal = {
      ...evaluation,
      status: 'orders_submitted',
      reason: `One-shot ${selectedSide} ladder submitted; no entry rearm for this window`,
    };
  }

  async submitEntry(order) {
    try {
      const response = await this.trader.placeLimitOrder(
        order.tokenId,
        'BUY',
        order.price,
        order.shares,
      );
      const id = orderId(response);
      if (!id) {
        order.status = 'SUBMISSION_UNCERTAIN';
        order.error = 'Exchange response did not include an order ID';
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = order.error;
        this.log('ERROR', 'Entry submission is uncertain; new entries halted', { order: order.clientKey });
        return;
      }
      this.ordersById.delete(order.clientKey);
      order.id = String(id);
      order.status = orderStatus(response);
      this.ordersById.set(order.id, order);
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Order was accepted but its ledger update failed: ${error.message || error}`;
      }
      this.log('ORDER', 'Limit buy submitted', {
        orderId: order.id,
        slug: order.slug,
        side: order.outcome,
        price: order.price,
        shares: order.shares,
      });
    } catch (error) {
      order.status = error?.submissionUncertain ? 'SUBMISSION_UNCERTAIN' : 'REJECTED';
      order.error = error.message || String(error);
      if (error?.submissionUncertain) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = 'An entry order may have reached the exchange; reconciliation is required';
      }
      this.lastError = order.error;
      this.log('ERROR', 'Limit buy was not confirmed', {
        order: order.clientKey,
        uncertain: Boolean(error?.submissionUncertain),
        error: order.error,
      });
      try {
        await this.persistState();
      } catch (persistError) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Could not persist entry result: ${persistError.message || persistError}`;
      }
    }
  }

  async reconcileOrders() {
    if (!this.running || !this.tradingEnabled || !this.authenticated || this.orderScanInFlight) return;
    this.orderScanInFlight = true;
    try {
      const now = this.clock();
      const resolvedSlugs = resolvedMarketSlugs(this.ordersById.values());
      const candidates = [...this.ordersById.values()].filter(order =>
        order.id && !resolvedSlugs.has(order.slug)
        && (!isTerminalStatus(order.status) || needsFillConfirmation(order))
        && now >= (order.nextPollAt || 0));
      const results = await Promise.allSettled(candidates.map(order => this.trader.fetchOrder(order.id)));
      const failures = [];
      let changed = false;
      for (const order of this.ordersById.values()) {
        if (resolvedSlugs.has(order.slug) && order.error) {
          order.error = null;
          changed = true;
        }
      }
      for (let i = 0; i < candidates.length; i++) {
        const order = candidates[i];
        const result = results[i];
        if (result.status === 'rejected') {
          order.error = result.reason?.message || String(result.reason);
          order.nextPollAt = now + Math.max(ORDER_POLL_MS, retryAfterMs(result.reason));
          failures.push(order.error);
          changed = true;
          continue;
        }
        const latest = result.value;
        if (!latest) {
          order.error = 'Exchange returned no status for a tracked order';
          order.nextPollAt = now + ORDER_POLL_MS;
          failures.push(order.error);
          changed = true;
          continue;
        }
        const previousMatched = order.matchedShares;
        const previousFinalFillChecks = numeric(order.pendingFinalFillChecks);
        order.matchedShares = Math.max(order.matchedShares, matchedSize(latest));
        if (order.matchedShares > previousMatched) {
          order.fillConfirmedAt = now;
        }
        const latestStatus = orderStatus(latest);
        const previousStatus = order.status;
        if (latestStatus !== 'UNKNOWN'
          && !(order.cancelledAt && ACTIVE.has(latestStatus))) {
          order.status = latestStatus;
        }
        if (order.pendingFinalFillChecks > 0) {
          order.pendingFinalFillChecks = Math.max(0, order.pendingFinalFillChecks - 1);
        }
        if (order.matchedShares !== previousMatched
          || order.status !== previousStatus
          || order.pendingFinalFillChecks !== previousFinalFillChecks) {
          order.updatedAt = now;
          changed = true;
        }
        order.error = null;
        if (order.kind === 'ENTRY' && order.matchedShares > previousMatched) {
          this.log('FILL', 'Exchange confirmed an entry fill', {
            orderId: order.id,
            slug: order.slug,
            outcome: order.outcome,
            matchedShares: order.matchedShares,
          });
        }
        if (order.kind === 'ENTRY'
          && order.entryType === 'MIDPOINT_TRIGGER_LADDER'
          && order.matchedShares > 0
          && !isTerminalStatus(order.status)) {
          await this.cancelEntryOrder(order, 'first_partial_fill');
        }
        if (order.kind === 'ENTRY' && order.windowEnd && now >= order.windowEnd && !isTerminalStatus(order.status)) {
          await this.cancelEntryOrder(order, 'window_end');
        }
        if (['TAKE_PROFIT', 'STOP_LOSS'].includes(order.kind)
          && order.windowEnd
          && now >= order.windowEnd
          && !isTerminalStatus(order.status)) {
          await this.cancelExitOrder(order);
        }
        if (order.testOnly && isTerminalStatus(order.status) && order.matchedShares === 0) {
          await this.completeFlowTest(`entry_${order.status.toLowerCase().replaceAll(' ', '_')}`, order.error, order);
        }
        if (['TAKE_PROFIT', 'STOP_LOSS'].includes(order.kind)
          && order.matchedShares > previousMatched) {
          this.log('FILL', `Exchange confirmed a ${order.kind.toLowerCase().replaceAll('_', '-')} fill`, {
            orderId: order.id,
            slug: order.slug,
            outcome: order.outcome,
            price: order.price,
            matchedShares: order.matchedShares,
          });
        }
      }
      const pairedEntriesWithFills = [...this.ordersById.values()].filter(order =>
        order.kind === 'ENTRY'
        && order.pairedEntryGroup
        && order.matchedShares > 0
        && !resolvedSlugs.has(order.slug));
      for (const order of pairedEntriesWithFills) {
        await this.cancelPairedEntryOrders(order);
      }
      for (const order of this.ordersById.values()) {
        if (order.kind === 'ENTRY' && order.matchedShares > 0 && !resolvedSlugs.has(order.slug)) {
          if (order.entryType === 'MIDPOINT_TRIGGER_LADDER') {
            await this.maybeSubmitSourceExit(order, now);
          } else if (order.testOnly) {
            await this.maybeSubmitTakeProfit(order);
          }
        }
      }
      for (const order of this.ordersById.values()) {
        if (order.kind === 'ENTRY'
          && isTerminalStatus(order.status)
          && order.matchedShares > 0
          && order.retryAt > 0
          && now >= order.retryAt
          && !resolvedSlugs.has(order.slug)) {
          if (order.entryType === 'MIDPOINT_TRIGGER_LADDER') {
            await this.maybeSubmitSourceExit(order, now);
          } else if (order.testOnly) {
            await this.maybeSubmitTakeProfit(order);
          }
        }
      }
      await this.reconcileExpiredPositions(now);
      this.orderError = failures[0] || null;
      if (changed) {
        try {
          await this.persistState();
        } catch (error) {
          this.halted = true;
          this.account.accountReady = false;
          this.account.status = 'state_store_error';
          this.account.error = error.message || String(error);
          this.lastError = this.account.error;
        }
      }
      if (failures.length) {
        this.refreshOrderReadiness();
        this.account.status = this.account.accountReady ? 'ready' : 'order_reconciliation_error';
        this.account.error = failures[0];
      } else if (this.account.snapshotHealthy
        && this.account.lastSuccessAt
        && now - this.account.lastSuccessAt <= Math.max(this.accountRefreshMs * 2, 30_000)
        && !this.halted) {
        this.refreshOrderReadiness();
        this.account.error = this.account.untrackedOpenOrders > 0
          ? `${this.account.untrackedOpenOrders} open exchange order(s) could not be classified safely`
          : null;
      }
    } catch (error) {
      this.orderError = error.message || String(error);
      this.lastError = this.orderError;
      this.log('ERROR', 'Order reconciliation failed', { error: this.orderError });
    } finally {
      this.orderScanInFlight = false;
    }
  }

  async reconcileExpiredPositions(now = this.clock()) {
    if (!this.trader?.getMarket) return;
    const expiredEntries = [...this.ordersById.values()].filter(order =>
      order.kind === 'ENTRY'
      && order.entryType === 'MIDPOINT_TRIGGER_LADDER'
      && order.windowEnd
      && now >= order.windowEnd
      && order.matchedShares > 0
      && order.resolutionStatus !== 'RESOLVED'
      && order.resolutionStatus !== 'CLOSED_BY_EXITS');
    const groups = new Map();
    for (const entry of expiredEntries) {
      const related = [entry, ...(entry.exits || [])];
      if (related.some(order => !isTerminalStatus(order.status)
        || numeric(order.pendingFinalFillChecks) > 0)) continue;
      const soldShares = (entry.exits || [])
        .reduce((sum, exit) => sum + numeric(exit.matchedShares), 0);
      const unsoldShares = Math.max(0, numeric(entry.matchedShares) - soldShares);
      if (unsoldShares <= 0.000001) {
        entry.resolutionStatus = 'CLOSED_BY_EXITS';
        entry.resolutionError = null;
        continue;
      }
      if (!entry.marketId && entry.windowStart !== null && entry.windowStart !== undefined) {
        try {
          const market = await this.marketData.getBtcMarket(
            Number(entry.windowStart),
            WINDOW_CONFIG[entry.timeframe],
          );
          if (market?.id) entry.marketId = String(market.id);
        } catch (error) {
          entry.resolutionError = error.message || String(error);
        }
      }
      if (!entry.marketId) {
        entry.resolutionStatus = 'AWAITING_SETTLEMENT';
        entry.resolutionError ||= 'Could not identify the original market for resolution';
        continue;
      }
      if (!groups.has(String(entry.marketId))) groups.set(String(entry.marketId), []);
      groups.get(String(entry.marketId)).push(entry);
    }

    let changed = false;
    for (const [marketId, entries] of groups) {
      if (now < numeric(this.resolutionPollAt.get(marketId))) continue;
      this.resolutionPollAt.set(marketId, now + RESOLUTION_RETRY_MS);
      let market = null;
      let error = null;
      try {
        market = await this.trader.getMarket(marketId);
      } catch (cause) {
        error = cause.message || String(cause);
      }
      for (const entry of entries) {
        const payout = resolvedMarketPayout(market, {
          marketId,
          tokenId: entry.tokenId,
          outcome: entry.outcome,
        });
        const checkedAt = this.clock();
        if (payout !== null) {
          const soldShares = (entry.exits || [])
            .reduce((sum, exit) => sum + numeric(exit.matchedShares), 0);
          const unsoldShares = Math.max(0, numeric(entry.matchedShares) - soldShares);
          entry.resolutionStatus = 'RESOLVED';
          entry.resolutionShares = unsoldShares;
          entry.resolutionPayoutPerShare = payout;
          entry.resolutionGrossPayout = unsoldShares * payout;
          entry.resolutionAt = checkedAt;
          entry.resolutionError = null;
          this.log('RESOLUTION', 'Original market resolution confirmed for unsold shares', {
            marketId,
            slug: entry.slug,
            outcome: entry.outcome,
            unsoldShares,
            payoutPerShare: payout,
            grossPayout: entry.resolutionGrossPayout,
          });
        } else {
          const wasPending = entry.resolutionStatus === 'AWAITING_SETTLEMENT';
          entry.resolutionStatus = 'AWAITING_SETTLEMENT';
          entry.resolutionLastCheckedAt = checkedAt;
          entry.resolutionError = error || 'Original market is not confirmed resolved yet; retrying.';
          if (!wasPending) {
            this.log('RESOLUTION', 'Waiting for confirmed resolution of the original market', {
              marketId,
              slug: entry.slug,
              reason: entry.resolutionError,
            });
          }
        }
        changed = true;
      }
    }
    if (changed || expiredEntries.some(entry =>
      entry.resolutionStatus === 'CLOSED_BY_EXITS' || entry.resolutionError)) {
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Could not persist market-resolution state: ${error.message || error}`;
      }
    }
  }

  async maybeSubmitSourceExit(entry, now = this.clock()) {
    if (entry.kind !== 'ENTRY'
      || entry.entryType !== 'MIDPOINT_TRIGGER_LADDER'
      || !entry.matchedShares
      || !this.trader
      || this.halted) return;

    if (!entry.sourceExitKind) {
      const state = this.markets[entry.timeframe];
      const quote = state?.slug === entry.slug ? state.quotes?.[entry.outcome] : null;
      const trigger = evaluateSourceExit({
        now,
        windowStart: Number(entry.windowStart),
        windowEnd: Number(entry.windowEnd),
        filledAt: Number(entry.fillConfirmedAt),
        quote,
      });
      if (!trigger) return;
      entry.sourceExitKind = trigger.kind;
      entry.sourceExitLimitPrice = trigger.limitPrice;
      entry.sourceExitTriggeredAt = now;
      entry.sourceExitTriggerBid = trigger.triggerBid;
      entry.sourceExitFailed = false;
      entry.sourceExitError = null;
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.status = 'state_store_error';
        this.account.error = `Could not persist the source exit trigger: ${error.message || error}`;
        return;
      }
      this.log('SIGNAL', `Source ${trigger.kind.toLowerCase().replaceAll('_', '-')} trigger latched`, {
        slug: entry.slug,
        outcome: entry.outcome,
        bestBid: trigger.triggerBid,
        limitSellPrice: trigger.limitPrice,
        triggeredAt: now,
      });
    }

    if (now >= Number(entry.windowEnd)
      || now < numeric(entry.retryAt)
      || entry.sourceExitFailed
      || !isTerminalStatus(entry.status)
      || numeric(entry.pendingFinalFillChecks) > 0) return;
    if ((entry.exits || []).some(exit =>
      !isTerminalStatus(exit.status) || numeric(exit.pendingFinalFillChecks) > 0)) return;

    const soldShares = (entry.exits || [])
      .reduce((sum, exit) => sum + numeric(exit.matchedShares), 0);
    const available = Math.floor((
      numeric(entry.matchedShares) - soldShares - numeric(entry.exitSubmittingShares)
    ) * 100) / 100;
    if (available <= 0) return;
    if (available < MIN_SELL_SHARES) {
      entry.exitBlockedReason = `Only ${available.toFixed(2)} confirmed shares remain; minimum sell is ${MIN_SELL_SHARES}`;
      return;
    }

    const exit = {
      id: null,
      clientKey: `source-exit:${entry.id}:${entry.sourceExitKind}:${(entry.exits || []).length + 1}`,
      kind: entry.sourceExitKind,
      side: 'SELL',
      outcome: entry.outcome,
      tokenId: entry.tokenId,
      price: entry.sourceExitLimitPrice,
      shares: available,
      matchedShares: 0,
      slug: entry.slug,
      timeframe: entry.timeframe,
      marketId: entry.marketId || null,
      windowStart: entry.windowStart,
      windowEnd: entry.windowEnd,
      triggerBid: entry.sourceExitTriggerBid,
      status: 'SUBMITTING',
      recovered: false,
      exits: [],
      pendingFinalFillChecks: 0,
      retryAt: 0,
      error: null,
      createdAt: now,
    };
    entry.exitSubmittingShares = numeric(entry.exitSubmittingShares) + available;
    entry.exitBlockedReason = null;
    entry.exits ||= [];
    entry.exits.push(exit);
    this.ordersById.set(exit.clientKey, exit);
    try {
      await this.persistState();
      const response = await this.trader.placeLimitOrder(
        entry.tokenId,
        'SELL',
        entry.sourceExitLimitPrice,
        available,
      );
      const id = orderId(response);
      if (!id) {
        exit.status = 'SUBMISSION_UNCERTAIN';
        exit.error = 'Exchange response did not include an order ID';
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = exit.error;
        this.log('ERROR', 'Source exit submission is uncertain; new entries halted', {
          entryOrderId: entry.id,
          exitKind: exit.kind,
        });
        return;
      }
      exit.id = String(id);
      this.ordersById.delete(exit.clientKey);
      exit.status = orderStatus(response);
      this.ordersById.set(exit.id, exit);
      entry.retryAt = 0;
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Source exit was accepted but its ledger update failed: ${error.message || error}`;
      }
      this.log('ORDER', `Source ${exit.kind.toLowerCase().replaceAll('_', '-')} limit sell submitted`, {
        entryOrderId: entry.id,
        orderId: exit.id,
        slug: exit.slug,
        outcome: exit.outcome,
        price: exit.price,
        shares: exit.shares,
        triggerBid: exit.triggerBid,
      });
    } catch (error) {
      exit.status = 'REJECTED';
      exit.error = error.message || String(error);
      if (isInsufficientBalance(error)) {
        entry.retryAt = this.clock() + Math.max(1_000, retryAfterMs(error));
        this.ordersById.delete(exit.clientKey);
        entry.exits.pop();
        this.log('WARNING', 'Exchange has not released the confirmed shares; source exit will retry', {
          entryOrderId: entry.id,
          retryAt: entry.retryAt,
          error: exit.error,
        });
      } else if (error?.submissionUncertain) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = 'A source exit order may have reached the exchange; reconciliation is required';
      } else {
        entry.retryAt = 0;
        entry.sourceExitFailed = true;
        entry.sourceExitError = exit.error;
        entry.exitBlockedReason = exit.error;
        this.log('ERROR', 'Source exit limit sell was rejected', {
          entryOrderId: entry.id,
          price: exit.price,
          shares: exit.shares,
          exitKind: exit.kind,
          error: exit.error,
        });
      }
      this.lastError = exit.error;
      try {
        await this.persistState();
      } catch (persistError) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Could not persist source exit result: ${persistError.message || persistError}`;
      }
    } finally {
      entry.exitSubmittingShares = Math.max(0, numeric(entry.exitSubmittingShares) - available);
    }
  }

  async maybeSubmitTakeProfit(entry) {
    if (!entry.takeProfitPrice || !entry.matchedShares || !this.trader || this.halted) return;
    if (this.clock() < entry.retryAt) return;
    const coveredShares = (entry.exits || []).reduce((sum, exit) => sum + exit.shares, 0);
    const available = Math.floor((entry.matchedShares - coveredShares - entry.exitSubmittingShares) * 100) / 100;
    if (available <= 0) {
      entry.exitBlockedReason = null;
      return;
    }
    if (available < MIN_SELL_SHARES) {
      entry.exitBlockedReason = `Only ${available.toFixed(2)} shares available; minimum sell is ${MIN_SELL_SHARES}`;
      return;
    }

    entry.exitSubmittingShares += available;
    entry.exitBlockedReason = null;
    const exit = {
      id: null,
      clientKey: `tp:${entry.id}:${entry.exits.length + 1}`,
      kind: 'TAKE_PROFIT',
      side: 'SELL',
      outcome: entry.outcome,
      tokenId: entry.tokenId,
      price: entry.takeProfitPrice,
      shares: available,
      matchedShares: 0,
      slug: entry.slug,
      timeframe: entry.timeframe,
      windowStart: entry.windowStart,
      windowEnd: entry.windowEnd,
      status: 'SUBMITTING',
      recovered: false,
      exits: [],
      retryAt: 0,
      error: null,
      createdAt: this.clock(),
    };
    entry.exits.push(exit);
    this.ordersById.set(exit.clientKey, exit);
    try {
      await this.persistState();
      const response = await this.trader.placeLimitOrder(
        entry.tokenId,
        'SELL',
        entry.takeProfitPrice,
        available,
      );
      const id = orderId(response);
      if (!id) {
        exit.status = 'SUBMISSION_UNCERTAIN';
        exit.error = 'Exchange response did not include an order ID';
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = exit.error;
        this.log('ERROR', 'Take-profit submission is uncertain; new entries halted', { entryOrderId: entry.id });
        return;
      }
      exit.id = String(id);
      this.ordersById.delete(exit.clientKey);
      exit.status = orderStatus(response);
      this.ordersById.set(exit.id, exit);
      entry.retryAt = 0;
      try {
        await this.persistState();
      } catch (error) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Take-profit was accepted but its ledger update failed: ${error.message || error}`;
      }
      this.log('ORDER', 'Take-profit limit sell submitted for confirmed shares', {
        entryOrderId: entry.id,
        orderId: exit.id,
        slug: exit.slug,
        outcome: exit.outcome,
        price: exit.price,
        shares: exit.shares,
      });
      if (entry.testOnly) {
        await this.completeFlowTest('take_profit_sell_submitted', null, entry, exit);
      }
    } catch (error) {
      exit.status = 'REJECTED';
      exit.error = error.message || String(error);
      if (isInsufficientBalance(error)) {
        entry.retryAt = this.clock() + Math.max(1_000, retryAfterMs(error));
        this.ordersById.delete(exit.clientKey);
        entry.exits.pop();
        if (entry.testOnly) {
          this.flowTestState.status = 'awaiting_sell_retry';
          this.flowTestState.error = exit.error;
        }
        this.log('WARNING', 'Exchange has not released the confirmed shares yet; take-profit will retry', {
          entryOrderId: entry.id,
          retryAt: entry.retryAt,
          error: exit.error,
        });
      } else if (error?.submissionUncertain) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = 'A take-profit order may have reached the exchange; reconciliation is required';
        if (entry.testOnly) {
          this.flowTestState.status = 'submission_uncertain';
          this.flowTestState.error = this.account.error;
        }
      } else {
        entry.retryAt = 0;
        entry.exitBlockedReason = exit.error;
        if (entry.testOnly) {
          this.flowTestState.status = 'sell_rejected';
          this.flowTestState.error = exit.error;
        }
        this.log('ERROR', 'Take-profit limit sell was rejected', {
          entryOrderId: entry.id,
          price: exit.price,
          shares: exit.shares,
          error: exit.error,
        });
      }
      this.lastError = exit.error;
      try {
        await this.persistState();
      } catch (persistError) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Could not persist take-profit result: ${persistError.message || persistError}`;
      }
    } finally {
      entry.exitSubmittingShares = Math.max(0, entry.exitSubmittingShares - available);
    }
  }

  async cancelPairedEntryOrders(filledEntry) {
    if (!filledEntry?.pairedEntryGroup || numeric(filledEntry.matchedShares) <= 0) return;
    const groupOrders = [...this.ordersById.values()].filter(order =>
      order.kind === 'ENTRY' && order.pairedEntryGroup === filledEntry.pairedEntryGroup);
    const peers = groupOrders.filter(order => order !== filledEntry);
    for (const peer of peers) {
      if (peer.matchedShares <= 0 && !isTerminalStatus(peer.status)) {
        await this.cancelEntryOrder(peer, 'paired_fill');
      }
    }

    const filledSides = groupOrders.filter(order => numeric(order.matchedShares) > 0).length;
    const newStatus = filledSides > 1
      ? 'both_sides_filled'
      : !peers.length
        ? 'counterpart_not_tracked'
        : peers.every(order => isTerminalStatus(order.status))
          ? peers.some(order => order.status === 'CANCELED')
            ? 'opposite_order_cancelled'
            : 'counterpart_inactive'
          : 'opposite_cancel_pending';
    const state = this.markets[filledEntry.timeframe];
    if (!state || state.slug !== filledEntry.slug || state.legacyWindowStartPairStatus === newStatus) return;
    state.legacyWindowStartPairStatus = newStatus;
    try {
      await this.persistState();
    } catch (error) {
      this.halted = true;
      this.account.accountReady = false;
      this.account.status = 'state_store_error';
      this.account.error = `Could not persist paired-order cancellation state: ${error.message || error}`;
    }
  }

  async cancelEntryOrder(order, reason = 'window_end') {
    if (order.kind !== 'ENTRY'
      || isTerminalStatus(order.status)
      || !order.id
      || !this.trader?.cancelOrder
      || numeric(order.nextCancelAt) > this.clock()) return false;
    try {
      const result = await this.trader.cancelOrder(order.id);
      order.status = 'CANCELED';
      order.cancelledAt = this.clock();
      order.nextCancelAt = 0;
      order.pendingFinalFillChecks = order.matchedShares < order.shares
        ? CANCEL_FINAL_FILL_CHECKS
        : 0;
      await this.persistState();
      if (order.testOnly && this.flowTestState.status !== 'complete'
        && this.flowTestState.status === 'awaiting_fill') {
        if (order.matchedShares > 0) {
          this.flowTestState.status = 'partial_fill_below_sell_minimum';
          this.flowTestState.error = order.exitBlockedReason
            || `Only ${order.matchedShares.toFixed(2)} diagnostic shares matched; the minimum sell is ${MIN_SELL_SHARES}`;
          await this.persistState();
        } else {
          await this.completeFlowTest('entry_canceled_unfilled', null, order);
        }
      }
      const message = reason === 'paired_fill'
        ? 'Opposite paired entry canceled after a confirmed fill'
        : reason === 'first_partial_fill'
          ? 'Unfilled entry remainder canceled after its first partial fill'
          : 'Unfilled entry remainder canceled at window end';
      this.log('ORDER', message, {
        orderId: order.id,
        slug: order.slug,
        matchedShares: order.matchedShares,
        result: result?.status || 'cancel requested',
      });
      return true;
    } catch (error) {
      order.error = error.message || String(error);
      order.nextCancelAt = this.clock() + Math.max(ORDER_POLL_MS, retryAfterMs(error));
      order.nextPollAt = Math.max(order.nextPollAt || 0, order.nextCancelAt);
      try {
        await this.persistState();
      } catch (persistError) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Could not persist entry-cancel state: ${persistError.message || persistError}`;
      }
      this.log('ERROR', reason === 'paired_fill'
        ? 'Could not cancel the opposite paired entry'
        : 'Could not cancel the entry order remainder', { orderId: order.id, error: order.error });
      return false;
    }
  }

  async cancelExitOrder(order, reason = 'window_end') {
    if (!['TAKE_PROFIT', 'STOP_LOSS'].includes(order.kind)
      || isTerminalStatus(order.status)
      || !order.id
      || !this.trader?.cancelOrder
      || numeric(order.nextCancelAt) > this.clock()) return false;
    try {
      const result = await this.trader.cancelOrder(order.id);
      order.status = 'CANCELED';
      order.cancelledAt = this.clock();
      order.nextCancelAt = 0;
      order.pendingFinalFillChecks = order.matchedShares < order.shares
        ? CANCEL_FINAL_FILL_CHECKS
        : 0;
      await this.persistState();
      this.log('ORDER', `Unfilled ${order.kind.toLowerCase().replaceAll('_', '-')} limit sell cancelled at window end`, {
        orderId: order.id,
        slug: order.slug,
        matchedShares: order.matchedShares,
        reason,
        result: result?.status || 'cancel requested',
      });
      return true;
    } catch (error) {
      order.error = error.message || String(error);
      order.nextCancelAt = this.clock() + Math.max(ORDER_POLL_MS, retryAfterMs(error));
      order.nextPollAt = Math.max(order.nextPollAt || 0, order.nextCancelAt);
      try {
        await this.persistState();
      } catch (persistError) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Could not persist exit-cancel state: ${persistError.message || persistError}`;
      }
      this.log('ERROR', 'Could not cancel the resting exit before source-market resolution', {
        orderId: order.id,
        error: order.error,
      });
      return false;
    }
  }

  async cancelWindowEntryOrders(state) {
    const ids = new Set(state.orderIds);
    for (const order of this.ordersById.values()) {
      if (order.kind === 'ENTRY'
        && (ids.has(order.clientKey) || order.slug === state.slug)
        && order.windowEnd
        && this.clock() >= order.windowEnd) {
        await this.cancelEntryOrder(order);
      }
    }
  }

  snapshot() {
    const markets = Object.fromEntries(TIMEFRAMES.map(timeframe => {
      const state = this.markets[timeframe];
      const orders = [...this.ordersById.values()]
        .filter(order => order.slug === state.slug || order.clientKey?.startsWith(`${state.slug}:`));
      return [timeframe, {
        timeframe,
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        slug: state.slug,
        title: state.title,
        quotes: state.quotes,
        signal: state.signal,
        pendingTrigger: state.pendingTrigger,
        triggeredAt: state.triggeredAt,
        error: state.error,
        orders,
      }];
    }));
    const status = !this.tradingEnabled ? 'live_disabled'
      : this.halted ? 'halted_reconciliation_required'
        : !this.account.accountReady ? (this.account.status || 'reconciling')
          : 'ready';
    return {
      ok: status === 'ready' || status === 'live_disabled',
      mode: 'REAL ORDERS',
      status,
      tradingEnabled: this.tradingEnabled,
      startedAt: this.startedAt,
      now: this.clock(),
      strategy: {
        version: STRATEGY_VERSION,
        markets: ['BTC 5m'],
        windowRule: 'Wait 120 seconds after each window starts, then monitor fresh UP/DOWN midpoints until the window ends',
        trigger: 'The first fresh midpoint at or above $0.80 selects a side; if both qualify, select the higher midpoint and break ties toward UP',
        triggerPersistence: 'The qualifying side and price are saved through account delays and process restarts until that window ends',
        selectedSideOnly: true,
        orders: ENTRY_RUNGS.map(rung => ({
          buyPrice: rung.price,
          shares: rung.shares,
        })),
        exits: {
          takeProfitTriggerBid: TAKE_PROFIT_BID,
          takeProfitLimitSell: TAKE_PROFIT_BID,
          stopLossTriggerBid: STOP_LOSS_BID,
          stopLossLimitSell: STOP_LOSS_BID,
          stopLossAfterSeconds: EXIT_START_SECONDS,
          exitQuoteMaxAgeMs: 5_000,
          resolution: 'Cancel unfilled exit orders at window end; hold unsold shares until the original market is confirmed resolved',
        },
        rearm: 'One selected-side two-rung ladder per window; no opening pair, order replacement, or re-entry',
        orderPollMs: this.orderPollMs,
        quoteMaxAgeMs: 5_000,
        entriesPausedForSmokeTest: this.flowTestPausesStrategy(),
      },
      flowTest: {
        ...this.flowTestState,
        enabled: this.flowTestEnabled,
        pausesStrategy: this.flowTestPausesStrategy(),
        buyLimitPrice: FLOW_TEST_BUY_PRICE,
        shares: FLOW_TEST_SHARES,
        maxBuyNotional: Number((FLOW_TEST_BUY_PRICE * FLOW_TEST_SHARES).toFixed(2)),
        takeProfitPrice: FLOW_TEST_TAKE_PROFIT_PRICE,
      },
      account: {
        status: this.account.status,
        accountReady: this.account.accountReady,
        snapshotHealthy: this.account.snapshotHealthy,
        snapshotError: this.account.snapshotError,
        error: this.account.error,
        tradingEnabled: this.tradingEnabled,
        failures: this.account.failures,
        collateral: this.account.collateral,
        positionValue: this.account.positionValue,
        equity: this.account.equity,
        positionCount: Array.isArray(this.account.positions) ? this.account.positions.length : 0,
        openOrderCount: Array.isArray(this.account.openOrders) ? this.account.openOrders.length : 0,
        untrackedOpenOrders: this.account.untrackedOpenOrders,
        asOf: this.account.asOf,
        lastSuccessAt: this.account.lastSuccessAt,
        nextRetryAt: this.account.nextRetryAt,
      },
      markets,
      orders: [...this.ordersById.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
      events: this.events,
      error: this.lastError || this.orderError || this.account.error || null,
    };
  }
}

module.exports = LiveBot;
module.exports.recoveredOrder = recoveredOrder;
module.exports.orderStatus = orderStatus;
