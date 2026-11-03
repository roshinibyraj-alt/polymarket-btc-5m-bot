'use strict';

const cfg = require('./config');
const {
  WINDOW_CONFIG,
  ENTRY_RUNGS,
  evaluateWindow,
  quoteFromBook,
  windowStartFor,
} = require('./live-strategy');

const TIMEFRAMES = Object.keys(WINDOW_CONFIG);
const TERMINAL = new Set(['MATCHED', 'FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED']);
const ACTIVE = new Set(['LIVE', 'OPEN', 'PENDING', 'PARTIALLY_FILLED', 'PARTIALLY MATCHED']);
const MIN_SELL_SHARES = Number(cfg.LIVE_MIN_SELL_SHARES || 5);
const SHARES_PER_RUNG = Number(cfg.LIVE_SHARES_PER_RUNG || 10);
const ORDER_POLL_MS = Number(cfg.LIVE_ORDER_POLL_MS || 500);
const ACCOUNT_REFRESH_MS = Number(cfg.LIVE_BALANCE_REFRESH_MS || 15_000);

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
  if (side === 'BUY') {
    const rung = ENTRY_RUNGS.find(item => Math.abs(item.price - price) < 0.000001);
    if (rung) {
      kind = 'ENTRY';
      takeProfitPrice = rung.takeProfitPrice;
    }
  } else if (side === 'SELL' && [0.75, 0.85].some(value => Math.abs(value - price) < 0.000001)) {
    kind = 'TAKE_PROFIT';
  }
  if (!id || !tokenId || !kind || !Number.isFinite(size)) return null;
  return {
    id,
    clientKey: `recovered:${id}`,
    kind,
    side,
    tokenId: String(tokenId),
    price,
    shares: size,
    matchedShares: matched,
    takeProfitPrice,
    slug,
    timeframe: window?.timeframe || null,
    outcome: raw?.outcome || raw?.outcomeName || raw?.outcome_name || null,
    windowStart: window?.start ?? null,
    windowEnd: window?.end ?? null,
    status: orderStatus(raw),
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
  }

  async restoreState(document) {
    this.entryKeys = new Set(document.entryKeys || []);
    for (const timeframe of TIMEFRAMES) {
      const saved = document.markets?.[timeframe];
      if (!saved || saved.windowStart === null || saved.windowStart === undefined
        || saved.windowEnd === null || saved.windowEnd === undefined
        || !Number.isFinite(Number(saved.windowStart))
        || !Number.isFinite(Number(saved.windowEnd)) || Number(saved.windowEnd) <= this.clock()) continue;
      const pendingTrigger = saved.pendingTrigger;
      const validPendingTrigger = pendingTrigger?.evaluation?.eligible === true
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
      markets: Object.fromEntries(TIMEFRAMES.map(timeframe => {
        const state = this.markets[timeframe];
        return [timeframe, {
          windowStart: state.windowStart,
          windowEnd: state.windowEnd,
          slug: state.slug,
          title: state.title,
          pendingTrigger: state.pendingTrigger,
          triggeredAt: state.triggeredAt,
          orderIds: state.orderIds,
          signal: state.signal,
        }];
      })),
    });
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
    void this.scanMarkets();
    if (this.tradingEnabled) void this.bootstrapTrading();
    else this.log('INFO', 'Live order execution is disabled by configuration');
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
    if (!this.trader) {
      this.account.status = 'error';
      this.account.error = 'Live trading is enabled but no exchange client is configured';
      this.lastError = this.account.error;
      this.bootstrapping = false;
      return;
    }
    if (this.flowTestEnabled) {
      this.account.status = 'paused_flow_test_mode';
      this.account.error = 'The legacy flow-test mode is not used by this strategy; live entries are paused';
      this.log('WARNING', this.account.error);
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
            await this.maybeSubmitTakeProfit(order);
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
    if (!this.running || !this.tradingEnabled || this.flowTestEnabled) return;
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
    if (!this.running || !this.tradingEnabled || this.flowTestEnabled || !this.authenticated) return;
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
    if (!this.running || this.marketScanInFlight) return;
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
    if (evaluation.eligible && !current.pendingTrigger && !current.triggeredAt
      && this.tradingEnabled && !this.flowTestEnabled) {
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
      } else if (this.flowTestEnabled) {
        current.signal = { ...current.signal, status: 'eligible_flow_test_disabled', reason: 'Live flow-test mode is not supported by this strategy' };
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
    } else if (evaluation.eligible && this.flowTestEnabled) {
      current.signal = { ...evaluation, status: 'eligible_flow_test_disabled', reason: 'Live flow-test mode is not supported by this strategy' };
    } else {
      current.signal = evaluation;
    }

    if (now >= current.windowEnd) {
      await this.cancelWindowEntryOrders(current);
    }
  }

  async fireWindowOrders(state, evaluation) {
    if (state.triggeredAt) return;
    if (!state.pendingTrigger) {
      state.pendingTrigger = {
        observedAt: this.clock(),
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        slug: state.slug,
        evaluation: { ...evaluation },
      };
    }
    state.triggeredAt = this.clock();
    state.signal = { ...evaluation, status: 'orders_submitting' };
    this.log('SIGNAL', 'Midpoint-band trigger fired; submitting the four limit buys once', {
      slug: state.slug,
      qualifyingSides: evaluation.qualifyingSides,
      upMid: evaluation.upMid,
      downMid: evaluation.downMid,
    });

    const entries = [];
    for (const side of ['UP', 'DOWN']) {
      for (const rung of ENTRY_RUNGS) {
        const clientKey = `${state.slug}:${side}:${rung.price.toFixed(2)}`;
        if (this.entryKeys.has(clientKey)) continue;
        this.entryKeys.add(clientKey);
        const order = {
          id: null,
          clientKey,
          kind: 'ENTRY',
          side: 'BUY',
          outcome: side,
          tokenId: String(state.market.tokens[side]),
          price: rung.price,
          shares: SHARES_PER_RUNG,
          matchedShares: 0,
          takeProfitPrice: rung.takeProfitPrice,
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
      reason: 'One-shot order set submitted; no entry rearm for this window',
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
        takeProfitPrice: order.takeProfitPrice,
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
      const candidates = [...this.ordersById.values()].filter(order =>
        order.id && !isTerminalStatus(order.status) && now >= (order.nextPollAt || 0));
      const results = await Promise.allSettled(candidates.map(order => this.trader.fetchOrder(order.id)));
      const failures = [];
      let changed = false;
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
        order.matchedShares = Math.max(order.matchedShares, matchedSize(latest));
        const latestStatus = orderStatus(latest);
        const previousStatus = order.status;
        if (latestStatus !== 'UNKNOWN') order.status = latestStatus;
        if (order.matchedShares !== previousMatched || order.status !== previousStatus) {
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
          await this.maybeSubmitTakeProfit(order);
        }
        if (order.kind === 'ENTRY' && order.windowEnd && now >= order.windowEnd && !isTerminalStatus(order.status)) {
          await this.cancelEntryOrder(order);
        }
        if (order.kind === 'ENTRY' && order.matchedShares > 0) {
          await this.maybeSubmitTakeProfit(order);
        }
        if (order.kind === 'TAKE_PROFIT' && order.matchedShares > previousMatched) {
          this.log('FILL', 'Exchange confirmed a take-profit fill', {
            orderId: order.id,
            slug: order.slug,
            outcome: order.outcome,
            price: order.price,
            matchedShares: order.matchedShares,
          });
        }
      }
      const resolvedSlugs = resolvedMarketSlugs(this.ordersById.values());
      for (const order of this.ordersById.values()) {
        if (order.kind === 'ENTRY'
          && isTerminalStatus(order.status)
          && order.matchedShares > 0
          && order.retryAt > 0
          && now >= order.retryAt
          && !resolvedSlugs.has(order.slug)) {
          await this.maybeSubmitTakeProfit(order);
        }
      }
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
    } catch (error) {
      exit.status = 'REJECTED';
      exit.error = error.message || String(error);
      if (isInsufficientBalance(error)) {
        entry.retryAt = this.clock() + Math.max(1_000, retryAfterMs(error));
        this.ordersById.delete(exit.clientKey);
        entry.exits.pop();
        this.log('WARNING', 'Exchange has not released the confirmed shares yet; take-profit will retry', {
          entryOrderId: entry.id,
          retryAt: entry.retryAt,
          error: exit.error,
        });
      } else if (error?.submissionUncertain) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = 'A take-profit order may have reached the exchange; reconciliation is required';
      } else {
        entry.retryAt = 0;
        entry.exitBlockedReason = exit.error;
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

  async cancelEntryOrder(order) {
    if (order.kind !== 'ENTRY' || isTerminalStatus(order.status) || !order.id || !this.trader?.cancelOrder) return;
    try {
      const result = await this.trader.cancelOrder(order.id);
      order.status = 'CANCELED';
      order.cancelledAt = this.clock();
      await this.persistState();
      this.log('ORDER', 'Unfilled entry remainder canceled at window end', {
        orderId: order.id,
        slug: order.slug,
        matchedShares: order.matchedShares,
        result: result?.status || 'cancel requested',
      });
    } catch (error) {
      order.error = error.message || String(error);
      order.nextPollAt = this.clock() + Math.max(ORDER_POLL_MS, retryAfterMs(error));
      try {
        await this.persistState();
      } catch (persistError) {
        this.halted = true;
        this.account.accountReady = false;
        this.account.error = `Could not persist entry-cancel state: ${persistError.message || persistError}`;
      }
      this.log('ERROR', 'Could not cancel the entry order remainder', { orderId: order.id, error: order.error });
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
      : this.flowTestEnabled ? 'paused_flow_test_mode'
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
        markets: ['BTC 5m', 'BTC 15m'],
        windowRule: 'Evaluate only during the final 60 seconds',
        trigger: 'Any one fresh UP or DOWN midpoint in the inclusive $0.30–$0.71 band during the final minute',
        triggerPersistence: 'First qualifying tick is saved through account delays and process restarts until the window ends',
        orders: ENTRY_RUNGS.map(rung => ({
          buyPrice: rung.price,
          shares: SHARES_PER_RUNG,
          takeProfitPrice: rung.takeProfitPrice,
        })),
        rearm: 'One entry set per window; no entry replacement',
        orderPollMs: this.orderPollMs,
        quoteMaxAgeMs: 5_000,
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
