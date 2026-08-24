'use strict';

const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';
const CLOB_POLL_MS = Number(process.env.CLOB_POLL_MS || 500);
const CLOB_FRESH_MS = Number(process.env.CLOB_FRESH_MS || 3500);
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS || 300);
const ENTRY_PRICE = Number(process.env.ENTRY_PRICE || 0.89);
const STOP_PRICE = Number(process.env.STOP_PRICE || 0.79);
const RESOLUTION_PRICE = Number(process.env.RESOLUTION_PRICE || 0.90);
const BASE_SHARES = Number(process.env.BASE_SHARES || 100);
const MARTINGALE_MULTIPLIER = Number(process.env.MARTINGALE_MULTIPLIER || 2.1);
const MAX_MARTINGALES = Number(process.env.MAX_MARTINGALES || 4);
const START_BANKROLL = Number(process.env.START_BANKROLL || 5000);
const TAKER_FEE_BPS = Number(process.env.TAKER_FEE_BPS || 0);

function round2(value) { return Math.round(value * 100) / 100; }
function round5(value) { return Math.round(value * 100000) / 100000; }
function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }
function sharesForStreak(streak) {
  return Math.round(BASE_SHARES * Math.pow(MARTINGALE_MULTIPLIER, streak));
}

class BtcBreakoutEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.emitTick = options.onTick || (() => {});
    this.emitLog = options.onLog || (() => {});
    this.startedAt = Date.now();
    this.bankroll = START_BANKROLL;
    this.realizedPnl = 0;
    this.totalFees = 0;
    this.wins = 0;
    this.losses = 0;
    this.tickCount = 0;
    this.pollCount = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;
    this.pollRunning = false;
    this.loopRunning = false;
    this.discoveryRunning = false;
    this.activeWindowStart = null;
    this.lossStreak = 0;
    this.openPosition = null;
    this.markets = new Map();
    this.tokens = new Map();
    this.history = new Map();
    this.windowStats = new Map();
    this.discoveredWindows = new Set();
    this.resolvedWindows = [];
    this.trades = [];
    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: START_BANKROLL }];
    this.discoveryErrors = [];
    this.lastDiscoveryAt = null;
  }

  log(message) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.emitLog(line);
  }

  parseJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  async requestJSON(url, options = {}, timeout = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'btc-breakout-bot/1.0', ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  getJSON(url, timeout) { return this.requestJSON(url, {}, timeout); }

  async discoverMarket(start) {
    const slug = slugFor(start);
    if (this.discoveredWindows.has(slug)) return this.markets.get(slug) || null;
    let market = null;
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, 8000);
      market = Array.isArray(rows) ? rows[0] : null;
      this.lastDiscoveryAt = Date.now();
    } catch (error) {
      this.addDiscoveryError(`${slug}: ${error.message}`);
      return null;
    }
    if (!market || !market.conditionId || !market.clobTokenIds || market.closed) {
      this.addDiscoveryError(`${slug}: market unavailable/closed`);
      return null;
    }
    const outcomes = this.parseJson(market.outcomes) || [];
    const tokenIds = this.parseJson(market.clobTokenIds) || [];
    const upIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'up');
    const downIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'down');
    if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
      this.addDiscoveryError(`${slug}: invalid UP/DOWN token mapping`);
      return null;
    }
    const record = {
      slug, asset: 'btc', title: market.question || slug,
      conditionId: market.conditionId,
      windowStart: start, windowEnd: start + WINDOW_SECONDS,
      tradingClosed: false, resolved: false, winner: null,
      resolutionSource: null, finalUpMax: null, finalDownMax: null,
      up: this.makeToken(tokenIds[upIndex], slug, 'UP'),
      down: this.makeToken(tokenIds[downIndex], slug, 'DOWN'),
    };
    this.markets.set(slug, record);
    this.tokens.set(record.up.tokenId, record.up);
    this.tokens.set(record.down.tokenId, record.down);
    this.discoveredWindows.add(slug);
    this.log(`🎯 BTC window discovered ${slug} — CLOB books armed`);
    return record;
  }

  addDiscoveryError(message) {
    this.discoveryErrors.unshift(message);
    this.discoveryErrors = this.discoveryErrors.slice(0, 8);
    this.log(`⚠️ Discovery ${message}`);
  }

  makeToken(tokenId, slug, outcome) {
    return {
      tokenId: String(tokenId), slug, outcome,
      bid: null, ask: null, mid: null, spread: null,
      updatedAt: null, refreshedAt: 0,
    };
  }

  async discoverWindow(start, label = 'Current') {
    const market = await this.discoverMarket(start);
    if (market && !this.activeWindowStart && !market.tradingClosed && !market.resolved) {
      this.activeWindowStart = start;
      this.log(`🚀 ${label} BTC window active — ${start}`);
    }
    return market;
  }

  currentShares() { return sharesForStreak(this.lossStreak); }

  getWindowStats(start) {
    const key = `${start}`;
    if (!this.windowStats.has(key)) {
      this.windowStats.set(key, {
        windowStart: start, windowEnd: start + WINDOW_SECONDS,
        levelUsed: this.lossStreak, plannedShares: this.currentShares(),
        buyCount: 0, sellCount: 0, invested: 0, realizedPnl: 0,
        status: 'PENDING', result: null, settledAt: null, nextShares: null,
      });
    }
    return this.windowStats.get(key);
  }

  applyBook(token, bids, asks) {
    const validBids = (Array.isArray(bids) ? bids : []).filter(level => Number(level.size) > 0)
      .map(level => ({ price: Number(level.price), size: Number(level.size) }));
    const validAsks = (Array.isArray(asks) ? asks : []).filter(level => Number(level.size) > 0)
      .map(level => ({ price: Number(level.price), size: Number(level.size) }));
    validBids.sort((a, b) => b.price - a.price);
    validAsks.sort((a, b) => a.price - b.price);
    this.setQuote(token, validBids[0]?.price ?? null, validAsks[0]?.price ?? null);
  }

  setQuote(token, bid, ask) {
    const cleanBid = Number.isFinite(bid) && bid > 0 && bid <= 1 ? bid : null;
    const cleanAsk = Number.isFinite(ask) && ask > 0 && ask <= 1 ? ask : null;
    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid;
    token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
    this.pushHistory(token.tokenId, token.mid);
    const market = this.markets.get(token.slug);
    if (market) this.trackFinalPrices(market);
  }

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const series = this.history.get(tokenId) || [];
    series.push({ t: now, p: price });
    while (series.length > 2 && now - series[0].t > 5000) series.shift();
    this.history.set(tokenId, series.slice(-240));
  }

  trackFinalPrices(market) {
    const elapsed = Date.now() / 1000 - market.windowStart;
    if (elapsed < WINDOW_SECONDS - 2) {
      market.finalUpMax = null;
      market.finalDownMax = null;
      return;
    }
    if (elapsed >= WINDOW_SECONDS) return;
    const upMid = Number.isFinite(market.up.mid) ? market.up.mid : null;
    const downMid = Number.isFinite(market.down.mid) ? market.down.mid : null;
    if (upMid != null && (market.finalUpMax == null || upMid > market.finalUpMax)) market.finalUpMax = upMid;
    if (downMid != null && (market.finalDownMax == null || downMid > market.finalDownMax)) market.finalDownMax = downMid;
  }

  resolveFromFinalPrices(market) {
    if (market.resolved || !Number.isFinite(market.finalUpMax) || !Number.isFinite(market.finalDownMax)) return false;
    const upStrong = market.finalUpMax > RESOLUTION_PRICE;
    const downStrong = market.finalDownMax > RESOLUTION_PRICE;
    if (upStrong === downStrong) return false;
    market.tradingClosed = true;
    market.resolved = true;
    market.winner = upStrong ? 'UP' : 'DOWN';
    market.resolutionSource = 'CLOB_FINAL_2S';
    if (this.openPosition?.slug === market.slug) {
      const position = this.openPosition;
      const exitPrice = position.outcome === market.winner ? 1 : 0;
      this.closePosition(exitPrice, 'RESOLUTION');
    }
    this.finalizeWindowStats(market);
    return true;
  }

  managePosition() {
    const position = this.openPosition;
    if (!position || position.status !== 'open') return false;
    const exitBid = position.token.bid;
    if (Number.isFinite(exitBid) && exitBid <= STOP_PRICE) {
      this.closePosition(exitBid, 'STOP_LOSS');
      return true;
    }
    return false;
  }

  evaluateEntry() {
    const nowSeconds = Date.now() / 1000;
    const start = windowStartFor(Date.now());
    const market = this.markets.get(slugFor(start));
    if (!market || market.tradingClosed || market.resolved ||
        this.activeWindowStart !== start || nowSeconds >= market.windowEnd || this.openPosition) return;

    const candidates = [market.up, market.down].filter(token =>
      Number.isFinite(token.mid) && token.mid >= ENTRY_PRICE && Number.isFinite(token.ask));
    if (!candidates.length) return;
    candidates.sort((a, b) => b.mid - a.mid);
    this.openPaperPosition(market, candidates[0]);
  }

  pushTrade(trade) {
    this.trades.push(trade);
    this.trades = this.trades.slice(-300);
  }

  openPaperPosition(market, token) {
    const shares = this.currentShares();
    const entryPrice = token.ask;
    const cost = round2(shares * entryPrice);
    const entryFee = round2(cost * TAKER_FEE_BPS / 10000);
    if (cost + entryFee > this.bankroll) {
      this.log(`⚠️ Entry skipped — need $${round2(cost + entryFee)}, available $${this.bankroll}`);
      return false;
    }
    const stats = this.getWindowStats(market.windowStart);
    stats.levelUsed = this.lossStreak;
    stats.plannedShares = shares;
    this.bankroll = round2(this.bankroll - cost - entryFee);
    this.totalFees = round2(this.totalFees + entryFee);
    const now = Date.now();
    this.openPosition = {
      id: `btc-${market.windowStart}-${now}`, slug: market.slug, asset: 'btc',
      outcome: token.outcome, tokenId: token.tokenId, token,
      conditionId: market.conditionId, shares, avgPrice: entryPrice, entryPrice,
      cost, entryFee, markPrice: token.mid, fills: 1, status: 'open',
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      openedAt: now, martingaleLevel: this.lossStreak,
      signal: { triggerPrice: token.mid, elapsed: Math.max(0, Math.floor(now / 1000 - market.windowStart)) },
    };
    stats.buyCount++;
    stats.invested = round2(stats.invested + cost + entryFee);
    this.pushTrade({
      timestamp: now, action: 'BUY', orderType: 'PAPER-FOK', ...pickPosition(this.openPosition),
      price: entryPrice, pnl: null, reason: 'BREAKOUT_0.89',
      signal: this.openPosition.signal,
    });
    this.log(`⚡ BUY BTC ${token.outcome} ${shares}sh @${entryPrice.toFixed(3)} | trigger ${token.mid.toFixed(3)} ≥ ${ENTRY_PRICE.toFixed(2)} | SL ${STOP_PRICE.toFixed(2)} | $${cost.toFixed(2)}`);
    this.recordEquity();
    return true;
  }

  closePosition(exitPrice, reason) {
    const position = this.openPosition;
    if (!position || position.status !== 'open') return null;
    const proceeds = round2(position.shares * exitPrice);
    const exitFee = round2(proceeds * TAKER_FEE_BPS / 10000);
    const pnl = round2(proceeds - exitFee - position.cost - position.entryFee);
    this.bankroll = round2(this.bankroll + proceeds - exitFee);
    this.totalFees = round2(this.totalFees + exitFee);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    position.status = 'closed';
    position.exitPrice = exitPrice;
    position.proceeds = proceeds;
    position.exitFee = exitFee;
    position.pnl = pnl;
    position.closedAt = Date.now();
    position.reason = reason;
    this.openPosition = null;
    const stats = this.getWindowStats(position.windowStart);
    stats.sellCount++;
    stats.realizedPnl = round2(stats.realizedPnl + pnl);
    if (stats.status === 'PENDING' && reason === 'STOP_LOSS') stats.result = 'STOPPED';
    this.pushTrade({
      timestamp: position.closedAt, action: 'SELL', orderType: 'PAPER-FOK', ...pickPosition(position),
      price: exitPrice, pnl, reason,
      signal: { exitReason: reason, elapsed: Math.floor(position.closedAt / 1000 - position.windowStart) },
    });
    this.log(`${reason === 'STOP_LOSS' ? '🛑 STOP' : '🏁 CLOSE'} BTC ${position.outcome} ${position.shares}sh @${exitPrice.toFixed(3)} | P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}${reason === 'STOP_LOSS' ? '' : ` · ${reason}`}`);
    this.recordEquity();
    return position;
  }

  finalizeWindowStats(market) {
    const stats = this.getWindowStats(market.windowStart);
    if (stats.status !== 'PENDING') return stats;
    const net = stats.realizedPnl;
    stats.result = net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'FLAT';
    stats.winner = market.winner;
    stats.resolutionSource = market.resolutionSource;
    stats.settledAt = Date.now();

    if (stats.buyCount > 0) {
      const previousStreak = stats.levelUsed;
      stats.previousStreak = previousStreak;
      stats.stakeShares = sharesForStreak(previousStreak);
      if (net < 0) {
        this.lossStreak = previousStreak + 1;
        if (this.lossStreak > MAX_MARTINGALES) this.lossStreak = 0;
        this.losses++;
      } else {
        this.lossStreak = 0;
        this.wins++;
      }
      stats.nextLevel = this.lossStreak;
      stats.nextShares = this.currentShares();
      this.log(`🏁 BTC ${market.windowStart} ${stats.result} · net ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)} · winner ${market.winner || 'UNKNOWN'} · next ${this.currentShares()}sh`);
    } else {
      stats.nextLevel = this.lossStreak;
      stats.nextShares = this.currentShares();
      this.log(`🏁 BTC ${market.windowStart} NO-TRADE · winner ${market.winner || 'UNKNOWN'} · next ${this.currentShares()}sh`);
    }
    this.resolvedWindows.unshift({ ...stats });
    this.resolvedWindows = this.resolvedWindows.slice(0, 30);
    return stats;
  }

  settleResolvedWindows() {
    for (const market of this.markets.values()) {
      if (market.resolved) this.finalizeWindowStats(market);
    }
  }

  async retryDiscovery() {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      const starts = [windowStartFor(Date.now()), windowStartFor(Date.now()) + WINDOW_SECONDS];
      await Promise.all(starts.map(start => this.markets.has(slugFor(start)) ? null : this.discoverMarket(start)));
    } finally { this.discoveryRunning = false; }
  }

  async rotateAndSweep() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      const start = windowStartFor(Date.now());
      if (start !== this.activeWindowStart) {
        this.activeWindowStart = null;
        for (const market of this.markets.values()) {
          if (!market.resolved && Date.now() / 1000 >= market.windowEnd) this.resolveFromFinalPrices(market);
        }
        this.settleResolvedWindows();
        await this.discoverWindow(start, 'New');
      } else {
        this.settleResolvedWindows();
      }
      this.pruneExpiredMarkets();
      this.recordEquity();
    } catch (error) {
      this.log(`⚠️ Loop: ${error.message}`);
    } finally { this.loopRunning = false; }
  }

  pruneExpiredMarkets() {
    const cutoff = Date.now() / 1000 - 10;
    const expired = [...this.markets.values()].filter(market =>
      market.windowEnd < cutoff && this.getWindowStats(market.windowStart).status !== 'PENDING');
    if (!expired.length) return;
    for (const market of expired) {
      this.tokens.delete(market.up.tokenId);
      this.tokens.delete(market.down.tokenId);
      this.history.delete(market.up.tokenId);
      this.history.delete(market.down.tokenId);
      this.markets.delete(market.slug);
    }
    this.log(`🧹 Released ${expired.length} expired BTC book(s)`);
  }

  async pollClobBooks() {
    if (this.pollRunning) return;
    const now = Date.now(), start = windowStartFor(now);
    const market = this.markets.get(slugFor(start));
    if (!market || market.resolved || market.tradingClosed) return;
    const tokens = [market.up, market.down];
    this.pollRunning = true;
    try {
      const books = await this.requestJSON(`${CLOB_REST}/books`, {
        method: 'POST', body: JSON.stringify(tokens.map(token => ({ token_id: token.tokenId }))),
      }, 2000);
      const byToken = new Map((Array.isArray(books) ? books : []).map(book => [String(book?.asset_id || ''), book]));
      for (const token of tokens) {
        const book = byToken.get(token.tokenId);
        if (book) this.applyBook(token, book.bids, book.asks);
      }
      this.pollCount++;
      this.lastPollAt = now;
      this.lastSuccessfulPollAt = Date.now();
      if (Date.now() / 1000 >= market.windowEnd) this.resolveFromFinalPrices(market);
      this.managePosition();
      this.evaluateEntry();
      this.tickCount++;
      this.emitTick(this.publicMarkets(), this.pollCount);
    } catch (error) {
      if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt >= 5000) {
        this.log(`⚠️ CLOB book poll failed: ${error.message}`);
        this.lastPollErrorAt = Date.now();
      }
    } finally { this.pollRunning = false; }
  }

  publicMarkets() {
    const start = windowStartFor(Date.now());
    const market = this.markets.get(slugFor(start));
    if (!market) return [];
    return [{
      slug: market.slug, asset: market.asset, title: market.title,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      resolved: market.resolved, winner: market.winner, resolutionSource: market.resolutionSource,
      finalUpMax: market.finalUpMax, finalDownMax: market.finalDownMax,
      elapsed: Math.max(0, Math.floor(Date.now() / 1000 - market.windowStart)),
      remaining: Math.max(0, market.windowEnd - Math.floor(Date.now() / 1000)),
      up: publicToken(market.up), down: publicToken(market.down),
    }];
  }

  positionPnl(position) {
    const mark = Number.isFinite(position.token?.mid) ? position.token.mid : position.markPrice;
    return round2(position.shares * (mark ?? position.avgPrice) - position.cost - position.entryFee);
  }

  floatingPnl() { return this.openPosition ? this.positionPnl(this.openPosition) : 0; }

  buildState() {
    const position = this.openPosition;
    const floating = this.floatingPnl();
    const openValue = position ? round2(position.shares * (position.token.mid ?? position.markPrice ?? position.avgPrice)) : 0;
    const markValue = round2(this.bankroll + openValue);
    const start = windowStartFor(Date.now());
    return {
      mode: 'AUTONOMOUS DEMO',
      strategy: `BTC breakout ≥${ENTRY_PRICE.toFixed(2)} · stop ≤${STOP_PRICE.toFixed(2)} · hold for final-2s resolution`,
      serverTime: Date.now(), windowStart: start,
      connected: this.isClobFresh(), pollCount: this.pollCount, tickCount: this.tickCount,
      lastPollAt: this.lastPollAt, lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      trackedTokens: this.tokens.size, bankroll: this.bankroll,
      markValue, openValue, realizedPnl: this.realizedPnl, unrealizedPnl: floating,
      totalFees: this.totalFees, totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      lossStreak: this.lossStreak, currentShares: this.currentShares(),
      nextShares: this.lossStreak >= MAX_MARTINGALES ? BASE_SHARES : sharesForStreak(this.lossStreak + 1),
      stakeSequence: Array.from({ length: MAX_MARTINGALES + 1 }, (_, index) => sharesForStreak(index)),
      maxMartingales: MAX_MARTINGALES, martingaleMultiplier: MARTINGALE_MULTIPLIER,
      position: position ? { ...position, token: undefined, pnl: this.positionPnl(position) } : null,
      currentWindow: this.getWindowStats(start),
      markets: this.publicMarkets(),
      results: this.resolvedWindows.slice(0, 20),
      trades: this.trades.slice(-120).reverse(),
      equityCurve: this.equityCurve.slice(-1500),
      logs: this.logs.slice(-220),
      discovery: { errors: this.discoveryErrors, lastDiscoveryAt: this.lastDiscoveryAt },
      config: {
        baseShares: BASE_SHARES, entryPrice: ENTRY_PRICE, stopPrice: STOP_PRICE,
        resolutionPrice: RESOLUTION_PRICE, martingaleMultiplier: MARTINGALE_MULTIPLIER,
        maxMartingales: MAX_MARTINGALES, pollMs: CLOB_POLL_MS, feeBps: TAKER_FEE_BPS,
      },
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  recordEquity() {
    const state = this.buildState();
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - state.markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: state.markValue });
      if (this.equityCurve.length > 2000) this.equityCurve.shift();
    }
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
  }

  async init() {
    const start = windowStartFor(Date.now());
    await Promise.all([this.discoverWindow(start), this.discoverMarket(start + WINDOW_SECONDS)]);
    await this.pollClobBooks();
    setInterval(() => this.rotateAndSweep(), 250);
    setInterval(() => this.pollClobBooks(), CLOB_POLL_MS);
    setInterval(() => this.retryDiscovery(), 1500);
    this.log(`🚀 BTC breakout bot started | CLOB books every ${CLOB_POLL_MS}ms | demo $${START_BANKROLL}`);
  }
}

function publicToken(token) {
  return { bid: token.bid, ask: token.ask, mid: token.mid, spread: token.spread, updatedAt: token.updatedAt };
}

function pickPosition(position) {
  return {
    id: position.id, slug: position.slug, asset: position.asset, outcome: position.outcome,
    shares: position.shares, entryPrice: position.avgPrice, cost: position.cost,
    martingaleLevel: position.martingaleLevel,
  };
}

module.exports = { BtcBreakoutEngine, config: {
  BASE_SHARES, ENTRY_PRICE, STOP_PRICE, RESOLUTION_PRICE,
  MARTINGALE_MULTIPLIER, MAX_MARTINGALES, CLOB_POLL_MS,
} };
