'use strict';

const cfg = require('./config');
const { getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS, fetchResolution } = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');
const strategy = require('./strategy');

const MAX_LOG = 300;
const EPSILON = 1e-8;

class Bot {
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.live = !!opts.live;
    this.w = null;
    this.pending = [];
    this.trades = [];
    this.outcomes = new Map();
    this._resolveTried = new Map();
    this._warned = new Set();
    this.stats = { wins: 0, losses: 0, takeProfitFills: 0, stopLosses: 0, expiryWins: 0, expiryLosses: 0, noEntry: 0, estimatedFees: 0, realizedPnl: 0 };
    this.counts = { UP: 0, DOWN: 0 };
    this.walletBalance = null;
    this.error = null;
    this.executionHalt = false;
    this.log = [];
    this.startedAt = Date.now();
    this.capital = this.live ? null : cfg.DEMO_CAPITAL;
    this.cash = this.live ? null : cfg.DEMO_CAPITAL;
    this.peak = this.capital;
    this.maxDD = 0;
    this.equity = this.capital == null ? [] : [{ ts: Date.now(), v: this.capital }];
    this.prices = null;
    this.priceSeries = [];
    this._seriesSlug = null;
    this._lastSeriesAt = 0;
    this._quotesByToken = new Map();
    this._feedStop = null;
    this._feedSlug = null;
    this._lastMarketEventAt = 0;
    this._lastRestFetchAt = 0;
    this._running = false;
    this.baseShares = cfg.BASE_SHARES;
    this.shareAdditions = 0;
  }

  _push(entry) {
    this.log.push({ ts: Date.now(), ...entry });
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  _warnOnce(key, entry) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this._push(entry);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._loop();
    this._priceLoop();
    this._settlementLoop();
    this._balanceLoop();
  }

  stop() {
    this._running = false;
    if (this._feedStop) { try { this._feedStop(); } catch (_) {} }
    this._feedStop = null;
    this._feedSlug = null;
  }

  async _loop() {
    while (this._running) {
      try {
        await this._tick();
        await this._managePositions();
      } catch (error) {
        this.error = 'tick error: ' + error.message;
        this._push({ event: 'ERROR', note: this.error });
      }
      await sleep(cfg.LOOP_MS);
    }
  }

  async _tick() {
    const now = Date.now();
    const openTs = currentWindowOpenTs(now);
    const slug = slugForTs(openTs);
    if (!this.w || this.w.slug !== slug) {
      if (this.w && this.w.window && !this.w.tradeTaken) this.stats.noEntry += 1;
      this.w = {
        slug, openTs, status: 'starting', window: null, armedSide: null,
        entryReadyLogged: false, tradeTaken: false, entryInFlight: false,
        position: null, lastOpenAttemptAt: 0,
      };
    }
    const w = this.w;
    if (!w.window) {
      const result = await getActiveWindow(now);
      if (result.window) {
        this.error = null;
        w.window = result.window;
        w.status = 'entry_blocked';
        this._push({ event: 'WINDOW_READY', slug: w.slug, note: 'BTC 5-minute market active; entry checks start immediately' });
      } else {
        this.error = result.reason || 'active market unavailable';
        w.status = 'waiting_for_market';
      }
    }
    if (!w.window) return;
    const elapsedSeconds = (now - w.openTs * 1000) / 1000;
    if (elapsedSeconds < cfg.ENTRY_START_SECONDS) {
      if (!w.tradeTaken) w.status = 'entry_blocked';
      return;
    }
    if (elapsedSeconds >= WINDOW_SECONDS) return;
    await this._entryStep(w, elapsedSeconds);
  }

  async _priceLoop() {
    while (this._running) {
      const w = this.w;
      if (w && w.window) {
        if (this._feedSlug !== w.slug) await this._ensureMarketFeed(w);
        const now = Date.now();
        if (now - this._lastMarketEventAt >= cfg.PRICE_STALE_MS
          && now - this._lastRestFetchAt >= cfg.PRICE_FEED_FALLBACK_MS) {
          await this._seedQuotes(w);
        }
      }
      await sleep(250);
    }
  }

  async _ensureMarketFeed(w) {
    if (!w || !w.window || this._feedSlug === w.slug) return;
    if (this._feedStop) { try { this._feedStop(); } catch (_) {} }
    this._feedSlug = w.slug;
    this._quotesByToken = new Map();
    this.prices = { slug: w.slug, ts: Date.now(), up: emptyQuote(), down: emptyQuote() };
    this._lastMarketEventAt = 0;
    this._lastRestFetchAt = 0;
    try {
      if (typeof this.trader.prepareMarket === 'function') {
        void this.trader.prepareMarket([w.window.tokenUp, w.window.tokenDown]).catch((error) => {
          this._warnOnce('market-meta-' + w.slug, { event: 'ERROR', slug: w.slug, note: 'market metadata warm-up failed: ' + error.message });
        });
      }
      this._feedStop = startMarketFeed([w.window.tokenUp, w.window.tokenDown],
        (tokenId, quoteValue) => this._onQuote(w.slug, tokenId, quoteValue),
        (error) => {
          this.error = 'CLOB WebSocket error: ' + error.message;
          this._warnOnce('clob-ws-' + w.slug, { event: 'ERROR', slug: w.slug, note: this.error });
        });
    } catch (error) {
      this.error = 'CLOB WebSocket start failed: ' + error.message;
      this._push({ event: 'ERROR', slug: w.slug, note: this.error });
    }
    await this._seedQuotes(w);
  }

  async _seedQuotes(w) {
    if (!w || !w.window || this._feedSlug !== w.slug) return;
    this._lastRestFetchAt = Date.now();
    try {
      const books = await Promise.all([
        this.trader.getOrderBook(w.window.tokenUp),
        this.trader.getOrderBook(w.window.tokenDown),
      ]);
      if (this._feedSlug !== w.slug) return;
      this._onQuote(w.slug, w.window.tokenUp, quote(books[0]));
      this._onQuote(w.slug, w.window.tokenDown, quote(books[1]));
    } catch (error) {
      this._warnOnce('seed-' + w.slug, { event: 'ERROR', slug: w.slug, note: 'CLOB quote refresh failed: ' + error.message });
    }
  }

  _onQuote(slug, tokenId, update) {
    const w = this.w;
    if (!w || w.slug !== slug || !w.window) return;
    const side = tokenId === w.window.tokenUp ? 'UP' : tokenId === w.window.tokenDown ? 'DOWN' : null;
    if (!side) return;
    const previous = this._quotesByToken.get(tokenId) || emptyQuote();
    const next = {
      bid: update && Object.prototype.hasOwnProperty.call(update, 'bid') ? update.bid : previous.bid,
      ask: update && Object.prototype.hasOwnProperty.call(update, 'ask') ? update.ask : previous.ask,
    };
    next.mid = next.bid == null || next.ask == null ? null : (next.bid + next.ask) / 2;
    this._quotesByToken.set(tokenId, next);
    const up = this._quotesByToken.get(w.window.tokenUp) || emptyQuote();
    const down = this._quotesByToken.get(w.window.tokenDown) || emptyQuote();
    const now = Date.now();
    this.prices = { slug, ts: now, up: { ...up }, down: { ...down } };
    this._lastMarketEventAt = now;
    if (this.error && (this.error.startsWith('CLOB WebSocket') || this.error.startsWith('CLOB quote'))) this.error = null;
    if (up.ask != null && down.ask != null) {
      if (this._seriesSlug !== slug) { this._seriesSlug = slug; this.priceSeries = []; }
      if (now - this._lastSeriesAt >= 250) {
        this.priceSeries.push({ t: Math.round((now - w.openTs * 1000) / 1000), up: round(up.ask, 3), down: round(down.ask, 3) });
        if (this.priceSeries.length > 600) this.priceSeries.shift();
        this._lastSeriesAt = now;
      }
    }
    void this._processPriceUpdate(w, now).catch((error) => {
      this._push({ event: 'ERROR', slug, note: 'price update error: ' + error.message });
    });
  }

  async _processPriceUpdate(w, now) {
    if (!this._running || !this.w || this.w.slug !== w.slug) return;
    await this._managePositions();
    const elapsed = (now - w.openTs * 1000) / 1000;
    if (elapsed >= cfg.ENTRY_START_SECONDS && elapsed < WINDOW_SECONDS) await this._entryStep(w, elapsed);
  }

  async _entryStep(w, elapsedSeconds) {
    if (!w.window || w.tradeTaken || w.entryInFlight || this.executionHalt) return;
    if (elapsedSeconds < cfg.ENTRY_START_SECONDS || elapsedSeconds >= WINDOW_SECONDS) return;
    const px = this.prices && this.prices.slug === w.slug ? this.prices : null;
    if (!px) return;
    const observed = strategy.observeEntry(w, { UP: px.up.mid, DOWN: px.down.mid }, elapsedSeconds, cfg);
    for (const event of observed.events) {
      if (event === 'SIDE_ARMED') {
        w.status = 'waiting_for_return';
        this._push({ event, slug: w.slug, side: observed.side, shares: this.baseShares,
          note: observed.side + ' midpoint moved above $' + cfg.ENTRY_ARM_PRICE.toFixed(2) + '; waiting for that same side to return to $' + cfg.ENTRY_TRIGGER_PRICE.toFixed(2) });
      } else if (event === 'ENTRY_READY') {
        w.status = 'entry_ready';
        this._push({ event, slug: w.slug, side: observed.side, shares: this.baseShares,
          note: observed.side + ' midpoint reached or fell below $' + cfg.ENTRY_TRIGGER_PRICE.toFixed(2) + '; submitting an immediate taker market order' });
      }
    }
    if (!observed.side) {
      w.status = 'watching_above_threshold';
      return;
    }
    const sideMid = observed.side === 'UP' ? px.up.mid : px.down.mid;
    if (sideMid == null || sideMid > cfg.ENTRY_TRIGGER_PRICE) {
      if (!w.tradeTaken) w.status = 'waiting_for_return';
      return;
    }
    if (!observed.shouldBuy || Date.now() - w.lastOpenAttemptAt < cfg.ENTRY_RETRY_MS) return;
    w.lastOpenAttemptAt = Date.now();
    const tokenId = observed.side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    await this._fire(w, observed.side, tokenId);
  }

  async _fire(w, side, tokenId) {
    if (w.tradeTaken || w.entryInFlight || this.executionHalt) return false;
    w.entryInFlight = true;
    w.status = 'firing';
    const targetShares = this.baseShares;
    this._push({ event: 'FIRING', slug: w.slug, side, shares: targetShares,
      note: 'submitting a CLOB FAK market buy sized from the live ask book for about ' + targetShares + ' shares' });
    try {
      const book = await this.trader.getOrderBook(tokenId);
      const best = quote(book);
      if (!book || best.ask == null) {
        w.entryInFlight = false;
        w.status = 'waiting_for_return';
        this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares: targetShares, note: 'order book unavailable; keeping the side armed and waiting for the next quote' });
        return false;
      }
      if (best.ask > cfg.ENTRY_TRIGGER_PRICE) {
        w.entryInFlight = false;
        w.status = 'waiting_for_return';
        this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares: targetShares, note: 'best ask moved above $' + cfg.ENTRY_TRIGGER_PRICE.toFixed(2) + ' before submission; no order sent' });
        return false;
      }
      const budget = strategy.estimateMarketBuyBudget(book, targetShares);
      if (!(budget.amount > 0) || !(budget.shares > 0)) {
        w.entryInFlight = false;
        w.status = 'waiting_for_return';
        this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares: targetShares, note: 'no ask liquidity available for a market buy; will retry while the trigger remains active' });
        return false;
      }
      const estimatedEntryPrice = budget.averagePrice;
      const estimatedFee = feeForTrade(budget.shares, estimatedEntryPrice);
      if (!this.live && budget.amount + estimatedFee > this.cash) {
        w.entryInFlight = false;
        w.status = 'waiting_for_return';
        this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares: targetShares, note: 'demo balance too low for the estimated market buy and taker fee' });
        return false;
      }
      const result = await this.trader.placeFakMarketOrder(tokenId, 'BUY', budget.amount);
      let fill = strategy.normalizeMarketFill(result, 'BUY');
      if (!(fill.shares > 0) && result && result.id && typeof this.trader.getOrder === 'function') {
        try {
          const order = await this.trader.getOrder(result.id);
          fill = strategy.normalizeMarketFill({ ...result, raw: { ...(result.raw || {}), ...(order || {}) } }, 'BUY');
        } catch (_) {}
      }
      if (!(fill.shares > 0) || !(fill.notional > 0)) {
        const status = String((result && result.raw && result.raw.status) || (result && result.status) || '').toUpperCase();
        const knownNoFill = /UNMATCHED|CANCEL|FAILED|REJECT/.test(status);
        if (!knownNoFill && result && result.id && this.live) {
          this.executionHalt = true;
          w.tradeTaken = true;
          w.status = 'entry_ambiguous';
          this._push({ event: 'ENTRY_AMBIGUOUS', slug: w.slug, side, shares: targetShares,
            note: 'CLOB returned an order ID without a confirmed fill; automatic entries halted to avoid duplicating an uncertain order' });
        } else {
          w.status = 'waiting_for_return';
          this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares: targetShares, note: 'market order did not fill (status: ' + (status || 'unknown') + '); will retry if the trigger remains active' });
        }
        w.entryInFlight = false;
        return false;
      }
      const shares = fill.shares;
      const price = fill.averagePrice;
      const entryFee = feeForTrade(shares, price);
      const cost = fill.notional + entryFee;
      if (!this.live && cost > this.cash + 1e-8) {
        w.entryInFlight = false;
        w.status = 'waiting_for_return';
        this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares: targetShares, note: 'simulated fill plus taker fee exceeded available demo cash; no position recorded' });
        return false;
      }
      if (!this.live) this.cash -= cost;
      const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
      const position = {
        slug: w.slug, openTs: w.openTs, closeTs, side, tokenId,
        shares, openShares: shares, price, entryNotional: fill.notional,
        entryFee, exitFees: 0, cost, exitProceeds: 0, makerRebate: 0,
        tpOrderId: null, tpOrderShares: 0, tpMatched: 0, tpSharesSold: 0,
        stopLossHit: false, appliedSizeAdjustments: [], sizeAdjustments: [],
        tpPlacementAmbiguous: false, lastOrderPollAt: 0, nextTpAttemptAt: 0,
        nextStopAttemptAt: 0, stopInFlight: false, managementInFlight: false,
        expired: false, expiryLogged: false, settled: false, firedAt: Date.now(), status: 'open',
      };
      this.pending.push(position);
      w.position = position;
      w.tradeTaken = true;
      w.entryInFlight = false;
      w.status = 'open_position';
      this._push({ event: 'ENTRY_FILLED', slug: w.slug, side, shares: round(shares, 4), price: round(price, 4),
        note: 'taker market buy filled ' + round(shares, 4) + ' shares at average $' + round(price, 4) + '; estimated taker fee $' + round(entryFee, 3) });
      await this._managePosition(position);
      return true;
    } catch (error) {
      w.entryInFlight = false;
      if (this.live) {
        this.executionHalt = true;
        w.tradeTaken = true;
        w.status = 'entry_ambiguous';
        this._push({ event: 'ENTRY_AMBIGUOUS', slug: w.slug, side, shares: targetShares,
          note: 'market-order request failed after submission began; automatic entries halted until the wallet/order state is reconciled: ' + error.message });
      } else {
        w.status = 'waiting_for_return';
        this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares: targetShares, note: 'demo market order failed: ' + error.message });
      }
      return false;
    }
  }

  async _managePositions() {
    for (const position of this.pending.slice()) await this._managePosition(position);
  }

  async _managePosition(position) {
    if (!position || position.settled || position.managementInFlight) return;
    position.managementInFlight = true;
    try {
      const now = Date.now();
      if (position.stopExecutionAmbiguous) return;
      if (now >= position.closeTs * 1000) {
        if (position.tpOrderId) {
          const safe = await this._cancelTakeProfit(position);
          if (!safe) return;
        }
        if (position.openShares <= EPSILON) {
          this._finalizePosition(position, 'WIN', 'TAKE_PROFIT');
          return;
        }
        position.expired = true;
        position.status = 'awaiting_resolution';
        if (!position.expiryLogged) {
          position.expiryLogged = true;
          this._push({ event: 'EXPIRY_HOLD', slug: position.slug, side: position.side, shares: round(position.openShares, 4),
            note: 'no full TP or stop exit before the five-minute close; canceled the resting maker order and holding remaining shares to official resolution' });
        }
        return;
      }

      if (position.tpPlacementAmbiguous) {
        const reconciled = await this._reconcileAmbiguousTakeProfit(position);
        if (!reconciled) return;
      }
      const px = this.prices && this.prices.slug === position.slug ? this.prices : null;
      const sideQuote = px ? (position.side === 'UP' ? px.up : px.down) : null;
      const bid = sideQuote ? sideQuote.bid : null;
      if (position.tpOrderId && now - position.lastOrderPollAt >= cfg.ORDER_STATUS_POLL_MS) {
        position.lastOrderPollAt = now;
        await this._refreshTakeProfit(position);
      }
      if (position.openShares <= EPSILON) {
        this._finalizePosition(position, 'WIN', 'TAKE_PROFIT');
        return;
      }
      if (bid != null && bid <= cfg.STOP_LOSS_PRICE && now >= position.nextStopAttemptAt) {
        await this._stopPosition(position, bid);
        return;
      }
      if (!position.tpOrderId && !position.tpPlacementAmbiguous && now >= position.nextTpAttemptAt) {
        await this._placeTakeProfit(position, bid);
      }
    } catch (error) {
      this._push({ event: 'ERROR', slug: position.slug, note: 'position management failed: ' + error.message });
    } finally {
      position.managementInFlight = false;
    }
  }

  async _placeTakeProfit(position, bestBid) {
    if (position.openShares <= EPSILON || position.tpOrderId || position.tpPlacementAmbiguous) return;
    if (bestBid != null && bestBid >= cfg.TAKE_PROFIT_PRICE) {
      position.nextTpAttemptAt = Date.now() + 500;
      return;
    }
    position.nextTpAttemptAt = Date.now() + 1000;
    try {
      const order = await this.trader.placeGtcOrder(position.tokenId, 'SELL', cfg.TAKE_PROFIT_PRICE, position.openShares);
      if (!order || !order.id) throw new Error('maker order returned no order ID');
      position.tpOrderId = order.id;
      position.tpOrderShares = position.openShares;
      position.tpMatched = 0;
      position.lastOrderPollAt = 0;
      position.status = 'tp_resting';
      this._push({ event: 'TP_PLACED', slug: position.slug, side: position.side, shares: round(position.openShares, 4),
        note: 'post-only GTC take-profit resting at $' + cfg.TAKE_PROFIT_PRICE.toFixed(2) + ' for ' + round(position.openShares, 4) + ' shares' });
    } catch (error) {
      position.tpPlacementAmbiguous = this.live;
      position.status = this.live ? 'tp_placement_ambiguous' : 'open_position';
      this._push({ event: this.live ? 'TP_AMBIGUOUS' : 'ERROR', slug: position.slug, side: position.side,
        note: 'could not confirm maker-only take-profit order; ' + (this.live ? 'automatic position actions are paused to avoid a duplicate or over-sell' : error.message) });
    }
  }

  async _refreshTakeProfit(position) {
    if (!position.tpOrderId) return null;
    let order;
    try { order = await this.trader.getOrder(position.tpOrderId); }
    catch (_) { return null; }
    if (!order) return null;
    const matchedRaw = order.size_matched ?? order.sizeMatched ?? order.filled_size ?? order.filledSize;
    let cumulative = Number(matchedRaw);
    const state = String(order.status || order.state || '').toUpperCase();
    if (!(cumulative >= 0)) cumulative = 0;
    if ((state === 'MATCHED' || state === 'FILLED') && cumulative <= 0) cumulative = position.tpOrderShares;
    cumulative = Math.min(position.tpOrderShares, cumulative);
    const delta = Math.min(position.openShares, Math.max(0, cumulative - position.tpMatched));
    if (delta > EPSILON) {
      position.tpMatched += delta;
      position.tpSharesSold += delta;
      position.openShares = Math.max(0, position.openShares - delta);
      const fillPrice = Number(order.avg_fill_price || order.avgPrice || order.price) || cfg.TAKE_PROFIT_PRICE;
      const proceeds = delta * fillPrice;
      const rebate = delta * cfg.MAKER_REBATE_PER_SHARE;
      position.exitProceeds += proceeds;
      position.makerRebate += rebate;
      if (!this.live) this.cash += proceeds + rebate;
      this.stats.takeProfitFills += 1;
      this._applySizeAdjustment(position, 'WIN');
      this._push({ event: 'TP_FILL', slug: position.slug, side: position.side, shares: round(delta, 4), price: round(fillPrice, 4),
        note: 'maker TP filled ' + round(delta, 4) + ' shares at $' + round(fillPrice, 4) + '; TP counts as a $1/share win for strategy sizing' });
    }
    if (['CANCELED', 'CANCELLED', 'UNMATCHED', 'EXPIRED'].includes(state)) {
      position.tpOrderId = null;
      position.tpOrderShares = 0;
      position.tpMatched = 0;
      position.tpPlacementAmbiguous = false;
      position.nextTpAttemptAt = Date.now() + 500;
    }
    return { order, state };
  }

  async _reconcileAmbiguousTakeProfit(position) {
    if (!position.tpPlacementAmbiguous) return true;
    try {
      if (typeof this.trader.getOpenOrders === 'function') {
        const orders = await this.trader.getOpenOrders();
        const matches = (Array.isArray(orders) ? orders : []).filter((order) =>
          String(order.asset_id || order.assetId || '') === String(position.tokenId)
          && String(order.side || '').toUpperCase() === 'SELL'
          && Math.abs(Number(order.price) - cfg.TAKE_PROFIT_PRICE) < 1e-8);
        if (matches.length === 1) {
          const order = matches[0];
          position.tpOrderId = order.id || order.orderID || null;
          if (!position.tpOrderId) return false;
          position.tpOrderShares = Number(order.original_size || order.size) || position.openShares;
          position.tpMatched = 0;
          position.tpPlacementAmbiguous = false;
          await this._refreshTakeProfit(position);
          return true;
        }
      }
      if (typeof this.trader.cancelMarketOrders !== 'function') return false;
      await this.trader.cancelMarketOrders(position.tokenId);
      if (typeof this.trader.getOpenOrders === 'function') {
        const remaining = await this.trader.getOpenOrders();
        const matchingOpen = (Array.isArray(remaining) ? remaining : []).some((order) =>
          String(order.asset_id || order.assetId || '') === String(position.tokenId)
          && String(order.side || '').toUpperCase() === 'SELL'
          && Math.abs(Number(order.price) - cfg.TAKE_PROFIT_PRICE) < 1e-8);
        if (matchingOpen) return false;
      }
      if (typeof this.trader.getTokenBalance === 'function') {
        const balance = await this.trader.getTokenBalance(position.tokenId);
        if (Number.isFinite(balance)) {
          const before = position.openShares;
          const remaining = Math.min(before, Math.max(0, balance));
          const sold = before - remaining;
          if (sold > EPSILON) {
            const proceeds = sold * cfg.TAKE_PROFIT_PRICE;
            const rebate = sold * cfg.MAKER_REBATE_PER_SHARE;
            position.tpSharesSold += sold;
            position.openShares = remaining;
            position.exitProceeds += proceeds;
            position.makerRebate += rebate;
            if (!this.live) this.cash += proceeds + rebate;
            this._applySizeAdjustment(position, 'WIN');
          }
        }
      }
      position.tpPlacementAmbiguous = false;
      position.tpOrderId = null;
      position.tpOrderShares = 0;
      position.tpMatched = 0;
      return true;
    } catch (error) {
      this._warnOnce('tp-reconcile-' + position.slug, { event: 'ERROR', slug: position.slug,
        note: 'could not reconcile/cancel uncertain TP order: ' + error.message });
      return false;
    }
  }

  async _cancelTakeProfit(position) {
    if (position.tpPlacementAmbiguous) {
      const resolved = await this._reconcileAmbiguousTakeProfit(position);
      if (!resolved) return false;
    }
    if (!position.tpOrderId) return true;
    const id = position.tpOrderId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await this.trader.cancelOrder(id); } catch (_) {}
      const refreshed = await this._refreshTakeProfit(position);
      if (position.openShares <= EPSILON) return true;
      if (position.tpOrderId !== id) return true;
      const state = refreshed && refreshed.state;
      if (state && !['LIVE', 'OPEN', 'DELAYED', 'PENDING'].includes(state)) {
        position.tpOrderId = null;
        position.tpOrderShares = 0;
        position.tpMatched = 0;
        return true;
      }
    }
    this._push({ event: 'CANCEL_PENDING', slug: position.slug, side: position.side,
      note: 'maker TP cancellation is not confirmed; holding off on a market sell to prevent selling shares twice' });
    return false;
  }

  async _stopPosition(position, triggerBid) {
    if (position.stopInFlight || position.openShares <= EPSILON) return;
    position.stopInFlight = true;
    try {
      if (position.tpOrderId || position.tpPlacementAmbiguous) {
        const canceled = await this._cancelTakeProfit(position);
        if (!canceled) { position.nextStopAttemptAt = Date.now() + 500; return; }
      }
      if (position.openShares <= EPSILON) {
        this._finalizePosition(position, 'WIN', 'TAKE_PROFIT');
        return;
      }
      if (!position.stopLossHit) {
        position.stopLossHit = true;
        this.stats.stopLosses += 1;
        this._applySizeAdjustment(position, 'STOP_LOSS');
      }
      const requestedShares = position.openShares;
      this._push({ event: 'STOP_TRIGGERED', slug: position.slug, side: position.side, shares: round(position.openShares, 4), price: triggerBid,
        note: 'best bid reached $' + round(triggerBid, 3) + ' (stop $' + cfg.STOP_LOSS_PRICE.toFixed(2) + '); submitting a taker market sell' });
      let result;
      try { result = await this.trader.placeFakMarketOrder(position.tokenId, 'SELL', requestedShares); }
      catch (error) {
        if (this.live) this.executionHalt = true;
        position.status = 'stop_exit_ambiguous';
        position.stopExecutionAmbiguous = true;
        position.nextStopAttemptAt = Number.MAX_SAFE_INTEGER;
        this._push({ event: 'STOP_AMBIGUOUS', slug: position.slug, side: position.side, shares: round(requestedShares, 4),
          note: 'market-sell result is uncertain; no automatic retry until the order state is reconciled: ' + error.message });
        return;
      }
      const fill = strategy.normalizeMarketFill(result, 'SELL');
      if (!(fill.shares > 0) || !(fill.notional > 0)) {
        position.nextStopAttemptAt = Date.now() + 500;
        this._push({ event: 'STOP_NO_FILL', slug: position.slug, side: position.side, shares: round(requestedShares, 4),
          note: 'stop market order did not fill; will retry while the position remains open' });
        return;
      }
      const shares = Math.min(requestedShares, fill.shares);
      const avgPrice = fill.notional / fill.shares;
      const proceeds = fill.notional * (shares / fill.shares);
      const fee = feeForTrade(shares, avgPrice);
      position.exitFees += fee;
      position.exitProceeds += proceeds - fee;
      position.openShares = Math.max(0, position.openShares - shares);
      if (!this.live) this.cash += proceeds - fee;
      position.status = position.openShares <= EPSILON ? 'stop_closed' : 'stop_exit_partial';
      this._push({ event: 'STOP_FILLED', slug: position.slug, side: position.side, shares: round(shares, 4), price: round(avgPrice, 4),
        note: 'taker stop exit filled ' + round(shares, 4) + ' shares at average $' + round(avgPrice, 4) + '; next-window size adjusted after the stop hit' });
      if (position.openShares <= EPSILON) this._finalizePosition(position, 'LOSS', 'STOP_LOSS');
      else position.nextStopAttemptAt = Date.now() + 500;
    } finally {
      position.stopInFlight = false;
    }
  }

  _applySizeAdjustment(position, outcome) {
    if (!position.appliedSizeAdjustments) position.appliedSizeAdjustments = [];
    if (position.appliedSizeAdjustments.includes(outcome)) return;
    position.appliedSizeAdjustments.push(outcome);
    const before = this.baseShares;
    this.baseShares = strategy.adjustBaseShares(this.baseShares, outcome, cfg);
    this.shareAdditions = strategy.additionCount(this.baseShares, cfg);
    position.sizeAdjustments.push({ outcome, before, after: this.baseShares });
    this._push({ event: 'SIZE_ADJUSTED', slug: position.slug, side: position.side, shares: this.baseShares,
      note: outcome + ': next-window size ' + before + ' → ' + this.baseShares + ' shares (' + this.shareAdditions + '/' + cfg.MAX_SHARE_ADDITIONS + ' additions)' });
  }

  async _settlementLoop() {
    while (this._running) {
      await sleep(cfg.SETTLEMENT_POLL_MS);
      const now = Date.now();
      for (const position of this.pending.slice()) {
        if (position.settled || now < position.closeTs * 1000 || position.managementInFlight || position.stopExecutionAmbiguous) continue;
        position.managementInFlight = true;
        try {
          if (position.tpOrderId || position.tpPlacementAmbiguous) {
            const safe = await this._cancelTakeProfit(position);
            if (!safe) continue;
          }
          if (position.openShares <= EPSILON) {
            this._finalizePosition(position, 'WIN', 'TAKE_PROFIT');
            continue;
          }
          const prior = this.outcomes.get(position.openTs);
          let winner = prior && prior.winner;
          const lastTried = this._resolveTried.get(position.openTs) || 0;
          if (!winner && now - lastTried >= cfg.RESOLUTION_RETRY_MS) {
            this._resolveTried.set(position.openTs, now);
            try { winner = await fetchResolution(position.slug); }
            catch (error) {
              this._warnOnce('resolution-' + position.openTs, { event: 'ERROR', slug: position.slug, note: 'official result lookup failed: ' + error.message });
            }
            if (winner) this._recordOutcome(position.openTs, position.slug, winner, 'official');
          }
          if (winner) {
            const payout = winner === position.side ? position.openShares : 0;
            if (!this.live) this.cash += payout;
            position.exitProceeds += payout;
            position.openShares = 0;
            position.resolutionPayout = payout;
            const outcome = winner === position.side ? 'WIN' : 'LOSS';
            if (outcome === 'WIN') {
              this.stats.expiryWins += 1;
              this._applySizeAdjustment(position, 'WIN');
            } else {
              this.stats.expiryLosses += 1;
            }
            this._finalizePosition(position, outcome, 'RESOLUTION', winner);
            this._resolveTried.delete(position.openTs);
          } else if (now - position.firedAt > cfg.SETTLEMENT_GIVE_UP_MS && !position.settlementTimedOut) {
            position.settlementTimedOut = true;
            this._push({ event: 'SETTLEMENT_TIMEOUT', slug: position.slug, side: position.side, shares: round(position.openShares, 4),
              note: 'official result is still pending; position remains open and resolution checks continue' });
          }
        } finally {
          position.managementInFlight = false;
        }
      }
    }
  }

  _recordOutcome(openTs, slug, winner, source) {
    if (this.outcomes.has(openTs)) return;
    this.outcomes.set(openTs, { winner, source, price: 1, loser: 0 });
    this.counts[winner] = (this.counts[winner] || 0) + 1;
    if (this.outcomes.size > 60) this.outcomes.delete(this.outcomes.keys().next().value);
    this._push({ event: 'OUTCOME', slug, side: winner,
      note: 'official Polymarket resolution: ' + winner + ' won ($1/share); ' + (winner === 'UP' ? 'DOWN' : 'UP') + ' lost ($0/share)' });
  }

  _finalizePosition(position, outcome, reason, winner = null) {
    if (position.settled) return;
    position.settled = true;
    position.status = 'closed';
    const pnl = position.exitProceeds + (position.makerRebate || 0) - position.cost;
    const baseBefore = position.sizeAdjustments.length ? position.sizeAdjustments[0].before : this.baseShares;
    this.stats.realizedPnl += pnl;
    this.stats.estimatedFees += position.entryFee + position.exitFees;
    if (outcome === 'WIN') this.stats.wins += 1; else this.stats.losses += 1;
    const trade = {
      slug: position.slug, openTs: position.openTs, side: position.side,
      winner: winner || (reason === 'TAKE_PROFIT' ? position.side : null), outcome, reason,
      shares: position.shares, tpShares: position.tpSharesSold || 0,
      entryPrice: round(position.price, 4), price: round(position.price, 4),
      entryNotional: round(position.entryNotional, 4), cost: round(position.cost, 4),
      fee: round(position.entryFee + position.exitFees, 4), rebate: round(position.makerRebate || 0, 4),
      proceeds: round(position.exitProceeds, 4), pnl: round(pnl, 2),
      outcomeValuePerShare: reason === 'TAKE_PROFIT' ? 1 : (reason === 'RESOLUTION' && outcome === 'WIN' ? 1 : null),
      baseSharesBefore: baseBefore, baseSharesAfter: this.baseShares,
      additionsAfter: this.shareAdditions, ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    if (this.w && this.w.openTs === position.openTs) this.w.status = 'settled';
    if (this.capital != null) {
      const equity = this.live && this.walletBalance != null ? this.walletBalance : this.cash;
      if (equity != null) {
        this.equity.push({ ts: Date.now(), v: round(equity, 2) });
        if (this.equity.length > 500) this.equity.shift();
        this.peak = Math.max(this.peak == null ? equity : this.peak, equity);
        this.maxDD = Math.max(this.maxDD, this.peak - equity);
      }
    }
    const event = outcome === 'WIN' ? 'SETTLED_WIN' : 'SETTLED_LOSS';
    this._push({ event, slug: position.slug, side: position.side, shares: round(position.shares, 4), pnl: round(pnl, 2),
      note: reason + ' · ' + outcome + ' · actual-fill P&L ' + (pnl >= 0 ? '+' : '') + '$' + round(pnl, 2) + '; next-window base ' + this.baseShares + ' shares' });
  }

  async _balanceLoop() {
    while (this._running) {
      try {
        this.walletBalance = await this.trader.getBalance();
        if (this.live && this.capital == null && this.walletBalance != null) {
          this.capital = this.walletBalance;
          this.peak = this.capital;
          this.equity = [{ ts: Date.now(), v: this.capital }];
        }
      } catch (error) {
        this._push({ event: 'ERROR', note: 'balance check failed: ' + error.message });
      }
      await sleep(30_000);
    }
  }

  snapshot() {
    const now = Date.now();
    const w = this.w;
    const px = this.prices;
    const pending = this.pending.slice(-10).map((position) => {
      const q = px && px.slug === position.slug ? (position.side === 'UP' ? px.up : px.down) : null;
      const mark = q ? (q.bid == null ? q.mid : q.bid) : null;
      const openCost = position.shares > 0 ? position.cost * (position.openShares / position.shares) : 0;
      return { ...position, mark, unrealized: mark == null ? null : position.openShares * mark - openCost };
    });
    const openValue = pending.reduce((sum, position) => sum + (position.mark != null ? position.openShares * position.mark : 0), 0);
    const cash = this.live ? this.walletBalance : this.cash;
    const outcomeRows = [...this.outcomes.entries()].slice(-24).map(([openTs, outcome]) => {
      const trade = this.trades.find((item) => item.openTs === openTs);
      const open = this.pending.find((item) => item.openTs === openTs);
      return { openTs, winner: outcome.winner, source: outcome.source, price: outcome.price, loser: outcome.loser,
        traded: trade ? trade.side : open ? open.side : null, result: trade ? trade.outcome : null, pnl: trade ? trade.pnl : null };
    });
    const elapsed = w ? Math.max(0, (now - w.openTs * 1000) / 1000) : 0;
    return {
      now, mode: this.live ? 'LIVE' : 'DEMO', uptimeSec: Math.floor((now - this.startedAt) / 1000),
      error: this.error, executionHalt: this.executionHalt, walletBalance: this.walletBalance,
      walletAddress: this.trader.depositWallet || this.trader.address,
      account: { capital: this.capital, cash, openValue, equity: cash == null ? null : cash + openValue, maxDrawdown: this.maxDD },
      window: w ? { slug: w.slug, status: w.status, side: w.position ? w.position.side : w.armedSide,
        armedSide: w.armedSide, shares: w.position ? w.position.shares : this.baseShares,
        openTs: w.openTs, closeTs: w.openTs + WINDOW_SECONDS, elapsedSeconds: elapsed,
        tradeTaken: w.tradeTaken, entryReady: w.status === 'entry_ready', positionStatus: w.position ? w.position.status : null } : null,
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      strategy: { armedSide: w ? w.armedSide : null, currentAsk: w && px && px.slug === w.slug && w.armedSide ? (w.armedSide === 'UP' ? px.up.ask : px.down.ask) : null,
        baseShares: this.baseShares, additions: this.shareAdditions, maxAdditions: cfg.MAX_SHARE_ADDITIONS,
        entryStartSeconds: cfg.ENTRY_START_SECONDS, armPrice: cfg.ENTRY_ARM_PRICE, entryPrice: cfg.ENTRY_TRIGGER_PRICE,
        stopLossPrice: cfg.STOP_LOSS_PRICE, takeProfitPrice: cfg.TAKE_PROFIT_PRICE,
        feeRateEstimate: cfg.TAKER_FEE_RATE },
      counts: this.counts, recentOutcomes: outcomeRows, pending, trades: this.trades.slice(-60).reverse(),
      equity: this.equity, stats: this.stats,
      cfg: { demoCapital: cfg.DEMO_CAPITAL, entryStartSeconds: cfg.ENTRY_START_SECONDS,
        armPrice: cfg.ENTRY_ARM_PRICE, entryPrice: cfg.ENTRY_TRIGGER_PRICE,
        stopLossPrice: cfg.STOP_LOSS_PRICE, takeProfitPrice: cfg.TAKE_PROFIT_PRICE,
        baseShares: cfg.BASE_SHARES, shareStep: cfg.SHARE_STEP, maxAdditions: cfg.MAX_SHARE_ADDITIONS,
        windowSec: WINDOW_SECONDS, makerRebatePerShare: cfg.MAKER_REBATE_PER_SHARE },
      log: this.log.slice(-100).reverse(),
    };
  }
}

function emptyQuote() { return { bid: null, ask: null, mid: null }; }

function quote(book) {
  if (!book) return emptyQuote();
  const bids = (book.bids || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
  const asks = (book.asks || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
  const bid = bids.length ? Math.max(...bids.map((level) => level.price)) : null;
  const ask = asks.length ? Math.min(...asks.map((level) => level.price)) : null;
  return { bid, ask, mid: bid == null || ask == null ? null : (bid + ask) / 2 };
}

function feeForTrade(shares, price) {
  const p = Number(price);
  const n = Number(shares);
  if (!(p > 0 && p < 1) || !(n > 0)) return 0;
  return n * cfg.TAKER_FEE_RATE * p * (1 - p);
}

const round = (value, digits = 2) => Number.isFinite(Number(value)) ? Math.round(Number(value) * (10 ** digits)) / (10 ** digits) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = Bot;
