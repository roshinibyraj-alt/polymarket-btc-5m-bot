'use strict';

// ── Config ────────────────────────────────────────────────
const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';

const WINDOW_SECONDS = 300;
const WAIT_SECONDS   = Number(process.env.WAIT_SECONDS   || 30);
const CHEAP_THRESHOLD= Number(process.env.CHEAP_THRESHOLD|| 0.20);  // buy underdog if ask ≤ this
const TP_PRICE       = Number(process.env.TP_PRICE       || 0.50);  // limit sell at this price
const BASE_PCT       = Number(process.env.BASE_PCT       || 0.10);  // 10% of capital
const START_BANKROLL = Number(process.env.START_BANKROLL  || 300);
const SLIP_CEILING   = Number(process.env.SLIP_CEILING   || 0.99);
const TAKER_FEE_RATE = Number(process.env.TAKER_FEE_RATE || 0.07);
const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));

function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function takerFee(C, p, rate = TAKER_FEE_RATE) { return round5(C * rate * p * (1 - p)); }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

class CheapHunterEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'CheapHunter';
    this.startedAt = Date.now();
    this.bankroll = options.bankroll ?? START_BANKROLL;
    this.initialBankroll = this.bankroll;
    this.realizedPnl = 0;
    this.totalFeesPaid = 0;
    this.wins = 0;
    this.losses = 0;
    this.peakEquity = this.bankroll;
    this.maxDrawdown = 0;
    this.maxSharesEver = 0;
    this.markets = new Map();
    this.tokens = new Map();
    this.discoveryJobs = new Map();
    this.currentStart = windowStartFor(Date.now());
    this.windowStartFor = null;
    this.openEntry = null;
    this.positionSeq = 0;
    this.baseShares = 0;
    this.entryWindow = null;
    this.pollInFlight = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;
    this.lastError = null;
    this.pollCount = 0;
    this.tickCount = 0;
    this.timers = [];
    this.positions = [];
    this.trades = [];
    this.results = [];
    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: this.bankroll }];
    this.windowTraded = false;
  }

  log(message) {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.onLog(line);
  }

  // ── Market Discovery ────────────────────────────────────
  async discoverWindow(windowStart) {
    const slug = slugFor(windowStart);
    if (this.markets.has(slug)) return this.markets.get(slug);
    const key = slug;
    if (this.discoveryJobs.has(key)) return this.discoveryJobs.get(key);
    const job = this._doDiscover(windowStart, slug);
    this.discoveryJobs.set(key, job);
    try { return await job; } finally { this.discoveryJobs.delete(key); }
  }

  async _doDiscover(windowStart, slug) {
    try {
      const url = `${GAMMA_API}/events?slug=${slug}`;
      const resp = await this.fetchImpl(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const events = await resp.json();
      if (!events || !events.length) return null;
      const event = events[0];
      const mkt = event.markets?.[0];
      if (!mkt) return null;
      const tokens = mkt.tokens || [];
      const upTok = tokens.find(t => t.outcome === 'Yes' || t.token_id === mkt.clobTokenIds?.[0]);
      const dnTok = tokens.find(t => t.outcome === 'No' || t.token_id === mkt.clobTokenIds?.[1]);
      if (!upTok || !dnTok) return null;
      const windowEnd = windowStart + WINDOW_SECONDS;
      const market = {
        slug, windowStart, windowEnd, eventId: event.id, marketId: mkt.id,
        up: { tokenId: upTok.token_id, outcome: 'UP', ask: null, bid: null, mid: null, lastFireTick: null },
        down: { tokenId: dnTok.token_id, outcome: 'DOWN', ask: null, bid: null, mid: null, lastFireTick: null },
      };
      this.markets.set(slug, market);
      this.tokens.set(upTok.token_id, market.up);
      this.tokens.set(dnTok.token_id, market.down);
      this.log(`🎯 MARKET ${slug} · ${mkt.question || slug}`);
      return market;
    } catch (e) {
      this.log(`⚠️ DISCOVER FAIL ${slug}: ${e.message}`);
      return null;
    }
  }

  // ── CLOB Polling ────────────────────────────────────────
  async pollClob() {
    if (this.pollInFlight > 0) return;
    this.pollInFlight += 1;
    this.lastPollAt = Date.now();
    try {
      const url = `${CLOB_REST}/book?token_id=ALL`;
      const resp = await this.fetchImpl(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data && typeof data === 'object') {
        for (const [tokenId, book] of Object.entries(data)) {
          const tok = this.tokens.get(tokenId);
          if (!tok) continue;
          const bestAsk = book.asks?.[0]?.price != null ? parseFloat(book.asks[0].price) : null;
          const bestBid = book.bids?.[0]?.price != null ? parseFloat(book.bids[0].price) : null;
          tok.ask = bestAsk;
          tok.bid = bestBid;
          tok.mid = bestAsk != null && bestBid != null ? round5((bestAsk + bestBid) / 2) : bestAsk ?? bestBid;
        }
      }
      this.lastSuccessfulPollAt = Date.now();
      this.pollCount += 1;
    } catch (error) {
      if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt > 5000) {
        this.lastPollErrorAt = Date.now();
        this.log(`CLOB FAIL ${error.message}`);
      }
    } finally {
      this.pollInFlight -= 1;
    }
  }

  // ── Strategy ──────────────────────────────────────────────
  // 1. Wait 30s after window opens
  // 2. If underdog ask ≤ 0.20 → market buy (GTC 0.99 ceiling)
  // 3. Immediately place limit sell at 0.50
  // 4. If limit sells → profit, done
  // 5. If window ends and limit unfilled → cancel, resolve at resolution

  computeBase() {
    this.baseShares = Math.max(1, Math.round(this.bankroll * BASE_PCT / 0.70));
  }

  prepareWindow(market) {
    this.windowStartFor = market.windowStart;
    this.positionSeq = 0;
    this.openEntry = null;
    this.windowTraded = false;
    this.computeBase();
    this.windowOpenedAt = Date.now();
    this.log(`🆕 WINDOW ${market.slug.slice(-10)} — BASE ${this.baseShares}sh = ${BASE_PCT*100}% of $${this.bankroll.toFixed(2)} · wait ${WAIT_SECONDS}s · buy underdog ≤ ${CHEAP_THRESHOLD.toFixed(2)} · TP limit @ ${TP_PRICE.toFixed(2)}`);
    this.onTick(this.buildState());
  }

  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));
    this.resolveExpired(market, nowS);
    if (!market) return;
    if (this.entryWindow != null && market.windowStart < this.entryWindow) return;
    if (this.windowStartFor !== market.windowStart) this.prepareWindow(market);
    const elapsed = Math.floor(nowS - market.windowStart);

    if (!this.windowTraded && !this.openEntry && elapsed >= WAIT_SECONDS) {
      this.tryEntry(market);
    }

    this.recordEquity();
    this.onTick(this.buildState());
  }

  tryEntry(market) {
    const upAsk = market.up?.ask;
    const dnAsk = market.down?.ask;
    if (upAsk == null || dnAsk == null) return;

    let side = null, ask = null;
    if (upAsk <= CHEAP_THRESHOLD && upAsk <= dnAsk) { side = 'UP'; ask = upAsk; }
    else if (dnAsk <= CHEAP_THRESHOLD && dnAsk <= upAsk) { side = 'DOWN'; ask = dnAsk; }
    else if (upAsk <= CHEAP_THRESHOLD) { side = 'UP'; ask = upAsk; }
    else if (dnAsk <= CHEAP_THRESHOLD) { side = 'DOWN'; ask = dnAsk; }
    if (!side) return;

    const shares = this.baseShares;
    const price = ask;
    const cost = round2(shares * price);
    const fee = takerFee(shares, price);
    if (cost + fee > this.bankroll) {
      this.log(`⚠️ SKIP ${side} @ ${price.toFixed(3)} — bankroll $${this.bankroll.toFixed(2)} < cost $${(cost+fee).toFixed(2)}`);
      return;
    }

    this.bankroll = round2(this.bankroll - cost - fee);
    this.totalFeesPaid = round2(this.totalFeesPaid + fee);
    this.positionSeq = 1;
    this.openEntry = side;
    this.windowTraded = true;
    if (shares > this.maxSharesEver) this.maxSharesEver = shares;

    const position = {
      slug: market.slug, outcome: side, market,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      shares, entryPrice: price, cost, buyFee: fee,
      openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null,
      entryNo: 1, limitSellPlaced: false,
    };
    this.positions = this.positions || [];
    this.positions.push(position);
    this.trades = this.trades || [];
    this.trades.push({ timestamp: Date.now(), type: 'BUY', slug: market.slug, outcome: side, shares, price, cost, fee, reason: `ENTRY ${side} ${shares}sh @ ${price.toFixed(3)} ≤ ${CHEAP_THRESHOLD.toFixed(2)}` });
    this.log(`⚡ BUY ${side} ${shares}sh @ ${price.toFixed(3)} · cost $${cost.toFixed(2)} · fee $${fee.toFixed(4)} · UNDERDOG ≤ ${CHEAP_THRESHOLD.toFixed(2)}`);
    this.onTick(this.buildState());
  }

  resolveExpired(market, nowS) {
    const positions = this.positions || [];
    const open = positions.filter(p => p.exitReason == null);
    for (const pos of open) {
      if (nowS < pos.windowEnd) continue;
      const m = pos.market;
      if (!m) continue;
      const upMid = m.up.mid, downMid = m.down.mid;
      let winner = null;
      if (upMid != null && downMid != null) winner = upMid >= downMid ? 'UP' : 'DOWN';
      else if (upMid != null) winner = upMid >= 0.5 ? 'UP' : 'DOWN';
      else if (downMid != null) winner = downMid >= 0.5 ? 'DOWN' : 'UP';
      if (!winner) winner = 'UP';
      const won = pos.outcome === winner;
      const exitPrice = won ? 1 : 0;
      this.sellPosition(pos, exitPrice, 'RESOLUTION', { winner, won });
    }
  }

  sellPosition(position, price, reason, extra = {}) {
    if (position.exitReason != null) return;
    const proceeds = round2(position.shares * price);
    const fee = (price > 0 && price < 1) ? takerFee(position.shares, price) : 0;
    const pnl = round2(proceeds - position.cost - (position.buyFee || 0) - fee);
    if (pnl >= 0) this.wins++; else this.losses++;
    this.bankroll = round2(this.bankroll + proceeds - fee);
    this.totalFeesPaid = round2(this.totalFeesPaid + fee);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    position.pnl = pnl;
    position.exitPrice = price;
    position.exitReason = reason;
    position.sellFee = fee;
    position.closedAt = Date.now();
    position.won = extra.won != null ? extra.won : pnl > 0;
    this.results = this.results || [];
    this.results.unshift({ ...position, market: undefined });
    this.results = this.results.slice(0, 50);
    this.trades = this.trades || [];
    this.trades.push({ timestamp: Date.now(), type: 'SELL', slug: position.slug, outcome: position.outcome, shares: position.shares, price, pnl, fee, reason, ...extra });
    const tag = reason === 'RESOLUTION' ? '🏁 RESOLUTION' : reason === 'TP_LIMIT' ? '✅ TP LIMIT' : '💰 SELL';
    this.log(`${tag} ${position.outcome} @ ${price.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · ${position.shares}sh · fees $${((position.buyFee||0)+fee).toFixed(4)}`);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  recordEquity() {
    const equity = this.bankroll + (this.positions || []).filter(p => p.exitReason == null).reduce((s, p) => s + p.cost, 0);
    if (equity > this.peakEquity) this.peakEquity = equity;
    const dd = this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    this.equityCurve.push({ t: Date.now(), equity: round2(equity) });
    if (this.equityCurve.length > 2000) this.equityCurve = this.equityCurve.slice(-1000);
  }

  buildState() {
    const now = Date.now();
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));
    const elapsed = market ? Math.floor(now / 1000 - market.windowStart) : 0;
    const pos = (this.positions || []).find(p => p.exitReason == null);
    let unrealized = 0;
    if (pos) {
      const px = pos.outcome === 'UP' ? market?.up?.mid : market?.down?.mid;
      if (px != null) unrealized = round2(pos.shares * px - pos.cost - (pos.buyFee || 0));
    }
    return {
      bankroll: this.bankroll, initialBankroll: this.initialBankroll,
      realizedPnl: this.realizedPnl, unrealizedPnl: unrealized,
      totalFeesPaid: this.totalFeesPaid, wins: this.wins, losses: this.losses,
      peakEquity: this.peakEquity, maxDrawdown: this.maxDrawdown,
      maxSharesEver: this.maxSharesEver,
      currentWindow: market?.slug?.slice(-10) || null,
      windowElapsed: elapsed, windowDuration: WINDOW_SECONDS,
      position: pos ? {
        side: pos.outcome, shares: pos.shares, entryPrice: pos.entryPrice,
        cost: pos.cost, buyFee: pos.buyFee, unrealized,
      } : null,
      upAsk: market?.up?.ask, upBid: market?.up?.bid, upMid: market?.up?.mid,
      dnAsk: market?.down?.ask, dnBid: market?.down?.bid, dnMid: market?.down?.mid,
      equityCurve: this.equityCurve.slice(-200),
      config: { basePct: BASE_PCT, cheapThreshold: CHEAP_THRESHOLD, tpPrice: TP_PRICE, waitSeconds: WAIT_SECONDS },
    };
  }

  // ── Main Loop ─────────────────────────────────────────────
  async start() {
    this.log(`🚀 CheapHunter started | wait ${WAIT_SECONDS}s · buy underdog ≤ ${CHEAP_THRESHOLD.toFixed(2)} · limit sell @ ${TP_PRICE.toFixed(2)} · ${BASE_PCT*100}% base · no SL · no martingale`);
    const now = Date.now();
    const currentStart = windowStartFor(now);
    this.entryWindow = currentStart + WINDOW_SECONDS;
    await this.discoverWindow(currentStart);
    await this.discoverWindow(currentStart + WINDOW_SECONDS);
    const pollLoop = async () => {
      while (true) {
        await this.pollClob();
        this.evaluate();
        await new Promise(r => setTimeout(r, CLOB_POLL_MS));
      }
    };
    pollLoop().catch(e => this.log(`POLL LOOP ERROR: ${e.message}`));
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers = []; }
}

module.exports = { CheapHunterEngine, config: { WINDOW_SECONDS, WAIT_SECONDS, CHEAP_THRESHOLD, TP_PRICE, BASE_PCT, START_BANKROLL, TAKER_FEE_RATE } };
