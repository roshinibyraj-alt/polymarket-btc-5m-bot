'use strict';

const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';
const MARKET_SLUG = process.env.MARKET_SLUG || 'crint-zaf-zwe-2026-08-29';
const SA_INDEX = Number(process.env.SA_INDEX || 0); // index of South Africa outcome in outcomes array
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 1000);
const BUCKET_COUNT = Number(process.env.BUCKET_COUNT || 4);
const SPACING = Number(process.env.SPACING || 0.02);   // distance between adjacent buckets
const PUSH = Number(process.env.PUSH || 0.02);         // below/above live price for entry, above entry for exit
const CLOB_POLL_MS = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_TIMEOUT_MS = Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));
const CLOB_FRESH_MS = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const PYRAMID_STEP = Number(process.env.PYRAMID_STEP || 0.03);   // deploy pyramid on every +STEP up-move of SA price

function round2(value) { return Math.round(value * 100) / 100; }
function round5(value) { return Math.round(value * 100000) / 100000; }

class SportsBucketEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'SportsBuckets';
    this.slug = options.slug || MARKET_SLUG;
    this.startedAt = Date.now();

    this.initialCapital = options.capital ?? TOTAL_CAPITAL;
    this.bucketCount = options.bucketCount ?? BUCKET_COUNT;
    this.spacing = options.spacing ?? SPACING;
    this.push = options.push ?? PUSH;
    const perBucket = round2(this.initialCapital / this.bucketCount);

    // Market discovery state
    this.market = null;          // { slug, title, conditionId, outcome, tokenId }
    this.token = null;           // { tokenId, bid, ask, mid, bookAsks, updatedAt }
    this.discoveryJob = null;
    this.lastDiscoveryAt = null;
    this.lastDiscoveryFailAt = null;
    this.lastError = null;

    // Order book / polling
    this.pollCount = 0;
    this.tickCount = 0;
    this.pollInFlight = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;

    // Buckets
    this.buckets = [];
    for (let i = 0; i < this.bucketCount; i++) {
      this.buckets.push(this.makeBucket(i, perBucket, i * this.spacing));
    }

    // Ledger
    this.trades = [];
    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: this.initialCapital }];
    this.realizedPnl = 0;
    this.totalFees = 0;
    this.roundTrips = 0;
    this.peakEquity = this.initialCapital;
    // Aggressive pyramid (Option 4): scalp profits feed a hold pool that is
    // deployed into SA held shares on every +PYRAMID_STEP up-move, held to $1.00.
    this.pyramid = {
      pool: 0,             // cash awaiting deployment
      lastStep: null,      // last mid price at which we pyramided in (anchor)
      heldShares: 0,
      heldCost: 0,
      heldEntry: null,
      totalDeployed: 0,
      entries: [],
    };
    this.timers = [];
  }

  makeBucket(index, bankroll, depth) {
    return {
      id: index + 1,
      // slot offset below live anchor when placing a buy
      depth,
      bankroll,
      initialBankroll: bankroll,
      state: 'FLAT',            // FLAT | BUY_PLACED | HELD
      restingBuy: null,         // resting BUY limit price (re-anchors upward only)
      order: null,              // { side: 'BUY'|'SELL', price, shares }
      entryPrice: null,         // locked entry when HELD
      shares: 0,
      cost: 0,
      realizedPnl: 0,
      roundTrips: 0,
      lastEvent: null,
    };
  }

  log(message) {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.onLog(line);
  }

  parseJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  async requestJSON(url, options = {}, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'sports-bucket-bot/1.0',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async discoverMarket() {
    if (this.market) return this.market;
    if (this.discoveryJob) return this.discoveryJob;
    this.discoveryJob = (async () => {
      try {
        const rows = await this.requestJSON(
          `${GAMMA_API}/markets?slug=${encodeURIComponent(this.slug)}`, {}, 10000,
        );
        const market = Array.isArray(rows) ? rows[0] : null;
        const outcomes = this.parseJson(market?.outcomes);
        const clobTokenIds = this.parseJson(market?.clobTokenIds);
        if (!market?.conditionId || !Array.isArray(outcomes) || !Array.isArray(clobTokenIds)) {
          throw new Error('market unavailable or not tradable');
        }
        if (market.closed) throw new Error('market is closed');
        const outcome = String(outcomes[SA_INDEX] ?? 'South Africa');
        const tokenId = String(clobTokenIds[SA_INDEX]);
        this.market = {
          slug: this.slug,
          title: market.question || market.title || this.slug,
          conditionId: market.conditionId,
          outcome,
          tokenId,
        };
        this.token = {
          tokenId,
          bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [],
        };
        this.lastDiscoveryAt = Date.now();
        this.log(`MARKET DISCOVERED ${this.market.title} · TRADING ${outcome} (@${tokenId})`);
      } catch (error) {
        this.lastError = error.message;
        if (!this.lastDiscoveryFailAt || Date.now() - this.lastDiscoveryFailAt > 5000) {
          this.lastDiscoveryFailAt = Date.now();
          this.log(`DISCOVERY FAIL ${error.message}`);
        }
        throw error;
      } finally {
        this.discoveryJob = null;
      }
    })();
    return this.discoveryJob;
  }

  applyQuote(bid, ask) {
    const token = this.token;
    if (bid != null && bid > 0) token.bid = bid;
    if (ask != null && ask > 0) token.ask = ask;
    token.mid = (token.bid != null && token.ask != null) ? round5((token.bid + token.ask) / 2) : null;
    token.spread = (token.bid != null && token.ask != null) ? round5(token.ask - token.bid) : null;
    token.updatedAt = Date.now();
  }

  async pollOnce() {
    if (this.pollInFlight >= 2) return;
    if (!this.market) {
      try { await this.discoverMarket(); } catch (_) { /* wait for next tick */ }
      return;
    }
    this.pollInFlight += 1;
    try {
      const books = await this.requestJSON(`${CLOB_REST}/books`, {
        method: 'POST',
        body: JSON.stringify([{ token_id: this.token.tokenId }]),
      }, CLOB_TIMEOUT_MS);
      const book = (Array.isArray(books) ? books : []).find(b => String(b.asset_id) === this.token.tokenId);
      if (book) {
        const bids = (book.bids || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
        const asks = (book.asks || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);
        this.token.bookAsks = asks;
        this.applyQuote(bids[0]?.price ?? null, asks[0]?.price ?? null);
      }
      this.lastSuccessfulPollAt = Date.now();
      this.lastPollAt = Date.now();
      this.lastError = null;
      this.pollCount += 1;
      this.tickCount += 1;
      this.manageBuckets();
      this.recordEquity();
      this.onTick(this.buildState());
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

  // Live anchor derived from the CLOB book (mid). All flat buy orders track this.
  anchor() {
    if (this.token?.mid == null) return null;
    return this.token.mid;
  }

  manageBuckets() {
    const anchor = this.anchor();
    if (anchor == null) return;
    for (const bucket of this.buckets) {
      this.manageBucket(bucket, anchor);
    }
    this.managePyramid();
  }

  // Aggressive pyramid: on every new +PYRAMID_STEP up-move of SA's live mid,
  // deploy the whole accumulated pool (scalp profits) into SA held shares at
  // market. Held shares ride to resolution at $1.00 if South Africa wins.
  managePyramid() {
    const mid = this.token?.mid;
    if (mid == null) return;
    if (this.pyramid.lastStep == null) {
      this.pyramid.lastStep = mid; // anchor the first step to the opening mid
      return;
    }
    if (mid < this.pyramid.lastStep + PYRAMID_STEP) return;
    if (this.pyramid.pool <= 0) return;
    const price = this.token.ask ?? mid;
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return;
    const budget = this.pyramid.pool;
    const shares = Math.floor(budget / price);
    if (shares < 1) return;
    const cost = round2(shares * price);
    this.pyramid.heldShares += shares;
    this.pyramid.heldCost = round2(this.pyramid.heldCost + cost);
    this.pyramid.heldEntry = price;
    this.pyramid.pool = round2(this.pyramid.pool - cost);
    this.pyramid.lastStep = mid;
    this.pyramid.totalDeployed = round2(this.pyramid.totalDeployed + cost);
    this.pyramid.entries.push({ timestamp: Date.now(), price, shares, cost });
    this.trades.unshift({
      timestamp: Date.now(),
      action: 'PYRAMID',
      shares,
      price,
      cost,
      reason: `+${(PYRAMID_STEP * 100).toFixed(0)}c up-step @ ${price.toFixed(2)}`,
    });
    this.log(`🧗 PYRAMID +${(PYRAMID_STEP * 100).toFixed(0)}c step → ${shares} SH @ ${price.toFixed(2)} = $${cost.toFixed(2)} · total ${this.pyramid.heldShares} SH held`);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  manageBucket(bucket, anchor) {
    switch (bucket.state) {
      case 'FLAT':
      case 'BUY_PLACED': {
        // Target BUY level just below live price at this bucket's depth slot.
        const target = round2(anchor - this.push - bucket.depth);
        if (target <= 0.01) return;
        // Re-anchor the resting BUY upward only: keep it resting to catch dips,
        // but raise it toward the market when the price rallies.
        const placed = bucket.restingBuy != null ? bucket.restingBuy : target;
        const buyPrice = Math.max(placed, target);
        bucket.state = 'BUY_PLACED';
        bucket.restingBuy = buyPrice;
        bucket.order = { side: 'BUY', price: buyPrice, shares: null };
        // Fill when CLOB best ask crosses at/below our resting limit.
        if (this.token.ask != null && this.token.ask <= buyPrice) {
          this.fillBuy(bucket);
        }
        break;
      }
      case 'HELD': {
        // Place SELL at entry + push whenever not already placed.
        const sellPrice = round2(bucket.entryPrice + this.push);
        bucket.order = { side: 'SELL', price: sellPrice, shares: bucket.shares };
        if (this.token.bid != null && this.token.bid >= sellPrice) {
          this.fillSell(bucket);
        }
        break;
      }
      default:
        break;
    }
  }

  fillBuy(bucket) {
    const price = bucket.order.price;
    if (price <= 0) return;
    const shares = Math.floor(bucket.bankroll / price);
    if (shares < 1) return;
    bucket.entryPrice = price;
    bucket.shares = shares;
    bucket.cost = round2(shares * price);
    bucket.bankroll = round2(bucket.bankroll - bucket.cost);
    bucket.state = 'HELD';
    bucket.restingBuy = null;
    bucket.order = null;
    bucket.lastEvent = Date.now();
    this.trades.unshift({
      timestamp: Date.now(),
      action: 'BUY',
      bucket: bucket.id,
      shares,
      price,
      cost: bucket.cost,
      reason: `BUCKET ${bucket.id} BUY filled below live`,
    });
    this.log(`BUCKET ${bucket.id} BUY ${shares} SH @ ${price.toFixed(2)} = $${bucket.cost.toFixed(2)}`);
    this.onTick(this.buildState());
  }

  fillSell(bucket) {
    const price = bucket.order.price;
    const shares = bucket.shares;
    const proceeds = round2(shares * price);
    const gross = round2(proceeds - bucket.cost);
    // Aggressive pyramid: restore the bucket's invested capital so it keeps
    // scalping, and sweep the ENTIRE scalp profit into the pyramid hold pool.
    bucket.bankroll = round2(bucket.bankroll + bucket.cost);
    if (gross > 0) this.pyramid.pool = round2(this.pyramid.pool + gross);
    bucket.entryPrice = null;
    bucket.shares = 0;
    bucket.cost = 0;
    bucket.realizedPnl = round2(bucket.realizedPnl + gross);
    bucket.roundTrips += 1;
    bucket.state = 'FLAT';
    bucket.restingBuy = null;
    bucket.order = null;
    bucket.lastEvent = Date.now();
    this.realizedPnl = round2(this.realizedPnl + gross);
    this.roundTrips += 1;
    this.totalFees = 0;
    this.trades.unshift({
      timestamp: Date.now(),
      action: 'SELL',
      bucket: bucket.id,
      shares,
      price,
      proceeds,
      pnl: gross,
      reason: `BUCKET ${bucket.id} SELL filled at target`,
    });
    this.log(`BUCKET ${bucket.id} SELL ${shares} SH @ ${price.toFixed(2)} PnL ${gross >= 0 ? '+' : ''}$${gross.toFixed(2)}`);
    this.onTick(this.buildState());
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
  }

  markValue() {
    let value = 0;
    for (const bucket of this.buckets) {
      if (bucket.state === 'HELD' && bucket.shares > 0 && this.token?.mid != null) {
        value += round2(bucket.shares * this.token.mid);
      } else {
        value += bucket.bankroll;
      }
    }
    if (this.pyramid.heldShares > 0 && this.token?.mid != null) {
      value += round2(this.pyramid.heldShares * this.token.mid);
    }
    value += this.pyramid.pool;
    return round2(value);
  }

  buildState() {
    const anchor = this.anchor();
    const mark = this.markValue();
    const drawdown = round2(this.peakEquity - mark);
    return {
      version: '1.0.0',
      name: this.name,
      strategy: `SPORTS PYRAMID · ${this.market?.title || this.slug} · ${this.bucketCount} BUCKETS x $${round2(this.initialCapital / this.bucketCount)} SCALP ±${this.push.toFixed(2)} → PYRAMID +${(PYRAMID_STEP * 100).toFixed(0)}c STEPS · HOLD SA TO $1`,
      serverTime: Date.now(),
      connected: this.isClobFresh(),
      marketReady: Boolean(this.market),
      discoveryActive: Boolean(this.discoveryJob),
      lastError: this.lastError,
      pollCount: this.pollCount,
      tickCount: this.tickCount,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      market: this.market ? {
        slug: this.market.slug,
        title: this.market.title,
        outcome: this.market.outcome,
        tokenId: this.market.tokenId,
      } : null,
      token: this.token ? {
        bid: this.token.bid, ask: this.token.ask, mid: this.token.mid,
        spread: this.token.spread, updatedAt: this.token.updatedAt,
      } : null,
      anchor,
      initialCapital: this.initialCapital,
      bankroll: round2(this.buckets.reduce((s, b) => s + b.bankroll, 0)),
      markValue: mark,
      realizedPnl: this.realizedPnl,
      totalPnl: round2(mark - this.initialCapital),
      roundTrips: this.roundTrips,
      totalFees: 0,
      pyramid: {
        pool: round2(this.pyramid.pool),
        lastStep: this.pyramid.lastStep,
        heldShares: this.pyramid.heldShares,
        heldCost: round2(this.pyramid.heldCost),
        heldEntry: this.pyramid.heldEntry,
        totalDeployed: round2(this.pyramid.totalDeployed),
        nextStep: this.pyramid.lastStep != null ? round2(this.pyramid.lastStep + PYRAMID_STEP) : null,
        entries: this.pyramid.entries.slice(-20),
      },
      buckets: this.buckets.map(bucket => ({
        id: bucket.id,
        state: bucket.state,
        depth: round2(bucket.depth),
        restingBuy: bucket.restingBuy,
        bankroll: round2(bucket.bankroll),
        initialBankroll: round2(bucket.initialBankroll),
        order: bucket.order ? { ...bucket.order, shares: bucket.order.shares } : null,
        entryPrice: bucket.entryPrice,
        shares: bucket.shares,
        cost: round2(bucket.cost),
        realizedPnl: round2(bucket.realizedPnl),
        roundTrips: bucket.roundTrips,
      })),
      trades: this.trades.slice(-80),
      equityCurve: this.equityCurve.slice(-1000),
      logs: this.logs.slice(-160),
      peakEquity: this.peakEquity,
      drawdown,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      config: {
        slug: this.slug,
        outcome: this.market?.outcome,
        totalCapital: this.initialCapital,
        bucketCount: this.bucketCount,
        bucketCapital: round2(this.initialCapital / this.bucketCount),
        spacing: this.spacing,
        push: this.push,
        pyramidStep: PYRAMID_STEP,
        pollMs: CLOB_POLL_MS,
      },
    };
  }

  recordEquity() {
    const mark = this.markValue();
    if (mark > this.peakEquity) this.peakEquity = mark;
    const last = this.equityCurve.at(-1);
    if (!last || Date.now() - last.t >= 1000 || Math.abs(last.equity - mark) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: mark });
      if (this.equityCurve.length > 1500) this.equityCurve.shift();
    }
  }

  init() {
    this.discoverMarket().catch(() => {});
    this.timers = [
      setInterval(() => { if (!this.market) this.discoverMarket().catch(() => {}); }, 1000),
      setInterval(() => { this.pollOnce().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => this.recordEquity(), 1000),
    ];
    this.log(`BOT STARTED [${this.name}] ${this.bucketCount} BUCKETS x $${round2(this.initialCapital / this.bucketCount)} LIMIT ±${this.push} SPACING ${this.spacing} POLL ${CLOB_POLL_MS}MS`);
  }

  close() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

module.exports = {
  SportsBucketEngine,
  config: {
    MARKET_SLUG, SA_INDEX, TOTAL_CAPITAL, BUCKET_COUNT, SPACING, PUSH, PYRAMID_STEP, CLOB_POLL_MS,
  },
};
