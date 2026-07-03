// src/binanceFeed.js — connects to Binance for live trades + order book depth,
// and backfills recent 1-min klines on startup so predictors aren't cold.

const config = require('../config');

class BinanceFeed {
  constructor() {
    this.trades = [];          // { price, qty, isBuyerMaker, ts }
    this.klines1m = [];        // { openTime, open, high, low, close, volume }
    this.bookTop = { bids: [], asks: [] }; // top N levels, refreshed ~10x/sec
    this.lastPrice = null;
    this._tradeWs = null;
    this._depthWs = null;
    this._listeners = { trade: [], depth: [], kline: [] };
  }

  on(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
  }

  _emit(event, payload) {
    for (const cb of this._listeners[event] || []) cb(payload);
  }

  async backfillKlines(limit = 60) {
    const url = `${config.klineRestUrl}?symbol=${config.symbol.toUpperCase()}&interval=1m&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Kline backfill failed: ${res.status} ${res.statusText}`);
    const raw = await res.json();
    this.klines1m = raw.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
    this.lastPrice = this.klines1m.length
      ? this.klines1m[this.klines1m.length - 1].close
      : null;
    console.log(`[BinanceFeed] Backfilled ${this.klines1m.length} 1m klines. Last price: ${this.lastPrice}`);
  }

  connect() {
    this._connectTrades();
    this._connectDepth();
    this._startKlineRoller();
  }

  _connectTrades() {
    this._tradeWs = new WebSocket(config.tradeStreamUrl);
    this._tradeWs.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      const trade = {
        price: parseFloat(data.p),
        qty: parseFloat(data.q),
        isBuyerMaker: data.m,      // true => aggressor was seller (sold into bid)
        ts: data.T,
      };
      this.lastPrice = trade.price;
      this.trades.push(trade);
      this._pruneTrades();
      this._emit('trade', trade);
    };
    this._tradeWs.onclose = () => {
      console.warn('[BinanceFeed] Trade WS closed, reconnecting in 2s...');
      setTimeout(() => this._connectTrades(), 2000);
    };
    this._tradeWs.onerror = (e) => console.error('[BinanceFeed] Trade WS error:', e.message || e);
  }

  _connectDepth() {
    this._depthWs = new WebSocket(config.depthStreamUrl);
    this._depthWs.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      this.bookTop = {
        bids: (data.bids || []).slice(0, config.bookDepthLevels).map(([p, q]) => ({ price: +p, qty: +q })),
        asks: (data.asks || []).slice(0, config.bookDepthLevels).map(([p, q]) => ({ price: +p, qty: +q })),
      };
      this._emit('depth', this.bookTop);
    };
    this._depthWs.onclose = () => {
      console.warn('[BinanceFeed] Depth WS closed, reconnecting in 2s...');
      setTimeout(() => this._connectDepth(), 2000);
    };
    this._depthWs.onerror = (e) => console.error('[BinanceFeed] Depth WS error:', e.message || e);
  }

  // Rebuilds the trailing 1m kline list from trade data every 5s so mean-reversion /
  // vol-breakout predictors have fresh bars without needing extra REST polling.
  _startKlineRoller() {
    setInterval(() => {
      const nowBucket = Math.floor(Date.now() / 60000) * 60000;
      const bucketTrades = this.trades.filter(t => t.ts >= nowBucket);
      if (!bucketTrades.length) return;
      const prices = bucketTrades.map(t => t.price);
      const bar = {
        openTime: nowBucket,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume: bucketTrades.reduce((s, t) => s + t.qty, 0),
        closeTime: nowBucket + 60000 - 1,
      };
      const last = this.klines1m[this.klines1m.length - 1];
      if (last && last.openTime === nowBucket) {
        this.klines1m[this.klines1m.length - 1] = bar;
      } else {
        this.klines1m.push(bar);
        if (this.klines1m.length > 200) this.klines1m.shift();
        this._emit('kline', bar);
      }
    }, 5000);
  }

  _pruneTrades() {
    const cutoff = Date.now() - config.tradeBufferSeconds * 1000;
    while (this.trades.length && this.trades[0].ts < cutoff) this.trades.shift();
  }

  getRecentTrades(seconds) {
    const cutoff = Date.now() - seconds * 1000;
    return this.trades.filter(t => t.ts >= cutoff);
  }
}

module.exports = BinanceFeed;
