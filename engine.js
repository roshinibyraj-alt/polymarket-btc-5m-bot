'use strict';

const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_WS = process.env.CLOB_WS || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WINDOW_SECONDS = 300;
const ASSETS = (process.env.ASSETS || 'btc,eth,sol,xrp').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const LEAD_ASSET = (process.env.LEAD_ASSET || 'btc').toLowerCase();
const START_BANKROLL = Number(process.env.START_BANKROLL || 5000);
const BASE_NOTIONAL = Number(process.env.BASE_NOTIONAL || 40);
const MAX_COST_PER_SIDE = Number(process.env.MAX_COST_PER_SIDE || 180);
const MAX_TRADES_PER_SIDE = Number(process.env.MAX_TRADES_PER_SIDE || 6);
const MIN_PRICE = Number(process.env.MIN_ENTRY_PRICE || 0.40);
const MAX_PRICE = Number(process.env.MAX_ENTRY_PRICE || 0.90);
const MAX_SPREAD = Number(process.env.MAX_SPREAD || 0.09);
const MOMENTUM_MS = Number(process.env.MOMENTUM_MS || 2200);
const LEAD_THRESHOLD = Number(process.env.LEAD_THRESHOLD || 0.030);
const FOLLOWER_MAX_MOVE = Number(process.env.FOLLOWER_MAX_MOVE || 0.014);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 700);
const NO_NEW_ENTRIES_AFTER = Number(process.env.NO_NEW_ENTRIES_AFTER || 255);
const TAKER_FEE_BPS = Number(process.env.TAKER_FEE_BPS || 0);
const SWEEP_INTERVAL_MS = Number(process.env.RESOLUTION_SWEEP_MS || 5000);

function round2(value) { return Math.round(value * 100) / 100; }
function round5(value) { return Math.round(value * 100000) / 100000; }
function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(asset, start) { return `${asset}-updown-5m-${start}`; }
function keyFor(slug, outcome) { return `${slug}:${outcome}`; }

class MomentumLagEngine {
  constructor(options = {}) {
    this.WebSocketImpl = options.WebSocketImpl || require('ws');
    this.fetchImpl = options.fetchImpl || fetch;
    this.emitTick = options.onTick || (() => {});
    this.emitLog = options.onLog || (() => {});
    this.startedAt = Date.now();
    this.bankroll = START_BANKROLL;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.tickCount = 0;
    this.messageCount = 0;
    this.reconnects = 0;
    this.connected = false;
    this.lastMessageAt = null;
    this.equityCurve = [{ t: Date.now(), equity: START_BANKROLL }];
    this.logs = [];
    this.trades = [];
    this.positions = [];
    this.markets = new Map();
    this.tokens = new Map();
    this.windows = new Map();
    this.resolvedWindows = [];
    this.history = new Map();
    this.cooldowns = new Map();
    this.discoveredWindows = new Set();
    this.activeWindowStart = null;
    this.socket = null;
    this.subscribedTokens = new Set();
    this.loopRunning = false;
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

  async getJSON(url, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'momentum-lag-bot/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async discoverMarket(asset, start) {
    const slug = slugFor(asset, start);
    if (this.discoveredWindows.has(slug)) return this.markets.get(slug) || null;
    let market = null;
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
      market = Array.isArray(rows) ? rows[0] : null;
    } catch (error) {
      this.log(`⚠️ Discovery ${slug}: ${error.message}`);
      return null;
    }
    this.discoveredWindows.add(slug);
    if (!market || !market.conditionId || !market.clobTokenIds || market.closed) return null;
    const outcomes = this.parseJson(market.outcomes) || [];
    const tokenIds = this.parseJson(market.clobTokenIds) || [];
    const upIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'up');
    const downIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'down');
    if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
      this.log(`⚠️ Invalid token mapping ${slug}`);
      return null;
    }
    const record = {
      slug,
      asset,
      conditionId: market.conditionId,
      title: market.question || slug,
      windowStart: start,
      windowEnd: start + WINDOW_SECONDS,
      tradingClosed: false,
      resolved: false,
      winner: null,
      up: this.makeToken(tokenIds[upIndex], slug, asset, 'UP'),
      down: this.makeToken(tokenIds[downIndex], slug, asset, 'DOWN'),
    };
    this.markets.set(slug, record);
    this.tokens.set(record.up.tokenId, record.up);
    this.tokens.set(record.down.tokenId, record.down);
    this.windows.set(slug, this.windowSummary(record));
    this.subscribe([record.up.tokenId, record.down.tokenId]);
    this.log(`🎯 ${asset.toUpperCase()} 5m discovered ${slug} — WebSocket armed`);
    return record;
  }

  makeToken(tokenId, slug, asset, outcome) {
    return {
      tokenId: String(tokenId), slug, asset, outcome,
      bid: null, ask: null, mid: null, spread: null,
      previousMid: null, updatedAt: null,
    };
  }

  async discoverWindow(start, label) {
    await Promise.all(ASSETS.map(asset => this.discoverMarket(asset, start)));
    if (!this.activeWindowStart && this.hasOpenTradingMarket(start)) {
      this.activeWindowStart = start;
      this.log(`🚀 ${label} window active — ${start}`);
    }
  }

  hasOpenTradingMarket(start) {
    return [...this.markets.values()].some(market =>
      market.windowStart === start && !market.tradingClosed && market.up.tokenId);
  }

  subscribe(tokenIds) {
    let added = false;
    for (const tokenId of tokenIds.map(String)) {
      if (!this.subscribedTokens.has(tokenId)) { this.subscribedTokens.add(tokenId); added = true; }
    }
    if (!added || !this.socket || this.socket.readyState !== 1) return;
    this.sendSubscription();
  }

  sendSubscription() {
    this.socket.send(JSON.stringify({ assets_ids: [...this.subscribedTokens], type: 'market' }));
  }

  connect() {
    if (!this.WebSocketImpl || this.socket) return;
    try { this.socket = new this.WebSocketImpl(CLOB_WS); }
    catch (error) { this.scheduleReconnect(); return; }
    this.socket.onopen = () => {
      this.connected = true;
      this.log(`🔌 CLOB market WebSocket connected — ${this.subscribedTokens.size} tokens`);
      if (this.subscribedTokens.size) this.sendSubscription();
    };
    this.socket.onmessage = event => this.handleMessage(String(event.data));
    this.socket.onerror = () => {};
    this.socket.onclose = () => {
      this.connected = false;
      this.socket = null;
      this.reconnects++;
      this.log('⚠️ CLOB socket closed — reconnecting');
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), 500);
  }

  handleMessage(raw) {
    let events;
    try { events = JSON.parse(raw); } catch (_) { return; }
    if (!Array.isArray(events)) events = [events];
    this.messageCount++;
    this.lastMessageAt = Date.now();
    for (const event of events) this.processEvent(event);
    this.tickCount++;
    this.emitTick(this.publicMarkets());
  }

  processEvent(event) {
    const eventType = event.event_type;
    if (event.asset_id && Array.isArray(event.bids)) {
      const token = this.tokens.get(String(event.asset_id));
      if (token) { this.applyBook(token, event.bids, event.asks || []); this.evaluateSignals(); }
      return;
    }
    if (Array.isArray(event.price_changes)) {
      for (const change of event.price_changes) {
        const token = this.tokens.get(String(change.asset_id));
        if (!token) continue;
        this.applyTop(token, change.best_bid, change.best_ask);
      }
      this.evaluateSignals();
    }
    void eventType;
  }

  applyBook(token, bids, asks) {
    const validBids = bids.filter(level => Number(level.size) > 0).map(level => ({ price: Number(level.price), size: Number(level.size) }));
    const validAsks = asks.filter(level => Number(level.size) > 0).map(level => ({ price: Number(level.price), size: Number(level.size) }));
    validBids.sort((a, b) => b.price - a.price);
    validAsks.sort((a, b) => a.price - b.price);
    this.setQuote(token, validBids[0]?.price ?? null, validAsks[0]?.price ?? null);
  }

  applyTop(token, bestBid, bestAsk) {
    const bid = bestBid == null ? token.bid : Number(bestBid);
    const ask = bestAsk == null ? token.ask : Number(bestAsk);
    this.setQuote(token, bid, ask);
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
  }

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const series = this.history.get(tokenId) || [];
    series.push({ t: now, p: price });
    while (series.length > 2 && now - series[0].t > MOMENTUM_MS + 2000) series.shift();
    this.history.set(tokenId, series.slice(-240));
  }

  momentum(token, horizon = MOMENTUM_MS) {
    if (!token) return null;
    const series = this.history.get(token.tokenId);
    if (!series || !series.length) return null;
    const now = Date.now();
    const currentPrice = Number.isFinite(token.mid) ? token.mid : series[series.length - 1].p;
    let oldest = null;
    for (const sample of series) {
      if (now - sample.t >= horizon) oldest = sample;
      else break;
    }
    if (!oldest) return null;
    return round5(currentPrice - oldest.p);
  }

  evaluateSignals() {
    const leadMarket = this.currentMarket(LEAD_ASSET);
    if (!leadMarket || this.bankroll <= 0) return;
    const leadMove = this.momentum(leadMarket.up);
    if (leadMove == null || Math.abs(leadMove) < LEAD_THRESHOLD) return;
    const elapsed = Math.floor(Date.now() / 1000 - leadMarket.windowStart);
    if (elapsed < 5 || elapsed >= NO_NEW_ENTRIES_AFTER) return;

    for (const market of this.markets.values()) {
      if (market.windowStart !== this.activeWindowStart || market.asset === LEAD_ASSET) continue;
      if (market.tradingClosed) continue;
      const direction = leadMove > 0 ? 'UP' : 'DOWN';
      const followerToken = direction === 'UP' ? market.up : market.down;
      const followerMove = this.momentum(followerToken);
      if (followerMove == null) continue;
      if (Math.abs(followerMove) > FOLLOWER_MAX_MOVE) continue;
      const lag = Math.abs(leadMove) - Math.abs(followerMove);
      if (lag < 0.008) continue;
      const confidence = Math.min(2, 0.75 + lag / LEAD_THRESHOLD + Math.abs(leadMove) / (LEAD_THRESHOLD * 3));
      this.firePaperOrder(market, followerToken, confidence, { leadMove, followerMove, lag });
    }
  }

  currentMarket(asset) {
    return [...this.markets.values()].find(market =>
      market.asset === asset && !market.resolved && Date.now() / 1000 < market.windowEnd + 3) || null;
  }

  firePaperOrder(market, token, confidence, signal) {
    const cooldownKey = keyFor(market.slug, token.outcome);
    const lastFire = this.cooldowns.get(cooldownKey) || 0;
    if (Date.now() - lastFire < COOLDOWN_MS) return;
    const sidePositions = this.positions.filter(position =>
      position.slug === market.slug && position.outcome === token.outcome && position.status === 'open');
    const deployed = sidePositions.reduce((sum, position) => sum + position.cost + position.fee, 0);
    if (sidePositions.length >= MAX_TRADES_PER_SIDE || deployed >= MAX_COST_PER_SIDE) return;
    const fillPrice = token.ask;
    if (!Number.isFinite(fillPrice) || fillPrice < MIN_PRICE || fillPrice > MAX_PRICE) return;
    if (token.spread != null && token.spread > MAX_SPREAD) return;
    const notional = Math.min(BASE_NOTIONAL * confidence, Math.max(0, MAX_COST_PER_SIDE - deployed));
    const shares = round2(notional / fillPrice);
    const cost = round2(shares * fillPrice);
    const fee = round2(cost * TAKER_FEE_BPS / 10000);
    if (shares <= 0 || cost + fee > this.bankroll) return;
    this.cooldowns.set(cooldownKey, Date.now());
    this.bankroll = round2(this.bankroll - cost - fee);
    const position = {
      id: `${market.slug}-${token.outcome}-${Date.now()}`,
      slug: market.slug, asset: market.asset, conditionId: market.conditionId,
      outcome: token.outcome, tokenId: token.tokenId, shares, entryPrice: fillPrice,
      cost, fee, status: 'open', openedAt: new Date().toISOString(), markPrice: token.mid,
      signal: { ...signal, confidence: round2(confidence), elapsed: Math.floor(Date.now() / 1000 - market.windowStart) },
    };
    this.positions.push(position);
    const trade = { ...position, orderType: 'PAPER-FOK', timestamp: Date.now() };
    this.trades.push(trade);
    if (this.trades.length > 400) this.trades.splice(0, this.trades.length - 250);
    this.log(`⚡ BUY ${market.asset.toUpperCase()} ${token.outcome} ${shares}sh @${fillPrice.toFixed(3)} | lead ${signal.leadMove.toFixed(3)}, lag ${signal.followerMove.toFixed(3)} | $${cost.toFixed(2)}`);
    this.recordEquity();
  }

  async rotateAndSweep() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      const start = windowStartFor(Date.now());
      if (start !== this.activeWindowStart) {
        this.activeWindowStart = null;
        await this.discoverWindow(start, 'New');
      }
      const pending = [...this.markets.values()].filter(market =>
        !market.resolved && Date.now() / 1000 >= market.windowEnd + 1 &&
        this.positions.some(position => position.slug === market.slug));
      await Promise.all(pending.map(market => this.resolveMarket(market)));
      this.recordEquity();
    } catch (error) {
      this.log(`⚠️ Loop: ${error.message}`);
    } finally { this.loopRunning = false; }
  }

  async resolveMarket(market) {
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?condition_id=${encodeURIComponent(market.conditionId)}`);
      const gamma = Array.isArray(rows) ? rows[0] : null;
      if (!gamma || !gamma.closed) return;
      const prices = this.parseJson(gamma.outcomePrices) || [];
      const outcomes = this.parseJson(gamma.outcomes) || [];
      const upIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'up');
      const upPrice = Number(prices[upIndex]);
      if (!Number.isFinite(upPrice)) return;
      market.tradingClosed = true;
      market.resolved = true;
      market.winner = upPrice >= 0.5 ? 'UP' : 'DOWN';
      this.settleMarket(market);
    } catch (error) { this.log(`⚠️ Resolve ${market.slug}: ${error.message}`); }
  }

  settleMarket(market) {
    const legs = this.positions.filter(position => position.slug === market.slug && position.status === 'open');
    if (!legs.length) return;
    let payout = 0, cost = 0, fees = 0;
    for (const leg of legs) {
      const won = leg.outcome === market.winner;
      const legPayout = won ? leg.shares : 0;
      payout += legPayout; cost += leg.cost; fees += leg.fee;
      leg.status = won ? 'won' : 'lost';
      leg.won = won; leg.payout = round2(legPayout); leg.pnl = round2(legPayout - leg.cost - leg.fee);
      leg.markPrice = won ? 1 : 0; leg.resolvedAt = new Date().toISOString();
    }
    payout = round2(payout); cost = round2(cost); fees = round2(fees);
    const pnl = round2(payout - cost - fees);
    this.bankroll = round2(this.bankroll + payout);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    if (pnl > 0) this.wins++; else if (pnl < 0) this.losses++;
    const summary = { ...this.windowSummary(market), resolved: true, winner: market.winner, payout, pnl, settledAt: new Date().toISOString() };
    this.resolvedWindows.unshift(summary);
    this.resolvedWindows = this.resolvedWindows.slice(0, 30);
    this.log(`🏁 ${market.asset.toUpperCase()} ${market.winner} — cost $${cost.toFixed(2)}, payout $${payout.toFixed(2)}, P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
  }

  windowSummary(market) {
    const legs = this.positions.filter(position => position.slug === market.slug);
    const sum = (filter, mapper) => round2(legs.filter(filter).reduce((total, leg) => total + mapper(leg), 0));
    const openUp = legs.find(leg => leg.outcome === 'UP' && leg.status === 'open');
    const openDown = legs.find(leg => leg.outcome === 'DOWN' && leg.status === 'open');
    const unrealized = round2(legs.reduce((total, leg) => {
      if (leg.status !== 'open') return total;
      const mark = leg.outcome === 'UP' ? market.up.mid : market.down.mid;
      return total + leg.shares * (mark ?? leg.entryPrice) - leg.cost - leg.fee;
    }, 0));
    return {
      slug: market.slug, asset: market.asset, type: '5m', title: market.title,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      upShares: sum(leg => leg.outcome === 'UP', leg => leg.shares),
      downShares: sum(leg => leg.outcome === 'DOWN', leg => leg.shares),
      upCost: sum(leg => leg.outcome === 'UP', leg => leg.cost),
      downCost: sum(leg => leg.outcome === 'DOWN', leg => leg.cost),
      trades: legs.length, unrealized,
      btcSignal: this.momentum(this.markets.get(slugFor(LEAD_ASSET, market.windowStart))?.up),
      holding: Boolean(openUp || openDown),
    };
  }

  publicMarkets() {
    return [...this.markets.values()]
      .filter(market => Date.now() / 1000 < market.windowEnd + 15)
      .sort((a, b) => a.asset.localeCompare(b.asset))
      .map(market => ({
        slug: market.slug, asset: market.asset, title: market.title,
        windowStart: market.windowStart, windowEnd: market.windowEnd,
        resolved: market.resolved, winner: market.winner,
        elapsed: Math.max(0, Math.floor(Date.now() / 1000 - market.windowStart)),
        remaining: Math.max(0, market.windowEnd - Math.floor(Date.now() / 1000)),
        up: publicToken(market.up), down: publicToken(market.down),
      }));
  }

  buildState() {
    const openLegs = this.positions.filter(position => position.status === 'open');
    const openValue = round2(openLegs.reduce((sum, leg) => {
      const market = this.markets.get(leg.slug);
      const token = leg.outcome === 'UP' ? market?.up : market?.down;
      return sum + leg.shares * (token?.mid ?? leg.entryPrice);
    }, 0));
    const markValue = round2(this.bankroll + openValue);
    const activeStart = windowStartFor(Date.now());
    const activeMarkets = [...this.markets.values()].filter(market => market.windowStart === activeStart);
    const windows = activeMarkets.map(market => this.windowSummary(market)).sort((a, b) => a.asset.localeCompare(b.asset));
    return {
      mode: 'AUTONOMOUS DEMO',
      strategy: 'BTC lead → lagging altcoin UP/DOWN momentum',
      serverTime: Date.now(),
      connected: this.connected, tickCount: this.tickCount, messageCount: this.messageCount,
      reconnects: this.reconnects, lastMessageAt: this.lastMessageAt,
      subscribedTokens: this.subscribedTokens.size,
      watchAssets: ASSETS, leadAsset: LEAD_ASSET.toUpperCase(),
      bankroll: this.bankroll, markValue, realizedPnl: this.realizedPnl,
      openValue, totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      markets: this.publicMarkets(),
      positions: openLegs.slice().reverse(),
      windows, resolvedWindows: this.resolvedWindows.slice(0, 12),
      trades: this.trades.slice(-80).reverse(),
      equityCurve: this.equityCurve.slice(-1200),
      logs: this.logs.slice(-180),
      config: {
        baseNotional: BASE_NOTIONAL, maxPerSide: MAX_COST_PER_SIDE, maxTradesPerSide: MAX_TRADES_PER_SIDE,
        leadThreshold: LEAD_THRESHOLD, followerMaxMove: FOLLOWER_MAX_MOVE,
        entryRange: [MIN_PRICE, MAX_PRICE], noEntriesAfter: NO_NEW_ENTRIES_AFTER,
        feeBps: TAKER_FEE_BPS,
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

  async init() {
    const start = windowStartFor(Date.now());
    await this.discoverWindow(start, 'Current');
    await this.discoverWindow(start + WINDOW_SECONDS, 'Next');
    this.connect();
    setInterval(() => this.rotateAndSweep(), 1000);
    setInterval(() => {
      if (this.connected && this.lastMessageAt && Date.now() - this.lastMessageAt > 12000) {
        try { this.socket?.send('PING'); } catch (_) {}
      }
    }, 3000);
    this.log(`🚀 Autonomous BTC→alt momentum bot started | ${ASSETS.join('/')} | demo $${START_BANKROLL}`);
  }
}

function publicToken(token) {
  return {
    bid: token.bid, ask: token.ask, mid: token.mid, spread: token.spread,
    updatedAt: token.updatedAt,
  };
}

module.exports = {
  MomentumLagEngine,
  config: {
    ASSETS, LEAD_ASSET, START_BANKROLL, BASE_NOTIONAL, MAX_COST_PER_SIDE,
    MAX_TRADES_PER_SIDE, MIN_PRICE, MAX_PRICE, MOMENTUM_MS, LEAD_THRESHOLD,
    FOLLOWER_MAX_MOVE, COOLDOWN_MS, NO_NEW_ENTRIES_AFTER, TAKER_FEE_BPS,
  },
};
