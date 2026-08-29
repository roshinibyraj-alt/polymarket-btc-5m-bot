'use strict';

// ── Config (env-overridable) ───────────────────────────────
const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';

const WINDOW_SECONDS = 300;                     // BTC 5m windows

const ENTRY_PRICE = Number(process.env.ENTRY_PRICE || 0.40);
const TP_PRICE    = Number(process.env.TP_PRICE    || 0.60);
const SL_PRICE    = Number(process.env.SL_PRICE    || 0.25);
const SHARES      = Number(process.env.SHARES      || 100);

const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));

// ── Helpers ────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

class LimitHedgeEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'LimitHedge5m';
    this.startedAt = Date.now();

    this.bankroll = options.bankroll ?? 1000;
    this.initialBankroll = this.bankroll;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.peakEquity = this.bankroll;

    this.markets = new Map();          // slug -> market record
    this.tokens = new Map();           // tokenId -> token
    this.discoveryJobs = new Map();
    this.currentStart = windowStartFor(Date.now());

    // Per-window trading state
    this.windowOrdersPlacedFor = null; // windowStart for which entry limits are out
    this.entryOrders = [];             // {outcome, price, status, placedAt}
    this.tpOrders = [];                // {outcome, price, status, placedAt}
    this.positions = [];               // open positions (both sides possible)
    this.results = [];
    this.trades = [];
    this.windowPaused = false;
    this.pauseReason = null;

    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: this.bankroll }];

    this.entryWindow = null;           // first tradeable window (wait for next on restart)
    this.pollInFlight = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;
    this.lastError = null;
    this.pollCount = 0;
    this.tickCount = 0;
    this.timers = [];
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
          'User-Agent': 'limit-hedge-bot/1.0',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Discovery ─────────────────────────────────────────────
  discoverWindow(start) {
    const slug = slugFor(start);
    if (this.markets.has(slug)) return Promise.resolve(this.markets.get(slug));
    if (this.discoveryJobs.has(slug)) return this.discoveryJobs.get(slug);
    const job = (async () => {
      try {
        const rows = await this.requestJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, {}, 8000);
        const market = Array.isArray(rows) ? rows[0] : null;
        if (!market?.conditionId || market.closed) throw new Error('market unavailable or closed');
        const outcomes = this.parseJson(market.outcomes) || [];
        const tokenIds = this.parseJson(market.clobTokenIds) || [];
        const ui = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
        const di = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
        if (ui < 0 || di < 0 || !tokenIds[ui] || !tokenIds[di]) throw new Error('missing up/down tokens');
        const rec = {
          slug, title: market.question || slug,
          conditionId: market.conditionId,
          windowStart: start, windowEnd: start + WINDOW_SECONDS,
          settled: false, winner: null,
          up: this.makeToken(String(tokenIds[ui]), slug, 'UP'),
          down: this.makeToken(String(tokenIds[di]), slug, 'DOWN'),
        };
        this.markets.set(slug, rec);
        this.log(`🎯 MARKET ${slug} · ${rec.title}`);
        return rec;
      } catch (error) {
        this.lastError = error.message;
        if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt > 5000) {
          this.lastPollErrorAt = Date.now();
          this.log(`DISCOVERY FAIL ${slug}: ${error.message}`);
        }
        return null;
      } finally {
        this.discoveryJobs.delete(slug);
      }
    })();
    this.discoveryJobs.set(slug, job);
    return job;
  }

  makeToken(tokenId, slug, outcome) {
    const token = {
      tokenId: String(tokenId), slug, outcome,
      bid: null, ask: null, mid: null, spread: null,
      topAskNotional: 0, updatedAt: null, bookAsks: [], bookBids: [],
    };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  // ── CLOB polling ──────────────────────────────────────────
  applyBook(token, bids, asks) {
    const validBids = (bids || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validBids.sort((a, b) => b.price - a.price);
    const validAsks = (asks || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookBids = validBids;
    token.bookAsks = validAsks;
    const bestBid = validBids[0]?.price ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    const topAskNotional = validAsks[0] ? round2(validAsks[0].price * validAsks[0].size) : 0;
    const cleanBid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    const cleanAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    token.bid = cleanBid; token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.topAskNotional = topAskNotional;
    token.updatedAt = Date.now();
  }

  async pollClob() {
    if (this.pollInFlight >= 2) return;
    const now = Date.now();
    const cs = windowStartFor(now);
    const markets = [this.markets.get(slugFor(cs)), this.markets.get(slugFor(cs + WINDOW_SECONDS))].filter(Boolean);
    const tokens = markets.flatMap(m => [m.up, m.down]);
    if (!tokens.length) { this.lastPollAt = Date.now(); return; }
    this.pollInFlight += 1;
    try {
      const books = await this.requestJSON(`${CLOB_REST}/books`, {
        method: 'POST',
        body: JSON.stringify(tokens.map(t => ({ token_id: t.tokenId }))),
      }, CLOB_TIMEOUT_MS);
      const byToken = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id || ''), b]));
      for (const t of tokens) {
        const b = byToken.get(t.tokenId);
        if (b) this.applyBook(t, b.bids || [], b.asks || []);
      }
      this.lastSuccessfulPollAt = Date.now();
      this.lastPollAt = Date.now();
      this.lastError = null;
      this.pollCount += 1;
      this.tickCount += 1;
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

  // ── Strategy ──────────────────────────────────────────────
  ensureWindowOrders(market) {
    const now = Date.now();
    if (this.windowOrdersPlacedFor === market.windowStart) return;
    this.windowOrdersPlacedFor = market.windowStart;
    this.windowPaused = false;
    this.pauseReason = null;
    this.entryOrders = [];
    this.tpOrders = [];

    if (this.entryWindow != null && market.windowStart < this.entryWindow) {
      this.log(`⏳ Window ${market.windowStart} skipped (entryWindow ${this.entryWindow})`);
      return;
    }

    this.entryOrders.push({ outcome: 'UP',   price: ENTRY_PRICE, status: 'RESTING', placedAt: now });
    this.entryOrders.push({ outcome: 'DOWN', price: ENTRY_PRICE, status: 'RESTING', placedAt: now });
    this.log(`📌 WINDOW ${market.slug.slice(-10)} — LIMIT BUY UP+DOWN @ ${ENTRY_PRICE.toFixed(2)} × ${SHARES}sh each`);
    this.onTick(this.buildState());
  }

  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));

    // Resolve any open position whose own window has ended (handles rollover).
    // NOTE: windowStart/windowEnd are stored in SECONDS (from windowStartFor).
    this.resolveExpired(market, nowS);

    if (!market) return;
    this.ensureWindowOrders(market);
    if (this.windowOrdersPlacedFor !== market.windowStart) return; // waiting for next window

    // Fill resting limit buys at 0.40 (natural fills, both sides independent)
    if (!this.windowPaused) this.fillEntryOrders(market);

    // TP limit sells: first-filled side gets a resting sell @ 0.60
    if (!this.windowPaused) this.fillTpOrders(market);

    // Stop-loss (market order): any open position mark <= SL → sell + pause window
    if (this.checkStopLosses(market)) this.pauseWindow(market);

    this.recordEquity();
    this.onTick(this.buildState());
  }

  sellPosition(position, price, reason, extra = {}) {
    const proceeds = round2(position.shares * price);
    const pnl = round2(proceeds - position.cost);
    if (pnl >= 0) this.wins++; else this.losses++;
    this.bankroll = round2(this.bankroll + proceeds);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    position.pnl = pnl;
    position.exitPrice = price;
    position.exitReason = reason;
    position.closedAt = Date.now();
    position.won = extra.won != null ? extra.won : pnl > 0;
    this.results.unshift({ ...position, market: undefined, token: undefined });
    this.results = this.results.slice(0, 50);
    this.trades.push({ timestamp: Date.now(), type: 'SELL', slug: position.slug, outcome: position.outcome, shares: position.shares, price, pnl, reason, ...extra });
    this.log(`💰 ${reason} ${position.outcome} @ ${price.toFixed(3)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · ${position.shares}sh`);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  fillEntryOrders(market) {
    for (const order of this.entryOrders) {
      if (order.status !== 'RESTING') continue;
      const token = order.outcome === 'UP' ? market.up : market.down;
      if (token.ask == null) continue;
      if (token.ask <= ENTRY_PRICE) {
        const cost = round2(SHARES * ENTRY_PRICE);
        if (cost > this.bankroll) { order.status = 'SKIPPED'; this.log(`⚠️  skip ${order.outcome} — bankroll $${this.bankroll} < cost $${cost}`); continue; }
        const isFirstFill = !this.positions.some(p => p.hasTp);
        order.status = 'FILLED';
        order.filledAt = Date.now();
        this.bankroll = round2(this.bankroll - cost);
        const position = {
          slug: market.slug, outcome: order.outcome, market,
          shares: SHARES, entryPrice: ENTRY_PRICE, cost,
          openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null, hasTp: isFirstFill,
        };
        this.positions.push(position);
        this.trades.push({ timestamp: Date.now(), type: 'BUY', slug: market.slug, outcome: order.outcome, shares: SHARES, price: ENTRY_PRICE, cost, reason: `LIMIT FILL ask ${token.ask.toFixed(2)} ≤ 0.40` });
        this.log(`✅ BUY ${order.outcome} ${SHARES}sh @ ${ENTRY_PRICE.toFixed(2)} · cost $${cost.toFixed(2)} · ask was ${token.ask.toFixed(2)}`);

        // First filled side → immediately place TP limit sell @ 0.60
        if (isFirstFill) {
          this.tpOrders.push({ outcome: order.outcome, price: TP_PRICE, status: 'RESTING', placedAt: Date.now() });
          this.log(`🎯 TP LIMIT SELL ${order.outcome} @ ${TP_PRICE.toFixed(2)} placed (${SHARES}sh)`);
        }
      }
    }
  }

  fillTpOrders(market) {
    for (const order of this.tpOrders) {
      if (order.status !== 'RESTING') continue;
      const token = order.outcome === 'UP' ? market.up : market.down;
      if (token.bid == null) continue;
      if (token.bid >= TP_PRICE) {
        const pos = this.positions.find(p => p.outcome === order.outcome && p.exitReason == null);

        order.status = 'FILLED';
        order.filledAt = Date.now();
        this.log(`🎯 TP HIT ${order.outcome} — LIMIT SELL @ ${TP_PRICE.toFixed(2)} (bid ${token.bid.toFixed(2)})`);
        this.sellPosition(pos, TP_PRICE, 'TP', {});
      }
    }
  }

  checkStopLosses(market) {
    let hit = false;
    for (const pos of this.positions) {
      if (pos.exitReason != null) continue;
      const token = pos.outcome === 'UP' ? market.up : market.down;
      if (token.mid == null) continue;
      pos.markPrice = token.mid;
      if (token.mid <= SL_PRICE) {
        this.log(`🛑 SL ${pos.outcome} — mid ${token.mid.toFixed(3)} ≤ ${SL_PRICE.toFixed(2)}`);
        this.sellPosition(pos, token.mid, 'SL', {});
        hit = true;
        break; // one SL → pause window
      }
    }
    return hit;
  }

  pauseWindow(market) {
    this.windowPaused = true;
    this.pauseReason = `SL ${SL_PRICE.toFixed(2)} hit — window paused`;
    for (const o of this.entryOrders) if (o.status === 'RESTING') o.status = 'CANCELLED';
    for (const o of this.tpOrders) if (o.status === 'RESTING') o.status = 'CANCELLED';
    this.log('🛑 SL hit — window PAUSED · pending orders cancelled · held side stays to resolution');
  }

  resolveExpired(market, nowS) {
    const open = this.positions.filter(p => p.exitReason == null);
    for (const pos of open) {
      if (nowS < pos.market.windowEnd) continue;
      const m = pos.market;
      const upMid = m.up.mid, downMid = m.down.mid;
      let winner = null;
      if (upMid != null && downMid != null) winner = upMid >= downMid ? 'UP' : 'DOWN';
      else if (upMid != null) winner = upMid >= 0.5 ? 'UP' : 'DOWN';
      else if (downMid != null) winner = downMid >= 0.5 ? 'DOWN' : 'UP';
      if (!winner) winner = 'UP';
      const won = pos.outcome === winner;
      const payout = won ? pos.shares : 0;
      const exitPrice = won ? 1 : 0;
      this.sellPosition(pos, exitPrice, 'RESOLUTION', { winner, won });
      this.log(`🏁 WINDOW ${m.slug.slice(-10)} RESOLVED → ${winner} · ${pos.outcome} ${won ? 'WIN' : 'LOSS'} · payout $${payout.toFixed(2)}`);
    }
  }

  // ── State / equity ────────────────────────────────────────
  markValue() {
    let value = this.bankroll;
    const cs = windowStartFor(Date.now());
    const market = this.markets.get(slugFor(cs));
    for (const p of this.positions) {
      if (p.exitReason != null) continue;
      const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
      const mark = token?.mid ?? p.entryPrice;
      value += round2(p.shares * mark);
    }
    return round2(value);
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
  }

  publicMarket(market) {
    const now = Date.now();
    const remaining = market.windowEnd - Math.floor(now / 1000);
    return {
      slug: market.slug, title: market.title,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      remaining: Math.max(0, remaining),
      elapsed: Math.max(0, Math.floor(now / 1000 - market.windowStart)),
      settled: market.settled, winner: market.winner,
      up: { bid: market.up.bid, ask: market.up.ask, mid: market.up.mid, spread: market.up.spread, topAskNotional: market.up.topAskNotional, updatedAt: market.up.updatedAt },
      down: { bid: market.down.bid, ask: market.down.ask, mid: market.down.mid, spread: market.down.spread, topAskNotional: market.down.topAskNotional, updatedAt: market.down.updatedAt },
    };
  }

  buildState() {
    const cs = windowStartFor(Date.now());
    const now = Date.now();
    const market = this.markets.get(slugFor(cs));
    const open = this.positions.filter(p => p.exitReason == null);
    const openUnrealized = open.reduce((s, p) => {
      const token = p.outcome === 'UP' ? market?.up : market?.down;
      const mark = token?.mid ?? p.entryPrice;
      return s + round2(p.shares * mark - p.cost);
    }, 0);
    return {
      version: '3.0.0',
      name: this.name,
      strategy: `LIMIT HEDGE · BUY BOTH SIDES @ 0.40 (${SHARES}sh) · TP 0.60 LIMIT SELL · SL 0.25 MARKET · MAX 2 BETS`,
      serverTime: now,
      connected: this.isClobFresh(),
      lastError: this.lastError,
      pollCount: this.pollCount,
      tickCount: this.tickCount,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      bankroll: this.bankroll,
      markValue: this.markValue(),
      realizedPnl: this.realizedPnl,
      unrealizedPnl: round2(openUnrealized),
      totalPnl: round2(this.markValue() - this.initialBankroll),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      entryWindow: this.entryWindow,
      waitingForWindow: this.entryWindow != null && cs < this.entryWindow,
      windowPaused: this.windowPaused,
      pauseReason: this.pauseReason,
      currentWindow: market ? this.publicMarket(market) : null,
      windowRemaining: market ? Math.max(0, market.windowEnd - Math.floor(now / 1000)) : null,
      entryOrders: this.entryOrders.map(o => ({ ...o })),
      tpOrders: this.tpOrders.map(o => ({ ...o })),
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? market?.up : market?.down;
        const mark = token?.mid ?? p.entryPrice;
        return {
          outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost,
          markPrice: mark, unrealized: round2(p.shares * mark - p.cost),
          remaining: market ? Math.max(0, market.windowEnd - Math.floor(now / 1000)) : null,
          hasTp: p.hasTp,
        };
      }),
      tradeCount: this.trades.length,
      trades: this.trades.slice(-60).reverse(),
      results: this.results.slice(0, 30),
      equityCurve: this.equityCurve.slice(-1000),
      logs: this.logs.slice(-160),
      peakEquity: this.peakEquity,
      drawdown: round2(this.peakEquity - this.markValue()),
      uptime: Math.floor((now - this.startedAt) / 1000),
      config: {
        entryPrice: ENTRY_PRICE, tpPrice: TP_PRICE, slPrice: SL_PRICE, shares: SHARES,
        pollMs: CLOB_POLL_MS, bankroll: this.initialBankroll,
      },
    };
  }

  recordEquity() {
    const mark = this.markValue();
    if (mark > this.peakEquity) this.peakEquity = mark;
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - mark) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: mark });
      if (this.equityCurve.length > 1500) this.equityCurve.shift();
    }
  }

  // ── Main loop ─────────────────────────────────────────────
  async init() {
    const start = windowStartFor(Date.now());
    this.entryWindow = start + WINDOW_SECONDS; // wait for next full window
    this.log(`⏳ Started mid-window ${start} — trading begins at next window ${this.entryWindow}`);
    await Promise.all([this.discoverWindow(start), this.discoverWindow(start + WINDOW_SECONDS)]);
    this.timers = [
      setInterval(() => { this.pollClob().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => { this.discoverWindow(windowStartFor(Date.now())).catch(() => {}); this.discoverWindow(windowStartFor(Date.now()) + WINDOW_SECONDS).catch(() => {}); }, 5000),
      setInterval(() => this.evaluate(), 200),
      setInterval(() => this.recordEquity(), 1000),
    ];
    this.log(`🚀 LimitHedge started | BUY UP+DOWN @ ${ENTRY_PRICE} × ${SHARES}sh · TP ${TP_PRICE} limit · SL ${SL_PRICE} market`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { LimitHedgeEngine, config: { ENTRY_PRICE, TP_PRICE, SL_PRICE, SHARES, CLOB_POLL_MS } };
