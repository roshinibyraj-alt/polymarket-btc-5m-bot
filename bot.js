'use strict';

const cfg = require('./config');
const { getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS, fetchResolution } = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');
const { estimateMakerRebate } = require('./strategy');

const MAX_LOG = 300;
const EPSILON = 1e-8;
const SIDES = ['UP', 'DOWN'];

class Bot {
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.live = !!opts.live;
    this.demoMode = !this.live && !!(trader && trader.demoMode === true);
    this.strategyBlocked = this.live || !this.demoMode;
    this.w = null;
    this.pending = [];
    this.trades = [];
    this.outcomes = new Map();
    this._resolveTried = new Map();
    this._warned = new Set();
    this.stats = {
      wins: 0, losses: 0, takeProfitFills: 0, expiryWins: 0, expiryLosses: 0,
      estimatedFees: 0, estimatedMakerRebates: 0, realizedPnl: 0,
    };
    this.counts = { UP: 0, DOWN: 0 };
    this.walletBalance = null;
    this.error = this.strategyBlocked ? 'This four-rung strategy is demo-only; order submission is disabled outside DemoTrader.' : null;
    this.executionHalt = this.strategyBlocked;
    this.log = [];
    this.startedAt = Date.now();
    this.capital = this.demoMode ? cfg.DEMO_CAPITAL : null;
    this.cash = this.demoMode ? cfg.DEMO_CAPITAL : null;
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
    if (this._running || this.strategyBlocked) {
      if (this.strategyBlocked) this._warnOnce('live-strategy-blocked', {
        event: 'LIVE_BLOCKED',
        note: 'The four-rung strategy requires the DemoTrader adapter; no live order methods will be called.',
      });
      return;
    }
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
    if (this.strategyBlocked) return;
    const now = Date.now();
    const openTs = currentWindowOpenTs(now);
    const slug = slugForTs(openTs);
    if (!this.w || this.w.slug !== slug) {
      if (this.w) await this._closeWindowOrders(this.w);
      this.w = makeWindowState(slug, openTs);
    }
    const w = this.w;
    if (!w.window) {
      const result = await getActiveWindow(now);
      if (result.window) {
        this.error = null;
        w.window = result.window;
        w.status = 'placing_orders';
        this._push({
          event: 'WINDOW_READY', slug: w.slug,
          note: 'BTC 5-minute market is active; placing four 500-share entry rungs on both UP and DOWN.',
        });
        await this._startWindowOrders(w);
      } else {
        this.error = result.reason || 'active market unavailable';
        w.status = 'waiting_for_market';
      }
    }
    if (!w.window) return;
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (now >= closeTs * 1000) {
      await this._closeWindowOrders(w);
      return;
    }
    if (!w.ordersStarted) await this._startWindowOrders(w);
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
          this._warnOnce('market-meta-' + w.slug, {
            event: 'ERROR', slug: w.slug, note: 'market metadata warm-up failed: ' + error.message,
          });
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
      this._warnOnce('seed-' + w.slug, {
        event: 'ERROR', slug: w.slug, note: 'CLOB quote refresh failed: ' + error.message,
      });
    }
  }

  _onQuote(slug, tokenId, update) {
    const w = this.w;
    if (!w || w.slug !== slug || !w.window || w.closing || w.closed) return;
    const now = Date.now();
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (now >= closeTs * 1000) {
      void this._closeWindowOrders(w).catch((error) => {
        this._push({ event: 'ERROR', slug, note: 'window close order cancellation failed: ' + error.message });
      });
      return;
    }
    const side = tokenId === w.window.tokenUp ? 'UP' : tokenId === w.window.tokenDown ? 'DOWN' : null;
    if (!side) return;
    const previous = this._quotesByToken.get(tokenId) || emptyQuote();
    const next = {
      bid: update && Object.prototype.hasOwnProperty.call(update, 'bid') ? update.bid : previous.bid,
      ask: update && Object.prototype.hasOwnProperty.call(update, 'ask') ? update.ask : previous.ask,
    };
    next.mid = next.bid == null || next.ask == null ? null : (next.bid + next.ask) / 2;
    this._quotesByToken.set(tokenId, next);
    if (typeof this.trader.updateQuote === 'function') this.trader.updateQuote(tokenId, next);
    const up = this._quotesByToken.get(w.window.tokenUp) || emptyQuote();
    const down = this._quotesByToken.get(w.window.tokenDown) || emptyQuote();
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
    if (!this._running || this.strategyBlocked || !this.w || this.w.slug !== w.slug) return;
    const closeTs = w.window && (Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS);
    if (closeTs && now >= closeTs * 1000) {
      await this._closeWindowOrders(w);
      return;
    }
    await this._manageCycles(w, now, true);
  }

  async _startWindowOrders(w) {
    if (!w || !w.window || w.ordersStarted || w.closing || w.closed || this.strategyBlocked) return;
    w.ordersStarted = true;
    await this._manageCycles(w, Date.now(), true);
    this._updateWindowStatus(w);
  }

  async _managePositions() {
    if (this.strategyBlocked || !this.w || !this.w.window) return;
    const now = Date.now();
    const closeTs = Number(this.w.window.closeTs) || this.w.openTs + WINDOW_SECONDS;
    if (now >= closeTs * 1000) {
      await this._closeWindowOrders(this.w);
      return;
    }
    await this._manageCycles(this.w, now);
  }

  async _manageCycles(w, now = Date.now(), forcePoll = false) {
    if (this.strategyBlocked || !w || !w.window || w.closing || w.closed) return;
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (now >= closeTs * 1000) {
      await this._closeWindowOrders(w);
      return;
    }
    await Promise.all(w.rungs.map((rung) => this._manageRung(w, rung, now, forcePoll)));
    this._updateWindowStatus(w);
  }

  async _manageRung(w, rung, now, forcePoll = false) {
    if (!rung || rung.inFlight || w.closing || w.closed) return;
    rung.inFlight = true;
    try {
      await Promise.all(SIDES.map((side) => this._placeEntryOrder(w, rung, rung.sides[side], now)));
      await this._refreshRungEntries(w, rung, now, forcePoll);
      await Promise.all(SIDES.map(async (side) => {
        const sideState = rung.sides[side];
        if (!sideState.position || sideState.position.openShares <= EPSILON) return;
        const hadTpOrder = !!sideState.tpOrderId;
        if (!hadTpOrder) await this._placeTakeProfit(w, rung, sideState, Date.now());
        if (sideState.tpOrderId) {
          await this._refreshTakeProfit(w, rung, sideState, Date.now(), forcePoll || !hadTpOrder);
        }
      }));
    } finally {
      rung.inFlight = false;
    }
  }

  async _placeEntryOrder(w, rung, sideState, now) {
    if (this.strategyBlocked || !w.window || w.closing || w.closed
      || sideState.entryOrderId || sideState.entryFilled || now < sideState.nextEntryAttemptAt) return;
    sideState.nextEntryAttemptAt = now + cfg.ENTRY_RETRY_MS;
    const tokenId = sideState.side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    try {
      const order = await this.trader.placeGtcOrder(tokenId, 'BUY', rung.entryPrice, cfg.BASE_SHARES);
      if (!order || !order.id) throw new Error('demo GTC buy returned no order ID');
      sideState.entryOrderId = order.id;
      sideState.status = 'buy_resting';
      sideState.entryLastPollAt = 0;
      this._push({
        event: 'BUY_LIMIT_PLACED', slug: w.slug, side: sideState.side,
        rungPrice: rung.entryPrice, shares: cfg.BASE_SHARES,
        note: 'GTC ' + sideState.side + ' BUY limit placed at $' + rung.entryPrice.toFixed(2)
          + ' for exactly ' + cfg.BASE_SHARES + ' shares.',
      });
    } catch (error) {
      sideState.status = 'buy_retry';
      this._push({
        event: 'BUY_LIMIT_RETRY', slug: w.slug, side: sideState.side,
        rungPrice: rung.entryPrice, shares: cfg.BASE_SHARES,
        note: 'could not place demo BUY at $' + rung.entryPrice.toFixed(2)
          + '; retrying while the five-minute window is open: ' + error.message,
      });
    }
  }

  async _refreshRungEntries(w, rung, now, force = false) {
    const fills = await Promise.all(SIDES.map(async (side) => {
      const sideState = rung.sides[side];
      if (!sideState.entryOrderId || sideState.entryFilled) return null;
      if (!force && now - sideState.entryLastPollAt < cfg.ORDER_STATUS_POLL_MS) return null;
      sideState.entryLastPollAt = now;
      let order;
      try { order = await this.trader.getOrder(sideState.entryOrderId); }
      catch (error) {
        this._warnOnce('entry-poll-' + sideState.entryOrderId, {
          event: 'ERROR', slug: w.slug, side, rungPrice: rung.entryPrice,
          note: 'entry order status lookup failed: ' + error.message,
        });
        return null;
      }
      if (!order) return null;
      const state = orderState(order);
      const matched = matchedShares(order, cfg.BASE_SHARES);
      const filled = matched >= cfg.BASE_SHARES - EPSILON || (['MATCHED', 'FILLED'].includes(state) && matched <= EPSILON);
      if (filled) return { side, sideState, order, matchedAt: Number(order.matchedAt || order.filledAt) || 0 };
      if (['CANCELED', 'CANCELLED', 'UNMATCHED', 'EXPIRED', 'REJECTED'].includes(state)) {
        sideState.entryOrderId = null;
        sideState.status = w.closing || w.closed ? 'window_closed' : 'buy_retry';
        sideState.nextEntryAttemptAt = now + cfg.ENTRY_RETRY_MS;
      }
      return null;
    }));
    fills.filter(Boolean).sort((a, b) => {
      if (a.matchedAt && b.matchedAt && a.matchedAt !== b.matchedAt) return a.matchedAt - b.matchedAt;
      return SIDES.indexOf(a.side) - SIDES.indexOf(b.side);
    }).forEach(({ side, sideState, order }) => this._recordEntryFill(w, rung, side, sideState, order));
  }

  _recordEntryFill(w, rung, side, sideState, order = null) {
    if (sideState.entryFilled || rung.fillCount >= SIDES.length) return;
    const shares = cfg.BASE_SHARES;
    const price = rung.entryPrice;
    const fillNumber = rung.fillCount + 1;
    if (fillNumber === 1) rung.firstFillSide = side;
    const takeProfitPrice = fillNumber === 1 ? rung.takeProfitPrice : cfg.SECOND_FILL_TAKE_PROFIT_PRICE;
    const notional = shares * price;
    const reportedRebate = Number(order && order.makerRebateEstimate);
    const rebate = order && Number.isFinite(reportedRebate) && reportedRebate >= 0
      ? reportedRebate : estimateMakerRebate(shares, price);
    const position = {
      slug: w.slug, openTs: w.openTs,
      closeTs: Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS,
      side, tokenId: side === 'UP' ? w.window.tokenUp : w.window.tokenDown,
      rungPrice: price, takeProfitPrice, rungFillNumber: fillNumber,
      firstFillSide: rung.firstFillSide,
      shares, openShares: shares, price,
      entryNotional: notional, entryFee: 0, exitFees: 0, cost: notional,
      exitProceeds: 0, entryRebate: rebate, takeProfitRebate: 0, makerRebate: rebate, tpSharesSold: 0,
      status: 'open_position', firedAt: Date.now(), settled: false,
      expiryLogged: false, settlementTimedOut: false,
    };
    sideState.entryFilled = true;
    sideState.position = position;
    sideState.status = 'position_open';
    rung.fillCount = fillNumber;
    this.pending.push(position);
    this.cash += rebate - notional;
    this.stats.estimatedMakerRebates += rebate;
    this._push({
      event: 'BUY_LIMIT_FILLED', slug: w.slug, side, rungPrice: price,
      fillNumber, takeProfitPrice, shares: round(shares, 4), price,
      rebate: round(rebate, 5),
      note: 'demo maker BUY filled on ask touch for the $' + price.toFixed(2) + ' rung; this is fill '
        + fillNumber + ' of 2 for the rung and TP is $' + takeProfitPrice.toFixed(2)
        + '. Maker fee $0; estimated rebate $' + rebate.toFixed(5) + ' credited.',
    });
  }

  async _placeTakeProfit(w, rung, sideState, now) {
    const position = sideState.position;
    if (this.strategyBlocked || !position || position.openShares <= EPSILON
      || sideState.tpOrderId || w.closing || w.closed) return;
    sideState.tpLastPollAt = now;
    try {
      const order = await this.trader.placeGtcOrder(
        position.tokenId, 'SELL', position.takeProfitPrice, position.openShares,
      );
      if (!order || !order.id) throw new Error('demo GTC take-profit returned no order ID');
      sideState.tpOrderId = order.id;
      sideState.tpOrderShares = position.openShares;
      sideState.tpMatched = 0;
      position.tpOrderId = order.id;
      position.status = 'tp_resting';
      sideState.status = 'tp_resting';
      this._push({
        event: 'TP_LIMIT_PLACED', slug: w.slug, side: position.side,
        rungPrice: rung.entryPrice, takeProfitPrice: position.takeProfitPrice,
        shares: round(position.openShares, 4),
        note: 'GTC limit SELL placed at $' + position.takeProfitPrice.toFixed(2)
          + ' for the $' + rung.entryPrice.toFixed(2) + ' rung trade.',
      });
    } catch (error) {
      sideState.status = 'tp_retry';
      position.status = 'open_position';
      this._push({
        event: 'TP_LIMIT_RETRY', slug: w.slug, side: position.side, rungPrice: rung.entryPrice,
        note: 'could not place demo take-profit at $' + position.takeProfitPrice.toFixed(2)
          + '; retrying while the window is open: ' + error.message,
      });
    }
  }

  async _refreshTakeProfit(w, rung, sideState, now, force = false) {
    if (!sideState.tpOrderId || !sideState.position) return null;
    if (!force && now - sideState.tpLastPollAt < cfg.ORDER_STATUS_POLL_MS) return null;
    sideState.tpLastPollAt = now;
    let order;
    try { order = await this.trader.getOrder(sideState.tpOrderId); }
    catch (error) {
      this._warnOnce('tp-poll-' + sideState.tpOrderId, {
        event: 'ERROR', slug: w.slug, side: sideState.side, rungPrice: rung.entryPrice,
        note: 'take-profit order status lookup failed: ' + error.message,
      });
      return null;
    }
    if (!order) return null;
    const state = orderState(order);
    const position = sideState.position;
    let matched = matchedShares(order, sideState.tpOrderShares);
    if (['MATCHED', 'FILLED'].includes(state) && matched <= EPSILON) matched = sideState.tpOrderShares;
    const delta = Math.min(position.openShares, Math.max(0, matched - sideState.tpMatched));
    if (delta > EPSILON) {
      sideState.tpMatched += delta;
      position.openShares = Math.max(0, position.openShares - delta);
      position.tpSharesSold += delta;
      const proceeds = delta * position.takeProfitPrice;
      const rebate = estimateMakerRebate(delta, position.takeProfitPrice);
      position.exitProceeds += proceeds;
      position.makerRebate += rebate;
      position.takeProfitRebate += rebate;
      this.cash += proceeds + rebate;
      this.stats.takeProfitFills += 1;
      this.stats.estimatedMakerRebates += rebate;
      this._push({
        event: 'TP_LIMIT_FILLED', slug: w.slug, side: sideState.side,
        rungPrice: rung.entryPrice, shares: round(delta, 4), price: position.takeProfitPrice,
        rebate: round(rebate, 5),
        note: 'demo maker SELL filled on bid touch at $' + position.takeProfitPrice.toFixed(2)
          + '; actual proceeds use that price. Maker fee $0, estimated rebate $'
          + rebate.toFixed(5) + ' credited.',
      });
    }
    if (['CANCELED', 'CANCELLED', 'UNMATCHED', 'EXPIRED', 'REJECTED'].includes(state)) {
      sideState.tpOrderId = null;
      sideState.tpOrderShares = 0;
      sideState.tpMatched = 0;
      if (position.openShares > EPSILON) {
        sideState.status = 'position_open';
        position.status = 'open_position';
      }
    }
    if (position.openShares <= EPSILON) {
      const completed = position;
      this._finalizePosition(completed, 'WIN', 'TAKE_PROFIT');
      sideState.position = null;
      sideState.tpOrderId = null;
      sideState.status = 'trade_complete';
      this._push({
        event: 'RUNG_TRADE_CLOSED', slug: w.slug, side: sideState.side,
        rungPrice: rung.entryPrice,
        note: 'the $' + rung.entryPrice.toFixed(2) + ' rung trade closed; it will not re-arm this window.',
      });
    }
    return { order, state };
  }

  async _closeWindowOrders(w) {
    if (!w || !w.window || w.closed || w.closing) {
      if (w && !w.window) w.closed = true;
      return;
    }
    w.closing = true;
    w.status = 'closing_orders';
    for (const rung of w.rungs) {
      await this._refreshRungEntries(w, rung, Date.now(), true);
      for (const side of SIDES) {
        const sideState = rung.sides[side];
        if (sideState.entryOrderId && !sideState.entryFilled) {
          const entryOrderId = sideState.entryOrderId;
          await this._cancelAndRefresh(entryOrderId,
            () => this._refreshRungEntries(w, rung, Date.now(), true), w, side);
          if (sideState.entryOrderId === entryOrderId) sideState.entryOrderId = null;
        }
      }
    }
    for (const rung of w.rungs) {
      for (const side of SIDES) {
        const sideState = rung.sides[side];
        if (sideState.tpOrderId) {
          await this._refreshTakeProfit(w, rung, sideState, Date.now(), true);
          if (sideState.tpOrderId) {
            const tpOrderId = sideState.tpOrderId;
            await this._cancelAndRefresh(tpOrderId,
              () => this._refreshTakeProfit(w, rung, sideState, Date.now(), true), w, side);
          }
        }
        if (sideState.position && sideState.position.openShares > EPSILON) {
          sideState.position.status = 'awaiting_resolution';
          if (!sideState.position.expiryLogged) {
            sideState.position.expiryLogged = true;
            this._push({
              event: 'EXPIRY_HOLD', slug: w.slug, side,
              rungPrice: rung.entryPrice, shares: round(sideState.position.openShares, 4),
              note: 'window closed; canceled resting orders and holding unsold shares for official Polymarket resolution.',
            });
          }
          sideState.status = 'awaiting_resolution';
        } else if (!sideState.position && !sideState.entryOrderId) {
          sideState.status = 'window_closed';
        }
      }
    }
    w.closed = true;
    w.closing = false;
    w.status = this.pending.some((position) => position.openTs === w.openTs && !position.settled)
      ? 'awaiting_resolution' : 'window_closed';
    this._push({
      event: 'WINDOW_CLOSED', slug: w.slug,
      note: 'window ended; no new orders will be placed and any unresolved shares await the official market result.',
    });
  }

  async _cancelAndRefresh(orderId, refresh, w, side) {
    try { await this.trader.cancelOrder(orderId); }
    catch (error) {
      this._push({ event: 'CANCEL_WARNING', slug: w.slug, side, note: 'cancel request failed for resting order: ' + error.message });
    }
    try { await refresh(); }
    catch (error) {
      this._push({ event: 'CANCEL_WARNING', slug: w.slug, side, note: 'could not refresh order after cancellation: ' + error.message });
    }
  }

  async _readOrderState(id) {
    try { return await this.trader.getOrder(id); } catch (_) { return null; }
  }

  _updateWindowStatus(w) {
    if (!w || w.closed || w.closing) return;
    if (this.pending.some((position) => position.openTs === w.openTs && !position.settled)) w.status = 'positions_active';
    else if (w.rungs.some((rung) => SIDES.some((side) => {
      const state = rung.sides[side];
      return state.entryOrderId && !state.entryFilled;
    }))) w.status = 'buy_limits_resting';
    else w.status = 'orders_active';
  }

  async _settlementLoop() {
    while (this._running) {
      await sleep(cfg.SETTLEMENT_POLL_MS);
      await this._settleClosedPositions(Date.now());
    }
  }

  async _settleClosedPositions(now = Date.now()) {
    for (const position of this.pending.slice()) {
      if (position.settled || now < position.closeTs * 1000) continue;
      if (this.w && this.w.openTs === position.openTs && !this.w.closed) {
        if (this.w.closing) continue;
        await this._closeWindowOrders(this.w);
      }
      const prior = this.outcomes.get(position.openTs);
      let winner = prior && prior.winner;
      const lastTried = this._resolveTried.get(position.openTs) || 0;
      if (!winner && now - lastTried >= cfg.RESOLUTION_RETRY_MS) {
        this._resolveTried.set(position.openTs, now);
        try {
          // Preserve the official-resolution filter: fetchResolution returns a side only
          // when Gamma says closed=true and an outcome price is decisive (>= 0.99).
          winner = await fetchResolution(position.slug);
        } catch (error) {
          this._warnOnce('resolution-' + position.openTs, {
            event: 'ERROR', slug: position.slug, note: 'official result lookup failed: ' + error.message,
          });
        }
        if (winner) this._recordOutcome(position.openTs, position.slug, winner, 'official');
      }
      if (winner !== 'UP' && winner !== 'DOWN') {
        if (now - position.firedAt > cfg.SETTLEMENT_GIVE_UP_MS && !position.settlementTimedOut) {
          position.settlementTimedOut = true;
          this._push({
            event: 'SETTLEMENT_TIMEOUT', slug: position.slug, side: position.side,
            shares: round(position.openShares, 4),
            note: 'official result is still pending; position remains open and resolution checks continue.',
          });
        }
        continue;
      }
      const payout = winner === position.side ? position.openShares : 0;
      this.cash += payout;
      position.exitProceeds += payout;
      position.openShares = 0;
      position.resolutionPayout = payout;
      const outcome = winner === position.side ? 'WIN' : 'LOSS';
      if (outcome === 'WIN') this.stats.expiryWins += 1;
      else this.stats.expiryLosses += 1;
      this._finalizePosition(position, outcome, 'RESOLUTION', winner);
      this._resolveTried.delete(position.openTs);
    }
  }

  _recordOutcome(openTs, slug, winner, source) {
    if (this.outcomes.has(openTs)) return;
    this.outcomes.set(openTs, { winner, source, price: 1, loser: 0 });
    this.counts[winner] = (this.counts[winner] || 0) + 1;
    if (this.outcomes.size > 60) this.outcomes.delete(this.outcomes.keys().next().value);
    this._push({
      event: 'OUTCOME', slug, side: winner,
      note: 'official Polymarket resolution: ' + winner + ' won ($1/share); ' + (winner === 'UP' ? 'DOWN' : 'UP') + ' lost ($0/share).',
    });
  }

  _finalizePosition(position, outcome, reason, winner = null) {
    if (position.settled) return;
    position.settled = true;
    position.status = 'closed';
    const pnl = position.exitProceeds + (position.makerRebate || 0) - position.cost;
    this.stats.realizedPnl += pnl;
    this.stats.estimatedFees += position.entryFee + position.exitFees;
    if (outcome === 'WIN') this.stats.wins += 1;
    else this.stats.losses += 1;
    const trade = {
      slug: position.slug, openTs: position.openTs, side: position.side,
      rungPrice: round(position.rungPrice, 4),
      takeProfitPrice: round(position.takeProfitPrice, 4),
      rungFillNumber: position.rungFillNumber,
      winner: winner || (reason === 'TAKE_PROFIT' ? position.side : null),
      outcome, reason, shares: position.shares, tpShares: position.tpSharesSold || 0,
      entryPrice: round(position.price, 4), price: round(position.price, 4),
      entryNotional: round(position.entryNotional, 4), cost: round(position.cost, 4),
      fee: round(position.entryFee + position.exitFees, 4), rebate: round(position.makerRebate || 0, 4),
      entryRebate: round(position.entryRebate || 0, 5),
      takeProfitRebate: round(position.takeProfitRebate || 0, 5),
      proceeds: round(position.exitProceeds, 4), pnl: round(pnl, 2),
      outcomeValuePerShare: reason === 'TAKE_PROFIT' ? position.takeProfitPrice : (reason === 'RESOLUTION' && outcome === 'WIN' ? 1 : null),
      ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    const event = outcome === 'WIN' ? 'SETTLED_WIN' : 'SETTLED_LOSS';
    this._push({
      event, slug: position.slug, side: position.side, shares: round(position.shares, 4), pnl: round(pnl, 2),
      note: reason + ' · ' + outcome + ' · demo P&L ' + (pnl >= 0 ? '+' : '') + '$' + round(pnl, 2) + '.',
    });
    if (this.capital != null) {
      const equity = this.cash;
      this.equity.push({ ts: Date.now(), v: round(equity, 2) });
      if (this.equity.length > 500) this.equity.shift();
      this.peak = Math.max(this.peak == null ? equity : this.peak, equity);
      this.maxDD = Math.max(this.maxDD, this.peak - equity);
    }
  }

  async _balanceLoop() {
    while (this._running) {
      try {
        this.walletBalance = await this.trader.getBalance();
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
    const pending = this.pending.slice(-20).map((position) => {
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
      return {
        openTs, winner: outcome.winner, source: outcome.source, price: outcome.price, loser: outcome.loser,
        traded: trade ? trade.side : open ? open.side : null,
        result: trade ? trade.outcome : null, pnl: trade ? trade.pnl : null,
      };
    });
    const elapsed = w ? Math.max(0, (now - w.openTs * 1000) / 1000) : 0;
    const sideCycles = w ? Object.fromEntries(SIDES.map((side) => {
      const rungStates = w.rungs.map((rung) => {
        const state = rung.sides[side];
        return {
          entryPrice: rung.entryPrice, takeProfitPrice: rung.takeProfitPrice,
          firstFillSide: rung.firstFillSide, fillCount: rung.fillCount,
          status: state.status, entryOrderId: state.entryOrderId,
          tpOrderId: state.tpOrderId, entryFilled: state.entryFilled,
          openShares: state.position ? state.position.openShares : 0,
          shares: cfg.BASE_SHARES,
        };
      });
      const openShares = rungStates.reduce((sum, rung) => sum + (Number(rung.openShares) || 0), 0);
      const openTrades = rungStates.filter((rung) => Number(rung.openShares) > EPSILON).length;
      const entriesResting = rungStates.filter((rung) => rung.entryOrderId && !rung.entryFilled).length;
      const filledCount = rungStates.filter((rung) => rung.entryFilled).length;
      const status = w.closed ? 'window_closed' : openShares > 0 ? 'positions_active'
        : entriesResting > 0 ? 'buy_limits_resting' : filledCount > 0 ? 'trades_complete' : 'starting';
      return [side, { status, openShares, openTrades, entriesResting, filledCount, shares: cfg.BASE_SHARES, rungs: rungStates }];
    })) : null;
    return {
      now, mode: this.live ? 'LIVE' : 'DEMO', uptimeSec: Math.floor((now - this.startedAt) / 1000),
      error: this.error, executionHalt: this.executionHalt, walletBalance: this.walletBalance,
      walletAddress: this.trader.depositWallet || this.trader.address,
      account: {
        capital: this.capital, cash, openValue,
        equity: cash == null ? null : cash + openValue, maxDrawdown: this.maxDD,
      },
      window: w ? {
        slug: w.slug, status: w.status, openTs: w.openTs,
        closeTs: Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS,
        elapsedSeconds: elapsed, closed: w.closed, sideCycles,
      } : null,
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      strategy: {
        baseShares: cfg.BASE_SHARES,
        entryRungs: cfg.ENTRY_RUNGS,
        secondFillTakeProfitPrice: cfg.SECOND_FILL_TAKE_PROFIT_PRICE,
        feeRateEstimate: cfg.MAKER_FEE_RATE,
        rebateIsEstimate: true,
      },
      counts: this.counts, recentOutcomes: outcomeRows, pending,
      trades: this.trades.slice(-60).reverse(), equity: this.equity, stats: this.stats,
      cfg: {
        demoCapital: cfg.DEMO_CAPITAL,
        entryRungs: cfg.ENTRY_RUNGS,
        secondFillTakeProfitPrice: cfg.SECOND_FILL_TAKE_PROFIT_PRICE,
        baseShares: cfg.BASE_SHARES,
        windowSec: WINDOW_SECONDS,
        makerFeeRate: cfg.MAKER_FEE_RATE,
        cryptoTakerFeeRate: cfg.CRYPTO_TAKER_FEE_RATE,
        makerRebatePoolShare: cfg.CRYPTO_MAKER_REBATE_POOL_SHARE,
      },
      log: this.log.slice(-100).reverse(),
    };
  }
}

function makeWindowState(slug, openTs) {
  return {
    slug, openTs, status: 'starting', window: null, ordersStarted: false,
    closing: false, closed: false,
    rungs: cfg.ENTRY_RUNGS.map((rung) => ({
      id: 'rung-' + rung.entryPrice.toFixed(2),
      entryPrice: rung.entryPrice,
      takeProfitPrice: rung.takeProfitPrice,
      firstFillSide: null,
      fillCount: 0,
      inFlight: false,
      sides: {
        UP: makeRungSide('UP'),
        DOWN: makeRungSide('DOWN'),
      },
    })),
  };
}

function makeRungSide(side) {
  return {
    side, status: 'buy_pending', entryOrderId: null, entryFilled: false,
    nextEntryAttemptAt: 0, entryLastPollAt: 0,
    position: null, tpOrderId: null, tpOrderShares: 0,
    tpMatched: 0, tpLastPollAt: 0,
  };
}

function orderState(order) {
  return String(order && (order.status || order.state) || '').toUpperCase();
}

function matchedShares(order, requested) {
  const raw = order && (order.size_matched ?? order.sizeMatched ?? order.filled_size ?? order.filledSize);
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(Number(requested) || n, n);
  return 0;
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

const round = (value, digits = 2) => Number.isFinite(Number(value))
  ? Math.round(Number(value) * (10 ** digits)) / (10 ** digits) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = Bot;