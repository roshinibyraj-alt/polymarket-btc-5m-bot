'use strict';

const cfg = require('./config');
const {
  getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS, fetchResolution,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');
const CcxtPriceFeed = require('./ccxt-feed');
const { computeOneSecondMove, adaptiveMoveThreshold, sideForMove } = require('./directional-strategy');
const { estimateTakerFee } = require('./strategy');

const EPSILON = 1e-8;
const MAX_LOG = 300;

class Bot {
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.live = !!opts.live;
    this.demoMode = !this.live && !!(trader && trader.demoMode === true);
    this.strategyBlocked = this.live || !this.demoMode;
    this.ccxtFeed = opts.ccxtFeed || new CcxtPriceFeed({
      exchangeId: cfg.CCXT_EXCHANGE,
      symbol: cfg.CCXT_SYMBOL || undefined,
      pollMs: cfg.CCXT_POLL_MS,
    });
    this.w = null;
    this.pending = [];
    this.trades = [];
    this.outcomes = new Map();
    this._resolveTried = new Map();
    this._clobTried = new Map();
    this._warned = new Set();
    this.stats = {
      wins: 0, losses: 0, signalEntries: 0,
      estimatedFees: 0, realizedPnl: 0,
    };
    this.counts = { UP: 0, DOWN: 0 };
    this.walletBalance = null;
    this.error = this.strategyBlocked
      ? 'This strategy is demo-only; order submission is disabled outside DemoTrader.' : null;
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
    this._marketFeedStop = null;
    this._marketFeedSlug = null;
    this._lastMarketEventAt = 0;
    this._lastRestFetchAt = 0;
    this._btcSamples = [];
    this._btcMoveHistory = [];
    this.activeSignal = null;
    this._signalBusy = false;
    this._queuedSignal = null;
    this._running = false;
    this._ccxtStop = null;
    this.ccxt = {
      exchange: this.ccxtFeed.exchangeId || cfg.CCXT_EXCHANGE,
      symbol: this.ccxtFeed.symbol || cfg.CCXT_SYMBOL || 'BTC/USD',
      pollMs: this.ccxtFeed.pollMs || cfg.CCXT_POLL_MS,
      requestedPollMs: cfg.CCXT_POLL_MS,
      thresholdUsd: null,
      thresholdReady: false,
      thresholdSampleCount: 0,
      thresholdMinSamples: cfg.BTC_MOVE_THRESHOLD_MIN_SAMPLES,
      thresholdPercentile: cfg.BTC_MOVE_THRESHOLD_PERCENTILE,
      thresholdWindowMs: cfg.BTC_MOVE_THRESHOLD_WINDOW_MS,
      thresholdFloorUsd: cfg.BTC_MOVE_THRESHOLD_FLOOR_USD,
      percentileThresholdUsd: null,
      lookbackMs: cfg.SIGNAL_LOOKBACK_MS,
      price: null, bid: null, ask: null, change1s: null, lookbackObservedMs: null,
      receivedAt: null, status: 'stopped', error: null, candidateSide: null, lastSignal: null,
    };
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
      if (this.strategyBlocked) {
        this._warnOnce('directional-strategy-blocked', {
          event: 'LIVE_BLOCKED',
          note: 'The CCXT directional strategy requires DemoTrader; no live order methods will be called.',
        });
      }
      return;
    }
    this._running = true;
    this.ccxt.status = 'connecting';
    try {
      this._ccxtStop = this.ccxtFeed.start(
        (sample) => { void this._onBtcSample(sample); },
        (error) => this._onCcxtError(error),
      );
    } catch (error) {
      this._onCcxtError(error);
    }
    void this._loop();
    void this._priceLoop();
    void this._settlementLoop();
    void this._balanceLoop();
  }

  stop() {
    this._running = false;
    const stopCcxt = this._ccxtStop;
    this._ccxtStop = null;
    if (stopCcxt) { try { stopCcxt(); } catch (_) {} }
    else if (this.ccxtFeed && typeof this.ccxtFeed.stop === 'function') {
      try { this.ccxtFeed.stop(); } catch (_) {}
    }
    if (this._marketFeedStop) { try { this._marketFeedStop(); } catch (_) {} }
    this._ccxtStop = null;
    this._marketFeedStop = null;
    this._marketFeedSlug = null;
  }

  async _loop() {
    while (this._running) {
      try { await this._tick(); }
      catch (error) {
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
      if (this.w) await this._closeWindow(this.w);
      this.w = makeWindowState(slug, openTs);
      if (this.activeSignal) {
        this.w.activeSignal = this.activeSignal;
        this.w.lastSignal = {
          side: this.activeSignal.side,
          changeUsd: this.activeSignal.changeUsd,
          thresholdUsd: this.activeSignal.thresholdUsd,
          lookbackMs: this.activeSignal.lookbackMs,
          ts: this.activeSignal.ts,
        };
      }
    }

    const w = this.w;
    if (!w.window) {
      const result = await getActiveWindow(now);
      if (result.window) {
        this.error = null;
        w.window = result.window;
        w.status = 'watching_signal';
        this._push({
          event: 'WINDOW_READY', slug: w.slug,
          note: 'BTC 5-minute market active; building the rolling adaptive BTC-move threshold.',
        });
        await this._ensureMarketFeed(w);
      } else {
        this.error = result.reason || 'active market unavailable';
        w.status = 'waiting_for_market';
      }
    }

    if (!w.window) return;
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (now >= closeTs * 1000) await this._closeWindow(w);
  }

  async _priceLoop() {
    while (this._running) {
      const w = this.w;
      if (w && w.window) {
        if (this._marketFeedSlug !== w.slug) await this._ensureMarketFeed(w);
        const now = Date.now();
        if (now - this._lastMarketEventAt >= cfg.PRICE_STALE_MS
          && now - this._lastRestFetchAt >= cfg.PRICE_FEED_FALLBACK_MS) {
          await this._seedQuotes(w);
        }
      }
      await sleep(cfg.LOOP_MS);
    }
  }

  async _ensureMarketFeed(w) {
    if (!w || !w.window || this._marketFeedSlug === w.slug) return;
    if (this._marketFeedStop) { try { this._marketFeedStop(); } catch (_) {} }
    this._marketFeedSlug = w.slug;
    this._quotesByToken = new Map();
    this.prices = { slug: w.slug, ts: Date.now(), up: emptyQuote(), down: emptyQuote() };
    this._lastMarketEventAt = 0;
    this._lastRestFetchAt = 0;
    try {
      this._marketFeedStop = startMarketFeed(
        [w.window.tokenUp, w.window.tokenDown],
        (tokenId, quoteValue) => this._onQuote(w.slug, tokenId, quoteValue),
        (error) => this._warnOnce('clob-ws-' + w.slug, {
          event: 'ERROR', slug: w.slug, note: 'Polymarket CLOB feed error: ' + error.message,
        }),
      );
    } catch (error) {
      this._warnOnce('clob-start-' + w.slug, {
        event: 'ERROR', slug: w.slug, note: 'Polymarket CLOB feed start failed: ' + error.message,
      });
    }
    await this._seedQuotes(w);
  }

  async _seedQuotes(w) {
    if (!w || !w.window || this._marketFeedSlug !== w.slug) return;
    this._lastRestFetchAt = Date.now();
    try {
      const books = await Promise.all([
        this.trader.getOrderBook(w.window.tokenUp),
        this.trader.getOrderBook(w.window.tokenDown),
      ]);
      if (this._marketFeedSlug !== w.slug) return;
      this._onQuote(w.slug, w.window.tokenUp, quote(books[0]));
      this._onQuote(w.slug, w.window.tokenDown, quote(books[1]));
    } catch (error) {
      this._warnOnce('seed-' + w.slug, {
        event: 'ERROR', slug: w.slug, note: 'Polymarket quote refresh failed: ' + error.message,
      });
    }
  }

  _onQuote(slug, tokenId, update) {
    const w = this.w;
    if (!w || w.slug !== slug || !w.window || w.closed) return;
    const side = tokenId === w.window.tokenUp ? 'UP'
      : tokenId === w.window.tokenDown ? 'DOWN' : null;
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
    const now = Date.now();
    this.prices = { slug, ts: now, up: { ...up }, down: { ...down } };
    this._lastMarketEventAt = now;
    if (w.position && w.position.side === side && w.position.openShares > EPSILON) {
      const mark = next.bid == null ? next.mid : next.bid;
      if (mark != null && Number.isFinite(Number(mark))) w.position.lastClobMark = Number(mark);
      if (!this._settlePositionAtClobPrice(w.position, next.mid)) this._recordEquity();
    }
    if (up.ask != null && down.ask != null) {
      if (this._seriesSlug !== slug) { this._seriesSlug = slug; this.priceSeries = []; }
      if (now - this._lastSeriesAt >= 250) {
        this.priceSeries.push({
          t: Math.round((now - w.openTs * 1000) / 1000),
          up: round(up.ask, 3), down: round(down.ask, 3),
        });
        if (this.priceSeries.length > 600) this.priceSeries.shift();
        this._lastSeriesAt = now;
      }
    }
    if (!w.position && w.activeSignal && w.activeSignal.side === side) {
      return this._attemptActiveSignal(w);
    }
    return null;
  }

  _onCcxtError(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.ccxt.status = this.ccxt.price == null ? 'error' : 'stale';
    this.ccxt.error = message;
    const key = 'ccxt-' + message;
    this._warnOnce(key, { event: 'CCXT_ERROR', note: 'CCXT ' + this.ccxt.exchange + ' feed: ' + message });
  }

  async _onBtcSample(sample) {
    const price = Number(sample && sample.price);
    const receivedAt = Number(sample && (sample.receivedAt ?? sample.ts)) || Date.now();
    if (!Number.isFinite(price) || price <= 0) return;
    const sampledAt = Number(sample && sample.sampledAt) || receivedAt;
    const responseAgeMs = Math.max(0, receivedAt - sampledAt);
    if (responseAgeMs > Math.max(cfg.CCXT_POLL_MS * 2, 1000)) {
      this.ccxt = {
        ...this.ccxt,
        status: 'stale',
        error: 'Discarded a delayed CCXT response (' + Math.round(responseAgeMs) + ' ms old).',
      };
      this._warnOnce('ccxt-delayed-sample', {
        event: 'CCXT_STALE_SAMPLE',
        note: 'Discarded a delayed BTC ticker response; waiting for a fresh sample.',
      });
      return;
    }
    this._warned.delete('ccxt-delayed-sample');
    const previousSample = this._btcSamples.length ? this._btcSamples[this._btcSamples.length - 1] : null;
    const normalized = {
      price, receivedAt,
      sampledAt,
      bid: positive(sample.bid),
      ask: positive(sample.ask),
    };
    this._btcSamples.push(normalized);
    this._btcSamples = this._btcSamples.filter((item) => receivedAt - item.receivedAt <= 5000);
    this._btcMoveHistory = this._btcMoveHistory.filter((item) =>
      item.at <= sampledAt && sampledAt - item.at <= cfg.BTC_MOVE_THRESHOLD_WINDOW_MS);
    const move = computeOneSecondMove(this._btcSamples, {
      lookbackMs: cfg.SIGNAL_LOOKBACK_MS,
      toleranceMs: cfg.SIGNAL_LOOKBACK_TOLERANCE_MS,
    });
    const threshold = adaptiveMoveThreshold(this._btcMoveHistory, {
      now: sampledAt,
      windowMs: cfg.BTC_MOVE_THRESHOLD_WINDOW_MS,
      percentile: cfg.BTC_MOVE_THRESHOLD_PERCENTILE,
      floorUsd: cfg.BTC_MOVE_THRESHOLD_FLOOR_USD,
      minSamples: cfg.BTC_MOVE_THRESHOLD_MIN_SAMPLES,
    });
    const side = move && threshold.ready
      ? sideForMove(move.changeUsd, threshold.thresholdUsd) : null;
    if (move) {
      this._btcMoveHistory.push({ at: sampledAt, absMoveUsd: Math.abs(move.changeUsd) });
    }
    this.ccxt = {
      ...this.ccxt,
      exchange: sample.exchange || this.ccxt.exchange,
      symbol: sample.symbol || this.ccxt.symbol,
      price,
      bid: normalized.bid,
      ask: normalized.ask,
      receivedAt,
      lastPollIntervalMs: previousSample ? sampledAt - previousSample.sampledAt : null,
      exchangeTimestamp: sample.exchangeTimestamp == null || sample.exchangeTimestamp === ''
        ? null : (Number.isFinite(Number(sample.exchangeTimestamp)) ? Number(sample.exchangeTimestamp) : null),
      change1s: move ? move.changeUsd : null,
      lookbackObservedMs: move ? move.lookbackMs : null,
      thresholdUsd: threshold.thresholdUsd,
      thresholdReady: threshold.ready,
      thresholdSampleCount: threshold.sampleCount,
      thresholdMinSamples: threshold.minSamples,
      thresholdPercentile: threshold.percentile,
      thresholdWindowMs: threshold.windowMs,
      thresholdFloorUsd: threshold.floorUsd,
      percentileThresholdUsd: threshold.percentileThresholdUsd,
      candidateSide: side,
      status: 'live',
      error: null,
    };
    if (!move || !threshold.ready || !side) return;
    const signalMove = { ...move, thresholdUsd: threshold.thresholdUsd };
    this.ccxt.lastSignal = {
      side, changeUsd: move.changeUsd, thresholdUsd: threshold.thresholdUsd,
      lookbackMs: move.lookbackMs, ts: receivedAt,
    };
    await this._handleSignal(side, signalMove);
  }

  async _handleSignal(side, move) {
    const now = Number(move.receivedAt) || Date.now();
    const signal = {
      side,
      move: { ...move },
      changeUsd: move.changeUsd,
      thresholdUsd: move.thresholdUsd,
      lookbackMs: move.lookbackMs,
      ts: now,
    };
    this.activeSignal = signal;
    const w = this.w;
    if (w) {
      w.activeSignal = signal;
      w.lastSignal = {
        side, changeUsd: move.changeUsd, thresholdUsd: move.thresholdUsd,
        lookbackMs: move.lookbackMs, ts: now,
      };
    }
    if (this.strategyBlocked || !w || !w.window || w.closed || w.closing) return;
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (now >= closeTs * 1000) {
      await this._closeWindow(w);
      return;
    }

    if (w.lastLoggedSignalSide !== side) {
      w.lastLoggedSignalSide = side;
      this._push({
        event: 'BTC_MOVE_SIGNAL', slug: w.slug, side,
        changeUsd: round(move.changeUsd, 2), thresholdUsd: round(move.thresholdUsd, 2),
        lookbackMs: move.lookbackMs,
        note: 'CCXT BTC moved ' + signedUsd(move.changeUsd) + ' over '
          + move.lookbackMs + ' ms against an adaptive $' + Number(move.thresholdUsd).toFixed(2)
          + ' threshold; target side is ' + side + '.',
      });
    }
    if (w.entryTaken || (w.position && w.position.openShares > EPSILON)) {
      w.status = w.position && w.position.openShares > EPSILON
        ? 'position_open' : 'trade_taken';
      return;
    }
    if (this._signalBusy) {
      this._queuedSignal = { side, move, window: w };
      return;
    }
    this._signalBusy = true;
    w.tradeInFlight = true;
    try {
      if (this.w !== w || w.closed || Date.now() >= closeTs * 1000
        || w.entryTaken || (w.position && w.position.openShares > EPSILON)
        || !w.activeSignal || w.activeSignal.side !== side) return;
      await this._buyPosition(w, side, move);
    } catch (error) {
      this._push({ event: 'SIGNAL_TRADE_ERROR', slug: w.slug, side, note: error.message });
    } finally {
      w.tradeInFlight = false;
      this._signalBusy = false;
      const queued = this._queuedSignal;
      this._queuedSignal = null;
      if (queued && this.w === queued.window) {
        await this._handleSignal(queued.side, queued.move);
      }
    }
  }

  async _attemptActiveSignal(w) {
    if (this.strategyBlocked || !w || this.w !== w || !w.window || w.closed || w.closing
      || w.entryTaken || w.position || !w.activeSignal || this._signalBusy) return false;
    const signal = w.activeSignal;
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (Date.now() >= closeTs * 1000) return false;
    const currentQuote = this.prices && this.prices.slug === w.slug
      ? (signal.side === 'UP' ? this.prices.up : this.prices.down) : null;
    const ask = currentQuote && currentQuote.ask != null ? Number(currentQuote.ask) : NaN;
    if (!Number.isFinite(ask) || ask < cfg.MIN_BUY_ENTRY_PRICE_USD
      || ask > cfg.MAX_BUY_ENTRY_PRICE_USD) {
      w.status = 'waiting_for_entry_price';
      return false;
    }

    this._signalBusy = true;
    w.tradeInFlight = true;
    try {
      if (w.activeSignal !== signal || w.position) return false;
      return await this._buyPosition(w, signal.side, signal.move);
    } catch (error) {
      this._push({ event: 'SIGNAL_TRADE_ERROR', slug: w.slug, side: signal.side, note: error.message });
      return false;
    } finally {
      w.tradeInFlight = false;
      this._signalBusy = false;
      const queued = this._queuedSignal;
      this._queuedSignal = null;
      if (queued && this.w === queued.window) {
        await this._handleSignal(queued.side, queued.move);
      }
    }
  }

  async _buyPosition(w, side, move) {
    if (w.entryTaken || w.position || !w.activeSignal || w.activeSignal.side !== side) return false;
    const tokenId = side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    const book = await this.trader.getOrderBook(tokenId);
    const asks = sortedLevels(book && book.asks, 'asc');
    const bids = sortedLevels(book && book.bids, 'desc');
    const bestAsk = asks.length ? asks[0].price : null;
    if (bestAsk == null) {
      w.status = 'waiting_for_entry_price';
      this._push({
        event: 'SIGNAL_BUY_NO_BOOK', slug: w.slug, side,
        note: 'No executable ask for ' + side + '; the signal remains active until an opposite signal.',
      });
      return false;
    }
    if (bestAsk < cfg.MIN_BUY_ENTRY_PRICE_USD || bestAsk > cfg.MAX_BUY_ENTRY_PRICE_USD) {
      w.status = 'waiting_for_entry_price';
      if (w.lastPriceWaitSignalSide !== side) {
        w.lastPriceWaitSignalSide = side;
        this._push({
          event: 'SIGNAL_WAITING_FOR_ENTRY_PRICE', slug: w.slug, side,
          ask: round(bestAsk, 4),
          note: side + ' signal remains active; waiting for its best ask to enter the $'
            + cfg.MIN_BUY_ENTRY_PRICE_USD.toFixed(2) + '–$'
            + cfg.MAX_BUY_ENTRY_PRICE_USD.toFixed(2) + ' range or for an opposite signal.',
        });
      }
      return false;
    }
    if (!w.activeSignal || w.activeSignal.side !== side) {
      return false;
    }
    const targetShares = cfg.BASE_SHARES;
    const priceLimit = Math.min(0.99, bestAsk * (1 + cfg.MAX_BUY_SLIPPAGE_PERCENT / 100));
    const spendLimit = targetShares * priceLimit;
    const estimatedFee = estimateTakerFee(targetShares, 0.5);
    if (this.cash == null || this.cash + EPSILON < spendLimit + estimatedFee) {
      this._push({
        event: 'SIGNAL_BUY_NO_CASH', slug: w.slug, side,
        note: 'Demo cash is insufficient for the configured ' + targetShares + '-share ' + side
          + ' entry at the maximum slippage price.',
      });
      return false;
    }
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (this.w !== w || w.closed || w.entryTaken || w.position
      || Date.now() >= closeTs * 1000
      || !w.activeSignal || w.activeSignal.side !== side) return false;

    const order = await this.trader.placeFakMarketOrder(tokenId, 'BUY', spendLimit, {
      priceLimit, targetShares,
    });
    const shares = positive(order && order.raw && order.raw.takingAmount);
    const notional = positive(order && order.raw && order.raw.makingAmount);
    if (shares == null || notional == null) {
      this._push({
        event: 'SIGNAL_BUY_UNFILLED', slug: w.slug, side,
        note: 'No shares filled within the configured ' + cfg.MAX_BUY_SLIPPAGE_PERCENT
          + '% slippage cap; no position opened.',
      });
      return false;
    }
    const averagePrice = notional / shares;
    const fee = estimateTakerFee(shares, averagePrice);
    if (notional + fee > this.cash + EPSILON) {
      this._push({
        event: 'SIGNAL_BUY_REJECTED', slug: w.slug, side,
        note: 'Estimated fill plus taker fee exceeded demo cash; position was not recorded.',
      });
      return false;
    }
    const position = {
      slug: w.slug, openTs: w.openTs,
      closeTs: Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS,
      side, tokenId, shares, openShares: shares,
      price: averagePrice, entryPrice: averagePrice, entryNotional: notional,
      entryFee: fee, exitFees: 0, cost: notional + fee,
      exitProceeds: 0, status: 'position_open', firedAt: Date.now(),
      lastClobMark: bids.length ? bids[0].price : averagePrice,
      realizedPnl: 0,
      signalChangeUsd: move.changeUsd, signalLookbackMs: move.lookbackMs,
      settled: false, settlementTimedOut: false,
    };
    this.cash -= position.cost;
    this.pending.push(position);
    w.position = position;
    w.entryTaken = true;
    w.status = 'position_open';
    this.stats.signalEntries += 1;
    this.stats.estimatedFees += fee;
    this._recordEquity();
    this._push({
      event: 'SIGNAL_BUY_FILLED', slug: w.slug, side,
      shares: round(shares, 4), price: round(averagePrice, 4),
      fee: round(fee, 5), changeUsd: round(move.changeUsd, 2),
      note: 'Demo marketable BUY filled ' + round(shares, 4) + ' ' + side
        + ' shares at average $' + averagePrice.toFixed(4)
        + ' (maximum ' + cfg.MAX_BUY_SLIPPAGE_PERCENT + '% above the observed ask)'
        + '; estimated taker fee $' + fee.toFixed(5) + '.',
    });
    return true;
  }

  async _closeWindow(w) {
    if (!w || w.closed || w.closing) return;
    w.closing = true;
    if (w.position && w.position.openShares > EPSILON) {
      w.position.status = 'awaiting_resolution';
      this._push({
        event: 'EXPIRY_HOLD', slug: w.slug, side: w.position.side,
        shares: round(w.position.openShares, 4),
        note: 'Window closed; remaining shares are watched for decisive CLOB prices, then official resolution.',
      });
    }
    w.closed = true;
    w.closing = false;
    w.status = w.position && w.position.openShares > EPSILON ? 'awaiting_resolution' : 'window_closed';
    this._push({ event: 'WINDOW_CLOSED', slug: w.slug, note: 'Window ended; no further signal trades will be placed.' });
  }

  async _settlementLoop() {
    while (this._running) {
      await sleep(cfg.SETTLEMENT_POLL_MS);
      await this._settleClosedPositions(Date.now());
    }
  }

  async _settleClosedPositions(now = Date.now()) {
    for (const position of this.pending.slice()) {
      if (position.settled) continue;
      const closeTime = Number(position.closeTs) * 1000;
      const activeWindow = this.w && this.w.openTs === position.openTs && !this.w.closed;
      if (activeWindow && this.prices && this.prices.slug === position.slug
        && now - this.prices.ts <= cfg.PRICE_STALE_MS) {
        const currentQuote = position.side === 'UP' ? this.prices.up : this.prices.down;
        if (currentQuote) {
          const mark = currentQuote.bid == null ? currentQuote.mid : currentQuote.bid;
          if (mark != null && Number.isFinite(Number(mark))) position.lastClobMark = Number(mark);
        }
        if (currentQuote && this._settlePositionAtClobPrice(position, currentQuote.mid)) continue;
      }
      if (now < closeTime) continue;
      if (this.w && this.w.openTs === position.openTs && !this.w.closed) {
        if (this.w.closing) continue;
        await this._closeWindow(this.w);
      }
      let winner = this.outcomes.get(position.openTs)?.winner;
      const lastClobCheck = this._clobTried.get(position) || 0;
      if (!winner && now - lastClobCheck >= cfg.RESOLUTION_RETRY_MS) {
        this._clobTried.set(position, now);
        try {
          const heldQuote = quote(await this.trader.getOrderBook(position.tokenId));
          const mark = heldQuote.bid == null ? heldQuote.mid : heldQuote.bid;
          if (mark != null && Number.isFinite(Number(mark))) position.lastClobMark = Number(mark);
          if (this._settlePositionAtClobPrice(position, heldQuote.mid)) continue;
          this._recordEquity();
        } catch (error) {
          this._warnOnce('clob-settlement-' + position.slug, {
            event: 'ERROR', slug: position.slug,
            note: 'CLOB threshold check failed; waiting for another quote or official result: ' + error.message,
          });
        }
      }
      const lastTried = this._resolveTried.get(position.openTs) || 0;
      if (!winner && now - lastTried >= cfg.RESOLUTION_RETRY_MS) {
        this._resolveTried.set(position.openTs, now);
        try { winner = await fetchResolution(position.slug); }
        catch (error) {
          this._warnOnce('resolution-' + position.openTs, {
            event: 'ERROR', slug: position.slug, note: 'Official result lookup failed: ' + error.message,
          });
        }
        if (winner) this._recordOutcome(position.openTs, position.slug, winner);
      }
      if (winner !== 'UP' && winner !== 'DOWN') continue;
      const payout = winner === position.side ? position.openShares : 0;
      this.cash += payout;
      position.exitProceeds += payout;
      position.openShares = 0;
      position.resolutionPayout = payout;
      this._finalizePosition(position, winner === position.side ? 'WIN' : 'LOSS', 'RESOLUTION', winner);
      this._resolveTried.delete(position.openTs);
      this._clobTried.delete(position);
    }
  }

  _settlePositionAtClobPrice(position, midpoint) {
    if (!position || position.settled || midpoint == null || midpoint === ''
      || !Number.isFinite(Number(midpoint)) || position.openShares <= EPSILON) return false;
    const price = Number(midpoint);
    if (price < 0 || price > 1) return false;
    const won = price >= cfg.CLOB_WIN_SETTLEMENT_PRICE;
    const lost = price <= cfg.CLOB_LOSS_SETTLEMENT_PRICE;
    if (!won && !lost) return false;

    const remainingShares = position.openShares;
    const payout = won ? remainingShares : 0;
    const winner = won ? position.side : (position.side === 'UP' ? 'DOWN' : 'UP');
    if (this.cash != null) this.cash += payout;
    position.exitProceeds += payout;
    position.openShares = 0;
    position.resolutionPayout = payout;
    position.clobThresholdPrice = price;
    this._clobTried.delete(position);
    this._resolveTried.delete(position.openTs);
    const window = this.w && this.w.openTs === position.openTs && this.w.position === position
      ? this.w : null;
    if (window) {
      window.position = null;
        window.status = window.closed ? 'window_closed'
          : window.entryTaken ? 'trade_settled' : 'watching_signal';
    }
    this._push({
      event: 'CLOB_THRESHOLD_SETTLEMENT',
      slug: position.slug,
      side: position.side,
      price: round(price, 4),
      shares: round(remainingShares, 4),
      payout: round(payout, 2),
      note: 'Held-side CLOB midpoint reached $' + price.toFixed(4)
        + '; demo settlement counts ' + round(remainingShares, 4) + ' remaining shares at $'
        + (won ? '1.00' : '0.00') + ' each.',
    });
    this._finalizePosition(position, won ? 'WIN' : 'LOSS', 'CLOB_THRESHOLD', winner);
    return true;
  }

  _recordOutcome(openTs, slug, winner) {
    if (this.outcomes.has(openTs)) return;
    this.outcomes.set(openTs, { winner, source: 'official', price: 1, loser: 0 });
    this.counts[winner] = (this.counts[winner] || 0) + 1;
    if (this.outcomes.size > 60) this.outcomes.delete(this.outcomes.keys().next().value);
    this._push({ event: 'OUTCOME', slug, side: winner, note: 'Official Polymarket resolution: ' + winner + ' won.' });
  }

  _finalizePosition(position, outcome, reason, winner = null) {
    if (position.settled) return;
    position.settled = true;
    position.status = 'closed';
    const totalCost = position.entryNotional + position.entryFee + position.exitFees;
    const pnl = position.exitProceeds - totalCost;
    this.stats.realizedPnl += pnl - (position.realizedPnl || 0);
    position.realizedPnl = pnl;
    if (outcome === 'WIN') this.stats.wins += 1;
    else if (outcome === 'LOSS') this.stats.losses += 1;
    const trade = {
      slug: position.slug, openTs: position.openTs, side: position.side,
      shares: position.shares, entryPrice: round(position.entryPrice, 4),
      exitPrice: position.shares > 0 ? round(position.exitProceeds / position.shares, 4) : null,
      entryNotional: round(position.entryNotional, 4),
      exitProceeds: round(position.exitProceeds, 4),
      fee: round(position.entryFee + position.exitFees, 4),
      outcome, reason, winner, pnl: round(pnl, 2), ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    this._push({
      event: outcome === 'CLOSED' ? 'SIGNAL_POSITION_CLOSED' : (outcome === 'WIN' ? 'SETTLED_WIN' : 'SETTLED_LOSS'),
      slug: position.slug, side: position.side, pnl: round(pnl, 2),
      note: reason + ' · ' + outcome + ' · demo P&L ' + (pnl >= 0 ? '+' : '') + '$' + round(pnl, 2) + '.',
    });
    this._recordEquity();
  }

  _recordEquity() {
    if (this.capital == null || this.cash == null) return;
    const now = Date.now();
    const openValue = this.pending.reduce((sum, position) => {
      const mark = position.lastClobMark != null && Number.isFinite(Number(position.lastClobMark))
        ? Number(position.lastClobMark) : Number(position.entryPrice);
      return sum + position.openShares * (Number.isFinite(mark) ? mark : 0);
    }, 0);
    const equity = this.cash + openValue;
    this.peak = Math.max(this.peak == null ? equity : this.peak, equity);
    this.maxDD = Math.max(this.maxDD, this.peak - equity);
    const last = this.equity[this.equity.length - 1];
    if (!last || Math.abs(equity - last.v) >= 0.01 || now - last.ts >= 1000) {
      this.equity.push({ ts: now, v: round(equity, 2) });
      if (this.equity.length > 500) this.equity.shift();
    }
  }

  async _balanceLoop() {
    while (this._running) {
      try { this.walletBalance = await this.trader.getBalance(); }
      catch (error) { this._push({ event: 'ERROR', note: 'Balance check failed: ' + error.message }); }
      await sleep(30_000);
    }
  }

  snapshot() {
    const now = Date.now();
    const w = this.w;
    const px = this.prices;
    const allPending = this.pending.map((position) => {
      const q = px && px.slug === position.slug ? (position.side === 'UP' ? px.up : px.down) : null;
      const currentMark = q ? (q.bid == null ? q.mid : q.bid) : null;
      const mark = currentMark == null
        ? (position.lastClobMark != null && Number.isFinite(Number(position.lastClobMark))
          ? Number(position.lastClobMark)
          : (Number.isFinite(Number(position.entryPrice)) ? Number(position.entryPrice) : null))
        : currentMark;
      const costBasis = position.shares > 0
        ? (position.entryNotional + position.entryFee) * (position.openShares / position.shares) : 0;
      return { ...position, mark, unrealized: mark == null ? null : position.openShares * mark - costBasis };
    });
    const pending = allPending.slice(-20);
    const openValue = allPending.reduce((sum, position) => sum + (position.mark != null ? position.openShares * position.mark : 0), 0);
    const unrealizedPnl = allPending.reduce((sum, position) => sum + (position.unrealized || 0), 0);
    const equity = this.cash == null ? null : this.cash + openValue;
    const elapsed = w ? Math.max(0, (now - w.openTs * 1000) / 1000) : 0;
    const ccxtAgeMs = this.ccxt.receivedAt == null ? null : Math.max(0, now - this.ccxt.receivedAt);
    const ccxtStatus = ccxtAgeMs != null && ccxtAgeMs > cfg.CCXT_STALE_MS ? 'stale' : this.ccxt.status;
    return {
      now, mode: this.live ? 'LIVE' : 'DEMO', uptimeSec: Math.floor((now - this.startedAt) / 1000),
      error: this.error, executionHalt: this.executionHalt, walletBalance: this.walletBalance,
      walletAddress: this.trader.depositWallet || this.trader.address,
      account: {
        capital: this.capital, cash: this.cash, openValue, unrealizedPnl,
        equity, totalPnl: equity == null || this.capital == null ? null : equity - this.capital,
        maxDrawdown: this.maxDD,
      },
      window: w ? {
        slug: w.slug, status: w.status, openTs: w.openTs,
        closeTs: Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS,
        elapsedSeconds: elapsed, closed: w.closed,
        positionSide: w.position && w.position.openShares > EPSILON ? w.position.side : null,
        openShares: w.position ? w.position.openShares : 0,
        lastSignal: w.lastSignal || null,
        activeSignalSide: w.activeSignal ? w.activeSignal.side : null,
        entryTaken: !!w.entryTaken,
      } : null,
      ccxt: { ...this.ccxt, status: ccxtStatus, ageMs: ccxtAgeMs },
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      strategy: {
        baseShares: cfg.BASE_SHARES,
        maxBuySlippagePercent: cfg.MAX_BUY_SLIPPAGE_PERCENT,
        minBuyEntryPrice: cfg.MIN_BUY_ENTRY_PRICE_USD,
        maxBuyEntryPrice: cfg.MAX_BUY_ENTRY_PRICE_USD,
        thresholdUsd: this.ccxt.thresholdUsd,
        thresholdReady: this.ccxt.thresholdReady,
        thresholdSampleCount: this.ccxt.thresholdSampleCount,
        thresholdMinSamples: cfg.BTC_MOVE_THRESHOLD_MIN_SAMPLES,
        thresholdPercentile: cfg.BTC_MOVE_THRESHOLD_PERCENTILE,
        thresholdWindowMs: cfg.BTC_MOVE_THRESHOLD_WINDOW_MS,
        thresholdFloorUsd: cfg.BTC_MOVE_THRESHOLD_FLOOR_USD,
        clobWinSettlementPrice: cfg.CLOB_WIN_SETTLEMENT_PRICE,
        clobLossSettlementPrice: cfg.CLOB_LOSS_SETTLEMENT_PRICE,
        lookbackMs: cfg.SIGNAL_LOOKBACK_MS,
        pollMs: this.ccxt.pollMs,
        exchange: this.ccxt.exchange,
        symbol: this.ccxt.symbol,
      },
      counts: this.counts, pending,
      trades: this.trades.slice(-60).reverse(), equity: this.equity, stats: this.stats,
      cfg: {
        demoCapital: cfg.DEMO_CAPITAL,
        baseShares: cfg.BASE_SHARES,
        windowSec: WINDOW_SECONDS,
        signalLookbackMs: cfg.SIGNAL_LOOKBACK_MS,
        btcMoveThresholdWindowMs: cfg.BTC_MOVE_THRESHOLD_WINDOW_MS,
        btcMoveThresholdPercentile: cfg.BTC_MOVE_THRESHOLD_PERCENTILE,
        btcMoveThresholdFloorUsd: cfg.BTC_MOVE_THRESHOLD_FLOOR_USD,
        btcMoveThresholdMinSamples: cfg.BTC_MOVE_THRESHOLD_MIN_SAMPLES,
        ccxtPollMs: this.ccxt.pollMs,
        ccxtExchange: this.ccxt.exchange,
        ccxtSymbol: this.ccxt.symbol,
      },
      log: this.log.slice(-100).reverse(),
    };
  }
}

function makeWindowState(slug, openTs) {
  return {
    slug, openTs, status: 'waiting_for_market', window: null,
    closed: false, closing: false, position: null, entryTaken: false,
    lastSignal: null, activeSignal: null, lastLoggedSignalSide: null, tradeInFlight: false,
  };
}

function emptyQuote() { return { bid: null, ask: null, mid: null }; }

function sortedLevels(levels, order) {
  return (levels || [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0
      && Number.isFinite(level.size) && level.size > 0)
    .sort(order === 'asc' ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);
}

function quote(book) {
  const bids = sortedLevels(book && book.bids, 'desc');
  const asks = sortedLevels(book && book.asks, 'asc');
  const bid = bids.length ? bids[0].price : null;
  const ask = asks.length ? asks[0].price : null;
  return { bid, ask, mid: bid == null || ask == null ? null : (bid + ask) / 2 };
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function signedUsd(value) {
  const n = Number(value);
  return (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(2);
}

const round = (value, digits = 2) => Number.isFinite(Number(value))
  ? Math.round(Number(value) * (10 ** digits)) / (10 ** digits) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = Bot;
module.exports.makeWindowState = makeWindowState;