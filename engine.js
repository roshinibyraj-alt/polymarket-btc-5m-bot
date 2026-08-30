'use strict';

// ── Config (env-overridable) ───────────────────────────────
const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';

const WINDOW_SECONDS = 300;                     // BTC 5m windows

const TRADE_PRICE   = Number(process.env.TRADE_PRICE   || 0.55); // fire when side ask ticks to this
const SLIP_TOL      = Number(process.env.SLIP_TOL      || 0.05); // accept entry slippage up to TRADE_PRICE + this
const BASE_PCT      = Number(process.env.BASE_PCT      || 0.01); // base = this fraction of bankroll
const MARTINGALE_X  = Number(process.env.MARTINGALE_X  || 2);    // each flip = prev shares * this
const START_BANKROLL= Number(process.env.START_BANKROLL|| 1000); // demo capital

const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));

// ── Helpers ────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

class FlipBotEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'FlipBot5m';
    this.startedAt = Date.now();

    this.bankroll = options.bankroll ?? START_BANKROLL;
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
    this.windowStartFor = null;           // windowStart currently being traded
    this.positionSeq = 0;                 // flip count within current window (1-based)
    this.baseShares = Math.max(1, Math.round(this.bankroll * BASE_PCT / TRADE_PRICE)); // 1% of capital in shares at 0.55
    this.nextShares = this.baseShares;    // shares for the next flip
    this.latestSide = null;               // 'UP' or 'DOWN' of the most recent fill
    this.firedThisWindow = 0;             // number of flips fired this window
    this.positions = [];                  // all accumulated BUY positions (hold to resolution)
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
          'User-Agent': 'flip-bot/1.0',
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
      prevAsk: null,
    };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  // ── CLOB polling ──────────────────────────────────────────
  applyBook(token, bids, asks) {
    token.prevAsk = token.ask; // snapshot for tick-crossing detection
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
  // Flip bot: whichever side's ask ticks to TRADE_PRICE (0.55) fires immediately.
  // Alternates UP -> DOWN -> UP -> ... with unlimited flips, each 2x the previous
  // shares. First flip of a window = base = 1% of capital. All shares are held to
  // resolution. New window recalculates base from updated capital.

  computeBaseForNextWindow() {
    this.baseShares = Math.max(1, Math.round(this.bankroll * BASE_PCT / TRADE_PRICE));
  }

  prepareWindow(market) {
    // Called once per new window to reset per-window flip state.
    this.windowStartFor = market.windowStart;
    this.positionSeq = 0;
    this.firedThisWindow = 0;
    this.latestSide = null;
    this.windowPaused = false;
    this.pauseReason = null;
    this.computeBaseForNextWindow();
    this.nextShares = this.baseShares;
    this.log(`🆕 WINDOW ${market.slug.slice(-10)} — BASE ${this.baseShares} SH ≈1% of $${this.bankroll.toFixed(2)} @ ${TRADE_PRICE.toFixed(2)} · flip ×${MARTINGALE_X}`);
    this.onTick(this.buildState());
  }

  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));

    // Resolve any open position whose own window has ended (handles rollover).
    this.resolveExpired(market, nowS);

    if (!market) return;
    if (this.entryWindow != null && market.windowStart < this.entryWindow) {
      // Started mid-window on (re)start: skip until next full window.
      return;
    }

    // New window → reset flip state (only when the window rolled over).
    if (this.windowStartFor !== market.windowStart) this.prepareWindow(market);

    // Fire on the side whose ask ticks to TRADE_PRICE, alternating.
    if (!this.windowPaused) this.fireFlips(market);

    this.recordEquity();
    this.onTick(this.buildState());
  }

  fireFlips(market) {
    // A side "ticks 0.55" when its ask crosses UP through TRADE_PRICE (the side
    // is becoming favored). Fire immediately on that tick, accepting slippage up
    // to TRADE_PRICE + SLIP_TOL. Alternating: after UP fires, only DOWN can fire,
    // and only when DOWN itself ticks up to 0.55. Unlimited flips per window.
    let guard = 0;
    while (guard++ < 40) {
      const allowUp   = this.latestSide !== 'UP';   // UP can fire unless UP just fired
      const allowDown = this.latestSide !== 'DOWN'; // DOWN can fire unless DOWN just fired
      const upCross = allowUp   && this.crossedUp(market.up);
      const downCross = allowDown && this.crossedUp(market.down);
      let side = null;
      if (upCross && downCross) {
        // Degenerate/stale book with both sides at the level: prefer the one
        // closest to TRADE_PRICE (the fresher tick), tie → UP.
        const upDist = Math.abs((market.up.ask ?? 1) - TRADE_PRICE);
        const dnDist = Math.abs((market.down.ask ?? 1) - TRADE_PRICE);
        side = upDist <= dnDist ? 'UP' : 'DOWN';
      } else if (upCross) side = 'UP';
      else if (downCross) side = 'DOWN';
      if (!side) break;

      const token = side === 'UP' ? market.up : market.down;
      const shares = this.nextShares;
      const cost = round2(shares * TRADE_PRICE);
      if (cost > this.bankroll) {
        this.log(`⚠️  SKIP ${side} FLIP #${this.positionSeq + 1} — bankroll $${this.bankroll.toFixed(2)} < cost $${cost.toFixed(2)}`);
        break;
      }
      this.executeFlip(market, side, shares, token.ask);
      if (this.bankroll < TRADE_PRICE) break; // out of funds for another flip
    }
  }

  crossedUp(token) {
    // True when the side's ask has just risen to the TRADE_PRICE level
    // (observed tick: previous ask below the level, current ask at/above it).
    const ask = token.ask;
    if (ask == null || token.prevAsk == null) return false; // need a real tick
    const cap = TRADE_PRICE + SLIP_TOL;
    return token.prevAsk < TRADE_PRICE && ask >= TRADE_PRICE && ask <= cap;
  }

  executeFlip(market, outcome, shares, fillAsk) {
    // Fire immediately at TRADE_PRICE (accept any slippage the book shows).
    const price = TRADE_PRICE;
    const cost = round2(shares * price);
    this.bankroll = round2(this.bankroll - cost);
    this.positionSeq += 1;
    this.firedThisWindow += 1;
    this.latestSide = outcome;
    const position = {
      slug: market.slug, outcome, market,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      shares, entryPrice: price, cost,
      openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null,
      flipNo: this.positionSeq,
    };
    this.positions.push(position);
    this.trades.push({ timestamp: Date.now(), type: 'BUY', slug: market.slug, outcome, shares, price, cost, reason: `FLIP #${this.positionSeq} ask ${fillAsk.toFixed(2)}` });
    this.log(`⚡ FLIP #${this.positionSeq} ${outcome} ${shares}sh @ ${price.toFixed(2)} · cost $${cost.toFixed(2)} · ask ${fillAsk.toFixed(2)} · latest ${outcome}`);
    // Next flip = 2x previous shares.
    this.nextShares = Math.round(shares * MARTINGALE_X);
    this.onTick(this.buildState());
  }

  sellPosition(position, price, reason, extra = {}) {
    if (position.exitReason != null) return;
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
    this.log(`💰 RESOLUTION ${position.outcome} @ ${price.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · ${position.shares}sh · flip #${position.flipNo}`);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  resolveExpired(market, nowS) {
    const open = this.positions.filter(p => p.exitReason == null);
    const buckets = new Map(); // windowStart -> positions
    for (const pos of open) {
      if (nowS < pos.windowEnd) continue;
      const w = pos.windowEnd;
      if (!buckets.has(w)) buckets.set(w, []);
      buckets.get(w).push(pos);
    }
    for (const [windowEnd, group] of buckets) {
      const m = group[0].market;
      const upMid = m.up.mid, downMid = m.down.mid;
      let winner = null;
      if (upMid != null && downMid != null) winner = upMid >= downMid ? 'UP' : 'DOWN';
      else if (upMid != null) winner = upMid >= 0.5 ? 'UP' : 'DOWN';
      else if (downMid != null) winner = downMid >= 0.5 ? 'DOWN' : 'UP';
      if (!winner) winner = 'UP';
      let winPayout = 0, lossCost = 0;
      for (const pos of group) {
        const won = pos.outcome === winner;
        const payout = won ? pos.shares : 0;
        const exitPrice = won ? 1 : 0;
        this.sellPosition(pos, exitPrice, 'RESOLUTION', { winner, won });
        if (won) winPayout += payout; else lossCost += pos.cost;
      }
      this.log(`🏁 WINDOW ${m.slug.slice(-10)} RESOLVED → ${winner} · win payout $${winPayout.toFixed(2)} · loss cost $${lossCost.toFixed(2)}`);
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
      const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
      const mark = token?.mid ?? p.entryPrice;
      return s + round2(p.shares * mark - p.cost);
    }, 0);
    return {
      version: '3.0.0',
      name: this.name,
      strategy: `FLIP BOT · FIRE @ ${TRADE_PRICE.toFixed(2)} (UP↔DOWN) · BASE=${BASE_PCT*100}% · ×${MARTINGALE_X} per flip · HOLD TO RESOLUTION`,
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
      baseShares: this.baseShares,
      nextShares: this.nextShares,
      latestSide: this.latestSide,
      flips: this.firedThisWindow,
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
        const mark = token?.mid ?? p.entryPrice;
        return {
          outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost,
          markPrice: mark, unrealized: round2(p.shares * mark - p.cost),
          remaining: p.windowEnd ? Math.max(0, p.windowEnd - Math.floor(now / 1000)) : null,
          flipNo: p.flipNo,
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
        tradePrice: TRADE_PRICE, basePct: BASE_PCT, martingaleX: MARTINGALE_X, slippageCap: SLIP_TOL,
        baseShares: this.baseShares, nextShares: this.nextShares, latestSide: this.latestSide, flips: this.firedThisWindow,
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
    this.log(`🚀 FlipBot started | FIRE @ ${TRADE_PRICE} alternating UP↔DOWN · base ${BASE_PCT*100}% of capital · each flip ×${MARTINGALE_X} · hold to resolution`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { FlipBotEngine, config: { TRADE_PRICE, BASE_PCT, MARTINGALE_X, START_BANKROLL, CLOB_POLL_MS } };
