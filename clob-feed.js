'use strict';

const WebSocket = require('ws');

const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const MAX_RECONNECT_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const CONNECTION_STALE_MS = 45_000;

function parseLevels(levels) {
  const result = new Map();
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = Number(level?.price);
    const size = Number(level?.size);
    if (Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0) {
      result.set(price, size);
    }
  }
  return result;
}

function orderedLevels(levels, descending = false) {
  return [...levels.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

class ClobMarketFeed {
  constructor({
    assetIds = [],
    WebSocketImpl = WebSocket,
    now = Date.now,
    onQuote = () => {},
    onStatus = () => {},
    heartbeatMs = HEARTBEAT_MS,
    connectionStaleMs = CONNECTION_STALE_MS,
  } = {}) {
    this.assetIds = [...new Set(assetIds.map(String).filter(Boolean))];
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.onQuote = onQuote;
    this.onStatus = onStatus;
    this.heartbeatMs = heartbeatMs;
    this.connectionStaleMs = connectionStaleMs;
    this.socket = null;
    this.started = false;
    this.status = 'STOPPED';
    this.error = null;
    this.lastMessageAt = null;
    this.reconnectCount = 0;
    this.reconnectDelay = 1_000;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.staleTimer = null;
    this.books = new Map();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop() {
    this.started = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.staleTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.staleTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.books.clear();
    this.status = 'STOPPED';
    this.error = null;
    if (socket) {
      try { socket.close(); } catch (_) {}
    }
    this.notifyStatus();
  }

  connect() {
    if (!this.started || !this.assetIds.length) return;
    this.status = 'CONNECTING';
    this.notifyStatus();
    let socket;
    try {
      socket = new this.WebSocketImpl(MARKET_WS);
      this.socket = socket;
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }

    socket.on('open', () => {
      if (this.socket !== socket || !this.started) return;
      this.status = 'CONNECTED';
      this.error = null;
      this.reconnectDelay = 1_000;
      this.lastMessageAt = this.now();
      socket.send(JSON.stringify({
        assets_ids: this.assetIds,
        type: 'market',
        custom_feature_enabled: true,
      }));
      this.startConnectionTimers(socket);
      this.notifyStatus();
    });

    socket.on('message', (raw) => {
      if (this.socket !== socket) return;
      this.handleMessage(raw);
    });

    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      this.status = 'ERROR';
      this.error = error?.message || 'Polymarket CLOB WebSocket error';
      this.notifyStatus();
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearConnectionTimers();
      this.clearBooks();
      if (this.started) this.scheduleReconnect(new Error('Polymarket CLOB WebSocket disconnected'));
      else {
        this.status = 'STOPPED';
        this.notifyStatus();
      }
    });
  }

  startConnectionTimers(socket) {
    this.clearConnectionTimers();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket === socket && socket.readyState === (this.WebSocketImpl.OPEN ?? 1)) {
        try { socket.send('PING'); } catch (_) {}
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.staleTimer = setInterval(() => {
      if (this.socket === socket
        && this.lastMessageAt != null
        && this.now() - this.lastMessageAt > this.connectionStaleMs) {
        try { socket.terminate(); } catch (_) {}
      }
    }, Math.min(this.heartbeatMs, 5_000));
    this.staleTimer.unref?.();
  }

  clearConnectionTimers() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.staleTimer);
    this.heartbeatTimer = null;
    this.staleTimer = null;
  }

  scheduleReconnect(error) {
    if (!this.started || this.reconnectTimer) return;
    this.status = 'RECONNECTING';
    this.error = error?.message || 'Polymarket CLOB WebSocket disconnected';
    this.reconnectCount += 1;
    this.notifyStatus();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  handleMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (text === 'PONG') {
      this.lastMessageAt = this.now();
      return;
    }
    if (text === 'PING') {
      this.lastMessageAt = this.now();
      try { this.socket?.send('PONG'); } catch (_) {}
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.error = `Invalid Polymarket CLOB WebSocket message: ${error.message}`;
      this.notifyStatus();
      return;
    }
    this.lastMessageAt = this.now();
    this.error = null;
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      this.handleEvent(event, this.lastMessageAt);
    }
  }

  handleEvent(event, receivedAt) {
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.type;
    if (type === 'book') {
      const assetId = String(event.asset_id || event.assetId || '');
      if (!this.assetIds.includes(assetId)) return;
      this.books.set(assetId, {
        bids: parseLevels(event.bids),
        asks: parseLevels(event.asks),
        updatedAt: receivedAt,
        exchangeTimestamp: event.timestamp ?? null,
      });
      this.publish(assetId);
      return;
    }

    if (type === 'price_change') {
      for (const change of event.price_changes || event.priceChanges || []) {
        const assetId = String(change.asset_id || change.assetId || change.token_id || change.tokenId || '');
        if (!this.assetIds.includes(assetId)) continue;
        const book = this.books.get(assetId);
        if (!book) continue; // Wait for a full snapshot after connect/reconnect.
        const price = Number(change.price);
        const size = Number(change.size);
        if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(size)) continue;
        const side = String(change.side || '').toUpperCase();
        const levels = side === 'BUY' ? book.bids : side === 'SELL' ? book.asks : null;
        if (!levels) continue;
        if (size <= 0) levels.delete(price);
        else levels.set(price, size);
        book.updatedAt = receivedAt;
        book.exchangeTimestamp = event.timestamp ?? null;
        this.publish(assetId);
      }
    }
  }

  publish(assetId) {
    const quote = this.getQuote(assetId);
    if (!quote) return;
    try { this.onQuote(assetId, quote); } catch (error) {
      this.error = `CLOB quote handler failed: ${error.message || String(error)}`;
      this.notifyStatus();
    }
  }

  clearBooks() {
    this.books.clear();
    for (const assetId of this.assetIds) {
      try { this.onQuote(assetId, null); } catch (_) {}
    }
  }

  getQuote(assetId) {
    const book = this.books.get(String(assetId));
    if (!book) return null;
    const bidLevels = orderedLevels(book.bids, true);
    const askLevels = orderedLevels(book.asks);
    const bestBid = bidLevels[0] || null;
    const bestAsk = askLevels[0] || null;
    return {
      status: bestBid && bestAsk ? 'LIVE' : 'MISSING',
      stale: false,
      source: 'POLYMARKET_CLOB_WEBSOCKET',
      bestBid: bestBid?.price ?? null,
      bidSize: bestBid?.size ?? 0,
      bestAsk: bestAsk?.price ?? null,
      askSize: bestAsk?.size ?? 0,
      mid: bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null,
      bidLevels,
      askLevels,
      updatedAt: book.updatedAt,
      exchangeTimestamp: book.exchangeTimestamp,
      error: null,
    };
  }

  snapshot() {
    const now = this.now();
    const quoteAgesMs = {};
    for (const assetId of this.assetIds) {
      const quote = this.books.get(assetId);
      quoteAgesMs[assetId] = quote ? Math.max(0, now - quote.updatedAt) : null;
    }
    return {
      source: 'Polymarket CLOB market WebSocket',
      endpoint: MARKET_WS,
      status: this.status,
      connected: this.status === 'CONNECTED',
      error: this.error,
      assetCount: this.assetIds.length,
      lastMessageAt: this.lastMessageAt,
      lastMessageAgeMs: this.lastMessageAt == null ? null : Math.max(0, now - this.lastMessageAt),
      reconnectCount: this.reconnectCount,
      quoteAgesMs,
    };
  }

  notifyStatus() {
    try { this.onStatus(this.snapshot()); } catch (_) {}
  }
}

module.exports = ClobMarketFeed;
module.exports.MARKET_WS = MARKET_WS;
