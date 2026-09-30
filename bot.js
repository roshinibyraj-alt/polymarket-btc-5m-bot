'use strict';

const cfg = require('./config');
const { getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS, fetchResolution } = require('./polymarket-market');
const candleFeed = require('./candle-feed');
const strategy = require('./strategy');

const POLL_MS = 1000;
const MAX_LOG = 300;
const WINDOW_MS = WINDOW_SECONDS * 1000;

class Bot {
  /** @param trader an authenticated PolymarketTrader */
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.live = !!opts.live;
    this.w = null;                                 // current window state
    this.pending = [];                             // filled bets awaiting outcome settlement
    this.stats = { wins: 0, losses: 0, noSignal: 0, voidNoFill: 0, voidNoData: 0, realizedPnl: 0 };
    this.outcomes = new Map();                     // CLOB cutoff or official outcomes by market-window open time
    this._resolveTried = new Map();                // openTs -> last official-resolution lookup time
    this.lastSignal = null;                        // previous-candle direction and planned entry
    this.walletBalance = null;
    this.error = null;
    this.log = [];
    this.startedAt = Date.now();
    this.capital = this.live ? null : cfg.DEMO_CAPITAL;   // demo: fixed play money; live: first wallet balance seen
    this.cash = this.live ? null : cfg.DEMO_CAPITAL;
    this.trades = [];                              // settled trades (newest last)
    this.equity = [{ ts: Date.now(), v: this.capital }];
    this.peak = this.capital; this.maxDD = 0;
    this.prices = null;                            // live UP/DOWN quotes for the current window
    this.priceSeries = []; this._seriesSlug = null;
    this.counts = { UP: 0, DOWN: 0 };              // windows resolved this session
    this.candles = [];
    this.baseShares = cfg.BASE_SHARES;
    this.shareAdditions = 0;
    this._stopCandleFeed = null;
    this._running = false;
    this._warned = new Set();
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
    this._settlementLoop();
    this._balanceLoop();
    this._priceLoop();
    this._candleLoop();
  }

  async _loop() {
    while (this._running) {
      try {
        await this._tick();
      } catch (e) {
        this.error = `tick error: ${e.message}`;
        this._push({ event: 'ERROR', note: this.error });
      }
      await sleep(POLL_MS);
    }
  }

  /** Live UP/DOWN prices every second (bid / ask / mid) for the dashboard + chart. */
  async _priceLoop() {
    while (this._running) {
      const w = this.w;
      if (w && w.window) {
        try {
          const [bu, bd] = await Promise.all([this.trader.getOrderBook(w.window.tokenUp), this.trader.getOrderBook(w.window.tokenDown)]);
          const up = quote(bu), down = quote(bd);
          this.prices = { slug: w.slug, ts: Date.now(), up, down };
          this._captureClobOutcome(w, { up, down }, this.prices.ts);
          if (this._seriesSlug !== w.slug) { this._seriesSlug = w.slug; this.priceSeries = []; }
          if (up.ask != null && down.ask != null) {
            this.priceSeries.push({ t: Math.round((Date.now() - w.openTs * 1000) / 1000), up: round(up.ask, 3), down: round(down.ask, 3) });
          }
        } catch (_) { /* keep last quote */ }
      }
      await sleep(1000);
    }
  }

  /** Follow the closed BTC 5-minute candles used to select the direction for each market window. */
  _candleLoop() {
    this._stopCandleFeed = candleFeed.startClosedCandleFeed(
      cfg.CANDLE_LOOKBACK,
      (candles) => this._processCandles(candles),
      (e) => {
        this.error = 'BTC candle feed error: ' + e.message;
        this._push({ event: 'ERROR', note: this.error });
      }
    );
  }

  _processCandles(candles) {
    if (!Array.isArray(candles) || !candles.length) return;
    if (typeof this.error === 'string' && this.error.startsWith('BTC candle feed error:')) this.error = null;
    this.candles = candles.slice(-cfg.CANDLE_LOOKBACK);
    if (this.w) this._syncWindowSignal(this.w);
  }

  _syncWindowSignal(w) {
    const signal = strategy.previousCandleSignal(this.candles, w.openTs, WINDOW_SECONDS);
    if (!signal.ready) {
      if (w.status === 'starting') w.status = 'waiting_for_candle';
      return false;
    }
    if (w.previousCandleOpenTs === signal.candle.openTs) return true;
    w.previousCandleOpenTs = signal.candle.openTs;
    w.previousCandle = signal.candle;
    w.candleColor = signal.color;
    w.side = signal.side;
    w.dipSeen = false;
    w.reboundSeen = false;
    w.status = signal.side ? 'watching_dip' : 'no_signal';
    if (!signal.side) {
      this.stats.noSignal += 1;
      this.lastSignal = null;
      this._push({ event: 'NO_SIGNAL', slug: w.slug, note: 'previous BTC candle was a doji; no direction selected' });
      return true;
    }
    this.lastSignal = { color: signal.color, side: signal.side, shares: this.baseShares, candle: signal.candle, slug: w.slug };
    this._push({ event: 'SIGNAL', slug: w.slug, side: signal.side, shares: this.baseShares,
      note: 'previous closed BTC candle was ' + signal.color.toLowerCase() + ' -> BUY ' + signal.side + ' ' + this.baseShares + ' shares; waiting for ask below $' + cfg.DIP_PRICE.toFixed(2) + ' then recovery to $' + cfg.ENTRY_PRICE.toFixed(2) });
    return true;
  }

  // ---- per-window flow -------------------------------------------------------
  async _tick() {
    const now = Date.now();
    const openTs = currentWindowOpenTs(now);
    const slug = slugForTs(openTs);
    if (!this.w || this.w.slug !== slug) {
      this.w = {
        slug, openTs, status: 'starting', window: null, previousCandle: null, previousCandleOpenTs: null,
        candleColor: null, side: null, dipSeen: false, reboundSeen: false,
        tradeTaken: false, entryInFlight: false, position: null, lastOpenAttemptAt: 0, clobOutcomeChecked: false,
      };
      this.lastSignal = null;
    }
    const w = this.w;
    const elapsed = now - openTs * 1000;
    if (!w.window) {
      const { window, reason } = await getActiveWindow(now);
      if (window) { this.error = null; w.window = window; } else { this.error = reason; }
    }
    this._syncWindowSignal(w);
    await this._entryStep(w, elapsed);
  }

  async _entryStep(w, elapsed) {
    if (!w.window || !w.side || w.tradeTaken || w.entryInFlight) return;
    this._syncWindowSignal(w);
    if (elapsed >= WINDOW_MS) return;
    const px = this.prices && this.prices.slug === w.slug ? this.prices : null;
    const ask = px ? (w.side === 'UP' ? px.up.ask : px.down.ask) : null;
    if (ask == null) return;
    const now = Date.now();
    const secondsRemaining = Math.max(0, (w.openTs * 1000 + WINDOW_MS - now) / 1000);
    const observed = strategy.observeEntryPrice(w, ask, secondsRemaining, cfg);
    for (const event of observed.events) {
      if (event === 'DIP_SEEN') {
        w.status = 'waiting_for_rebound';
        this._push({ event, slug: w.slug, side: w.side, shares: this.baseShares,
          note: w.side + ' best ask dipped below $' + cfg.DIP_PRICE.toFixed(2) + '; waiting for recovery to $' + cfg.ENTRY_PRICE.toFixed(2) });
      } else if (event === 'REBOUND_SEEN') {
        w.status = 'waiting_for_entry';
        this._push({ event, slug: w.slug, side: w.side, shares: this.baseShares,
          note: w.side + ' best ask recovered to $' + cfg.ENTRY_PRICE.toFixed(2) + ' after the dip; FOK buy limit is $' + cfg.ENTRY_PRICE.toFixed(2) });
      }
    }
    if (w.reboundSeen && secondsRemaining < cfg.MIN_SECONDS_REMAINING) {
      w.status = 'entry_expired';
      return;
    }
    if (!observed.shouldBuy || now - (w.lastOpenAttemptAt || 0) < cfg.ENTRY_RETRY_MS) return;
    w.lastOpenAttemptAt = now;
    const token = w.side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    await this._fire(w, w.side, this.baseShares, token);
  }

  async _orderFilled(result, shares) {
    const raw = result.raw || {};
    const status = String(raw.status || result.status || '').toLowerCase();
    let filled = !!result.isFilled || status === 'matched' || status === 'filled';
    if (!filled && result.id) {
      try {
        const order = await this.trader.getOrder(result.id);
        const orderStatus = String(order?.status || '').toLowerCase();
        filled = orderStatus === 'matched' || orderStatus === 'filled' || parseFloat(order?.size_matched || '0') >= shares;
      } catch (_) { /* leave unfilled */ }
    }
    return { filled, status };
  }

  async _fire(w, side, shares, token) {
    if (w.tradeTaken || w.entryInFlight) return false;
    w.entryInFlight = true;
    w.status = 'firing';
    this._push({ event: 'FIRING', slug: w.slug, side, shares,
      note: 'buying ' + shares + 'sh ' + side + ' with a FOK limit at $' + cfg.ENTRY_PRICE.toFixed(2) });

    const waitForFill = (why) => {
      w.entryInFlight = false;
      w.status = w.reboundSeen ? 'waiting_for_entry' : w.dipSeen ? 'waiting_for_rebound' : 'watching_dip';
      this._push({ event: 'ENTRY_WAITING', slug: w.slug, side, shares,
        note: why + '; will retry only while the one-trade setup remains eligible' });
      return false;
    };
    let result;
    try {
      result = await this.trader.placeFokLimitOrder(token, 'BUY', cfg.ENTRY_PRICE, shares);
    } catch (e) {
      return waitForFill('FOK buy failed: ' + e.message);
    }

    const { filled, status } = await this._orderFilled(result, shares);
    if (!filled) return waitForFill('FOK not filled (status: ' + (status || 'none') + ')');

    const raw = result.raw || {};
    let price = Number(result.avgPrice);
    const paid = parseFloat(raw.makingAmount), got = parseFloat(raw.takingAmount);
    if (paid > 0 && got > 0) price = paid / got;
    if (!Number.isFinite(price) || price <= 0 || price > cfg.ENTRY_PRICE + 1e-9) {
      return waitForFill('buy fill returned an invalid or over-limit average price');
    }

    const fee = shares * cfg.TAKER_FEE_RATE * price * (1 - price);
    const cost = shares * price + fee;
    if (!this.live && cost > this.cash) return waitForFill('demo balance too low ($' + this.cash.toFixed(2) + ' < $' + cost.toFixed(2) + ')');
    if (!this.live) this.cash -= cost;

    const position = { slug: w.slug, openTs: w.openTs, closeTs: w.window.closeTs, side, shares, price, fee, cost,
      baseSharesAtEntry: shares, firedAt: Date.now() };
    this.pending.push(position);
    w.position = position;
    w.tradeTaken = true;
    w.entryInFlight = false;
    w.status = 'fired';
    this.lastSignal = { color: w.candleColor, side, shares, candle: w.previousCandle, slug: w.slug };
    this._push({ event: 'ENTRY_FILLED', slug: w.slug, side, shares, price: round(price, 4),
      note: 'filled ' + shares + 'sh ' + side + ' @ ' + round(price, 4) + '; one trade this window, holding for settlement' });
    return true;
  }

  _captureClobOutcome(w, quotes, sampledAt) {
    if (!w || w.clobOutcomeChecked) return;
    const elapsed = (sampledAt - w.openTs * 1000) / 1000;
    if (elapsed < cfg.CLOB_SETTLEMENT_SECOND || elapsed >= WINDOW_SECONDS) return;
    w.clobOutcomeChecked = true;

    const upBid = quotes.up && Number.isFinite(quotes.up.bid) ? quotes.up.bid : null;
    const downBid = quotes.down && Number.isFinite(quotes.down.bid) ? quotes.down.bid : null;
    const upWins = upBid != null && upBid > cfg.CLOB_WIN_THRESHOLD;
    const downWins = downBid != null && downBid > cfg.CLOB_WIN_THRESHOLD;
    if (upWins === downWins) {
      const show = (price) => price == null ? 'unavailable' : '$' + price.toFixed(3);
      this._push({ event: 'CLOB_OUTCOME_UNCLEAR', slug: w.slug,
        note: '297s CLOB check had no unique side with best bid strictly above $' + cfg.CLOB_WIN_THRESHOLD.toFixed(2) + ' (UP ' + show(upBid) + ', DOWN ' + show(downBid) + '); waiting for official result' });
      return;
    }
    const winner = upWins ? 'UP' : 'DOWN';
    const bid = upWins ? upBid : downBid;
    this._setWindowOutcome(w.openTs, winner, 'clob_297s', { upBid, downBid, bid, sampledAt });
  }

  _setWindowOutcome(openTs, winner, source = 'official', details = null) {
    if (this.outcomes.has(openTs)) return;
    const loser = winner === 'UP' ? 'DOWN' : 'UP';
    this.outcomes.set(openTs, { winner, source, price: 1, loser: 0, ...(details || {}) });
    this.counts[winner] += 1;
    if (this.outcomes.size > 60) this.outcomes.delete(this.outcomes.keys().next().value);
    const note = source === 'clob_297s'
      ? '297s CLOB check: ' + winner + ' best bid $' + details.bid.toFixed(3) + ' > $' + cfg.CLOB_WIN_THRESHOLD.toFixed(2) + '; ' + loser + ' loses at $0/share'
      : 'official Polymarket resolution: ' + winner + ' won ($1/share); ' + loser + ' lost ($0/share)';
    this._push({ event: 'OUTCOME', slug: slugForTs(openTs), side: winner, note });
  }

  async _settlementLoop() {
    while (this._running) {
      await sleep(cfg.SETTLEMENT_POLL_MS);
      if (!this.pending.length) continue;
      const now = Date.now();
      const pendingAtStart = this.pending.slice();
      const settledThisTick = new Set();
      for (const p of pendingAtStart) {
        let winner = this.outcomes.get(p.openTs)?.winner || null;
        if (!winner && now < p.closeTs * 1000) continue;
        const lastTried = this._resolveTried.get(p.openTs) || 0;
        if (!winner && now - lastTried >= cfg.RESOLUTION_RETRY_MS) {
          this._resolveTried.set(p.openTs, now);
          try {
            winner = await fetchResolution(p.slug);
          } catch (e) {
            this._warnOnce('resolution-' + p.openTs, { event: 'ERROR', slug: p.slug,
              note: 'official market resolution lookup failed: ' + e.message });
          }
          if (winner) this._setWindowOutcome(p.openTs, winner);
        }
        if (winner) {
          this._settle(p, winner);
          this._resolveTried.delete(p.openTs);
          settledThisTick.add(p);
          continue;
        }
        if (now - p.firedAt > cfg.SETTLEMENT_GIVE_UP_MS && !p.settlementTimedOut) {
          p.settlementTimedOut = true;
          this._push({ event: 'SETTLEMENT_TIMEOUT', slug: p.slug, side: p.side, shares: p.shares,
            note: '297s CLOB check was inconclusive and official result is still pending; keeping the position open and continuing to check' });
        }
      }
      if (settledThisTick.size) this.pending = this.pending.filter((p) => !settledThisTick.has(p));
    }
  }

  _settle(p, winner) {
    const win = winner === p.side;
    const outcome = win ? 'WIN' : 'LOSS';
    p.final = true;
    const previousBase = this.baseShares;
    this.baseShares = strategy.adjustBaseShares(this.baseShares, outcome, cfg);
    this.shareAdditions = strategy.additionCount(this.baseShares, cfg);

    const fee = p.fee, cost = p.cost;
    const pnl = win ? p.shares - cost : -cost;
    if (win) this.stats.wins += 1; else this.stats.losses += 1;
    this.stats.realizedPnl += pnl;
    if (win && !this.live) this.cash += p.shares;
    this.trades.push({ slug: p.slug, openTs: p.openTs, side: p.side, winner, outcome, shares: p.shares,
      price: round(p.price, 4), cost: round(cost, 2), fee: round(fee, 3), pnl: round(pnl, 2),
      baseSharesBefore: previousBase, baseSharesAfter: this.baseShares, additionsAfter: this.shareAdditions, ts: Date.now() });
    if (this.trades.length > 200) this.trades.shift();
    if (this.capital != null) {
      const eq = this.capital + this.stats.realizedPnl;
      this.equity.push({ ts: Date.now(), v: round(eq, 2) });
      if (this.equity.length > 500) this.equity.shift();
      this.peak = Math.max(this.peak, eq);
      this.maxDD = Math.max(this.maxDD, this.peak - eq);
    }
    if (this.w && this.w.openTs === p.openTs) this.w.status = 'settled';
    this._push({ event: win ? 'SETTLED_WIN' : 'SETTLED_LOSS', slug: p.slug, side: p.side, shares: p.shares, pnl: round(pnl, 2),
      note: outcome + ' on ' + (this.outcomes.get(p.openTs)?.source === 'clob_297s' ? '297s CLOB threshold' : 'official Polymarket resolution') + '; base size ' + previousBase + ' → ' + this.baseShares + ' shares (' + this.shareAdditions + '/' + cfg.MAX_SHARE_ADDITIONS + ' additions), estimated P&L ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) });
  }

  async _balanceLoop() {
    while (this._running) {
      try {
        this.walletBalance = await this.trader.getBalance();
        if (this.live && this.capital == null && this.walletBalance != null) {
          this.capital = this.walletBalance; this.peak = this.capital; this.equity = [{ ts: Date.now(), v: this.capital }];
        }
      }
      catch (e) { this._push({ event: 'ERROR', note: `balance check failed: ${e.message}` }); }
      await sleep(30_000);
    }
  }

  snapshot() {
    const w = this.w, px = this.prices, now = Date.now();
    const pending = this.pending.slice(-10).map((p) => {
      const mark = px && px.slug === p.slug ? (p.side === 'UP' ? px.up.mid : px.down.mid) : null;
      return { ...p, mark, unrealized: mark != null ? p.shares * mark - p.cost : null };
    });
    const openValue = pending.reduce((s, p) => s + (p.mark != null ? p.shares * p.mark : p.cost), 0);
    const cash = this.live ? this.walletBalance : this.cash;
    const tradeBy = new Map(this.trades.map((t) => [t.openTs, t]));
    const pendBy = new Map(this.pending.map((p) => [p.openTs, p]));
    return {
      now,
      mode: this.live ? 'LIVE' : 'DEMO',
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      error: this.error,
      walletBalance: this.walletBalance,
      walletAddress: this.trader.depositWallet || this.trader.address,
      account: { capital: this.capital, cash, openValue, equity: cash == null ? null : cash + openValue, maxDrawdown: this.maxDD },
      window: w ? { slug: w.slug, status: w.status, side: w.position ? w.position.side : w.side, shares: w.position ? w.position.shares : (w.side ? this.baseShares : null), openTs: w.openTs, closeTs: w.openTs + WINDOW_SECONDS, candleColor: w.candleColor, dipSeen: w.dipSeen, reboundSeen: w.reboundSeen, tradeTaken: w.tradeTaken } : null,
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      strategy: { previousCandle: w ? w.previousCandle : null, color: w ? w.candleColor : null, side: w ? w.side : null,
        dipSeen: !!(w && w.dipSeen), reboundSeen: !!(w && w.reboundSeen), currentAsk: w && this.prices && this.prices.slug === w.slug && w.side ? (w.side === 'UP' ? this.prices.up.ask : this.prices.down.ask) : null,
        baseShares: this.baseShares, additions: this.shareAdditions, maxAdditions: cfg.MAX_SHARE_ADDITIONS, candles: this.candles.slice(-cfg.CANDLE_LOOKBACK) },
      counts: this.counts,
      recentOutcomes: [...this.outcomes.entries()].slice(-24).map(([t, o]) => {
        const tr = tradeBy.get(t), pd = pendBy.get(t);
        return { openTs: t, winner: o.winner, source: o.source, price: o.price, loser: o.loser,
          traded: tr ? tr.side : pd ? pd.side : null, result: tr ? tr.outcome : null, pnl: tr ? tr.pnl : null };
      }),
      lastSignal: this.lastSignal,
      pending,
      trades: this.trades.slice(-60).reverse(),
      equity: this.equity,
      stats: this.stats,
      cfg: { dipPrice: cfg.DIP_PRICE, entryPrice: cfg.ENTRY_PRICE, minSecondsRemaining: cfg.MIN_SECONDS_REMAINING,
        baseShares: cfg.BASE_SHARES, shareStep: cfg.SHARE_STEP, maxAdditions: cfg.MAX_SHARE_ADDITIONS,
        candleInterval: cfg.CANDLE_INTERVAL, windowSec: WINDOW_SECONDS, clobSettlementSecond: cfg.CLOB_SETTLEMENT_SECOND, clobWinThreshold: cfg.CLOB_WIN_THRESHOLD },
      log: this.log.slice(-100).reverse(),
    };
  }
}

/** Best bid / best ask / mid of one order book (mid falls back to the bid when there are no asks). */
function quote(book) {
  const num = (x) => parseFloat(x);
  const bids = ((book && book.bids) || []).filter((b) => num(b.price) > 0 && num(b.size) > 0).map((b) => num(b.price));
  const asks = ((book && book.asks) || []).filter((a) => num(a.price) > 0 && num(a.size) > 0).map((a) => num(a.price));
  const bid = bids.length ? Math.max(...bids) : null, ask = asks.length ? Math.min(...asks) : null;
  return { bid, ask, mid: bid == null ? null : ask == null ? bid : (bid + ask) / 2 };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = Bot;
