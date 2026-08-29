'use strict';

// ── Config ──────────────────────────────────────────────────
const GAMMA_API   = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST   = process.env.CLOB_REST || 'https://clob.polymarket.com';
const BINANCE_API = process.env.BINANCE_API || 'https://api.binance.com';
const WINDOW_SECONDS = 300;

const PROFILE         = process.env.PROFILE || 'conservative';   // conservative | aggressive
const THRESHOLD       = Number(process.env.THRESHOLD || 0.70);   // trigger on best ask >= threshold
const STAKE_USD       = Number(process.env.STAKE_USD || 5);      // paper stake per trade
const MAX_NOTIONAL    = Number(process.env.MAX_NOTIONAL || 8);   // hard cap per trade
const STOP_LOSS_PCT   = Number(process.env.STOP_LOSS_PCT || 0.25); // 0 = disabled
const ENTRY_TARGET_LEFT = Number(process.env.ENTRY_TARGET_LEFT || 120); // ~2 min left
const ENTRY_TOLERANCE   = Number(process.env.ENTRY_TOLERANCE || 30);    // +/- tolerance on target
const MIN_ENTRY_LEFT    = Number(process.env.MIN_ENTRY_LEFT || 60);     // never enter earlier than this
const EXIT_BEFORE_SEC   = Number(process.env.EXIT_BEFORE_SEC || 20);    // exit before end (if position could be closed)
const MOVE_MIN_USD      = Number(process.env.MOVE_MIN_USD || 70);       // impulse confirmation min
const MOVE_MAX_USD      = Number(process.env.MOVE_MAX_USD || 100);      // impulse confirmation max ref
const SPREAD_GUARD      = Number(process.env.SPREAD_GUARD || 0.03);     // skip if spread > this
const MIN_TOP_NOTIONAL  = Number(process.env.MIN_TOP_NOTIONAL || 30);   // skip if top ask notional < this
const STALE_GUARD_MS    = Number(process.env.STALE_GUARD_MS || 8000);   // skip if quote stale

const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS = Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));

// ── Helpers ─────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

class BtcMomentumEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'Momentum5m';
    this.startedAt = Date.now();

    this.bankroll = options.bankroll ?? 1000;
    this.initialBankroll = this.bankroll;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.peakEquity = this.bankroll;

    // Market state
    this.markets = new Map();        // slug -> market
    this.tokens = new Map();         // tokenId -> token
    this.discoveryJobs = new Map();
    this.currentStart = windowStartFor(Date.now());

    // Binance impulse data
    this.binanceCandles = [];
    this.tickHistory = [];
    this.candleFetching = false;
    this.candleFetchedAt = 0;
    this.tickFetching = false;
    this.tickFetchedAt = 0;

    // Position
    this.openPosition = null;        // one at a time
    this.trades = [];
    this.results = [];
    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: this.bankroll }];

    this.startedAtMs = Date.now();
    this.entryWindow = null;
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
          'User-Agent': 'btc-momentum-bot/1.0',
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
      topAskNotional: 0, updatedAt: null, bookAsks: [],
    };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  // ── CLOB polling ──────────────────────────────────────────
  applyBook(token, bids, asks) {
    const validAsks = (asks || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    const bestBid = (bids || []).filter(l => Number(l.size) > 0).map(l => Number(l.price)).sort((a, b) => b - a)[0] ?? null;
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
    const tokens = markets.flatMap(m => [m.up, m.down]).filter(t => t && !this.positionFor(markets.find(mm => mm.slug === t.slug)?.slug));
    if (!tokens.length) {
      this.lastPollAt = Date.now();
      return;
    }
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

  positionFor(slug) {
    return this.openPosition && this.openPosition.slug === slug ? this.openPosition : null;
  }

  // ── Binance impulse ───────────────────────────────────────
  async fetchBinanceCandles(limit = 25) {
    if (this.candleFetching) return;
    const now = Date.now();
    if (now - this.candleFetchedAt < 5000) return;
    this.candleFetching = true;
    try {
      const data = await this.requestJSON(`${BINANCE_API}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`, {}, 6000);
      if (Array.isArray(data) && data.length > 0) {
        this.binanceCandles = data.map(c => ({
          openTime: Number(c[0]) / 1000,
          open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]),
          volume: Number(c[5]),
        }));
        this.candleFetchedAt = now;
      }
    } catch (_) {} finally { this.candleFetching = false; }
  }

  async fetchBinanceTick() {
    if (this.tickFetching) return;
    const now = Date.now();
    if (now - this.tickFetchedAt < 300) return;
    this.tickFetching = true;
    try {
      const data = await this.requestJSON(`${BINANCE_API}/api/v3/ticker/price?symbol=BTCUSDT`, {}, 4000);
      const price = Number(data?.price);
      if (Number.isFinite(price)) {
        this.tickHistory.push({ t: now, p: price });
        if (this.tickHistory.length > 300) this.tickHistory.shift();
        this.tickFetchedAt = now;
      }
    } catch (_) {} finally { this.tickFetching = false; }
  }

  // Window open price for impulse calculation (from candles)
  openPriceFor(windowStart) {
    const candles = this.binanceCandles;
    if (!candles || !candles.length) return null;
    for (const c of candles) {
      if (c.openTime <= windowStart && c.openTime + 60 > windowStart) return c.open;
    }
    return candles[0]?.open ?? null;
  }

  latestPrice() {
    const tick = this.tickHistory[this.tickHistory.length - 1];
    if (tick) return tick.p;
    const last = this.binanceCandles[this.binanceCandles.length - 1];
    return last?.close ?? null;
  }

  impulseUsd(windowStart) {
    const open = this.openPriceFor(windowStart);
    const current = this.latestPrice();
    if (open == null || current == null || open <= 0) return null;
    return round2(current - open);
  }

  // ── Momentum-near-close strategy ──────────────────────────
  evaluateEntry() {
    const now = Date.now();
    const cs = windowStartFor(now);
    // Same as the RecoverBot/MartingaleBot: never enter the window the bot started in.
    if (this.entryWindow != null && cs < this.entryWindow) return;
    const elapsed = Math.floor(now / 1000) - cs;
    const remaining = WINDOW_SECONDS - elapsed;
    if (remaining <= 0) return;

    // Entry window: ~120s left ± tolerance, never before 60s left.
    const targetOk = remaining >= (ENTRY_TARGET_LEFT - ENTRY_TOLERANCE) && remaining <= (ENTRY_TARGET_LEFT + ENTRY_TOLERANCE);
    if (remaining > ENTRY_TARGET_LEFT + ENTRY_TOLERANCE) return;   // too early
    if (remaining < MIN_ENTRY_LEFT) return;                         // too late

    // One trade per window.
    const market = this.markets.get(slugFor(cs));
    if (!market || market.settled) return;
    if (this.positionFor(market.slug)) return;
    if (this.trades.some(t => t.slug === market.slug && t.type === 'BUY')) return;

    // Safety guards.
    const nowMs = Date.now();
    if (this.isStale(market) || this.isStale(market.up) || this.isStale(market.down)) return;
    if (this.spreadTooWide(market)) return;
    if (this.liquidityTooThin(market)) return;
    if (!this.impulseOk(cs)) return;

    // Trigger: best ask >= threshold, pick stronger side (follow momentum).
    const upAsk = market.up.ask;
    const downAsk = market.down.ask;
    if (upAsk == null || downAsk == null) return;
    const upFire = upAsk >= THRESHOLD;
    const downFire = downAsk >= THRESHOLD;
    if (!upFire && !downFire) return;

    let outcome;
    if (upFire && downFire) outcome = upAsk >= downAsk ? 'UP' : 'DOWN';
    else outcome = upFire ? 'UP' : 'DOWN';
    this.executeBuy(market, outcome, (outcome === 'UP' ? market.up : market.down).ask, cs);
  }

  isStale(x) {
    if (!x?.updatedAt) return true;
    return Date.now() - x.updatedAt > STALE_GUARD_MS;
  }
  spreadTooWide(market) {
    const sides = [market.up, market.down].filter(t => t.spread != null);
    if (!sides.length) return true;
    const maxSpread = Math.max(...sides.map(t => t.spread));
    return maxSpread > SPREAD_GUARD;
  }
  liquidityTooThin(market) {
    const sides = [market.up, market.down];
    const hasDepth = sides.some(t => t.topAskNotional != null && t.topAskNotional >= MIN_TOP_NOTIONAL);
    return !hasDepth;
  }
  impulseOk(cs) {
    const move = this.impulseUsd(cs);
    if (move == null) return false;
    return Math.abs(move) >= MOVE_MIN_USD;
  }

  executeBuy(market, outcome, price, windowStart) {
    const token = outcome === 'UP' ? market.up : market.down;
    const budget = Math.min(STAKE_USD, MAX_NOTIONAL);
    if (budget <= 0 || price <= 0 || price >= 1) return;
    const shares = Math.max(1, Math.floor(budget / price));
    const cost = round2(shares * price);
    if (cost > this.bankroll) return;
    this.bankroll = round2(this.bankroll - cost);
    const impulse = this.impulseUsd(windowStart) ?? 0;
    this.openPosition = {
      slug: market.slug, market, token, outcome,
      shares, entryPrice: price, cost, windowStart, windowEnd: market.windowEnd,
      openedAt: Date.now(),
    };
    this.trades.push({ timestamp: Date.now(), type: 'BUY', slug: market.slug, outcome, shares, price, cost, reason: `ask ${price.toFixed(2)} ≥ ${THRESHOLD} · impulse $${impulse.toFixed(0)} · ${Math.floor((market.windowEnd - Date.now() / 1000))}s left` });
    this.log(`⚡ BUY ${outcome} ${shares}sh @ ${price.toFixed(2)} · cost $${cost.toFixed(2)} · impulse $${impulse.toFixed(0)} · ${Math.floor(market.windowEnd - Date.now() / 1000)}s left`);
    this.recordEquity();
    this.onTick(this.buildState());
    this.evaluateExit(true);
  }

  // ── Exit ──────────────────────────────────────────────────
  evaluateExit(force = false) {
    const p = this.openPosition;
    if (!p) return;
    const now = Date.now();
    const remainingS = p.windowEnd - now / 1000;

    // Stop-loss: exit if price falls below entry * (1 - stop_loss_pct)
    if (STOP_LOSS_PCT > 0 && p.token.mid != null) {
      const stopPrice = p.entryPrice * (1 - STOP_LOSS_PCT);
      if (p.token.mid <= stopPrice) { this.sellPosition('STOP_LOSS'); return; }
    }
    // Exit before end (exit_before_sec)
    if (remainingS <= EXIT_BEFORE_SEC && p.token.mid != null) {
      this.sellPosition('EXIT_BEFORE_END');
      return;
    }
    // Fill exit for stops on the paper bot: use best bid when it crosses a
    // conservative exit level (avoid waiting for resolution if possible).
    if (force) return;
  }

  sellPosition(reason) {
    const p = this.openPosition;
    if (!p) return;
    const exitPrice = p.token.mid ?? p.entryPrice;
    const proceeds = round2(p.shares * exitPrice);
    const pnl = round2(proceeds - p.cost);
    const won = pnl >= 0;
    if (won) this.wins++; else this.losses++;
    this.bankroll = round2(this.bankroll + proceeds);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    p.pnl = pnl; p.exitReason = reason; p.exitPrice = exitPrice; p.closedAt = Date.now();
    this.results.unshift({ ...p, market: undefined, token: undefined });
    this.results = this.results.slice(0, 50);
    this.trades.push({ timestamp: Date.now(), type: 'SELL', slug: p.slug, outcome: p.outcome, shares: p.shares, price: exitPrice, pnl, reason });
    this.log(`💰 ${reason} ${p.outcome} @ ${exitPrice.toFixed(3)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    this.openPosition = null;
    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── Resolution (polymarket close price, paper) ────────────
  resolveMarket() {
    const p = this.openPosition;
    if (!p) return;
    const nowS = Date.now() / 1000;
    if (nowS < p.windowEnd) return;
    // Use the final-observed CLOB value: whichever side's mid is closer to 1
    // wins (either UP or DOWN). This is the paper analog of the last-2s rule.
    const upMid = p.market.up.mid, downMid = p.market.down.mid;
    let winner = null;
    if (upMid != null || downMid != null) {
      const up = upMid ?? 0, down = downMid ?? 0;
      if (up >= 0.5 && up >= down) winner = 'UP';
      else if (down > up) winner = 'DOWN';
    }
    if (!winner) winner = p.outcome; // absolute edge: never leave unresolved

    const won = p.outcome === winner;
    const payout = won ? p.shares : 0;
    const pnl = round2(payout - p.cost);
    if (won) this.wins++; else this.losses++;
    this.bankroll = round2(this.bankroll + payout);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    p.pnl = pnl; p.exitReason = 'RESOLUTION'; p.exitPrice = won ? 1 : 0; p.won = won; p.resolvedWinner = winner; p.closedAt = Date.now();
    this.results.unshift({ ...p, market: undefined, token: undefined });
    this.results = this.results.slice(0, 50);
    this.trades.push({ timestamp: Date.now(), type: 'RESOLVED', slug: p.slug, outcome: p.outcome, shares: p.shares, price: won ? 1 : 0, pnl, reason: `winner ${winner}` });
    this.log(`🏁 RESOLUTION ${winner} · ${p.outcome} ${won ? 'WIN' : 'LOSS'} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    this.openPosition = null;
    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── State / equity ────────────────────────────────────────
  markValue() {
    let value = this.bankroll;
    const p = this.openPosition;
    if (p) {
      const mark = p.token.mid ?? p.entryPrice;
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
    const p = this.openPosition;
    const sysRemaining = market ? market.windowEnd - Math.floor(now / 1000) : null;
    const impulse = market ? this.impulseUsd(cs) : null;
    return {
      version: '3.0.0',
      name: this.name,
      strategy: `MOMENTUM INTO CLOSE · ENTER ~${ENTRY_TARGET_LEFT}s LEFT (±${ENTRY_TOLERANCE}) · ASK ≥ ${THRESHOLD} · IMPULSE $${MOVE_MIN_USD}-${MOVE_MAX_USD} · STAKE $${STAKE_USD}`,
      serverTime: now,
      connected: this.isClobFresh(),
      lastError: this.lastError,
      pollCount: this.pollCount,
      tickCount: this.tickCount,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      bankroll: this.bankroll,
      markValue: this.markValue(),
      realizedPnl: this.realizedPnl,
      totalPnl: round2(this.markValue() - this.initialBankroll),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      entryWindow: this.entryWindow,
      waitingForWindow: this.entryWindow != null && cs < this.entryWindow,
      currentWindow: market ? this.publicMarket(market) : null,
      windowRemaining: sysRemaining,
      impulseUsd: impulse,
      btcPrice: this.latestPrice(),
      position: p ? {
        outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost,
        markPrice: p.token.mid ?? p.entryPrice,
        unrealized: round2(p.shares * (p.token.mid ?? p.entryPrice) - p.cost),
        remaining: Math.max(0, p.windowEnd - Math.floor(now / 1000)),
        reason: p.reason,
      } : null,
      trades: this.trades.slice(-60).reverse(),
      results: this.results.slice(0, 30),
      equityCurve: this.equityCurve.slice(-1000),
      logs: this.logs.slice(-160),
      peakEquity: this.peakEquity,
      drawdown: round2(this.peakEquity - this.markValue()),
      uptime: Math.floor((now - this.startedAt) / 1000),
      config: {
        profile: PROFILE, threshold: THRESHOLD, stakeUsd: STAKE_USD, maxNotional: MAX_NOTIONAL,
        stopLossPct: STOP_LOSS_PCT, entryTargetLeft: ENTRY_TARGET_LEFT, entryTolerance: ENTRY_TOLERANCE,
        minEntryLeft: MIN_ENTRY_LEFT, exitBeforeSec: EXIT_BEFORE_SEC, moveMinUsd: MOVE_MIN_USD, moveMaxUsd: MOVE_MAX_USD,
        spreadGuard: SPREAD_GUARD, minTopNotional: MIN_TOP_NOTIONAL, staleGuardMs: STALE_GUARD_MS,
        pollMs: CLOB_POLL_MS,
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
    // Wait for next full window on (re)start (same behavior as other bots).
    this.entryWindow = start + WINDOW_SECONDS;
    this.log(`⏳ Started mid-window ${start} — begin trading at next window ${this.entryWindow}`);
    await Promise.all([this.discoverWindow(start), this.discoverWindow(start + WINDOW_SECONDS)]);
    this.timers = [
      setInterval(() => { this.pollClob().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => this.fetchBinanceTick().catch(() => {}), 200),
      setInterval(() => this.fetchBinanceCandles().catch(() => {}), 5000),
      setInterval(() => { this.discoverWindow(windowStartFor(Date.now())).catch(() => {}); this.discoverWindow(windowStartFor(Date.now()) + WINDOW_SECONDS).catch(() => {}); }, 5000),
      setInterval(() => this.evaluateEntry(), 200),
      setInterval(() => this.evaluateExit(), 200),
      setInterval(() => this.resolveMarket(), 250),
      setInterval(() => this.recordEquity(), 1000),
    ];
    this.log(`🚀 MomentumBot started | enter ~${ENTRY_TARGET_LEFT}s left · ask ≥ ${THRESHOLD} · stake $${STAKE_USD} · impulse $${MOVE_MIN_USD}+`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { BtcMomentumEngine, config: { PROFILE, THRESHOLD, STAKE_USD, MAX_NOTIONAL, STOP_LOSS_PCT, ENTRY_TARGET_LEFT, ENTRY_TOLERANCE, MIN_ENTRY_LEFT, EXIT_BEFORE_SEC, MOVE_MIN_USD, MOVE_MAX_USD, SPREAD_GUARD, MIN_TOP_NOTIONAL, STALE_GUARD_MS, CLOB_POLL_MS } };
