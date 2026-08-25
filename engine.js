'use strict';

const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS || 300);
const ENTRY_PRICE = Number(process.env.ENTRY_PRICE || 0.60);
const PRICE_TOLERANCE = Number(process.env.PRICE_TOLERANCE || 0.02);
const TARGET_PROFIT = Number(process.env.TARGET_PROFIT || 10);
const WAIT_AFTER_OPEN = 0;
const MAX_WINDOW_INVESTMENT = Number(process.env.MAX_WINDOW_INVESTMENT || 2000);
const RESOLUTION_PRICE = Number(process.env.RESOLUTION_PRICE || 0.90);
const START_BANKROLL = Number(process.env.START_BANKROLL || 5000);
const TAKER_FEE_BPS = Number(process.env.TAKER_FEE_BPS || 0);
const CLOB_POLL_MS = Math.max(50, Number(process.env.CLOB_POLL_MS || 100));
const CLOB_TIMEOUT_MS = Math.max(250, Number(process.env.CLOB_TIMEOUT_MS || 900));
const CLOB_FRESH_MS = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 900));

function round2(value) { return Math.round(value * 100) / 100; }
function round5(value) { return Math.round(value * 100000) / 100000; }
function windowStartFor(timeMs) {
  return Math.floor(timeMs / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
}
function slugFor(start) { return `btc-updown-5m-${start}`; }

class BtcBreakoutEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.startedAt = Date.now();
    this.bankroll = START_BANKROLL;
    this.realizedPnl = 0;
    this.totalFees = 0;
    this.wins = 0;
    this.losses = 0;
    this.currentStart = windowStartFor(Date.now());
    this.tradedThisWindow = false;
    this.openPosition = null;
    this.markets = new Map();
    this.tokens = new Map();
    this.discoveryJobs = new Map();
    this.windowStats = new Map();
    this.priceHistory = new Map();
    this.results = [];
    this.trades = [];
    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: START_BANKROLL }];
    this.discoveryErrors = [];
    this.lastDiscoveryAt = null;
    this.pollCount = 0;
    this.tickCount = 0;
    this.pollInFlight = 0;
    this.pollSequence = 0;
    this.appliedPollSequence = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;
    this.lastError = null;
    this.timers = [];
    this.windowEntries = [];
    this.windowSunkCost = 0;
    this.windowFlipCount = 0;
    this.accumUpShares = 0;
    this.accumDownShares = 0;
    this.lastFlipKey = null;
    this.monitoringActive = false;
    this.peakEquity = START_BANKROLL;
  }

  log(message) {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.onLog(line);
  }

  addDiscoveryError(message) {
    this.discoveryErrors.unshift(`${new Date().toISOString()} ${message}`);
    this.discoveryErrors = this.discoveryErrors.slice(0, 6);
    this.log(`DISCOVERY FAIL ${message}`);
  }

  parseJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  async requestJSON(url, options = {}, timeout = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'btc-flip-bot/3.0',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  makeToken(tokenId, slug, outcome) {
    const token = {
      tokenId: String(tokenId), slug, outcome,
      bid: null, ask: null, mid: null, spread: null, updatedAt: null,
      bookAsks: [],
    };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  discoverMarket(start) {
    const slug = slugFor(start);
    if (this.markets.has(slug)) return Promise.resolve(this.markets.get(slug));
    if (this.discoveryJobs.has(slug)) return this.discoveryJobs.get(slug);
    const job = (async () => {
      try {
        const rows = await this.requestJSON(
          `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, {}, 8000,
        );
        const market = Array.isArray(rows) ? rows[0] : null;
        if (!market?.conditionId || !market?.clobTokenIds || market.closed) {
          throw new Error('market unavailable or closed');
        }
        const outcomes = this.parseJson(market.outcomes) || [];
        const tokenIds = this.parseJson(market.clobTokenIds) || [];
        const upIndex = outcomes.findIndex(value => String(value).toLowerCase() === 'up');
        const downIndex = outcomes.findIndex(value => String(value).toLowerCase() === 'down');
        if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
          throw new Error('invalid UP/DOWN CLOB mapping');
        }
        const record = {
          slug,
          title: market.question || slug,
          conditionId: market.conditionId,
          windowStart: start,
          windowEnd: start + WINDOW_SECONDS,
          settled: false,
          winner: null,
          resolutionSource: null,
          finalUpMax: null,
          finalDownMax: null,
          up: this.makeToken(tokenIds[upIndex], slug, 'UP'),
          down: this.makeToken(tokenIds[downIndex], slug, 'DOWN'),
        };
        this.markets.set(slug, record);
        this.lastDiscoveryAt = Date.now();
        this.log(`WINDOW READY ${slug}`);
        return record;
      } catch (error) {
        this.addDiscoveryError(`${slug}: ${error.message}`);
        throw error;
      } finally {
        this.discoveryJobs.delete(slug);
      }
    })();
    this.discoveryJobs.set(slug, job);
    return job;
  }

  ensureWindowMarkets() {
    const currentStart = windowStartFor(Date.now());
    const nextStart = currentStart + WINDOW_SECONDS;
    for (const start of [currentStart, nextStart]) {
      const slug = slugFor(start);
      if (!this.markets.has(slug) && !this.discoveryJobs.has(slug)) {
        this.discoverMarket(start).catch(() => {});
      }
    }
  }

  pruneOldMarkets(currentStart) {
    for (const [slug, market] of this.markets) {
      if (market.windowEnd < currentStart - WINDOW_SECONDS) {
        this.tokens.delete(market.up.tokenId);
        this.tokens.delete(market.down.tokenId);
        this.priceHistory.delete(market.up.tokenId);
        this.priceHistory.delete(market.down.tokenId);
        this.markets.delete(slug);
      }
    }
  }

  getWindowStats(start) {
    const key = String(start);
    if (!this.windowStats.has(key)) {
      this.windowStats.set(key, {
        windowStart: start,
        windowEnd: start + WINDOW_SECONDS,
        plannedShares: 0,
        buyCount: 0,
        sellCount: 0,
        invested: 0,
        realizedPnl: 0,
        result: 'PENDING',
        winner: null,
        resolutionSource: null,
        settledAt: null,
      });
    }
    return this.windowStats.get(key);
  }

  profitPerShare(entryPrice) {
    const entryFeeRate = TAKER_FEE_BPS / 10000;
    const exitFeeRate = TAKER_FEE_BPS / 10000;
    return round5((1.00 - exitFeeRate) - entryPrice * (1 + entryFeeRate));
  }

  calculateShares(flipNumber = 0) {
    const DOUBLING = [20, 40, 80];
    return DOUBLING[Math.min(flipNumber, DOUBLING.length - 1)];
  }

  simulateGtcBookFill(token, shares, ceiling = 0.99) {
    const asks = token.bookAsks || [];
    let remaining = shares;
    let totalCost = 0;
    const levels = [];
    for (const level of asks) {
      if (level.price > ceiling) break;
      if (remaining <= 0) break;
      const fill = Math.min(level.size, remaining);
      const cost = round2(fill * level.price);
      levels.push({ price: level.price, size: fill, cost });
      totalCost += cost;
      remaining -= fill;
    }
    const filled = shares - remaining;
    if (filled <= 0) return null;
    const avgPrice = round5(totalCost / filled);
    return { avgPrice, filled, totalCost: round2(totalCost), levels };
  }

  applyQuote(token, bidValue, askValue) {
    const bid = Number.isFinite(bidValue) && bidValue > 0 && bidValue <= 1 ? bidValue : null;
    const ask = Number.isFinite(askValue) && askValue > 0 && askValue <= 1 ? askValue : null;
    token.bid = bid;
    token.ask = ask;
    token.spread = bid != null && ask != null ? round5(ask - bid) : null;
    token.mid = bid != null && ask != null ? round5((bid + ask) / 2) : (ask ?? bid);
    token.updatedAt = Date.now();
    const series = this.priceHistory.get(token.tokenId) || [];
    series.push({ t: Date.now(), p: token.mid });
    while (series.length > 2 && Date.now() - series[0].t > 5000) series.shift();
    this.priceHistory.set(token.tokenId, series.slice(-120));
  }

  trackFinalPrices(market, elapsed) {
    if (elapsed < WINDOW_SECONDS - 2) {
      market.finalUpMax = null;
      market.finalDownMax = null;
      return;
    }
    if (elapsed >= WINDOW_SECONDS) return;
    if (Number.isFinite(market.up.mid) && (!Number.isFinite(market.finalUpMax) || market.up.mid > market.finalUpMax)) {
      market.finalUpMax = market.up.mid;
    }
    if (Number.isFinite(market.down.mid) && (!Number.isFinite(market.finalDownMax) || market.down.mid > market.finalDownMax)) {
      market.finalDownMax = market.down.mid;
    }
  }

  positionPnl(position) {
    const mark = Number.isFinite(position.token?.mid) ? position.token.mid : position.entryPrice;
    return round2(position.shares * mark - position.cost - position.entryFee);
  }

  evaluateEntry(market) {
    if (this.tradedThisWindow || this.openPosition) return false;
    const nowSeconds = Date.now() / 1000;
    const elapsed = nowSeconds - market.windowStart;
    if (elapsed < WAIT_AFTER_OPEN) return false;
    if (!this.monitoringActive) {
      this.monitoringActive = true;
      this.log(`MONITORING ACTIVE after ${WAIT_AFTER_OPEN}s wait`);
    }
    const TRIGGER = ENTRY_PRICE - 0.02;
    const candidates = [market.up, market.down].map(token => {
      const best = token.mid ?? token.ask ?? token.bid;
      return { token, price: best };
    }).filter(c => Number.isFinite(c.price) && c.price >= TRIGGER);
    if (!candidates.length) return false;
    candidates.sort((a, b) => a.price - b.price);
    this.enterPosition(market, candidates[0].token, candidates[0].price);
    return true;
  }

  evaluateFlip(market) {
    if (!this.openPosition) return false;
    const nowSeconds = Date.now() / 1000;
    const elapsed = nowSeconds - market.windowStart;
    if (elapsed < WAIT_AFTER_OPEN) return false;
    const currentOutcome = this.openPosition.outcome;
    const flipToken = currentOutcome === 'UP' ? market.down : market.up;
    if (this.windowFlipCount >= 2) return false;
    const price = flipToken.mid ?? flipToken.ask ?? flipToken.bid;
    if (!Number.isFinite(price)) return false;
    if (price < ENTRY_PRICE - 0.02) return false;
    this.flipPosition(market, flipToken);
    return true;
  }

  enterPosition(market, token, triggerPrice) {
    const CEILING = 0.99;
    const shares = this.calculateShares(0);
    const sweep = this.simulateGtcBookFill(token, shares, CEILING);
    if (!sweep) return false;
    const entryPrice = sweep.avgPrice;
    const cost = sweep.totalCost;
    const entryFee = round2(cost * TAKER_FEE_BPS / 10000);
    if (cost + entryFee > this.bankroll) {
      this.tradedThisWindow = true;
      this.log(`ENTRY SKIPPED need $${round2(cost + entryFee)} available $${this.bankroll}`);
      return false;
    }
    if (this.windowSunkCost + cost + entryFee > MAX_WINDOW_INVESTMENT) {
      this.tradedThisWindow = true;
      this.log(`ENTRY SKIPPED max window investment $${MAX_WINDOW_INVESTMENT} would be exceeded`);
      return false;
    }
    const stats = this.getWindowStats(market.windowStart);
    stats.plannedShares = shares;
    this.bankroll = round2(this.bankroll - cost - entryFee);
    this.totalFees = round2(this.totalFees + entryFee);
    this.windowSunkCost = round2(this.windowSunkCost + cost + entryFee);
    const now = Date.now();
    this.openPosition = {
      id: `btc-${market.windowStart}-${now}`,
      slug: market.slug,
      outcome: token.outcome,
      tokenId: token.tokenId,
      token,
      shares,
      entryPrice,
      cost,
      entryFee,
      status: 'OPEN',
      openedAt: now,
      windowStart: market.windowStart,
      signal: {
        triggerPrice,
        triggerSource: 'ENTRY_0.60',
        bid: token.bid,
        ask: token.ask,
        mid: token.mid,
        elapsed: Math.max(0, Math.floor(now / 1000 - market.windowStart)),
      },
    };
    if (token.outcome === 'UP') this.accumUpShares += shares;
    else this.accumDownShares += shares;
    this.windowEntries.push({ ...this.openPosition, signal: { ...this.openPosition.signal } });
    this.tradedThisWindow = true;
    stats.buyCount += 1;
    stats.invested = round2(stats.invested + cost + entryFee);
    this.pushTrade('BUY', this.openPosition, entryPrice, null, 'ENTRY_0.60');
    this.log(`⚡ GTC BUY BTC ${token.outcome} ${shares} SH avg:${entryPrice.toFixed(3)} (sweep ${sweep.filled}sh levels:${sweep.levels.length}) TARGET $${TARGET_PROFIT} cost $${cost.toFixed(2)} sunk $${this.windowSunkCost.toFixed(2)}`);
    this.recordEquity();
    return true;
  }

  flipPosition(market, token) {
    if (this.windowFlipCount >= 2) return false;
    this.windowFlipCount += 1;
    const CEILING = 0.99;
    const shares = this.calculateShares(this.windowFlipCount);
    const sweep = this.simulateGtcBookFill(token, shares, CEILING);
    if (!sweep) { this.windowFlipCount -= 1; return false; }
    const entryPrice = sweep.avgPrice;
    const cost = sweep.totalCost;
    const entryFee = round2(cost * TAKER_FEE_BPS / 10000);
    if (cost + entryFee > this.bankroll) {
      this.log(`FLIP SKIPPED need $${round2(cost + entryFee)} available $${this.bankroll}`);
      return false;
    }
    if (this.windowSunkCost + cost + entryFee > MAX_WINDOW_INVESTMENT) {
      this.log(`FLIP SKIPPED max window investment $${MAX_WINDOW_INVESTMENT} would be exceeded`);
      return false;
    }
    const stats = this.getWindowStats(market.windowStart);
    this.bankroll = round2(this.bankroll - cost - entryFee);
    this.totalFees = round2(this.totalFees + entryFee);
    this.windowSunkCost = round2(this.windowSunkCost + cost + entryFee);
    const now = Date.now();
    this.openPosition = {
      id: `btc-${market.windowStart}-flip${this.windowFlipCount}-${now}`,
      slug: market.slug,
      outcome: token.outcome,
      tokenId: token.tokenId,
      token,
      shares,
      entryPrice,
      cost,
      entryFee,
      status: 'OPEN',
      openedAt: now,
      windowStart: market.windowStart,
      signal: {
        triggerPrice: entryPrice,
        triggerSource: `FLIP_${this.windowFlipCount}`,
        bid: token.bid,
        ask: token.ask,
        mid: token.mid,
        elapsed: Math.max(0, Math.floor(now / 1000 - market.windowStart)),
      },
    };
    if (token.outcome === 'UP') this.accumUpShares += shares;
    else this.accumDownShares += shares;
    this.windowEntries.push({ ...this.openPosition, signal: { ...this.openPosition.signal } });
    stats.buyCount += 1;
    stats.invested = round2(stats.invested + cost + entryFee);
    this.pushTrade('BUY', this.openPosition, entryPrice, null, `FLIP_${this.windowFlipCount}`);
    this.log(`⚡ GTC FLIP #${this.windowFlipCount} BTC ${token.outcome} ${shares} SH avg:${entryPrice.toFixed(3)} (sweep ${sweep.filled}sh levels:${sweep.levels.length}) TARGET $${TARGET_PROFIT} cost $${cost.toFixed(2)} sunk $${this.windowSunkCost.toFixed(2)}`);
    this.recordEquity();
    return true;
  }

  closePosition(position, exitPrice, reason) {
    if (position.status !== 'OPEN') return null;
    const proceeds = round2(position.shares * exitPrice);
    const exitFee = round2(proceeds * TAKER_FEE_BPS / 10000);
    const pnl = round2(proceeds - exitFee - position.cost - position.entryFee);
    this.bankroll = round2(this.bankroll + proceeds - exitFee);
    this.totalFees = round2(this.totalFees + exitFee);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    position.status = 'CLOSED';
    position.exitPrice = exitPrice;
    position.proceeds = proceeds;
    position.pnl = pnl;
    position.closedAt = Date.now();
    position.closeReason = reason;
    this.openPosition = null;
    const stats = this.getWindowStats(position.windowStart);
    stats.sellCount += 1;
    stats.realizedPnl = round2(stats.realizedPnl + pnl);
    this.pushTrade('SELL', position, exitPrice, pnl, reason);
    this.log(`${reason} BTC ${position.outcome} ${position.shares} SH @${exitPrice.toFixed(3)} PNL ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    this.recordEquity();
    return position;
  }

  pushTrade(action, position, price, pnl, reason) {
    this.trades.push({
      timestamp: action === 'BUY' ? position.openedAt : position.closedAt,
      action,
      outcome: position.outcome,
      shares: position.shares,
      price,
      cost: position.cost,
      pnl,
      reason,
      orderType: 'PAPER-GTC@0.99',
      signal: position.signal,
    });
    this.trades = this.trades.slice(-200);
  }

  settleWindow(market) {
    if (market.settled) return;
    market.settled = true;
    if (market.windowStart === this.currentStart || this.openPosition?.windowStart === market.windowStart) this.tradedThisWindow = false;
    this.monitoringActive = false;
    if (!Number.isFinite(market.finalUpMax) && Number.isFinite(market.up.mid)) market.finalUpMax = market.up.mid;
    if (!Number.isFinite(market.finalDownMax) && Number.isFinite(market.down.mid)) market.finalDownMax = market.down.mid;
    const upStrong = market.finalUpMax > RESOLUTION_PRICE;
    const downStrong = market.finalDownMax > RESOLUTION_PRICE;
    if (upStrong !== downStrong) {
      market.winner = upStrong ? 'UP' : 'DOWN';
      market.resolutionSource = 'CLOB_FINAL_2S';
      const winningShares = market.winner === 'UP' ? this.accumUpShares : this.accumDownShares;
      const payout = round2(winningShares);
      const exitFee = round2(payout * TAKER_FEE_BPS / 10000);
      const net = round2(payout - exitFee - this.windowSunkCost);
      this.bankroll = round2(this.bankroll + payout - exitFee);
      this.totalFees = round2(this.totalFees + exitFee);
      this.realizedPnl = round2(this.realizedPnl + net);
      const position = this.openPosition;
      if (position?.slug === market.slug) {
        position.status = 'CLOSED';
        position.exitPrice = 1;
        position.pnl = net;
        position.proceeds = payout;
        position.closedAt = Date.now();
        position.closeReason = 'WINDOW_RESOLUTION';
        const stats = this.getWindowStats(market.windowStart);
        stats.sellCount += 1;
        stats.realizedPnl = round2(stats.realizedPnl + net);
        this.pushTrade('SELL', position, 1, net, 'WINDOW_RESOLUTION');
        this.log(`SETTLE ${market.winner} WON ${winningShares} SH PAYOUT $${payout.toFixed(2)} SUNK $${this.windowSunkCost.toFixed(2)} NET ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)}`);
      } else {
        this.log(`SETTLE ${market.winner} WON ${winningShares} SH PAYOUT $${payout.toFixed(2)} SUNK $${this.windowSunkCost.toFixed(2)} NET ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)} (no openPosition)`);
      }
      this.openPosition = null;
    } else {
      market.winner = null;
      market.resolutionSource = 'NO_SIDE_ABOVE_090';
      const losingShares = this.accumUpShares + this.accumDownShares;
      const totalLoss = round2(-this.windowSunkCost);
      this.realizedPnl = round2(this.realizedPnl + totalLoss);
      this.log(`SETTLE INDETERMINATE ${losingShares} SH LOST $${this.windowSunkCost.toFixed(2)}`);
      const position = this.openPosition;
      if (position?.slug === market.slug) {
        position.status = 'CLOSED';
        position.exitPrice = 0;
        position.pnl = totalLoss;
        position.closedAt = Date.now();
        position.closeReason = 'INDETERMINATE_WINDOW_END';
        const stats = this.getWindowStats(market.windowStart);
        stats.sellCount += 1;
        this.pushTrade('SELL', position, 0, totalLoss, 'INDETERMINATE_WINDOW_END');
      }
      this.openPosition = null;
    }
    this.finalizeStats(market);
  }

  finalizeStats(market) {
    const stats = this.getWindowStats(market.windowStart);
    if (stats.finalized) return stats;
    const net = stats.realizedPnl;
    stats.finalized = true;
    stats.result = net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'FLAT';
    stats.winner = market.winner;
    stats.resolutionSource = market.resolutionSource;
    stats.settledAt = Date.now();
    if (stats.buyCount > 0) {
      if (net < 0) this.losses += 1;
      else this.wins += 1;
    }
    stats.flipCount = this.windowFlipCount;
    stats.sunkCost = this.windowSunkCost;
    stats.accumUpShares = this.accumUpShares;
    stats.accumDownShares = this.accumDownShares;
    this.results.unshift({ ...stats });
    this.results = this.results.slice(0, 40);
    this.log(`WINDOW ${market.slug} ${stats.result} winner ${market.winner || 'UNKNOWN'} net $${net.toFixed(2)} flips ${this.windowFlipCount} up:${this.accumUpShares} down:${this.accumDownShares}`);
    this.windowSunkCost = 0;
    this.windowFlipCount = 0;
    this.windowEntries = [];
    this.lastFlipKey = null;
    return stats;
  }

  handleRollover(nowMs = Date.now()) {
    const start = windowStartFor(nowMs);
    if (start === this.currentStart) return this.markets.get(slugFor(start));
    const previous = this.markets.get(slugFor(this.currentStart));
    if (previous && !previous.settled) {
      this.settleWindow(previous);
    } else if (this.openPosition?.windowStart === this.currentStart) {
      const rolloverMarket = this.markets.get(slugFor(this.currentStart));
      if (rolloverMarket && !rolloverMarket.settled) {
        this.settleWindow(rolloverMarket);
      } else {
        const mark = Number.isFinite(this.openPosition.token.mid) ? this.openPosition.token.mid : this.openPosition.entryPrice;
        this.closePosition(this.openPosition, mark, 'WINDOW_ROLLOVER');
      }
    }
    this.currentStart = start;
    this.tradedThisWindow = false;
    this.accumUpShares = 0;
    this.accumDownShares = 0;
    this.windowSunkCost = 0;
    this.windowFlipCount = 0;
    this.windowEntries = [];
    this.lastFlipKey = null;
    this.monitoringActive = false;
    this.ensureWindowMarkets();
    this.pruneOldMarkets(start);
    return this.markets.get(slugFor(start)) || null;
  }

  processQuotes(market, quotes, sequence) {
    if (sequence <= this.appliedPollSequence) return;
    this.appliedPollSequence = sequence;
    if (Array.isArray(quotes)) {
      const byToken = new Map(quotes.map(book => [String(book?.asset_id || ''), book]));
      for (const token of [market.up, market.down]) {
        const book = byToken.get(token.tokenId);
        if (book) {
          const bids = (book.bids || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
          const asks = (book.asks || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
          bids.sort((a, b) => b.price - a.price);
          asks.sort((a, b) => a.price - b.price);
          token.bookAsks = asks;
          this.applyQuote(token, bids[0]?.price ?? null, asks[0]?.price ?? null);
        }
      }
    } else {
      for (const token of [market.up, market.down]) {
        const quote = quotes?.[token.tokenId];
        this.applyQuote(token, Number(quote?.BUY), Number(quote?.SELL));
      }
    }
    this.pollCount += 1;
    this.tickCount += 1;
    this.lastPollAt = Date.now();
    this.lastSuccessfulPollAt = Date.now();
    this.lastError = null;
    const nowSeconds = Date.now() / 1000;
    const elapsed = nowSeconds - market.windowStart;
    this.trackFinalPrices(market, elapsed);
    if (nowSeconds >= market.windowEnd) {
      this.settleWindow(market);
    } else if (this.openPosition?.slug === market.slug) {
      this.evaluateFlip(market);
    } else {
      this.evaluateEntry(market);
    }
    this.recordEquity();
    this.onTick(this.buildState());
  }

  async pollOnce() {
    if (this.pollInFlight >= 2) return;
    let market;
    try {
      market = this.handleRollover();
    } catch (error) {
      this.lastError = error.message;
      this.log(`ROLLOVER FAIL ${error.message}`);
      return;
    }
    if (!market || market.settled) return;
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds >= market.windowEnd) {
      this.settleWindow(market);
      return;
    }
    this.pollInFlight += 1;
    this.pollSequence += 1;
    const sequence = this.pollSequence;
    try {
      this.ensureWindowMarkets();
      const books = await this.requestJSON(`${CLOB_REST}/books`, {
        method: 'POST',
        body: JSON.stringify([market.up, market.down].map(token => ({ token_id: token.tokenId }))),
      }, CLOB_TIMEOUT_MS);
      this.processQuotes(market, books, sequence);
    } catch (error) {
      this.lastError = error.message;
      if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt > 5000) {
        this.lastPollErrorAt = Date.now();
        this.log(`CLOB POLL FAIL ${error.message}`);
      }
    } finally {
      this.pollInFlight -= 1;
    }
  }

  publicToken(token) {
    return {
      bid: token.bid, ask: token.ask, mid: token.mid,
      spread: token.spread, updatedAt: token.updatedAt,
    };
  }

  publicMarket(market) {
    const now = Date.now();
    return {
      slug: market.slug,
      title: market.title,
      windowStart: market.windowStart,
      windowEnd: market.windowEnd,
      elapsed: Math.max(0, Math.floor(now / 1000 - market.windowStart)),
      remaining: Math.max(0, market.windowEnd - Math.floor(now / 1000)),
      settled: market.settled,
      winner: market.winner,
      resolutionSource: market.resolutionSource,
      finalUpMax: market.finalUpMax,
      finalDownMax: market.finalDownMax,
      up: this.publicToken(market.up),
      down: this.publicToken(market.down),
    };
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
  }

  buildState() {
    const start = this.currentStart;
    const market = this.markets.get(slugFor(start));
    const position = this.openPosition;
    const floating = position ? this.positionPnl(position) : 0;
    const openValue = position ? round2(position.shares * (position.token.mid ?? position.entryPrice)) : 0;
    const markValue = round2(this.bankroll + openValue);
    const drawdown = round2(this.peakEquity - markValue);
    return {
      version: '7.0.0',
      strategy: `GTC@0.99 · ENTRY ~${ENTRY_PRICE.toFixed(2)} · MAX 2 FLIPS · DOUBLING 20→80 · TARGET $${TARGET_PROFIT} · BOOK SWEEP`,
      serverTime: Date.now(),
      connected: this.isClobFresh(),
      marketReady: Boolean(market),
      discoveryActive: this.discoveryJobs.size,
      lastError: this.lastError,
      pollCount: this.pollCount,
      tickCount: this.tickCount,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      bankroll: this.bankroll,
      markValue,
      openValue,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: floating,
      totalFees: this.totalFees,
      totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins,
      losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      accumUpShares: this.accumUpShares,
      accumDownShares: this.accumDownShares,
      windowFlipCount: this.windowFlipCount,
      windowSunkCost: this.windowSunkCost,
      monitoringActive: this.monitoringActive,
      tradedThisWindow: this.tradedThisWindow,
      position: position ? { ...position, token: undefined, pnl: floating } : null,
      market: market ? this.publicMarket(market) : null,
      results: this.results.slice(0, 20),
      trades: this.trades.slice(-80).reverse(),
      equityCurve: this.equityCurve.slice(-1000),
      logs: this.logs.slice(-160),
      discoveryErrors: this.discoveryErrors,
      config: {
        entryPrice: ENTRY_PRICE,
        priceTolerance: PRICE_TOLERANCE,
        targetProfit: TARGET_PROFIT,
        waitAfterOpen: WAIT_AFTER_OPEN,
        maxWindowInvestment: MAX_WINDOW_INVESTMENT,
        resolutionPrice: RESOLUTION_PRICE,
        pollMs: CLOB_POLL_MS,
        feeBps: TAKER_FEE_BPS,
      },
      peakEquity: this.peakEquity,
      drawdown: drawdown,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  recordEquity() {
    const state = this.buildState();
    if (state.markValue > this.peakEquity) this.peakEquity = state.markValue;
    const last = this.equityCurve.at(-1);
    if (!last || Date.now() - last.t >= 1000 || Math.abs(last.equity - state.markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: state.markValue });
      if (this.equityCurve.length > 1500) this.equityCurve.shift();
    }
  }

  init() {
    this.ensureWindowMarkets();
    this.pollOnce().catch(error => this.log(`INIT FAIL ${error.message}`));
    this.timers = [
      setInterval(() => { this.ensureWindowMarkets(); }, 500),
      setInterval(() => { this.pollOnce().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => this.recordEquity(), 1000),
    ];
    this.log(`BOT STARTED CLOB ONLY ${CLOB_POLL_MS}MS BANKROLL $${START_BANKROLL} TARGET $${TARGET_PROFIT}`);
  }

  close() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

module.exports = {
  BtcBreakoutEngine,
  config: {
    ENTRY_PRICE, PRICE_TOLERANCE, TARGET_PROFIT, WAIT_AFTER_OPEN, MAX_WINDOW_INVESTMENT, RESOLUTION_PRICE, CLOB_POLL_MS,
  },
};
