'use strict';

const WebSocket = require('ws');

const STREAM_URL = 'wss://data-stream.binance.vision/stream?streams=btcusdt@aggTrade/btcusdt@kline_5m';
const WINDOW_MS = 5 * 60 * 1000;
const RETAIN_MS = 60 * 1000;

class BinanceTickFeed {
  constructor({ WebSocketImpl = WebSocket, now = Date.now } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.socket = null;
    this.started = false;
    this.status = 'WAITING';
    this.error = null;
    this.price = null;
    this.tickAt = null;
    this.currentCandle = null;
    this.previousClosedCandle = null;
    this.recentTrades = [];
    this.priceSamples = [];
    this.retryMs = 1000;
    this.reconnectTimer = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  connect() {
    if (!this.started) return;
    this.status = 'CONNECTING';
    let socket;
    try {
      socket = new this.WebSocketImpl(STREAM_URL);
      this.socket = socket;
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.retryMs = 1000;
      this.error = null;
      this.status = 'CONNECTED';
    });
    socket.on('message', (raw) => {
      if (this.socket === socket) this.handleMessage(raw);
    });
    socket.on('error', (error) => {
      if (this.socket === socket) {
        this.status = 'ERROR';
        this.error = error?.message || 'Binance public stream error';
      }
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.scheduleReconnect(new Error('Binance public stream disconnected'));
      }
    });
  }

  scheduleReconnect(error) {
    this.status = 'RECONNECTING';
    this.error = error?.message || 'Binance public stream disconnected';
    if (!this.started || this.reconnectTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  handleMessage(raw) {
    try {
      const payload = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
      let text;
      if (typeof payload === 'string') text = payload;
      else if (Buffer.isBuffer(payload)) text = payload.toString('utf8');
      else if (ArrayBuffer.isView(payload)) text = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
      else if (payload instanceof ArrayBuffer) text = Buffer.from(payload).toString('utf8');
      else text = JSON.stringify(payload);
      const message = JSON.parse(text);
      if (message?.stream && message?.data) {
        if (message.stream.endsWith('@kline_5m')) {
          this.handleKline(message.data.k);
          return;
        }
        this.handleMessage(message.data);
        return;
      }
      const price = Number(message.p);
      const quantity = Number(message.q);
      let timestamp = Number(message.T || message.E || this.now());
      if (timestamp < 1e12) timestamp *= 1000;
      if (!(price > 0) || !Number.isFinite(timestamp)) return;

      this.price = price;
      this.tickAt = timestamp;
      const start = Math.floor(timestamp / WINDOW_MS) * WINDOW_MS;
      if (this.currentCandle && this.currentCandle.start < start
        && (!this.previousClosedCandle || this.currentCandle.start >= this.previousClosedCandle.start)) {
        this.previousClosedCandle = { ...this.currentCandle, closedAt: timestamp };
      }
      if (!this.currentCandle || this.currentCandle.start !== start) {
        this.currentCandle = {
          start,
          open: price,
          high: price,
          low: price,
          close: price,
        };
      } else {
        this.currentCandle.high = Math.max(this.currentCandle.high, price);
        this.currentCandle.low = Math.min(this.currentCandle.low, price);
        this.currentCandle.close = price;
      }

      this.priceSamples.push({ ts: timestamp, price });
      this.prune(timestamp);
      if (quantity > 0 && typeof message.m === 'boolean') {
        this.recentTrades.push({
          ts: timestamp,
          price,
          quantity,
          notional: price * quantity,
          aggressor: message.m ? 'SELL' : 'BUY',
        });
      }
      this.status = 'CONNECTED';
      this.error = null;
    } catch (error) {
      this.error = error.message || String(error);
    }
  }

  handleKline(kline) {
    const start = Number(kline?.t);
    const open = Number(kline?.o);
    const high = Number(kline?.h);
    const low = Number(kline?.l);
    const close = Number(kline?.c);
    if (![start, open, high, low, close].every(Number.isFinite)
      || !(open > 0 && high > 0 && low > 0 && close > 0)) return;
    const candle = { start, open, high, low, close, source: 'BINANCE_5M_KLINE' };
    if (kline.x === true
      && (!this.previousClosedCandle || start >= this.previousClosedCandle.start)) {
      this.previousClosedCandle = { ...candle, closedAt: Number(kline.T) || this.now() };
    } else if (this.currentCandle && this.currentCandle.start < start
      && (!this.previousClosedCandle || this.currentCandle.start >= this.previousClosedCandle.start)) {
      this.previousClosedCandle = { ...this.currentCandle, closedAt: this.now() };
    }
    if (!this.currentCandle || start >= this.currentCandle.start) this.currentCandle = candle;
    this.candleAt = Number(kline.E) || this.now();
    this.status = 'CONNECTED';
    this.error = null;
  }

  prune(now = this.now()) {
    const cutoff = now - RETAIN_MS;
    this.recentTrades = this.recentTrades.filter((trade) => trade.ts >= cutoff).slice(-5000);
    this.priceSamples = this.priceSamples.filter((sample) => sample.ts >= cutoff).slice(-10000);
  }

  tradeFlow(now = this.now(), windowMs = 5000) {
    this.prune(now);
    const trades = this.recentTrades.filter((trade) => now - trade.ts <= windowMs);
    const buyNotional = trades
      .filter((trade) => trade.aggressor === 'BUY')
      .reduce((sum, trade) => sum + trade.notional, 0);
    const sellNotional = trades
      .filter((trade) => trade.aggressor === 'SELL')
      .reduce((sum, trade) => sum + trade.notional, 0);
    const totalNotional = buyNotional + sellNotional;
    const first = trades[0];
    const last = trades.at(-1);
    return {
      windowMs,
      tradeCount: trades.length,
      buyCount: trades.filter((trade) => trade.aggressor === 'BUY').length,
      sellCount: trades.filter((trade) => trade.aggressor === 'SELL').length,
      buyNotional,
      sellNotional,
      totalNotional,
      imbalance: totalNotional > 0 ? (buyNotional - sellNotional) / totalNotional : null,
      priceChangePct: first && last && first.price > 0
        ? (last.price - first.price) / first.price
        : null,
    };
  }

  snapshot() {
    const now = this.now();
    return {
      source: 'Binance BTCUSDT aggregate trades',
      status: this.status,
      error: this.error,
      price: this.price,
      tickAt: this.tickAt,
      candleAt: this.candleAt || null,
      tickAgeMs: this.tickAt == null ? null : Math.max(0, now - this.tickAt),
      currentCandle: this.currentCandle ? { ...this.currentCandle } : null,
      previousClosedCandle: this.previousClosedCandle ? { ...this.previousClosedCandle } : null,
      priceSamples: this.priceSamples.slice(-1000).map((sample) => ({ ...sample })),
      tradeFlow: this.tradeFlow(now),
    };
  }

  stop() {
    this.started = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch (_) {}
    }
    this.status = 'STOPPED';
  }
}

module.exports = BinanceTickFeed;
module.exports.STREAM_URL = STREAM_URL;
