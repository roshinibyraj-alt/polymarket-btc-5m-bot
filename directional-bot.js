'use strict';

const cfg = require('./config');
const {
  getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS, fetchResolution,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');
const CcxtPriceFeed = require('./ccxt-feed');
const { candleColor, matchMinutePattern } = require('./directional-strategy');
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
    this.activeSignal = null;
    this._signalBusy = false;
    this._running = false;
    this._ccxtStop = null;
    this.ccxt = {
      exchange: this.ccxtFeed.exchangeId || cfg.CCXT_EXCHANGE,
      symbol: this.ccxtFeed.symbol || cfg.CCXT_SYMBOL || 'BTC/USD',
      pollMs: this.ccxtFeed.pollMs || cfg.CCXT_POLL_MS,
      requestedPollMs: cfg.CCXT_POLL_MS,
      candleSequence: '', lastCandleColor: null, patternAction: 'WAIT',
      price: null, bid: null, ask: null,
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
      this.activeSignal = null;
      this.ccxt = {
        ...this.ccxt, candidateSide: null, lastSignal: null,
        candleSequence: '', lastCandleColor: null, patternAction: 'WAIT',
      };
    }

    const w = this.w;
    if (!w.window) {
      const result = await getActiveWindow(now);
      if (result.window) {
        this.error = null;
        w.window = result.window;
        w.status = 'waiting_for_first_candle';
        this._push({
          event: 'WINDOW_READY', slug: w.slug,
          note: 'BTC 5-minute market active; collecting completed one-minute candles for entry patterns.',
        });
        await this._ensureMarketFeed(w);
      } else {
        this.error = result.reason || 'active market unavailable';
        w.status = 'waiting_for_market';
      }
    }

    if (!w.window) return;
    await this._finalizeDueMinutes(w, now);
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
      this._recordEquity();
    }
    if (up.ask != null && down.ask != null) {
      if (this._seriesSlug !== slug) { this._seriesSlug = slug; this.priceSeries = []; }
      if (now - this._lastSeriesAt >= 250) {
        const t = Math.round((now - w.openTs * 1000) / 1000);
        const point = {
          t,
          up: round(up.ask, 3), down: round(down.ask, 3),
        };
        const recent = this.priceSeries.filter((item) => t - item.t <= 10);
        const samples = [...recent, point];
        point.avgUp = round(samples.reduce((sum, item) => sum + item.up, 0) / samples.length, 4);
        point.avgDown = round(samples.reduce((sum, item) => sum + item.down, 0) / samples.length, 4);
        this.priceSeries.push(point);
        if (this.priceSeries.length > 600) this.priceSeries.shift();
        this._lastSeriesAt = now;
      }
    }
    if (w.activeSignal && w.activeSignal.side === side) {
      if (w.activeSignal.action === 'BUY' && !w.position) {
        return this._attemptPatternEntry(w, w.activeSignal);
      }
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
      price, receivedAt, sampledAt,
      bid: positive(sample.bid), ask: positive(sample.ask),
    };
    this._btcSamples.push(normalized);
    this._btcSamples = this._btcSamples.filter((item) =>
      receivedAt - item.receivedAt <= cfg.BTC_SAMPLE_RETENTION_MS);
    const currentWindow = this.w;
    if (currentWindow && currentWindow.window && !currentWindow.closed && !currentWindow.closing) {
      await this._addMinuteSample(currentWindow, sampledAt, price);
    }
    const lastInterval = previousSample ? sampledAt - previousSample.sampledAt : null;
    this.ccxt = {
      ...this.ccxt,
      exchange: sample.exchange || this.ccxt.exchange,
      symbol: sample.symbol || this.ccxt.symbol,
      price,
      bid: normalized.bid,
      ask: normalized.ask,
      receivedAt,
      lastPollIntervalMs: lastInterval,
      exchangeTimestamp: sample.exchangeTimestamp == null || sample.exchangeTimestamp === ''
        ? null : (Number.isFinite(Number(sample.exchangeTimestamp)) ? Number(sample.exchangeTimestamp) : null),
      candleSequence: currentWindow && currentWindow.candleSequence || '',
      lastCandleColor: currentWindow && currentWindow.lastCandle
        ? currentWindow.lastCandle.color : null,
      patternAction: currentWindow && currentWindow.lastSignal
        ? currentWindow.lastSignal.action : 'WAIT',
      candidateSide: currentWindow && currentWindow.activeSignal
        ? currentWindow.activeSignal.side : null,
      status: 'live',
      error: null,
    };
  }

  async _addMinuteSample(w, sampledAt, price) {
    const openMs = w.openTs * 1000;
    const closeMs = (Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000;
    const minuteMs = cfg.STRATEGY_MINUTE_MS;
    if (sampledAt < openMs || sampledAt >= closeMs) return false;

    await this._finalizeDueMinutes(w, sampledAt);
    const index = Math.floor((sampledAt - openMs) / minuteMs);
    const minuteCount = Math.ceil((closeMs - openMs) / minuteMs);
    if (index < 0 || index >= minuteCount || index < w.nextMinuteIndex) return false;

    while (w.nextMinuteIndex < index) {
      const missingIndex = w.nextMinuteIndex++;
      await this._completeMinuteCandle(w, {
        index: missingIndex,
        startMs: openMs + missingIndex * minuteMs,
        endMs: openMs + (missingIndex + 1) * minuteMs,
        open: null, high: null, low: null, close: null,
        sampleCount: 0, color: 'N',
      });
    }

    const current = w.currentMinuteCandle;
    if (!current) {
      w.currentMinuteCandle = {
        index,
        startMs: openMs + index * minuteMs,
        endMs: openMs + (index + 1) * minuteMs,
        open: price, high: price, low: price, close: price,
        sampleCount: 1, lastSampledAt: sampledAt,
      };
      return true;
    }
    if (current.index !== index) return false;
    current.high = Math.max(current.high, price);
    current.low = Math.min(current.low, price);
    current.close = price;
    current.sampleCount += 1;
    current.lastSampledAt = sampledAt;
    return true;
  }

  async _finalizeDueMinutes(w, nowMs) {
    while (w && w.currentMinuteCandle && w.currentMinuteCandle.endMs <= nowMs) {
      const current = w.currentMinuteCandle;
      w.currentMinuteCandle = null;
      w.nextMinuteIndex = current.index + 1;
      const color = current.sampleCount >= cfg.STRATEGY_MIN_CANDLE_SAMPLES
        ? candleColor(current.open, current.close) : 'N';
      await this._completeMinuteCandle(w, { ...current, color });
    }
    if (!w || !w.window || w.currentMinuteCandle || w.closed) return;
    const openMs = w.openTs * 1000;
    const closeMs = (Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000;
    const minuteMs = cfg.STRATEGY_MINUTE_MS;
    const minuteCount = Math.ceil((closeMs - openMs) / minuteMs);
    const dueIndex = Math.min(minuteCount, Math.max(0, Math.floor((Math.min(nowMs, closeMs) - openMs) / minuteMs)));
    while (w.nextMinuteIndex < dueIndex) {
      const missingIndex = w.nextMinuteIndex++;
      await this._completeMinuteCandle(w, {
        index: missingIndex,
        startMs: openMs + missingIndex * minuteMs,
        endMs: openMs + (missingIndex + 1) * minuteMs,
        open: null, high: null, low: null, close: null,
        sampleCount: 0, color: 'N',
      });
    }
  }

  async _completeMinuteCandle(w, candle) {
    if (!w || !w.window || w.closed) return;
    const completed = {
      ...candle,
      open: candle.open != null && Number.isFinite(Number(candle.open)) ? Number(candle.open) : null,
      high: candle.high != null && Number.isFinite(Number(candle.high)) ? Number(candle.high) : null,
      low: candle.low != null && Number.isFinite(Number(candle.low)) ? Number(candle.low) : null,
      close: candle.close != null && Number.isFinite(Number(candle.close)) ? Number(candle.close) : null,
    };
    w.minuteCandles.push(completed);
    w.candleSequence = w.minuteCandles.map((item) => item.color).join('');
    w.lastCandle = completed;
    const match = matchMinutePattern(w.candleSequence);
    const signal = {
      ...match,
      ts: completed.endMs,
      minuteIndex: completed.index,
      candleColor: completed.color,
    };
    w.lastSignal = signal;
    this.ccxt = {
      ...this.ccxt,
      candleSequence: w.candleSequence,
      lastCandleColor: completed.color,
      patternAction: match.action,
      candidateSide: match.side,
      lastSignal: signal,
    };
    this._push({
      event: 'BTC_1M_CANDLE',
      slug: w.slug,
      minute: completed.index + 1,
      color: completed.color,
      open: completed.open == null ? null : round(completed.open, 2),
      close: completed.close == null ? null : round(completed.close, 2),
      sequence: w.candleSequence,
      note: completed.color === 'N'
        ? 'One-minute candle ' + (completed.index + 1) + ' was neutral or lacked enough BTC samples; no pattern is formed.'
        : 'One-minute candle ' + (completed.index + 1) + ' closed ' + completed.color
          + ' (' + round(completed.open, 2) + ' → ' + round(completed.close, 2)
          + '); sequence is ' + w.candleSequence + '.',
    });

    if (match.action === 'WAIT') {
      w.activeSignal = null;
      this.activeSignal = null;
      w.status = w.position && w.position.openShares > EPSILON
        ? 'position_open' : w.entryCount > 0 ? 'trade_taken' : 'waiting_for_pattern';
      return;
    }
    if (match.action === 'BUY') {
      if (w.entryCount > 0 || (w.position && w.position.openShares > EPSILON)) {
        w.activeSignal = null;
        this.activeSignal = null;
        w.status = w.position && w.position.openShares > EPSILON ? 'position_open' : 'trade_taken';
        return;
      }
      w.activeSignal = signal;
      this.activeSignal = signal;
      w.status = 'pattern_ready';
      this._push({
        event: 'CANDLE_PATTERN_BUY_SIGNAL', slug: w.slug,
        side: signal.side, pattern: signal.pattern, sequence: signal.sequence,
        note: 'Completed one-minute pattern ' + signal.pattern + ' signals BUY ' + signal.side + '.',
      });
      if (!this.strategyBlocked) return this._attemptPatternEntry(w, signal);
      return;
    }
    return;
  }

  async _attemptPatternEntry(w, signal = w && w.activeSignal) {
    if (this.strategyBlocked || !w || this.w !== w || !w.window || w.closed || w.closing
      || !signal || signal.action !== 'BUY' || !signal.side) return false;
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (Date.now() >= closeTs * 1000) return false;
    if (w.entryCount > 0) {
      w.status = w.position && w.position.openShares > EPSILON ? 'position_open' : 'trade_taken';
      return false;
    }
    if (w.position && w.position.openShares > EPSILON) return false;
    if (this._signalBusy) return false;
    this._signalBusy = true;
    w.tradeInFlight = true;
    try {
      const currentSignal = w.activeSignal || signal;
      if (this.w !== w || w.closed || w.closing || !w.window) return false;
      if (!currentSignal || currentSignal.action !== 'BUY' || currentSignal.pattern !== signal.pattern) return false;
      if (w.entryCount > 0 || (w.position && w.position.openShares > EPSILON)) return false;
      return await this._buyPosition(w, currentSignal);
    } catch (error) {
      this._push({ event: 'CANDLE_BUY_ERROR', slug: w.slug, side: signal.side, note: error.message });
      return false;
    } finally {
      w.tradeInFlight = false;
      this._signalBusy = false;
    }
  }

  async _buyPosition(w, signal) {
    const side = signal && signal.side;
    if (this.strategyBlocked || this.w !== w || !w.window || w.closed || w.closing
      || w.entryCount > 0 || (w.position && w.position.openShares > EPSILON)
      || !signal || signal.action !== 'BUY' || !side) return false;
    const tokenId = side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    const book = await this.trader.getOrderBook(tokenId);
    const asks = sortedLevels(book && book.asks, 'asc');
    const bids = sortedLevels(book && book.bids, 'desc');
    const bestAsk = asks.length ? asks[0].price : null;
    if (bestAsk == null) {
      w.status = 'waiting_for_order_book';
      this._push({
        event: 'CANDLE_PATTERN_BUY_NO_BOOK', slug: w.slug, side,
        pattern: signal.pattern,
        note: 'No executable ask for the pattern-selected ' + side + ' side; waiting for an order book.',
      });
      return false;
    }
    const targetShares = cfg.BASE_SHARES;
    const estimatedNotional = estimateBuyNotional(asks, targetShares);
    if (estimatedNotional == null || estimatedNotional <= 0) {
      w.status = 'waiting_for_order_book';
      return false;
    }
    const estimatedFee = estimateTakerFee(targetShares, estimatedNotional / targetShares);
    if (this.cash == null || this.cash + EPSILON < estimatedNotional + estimatedFee) {
      this._push({
        event: 'CANDLE_PATTERN_BUY_NO_CASH', slug: w.slug, side,
        pattern: signal.pattern,
        note: 'Demo cash is insufficient for the fixed ' + targetShares + '-share ' + side + ' entry.',
      });
      return false;
    }
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (this.w !== w || w.closed || w.closing || (w.position && w.position.openShares > EPSILON)
      || w.entryCount > 0 || !w.activeSignal || w.activeSignal.action !== 'BUY'
      || w.activeSignal.pattern !== signal.pattern || w.activeSignal.side !== side
      || Date.now() >= closeTs * 1000) return false;

    const order = await this.trader.placeFakMarketOrder(tokenId, 'BUY', targetShares, {
      targetShares, orderBook: book,
    });
    const shares = positive(order && order.raw && order.raw.takingAmount) || 0;
    const notional = positive(order && order.raw && order.raw.makingAmount) || 0;
    const simulatedLiquidityShares = positive(order && order.raw && order.raw.simulatedLiquidityShares) || 0;
    if (shares + EPSILON < targetShares || notional <= 0) {
      this._push({
        event: 'CANDLE_PATTERN_BUY_UNFILLED', slug: w.slug, side,
        pattern: signal.pattern,
        note: 'The demo simulator did not fill all 500 shares; no partial position was recorded.',
      });
      return false;
    }
    const averagePrice = notional / shares;
    const fee = estimateTakerFee(shares, averagePrice);
    if (notional + fee > this.cash + EPSILON) {
      this._push({
        event: 'CANDLE_PATTERN_BUY_REJECTED', slug: w.slug, side,
        pattern: signal.pattern,
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
      simulatedLiquidityShares,
      exitProceeds: 0, status: 'position_open', firedAt: Date.now(),
      lastClobMark: bids.length ? bids[0].price : averagePrice,
      realizedPnl: 0,
      entryPattern: signal.pattern,
      entrySequence: signal.sequence,
      entryMinuteIndex: signal.minuteIndex,
      settled: false, settlementTimedOut: false,
    };
    this.cash -= position.cost;
    this.pending.push(position);
    w.position = position;
    w.entryTaken = true;
    w.entryCount += 1;
    w.status = 'position_open';
    this.stats.signalEntries += 1;
    this.stats.estimatedFees += fee;
    this._recordEquity();
    this._push({
      event: 'CANDLE_PATTERN_BUY_FILLED', slug: w.slug, side, pattern: signal.pattern,
      shares: round(shares, 4), targetShares, simulatedLiquidityShares: round(simulatedLiquidityShares, 4),
      price: round(averagePrice, 4),
      fee: round(fee, 5),
      note: 'Demo marketable BUY filled a fixed ' + targetShares + ' ' + side
        + ' shares at average $' + averagePrice.toFixed(4)
        + ' on the completed one-minute pattern ' + signal.pattern + '.'
        + (simulatedLiquidityShares > EPSILON
          ? ' ' + round(simulatedLiquidityShares, 4) + ' shares used modeled demo liquidity.'
          : ' All target shares swept from visible asks.')
        + ' Estimated taker fee $' + fee.toFixed(5) + '.',
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
        this._recordEquity();
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
          if (this._settlePositionAtClobPrice(position, heldQuote.mid, heldQuote.bid)) continue;
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

  _settlePositionAtClobPrice(position, midpoint, bestBid) {
    if (!position || position.settled || position.openShares <= EPSILON) return false;
    const mid = midpoint == null || midpoint === '' ? null : Number(midpoint);
    const bid = bestBid == null || bestBid === '' ? null : Number(bestBid);
    const validMid = Number.isFinite(mid) && mid >= 0 && mid <= 1 ? mid : null;
    const validBid = Number.isFinite(bid) && bid >= 0 && bid <= 1 ? bid : null;
    const won = validMid != null && validMid >= cfg.CLOB_WIN_SETTLEMENT_PRICE;
    const lost = validBid != null && validBid <= cfg.CLOB_LOSS_SETTLEMENT_PRICE;
    if (!won && !lost) return false;

    const settlementPrice = won ? validMid : validBid;
    const settlementBasis = won ? 'MIDPOINT' : 'BEST_BID';
    const remainingShares = position.openShares;
    const payout = won ? remainingShares : 0;
    const winner = won ? position.side : (position.side === 'UP' ? 'DOWN' : 'UP');
    if (this.cash != null) this.cash += payout;
    position.exitProceeds += payout;
    position.openShares = 0;
    position.resolutionPayout = payout;
    position.clobThresholdPrice = settlementPrice;
    position.clobSettlementBasis = settlementBasis;
    this._clobTried.delete(position);
    this._resolveTried.delete(position.openTs);
    const window = this.w && this.w.openTs === position.openTs && this.w.position === position
      ? this.w : null;
    if (window) {
      window.position = null;
      window.status = window.closed ? 'window_closed' : 'trade_taken';
    }
    this._push({
      event: 'CLOB_THRESHOLD_SETTLEMENT',
      slug: position.slug,
      side: position.side,
      price: round(settlementPrice, 4),
      settlementBasis,
      shares: round(remainingShares, 4),
      payout: round(payout, 2),
      note: 'Held-side CLOB ' + (won ? 'midpoint' : 'best bid') + ' reached $'
        + settlementPrice.toFixed(4)
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
      entryPattern: position.entryPattern || null,
      entryNotional: round(position.entryNotional, 4),
      exitProceeds: round(position.exitProceeds, 4),
      fee: round(position.entryFee + position.exitFees, 4),
      outcome, reason, winner, pnl: round(pnl, 2), ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    this._push({
      event: outcome === 'CLOSED' ? 'PRICE_POSITION_CLOSED' : (outcome === 'WIN' ? 'SETTLED_WIN' : 'SETTLED_LOSS'),
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
        candleSequence: w.candleSequence,
        minuteCandles: w.minuteCandles,
        lastCandle: w.lastCandle,
        positionSide: w.position && w.position.openShares > EPSILON ? w.position.side : null,
        openShares: w.position ? w.position.openShares : 0,
        entryCount: w.entryCount,
        lastSignal: w.lastSignal || null,
        activeSignal: w.activeSignal || null,
        activeSignalSide: w.activeSignal ? w.activeSignal.side : null,
        entryTaken: w.entryCount > 0,
      } : null,
      ccxt: { ...this.ccxt, status: ccxtStatus, ageMs: ccxtAgeMs },
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      strategy: {
        baseShares: cfg.BASE_SHARES,
        fixedOrderShares: cfg.BASE_SHARES,
        nextEntryShares: cfg.BASE_SHARES,
        minuteMs: cfg.STRATEGY_MINUTE_MS,
        minSamplesPerCandle: cfg.STRATEGY_MIN_CANDLE_SAMPLES,
        maxEntriesPerWindow: 1,
        clobWinSettlementPrice: cfg.CLOB_WIN_SETTLEMENT_PRICE,
        clobLossSettlementPrice: cfg.CLOB_LOSS_SETTLEMENT_PRICE,
        pollMs: this.ccxt.pollMs,
        exchange: this.ccxt.exchange,
        symbol: this.ccxt.symbol,
      },
      counts: this.counts, pending,
      trades: this.trades.slice(-60).reverse(), equity: this.equity, stats: this.stats,
      btcSeries: buildBtcSeries(this._btcSamples, w ? w.openTs : null),
      cfg: {
        demoCapital: cfg.DEMO_CAPITAL,
        baseShares: cfg.BASE_SHARES,
        windowSec: WINDOW_SECONDS,
        btcCandleMs: cfg.STRATEGY_MINUTE_MS,
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
    entryCount: 0, minuteCandles: [], nextMinuteIndex: 0, currentMinuteCandle: null,
    candleSequence: '', lastCandle: null, lastSignal: null, activeSignal: null,
    tradeInFlight: false,
  };
}

function emptyQuote() { return { bid: null, ask: null, mid: null }; }

function sortedLevels(levels, order) {
  return (levels || [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0
      && level.price <= 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort(order === 'asc' ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);
}

function estimateBuyNotional(asks, targetShares) {
  let remaining = Number(targetShares);
  let notional = 0;
  let lastPrice = null;
  for (const level of asks || []) {
    if (remaining <= EPSILON) break;
    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    remaining -= take;
    lastPrice = level.price;
  }
  if (remaining > EPSILON) {
    const modeledPrice = lastPrice || (asks && asks[0] && asks[0].price);
    if (!Number.isFinite(Number(modeledPrice)) || Number(modeledPrice) <= 0) return null;
    notional += remaining * Number(modeledPrice);
  }
  return notional;
}

function buildBtcSeries(samples, openTs) {
  if (!Array.isArray(samples) || !samples.length || !Number.isFinite(Number(openTs))) return [];
  const openMs = Number(openTs) * 1000;
  const ordered = samples
    .map((sample) => ({ t: Number(sample.sampledAt), price: Number(sample.price) }))
    .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.price)
      && sample.price > 0 && sample.t >= openMs - 10_000)
    .sort((a, b) => a.t - b.t);
  const output = [];
  let start = 0;
  let sum = 0;
  for (let i = 0; i < ordered.length; i++) {
    const sample = ordered[i];
    sum += sample.price;
    while (start < i && ordered[start].t < sample.t - 10_000) {
      sum -= ordered[start].price;
      start += 1;
    }
    output.push({
      t: round((sample.t - openMs) / 1000, 1),
      price: round(sample.price, 2),
      avg10s: round(sum / (i - start + 1), 2),
    });
  }
  return output;
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