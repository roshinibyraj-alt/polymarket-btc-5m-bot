'use strict';

const STREAM_URL = 'wss://data-stream.binance.vision/ws/btcusdt@kline_1m';
const KLINES_URL = 'https://data-api.binance.vision/api/v3/klines';
const CANDLE_MS = 60_000;
const HISTORY_LIMIT = 30;
const STALE_AFTER_MS = 5_000;

function parseRow(row) {
  return {
    start: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    closeAt: Number(row[6]),
    closed: true,
    source: 'BINANCE_1M_KLINE',
  };
}

function parseKline(kline) {
  return {
    start: Number(kline.t),
    open: Number(kline.o),
    high: Number(kline.h),
    low: Number(kline.l),
    close: Number(kline.c),
    closeAt: Number(kline.T),
    closed: Boolean(kline.x),
    source: 'BINANCE_1M_WEBSOCKET',
  };
}

class BinanceMinuteFeed {
  constructor({
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.status = 'WAITING';
    this.historyStatus = 'WAITING';
    this.error = null;
    this.price = null;
    this.tickAt = null;
    this.lastMessageAt = null;
    this.currentCandle = null;
    this.closedCandles = [];
    this.socket = null;
    this.retryTimer = null;
    this.historyTimer = null;
    this.stopped = true;
    this.reconnectCount = 0;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.refreshHistory().catch((error) => this.setError(error));
    this.historyTimer = setInterval(() => {
      this.refreshHistory().catch((error) => this.setError(error));
    }, 60_000);
    this.historyTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.historyTimer);
    clearTimeout(this.retryTimer);
    this.historyTimer = null;
    this.retryTimer = null;
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
    this.socket = null;
    this.status = 'STOPPED';
  }

  async refreshHistory() {
    if (typeof this.fetchImpl !== 'function') {
      this.historyStatus = 'ERROR';
      this.error = 'Fetch is unavailable for Binance one-minute candle history.';
      return;
    }
    const url = new URL(KLINES_URL);
    url.search = new URLSearchParams({
      symbol: 'BTCUSDT',
      interval: '1m',
      limit: String(HISTORY_LIMIT),
    }).toString();
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`Binance one-minute candle history failed (${response.status}).`);
      const rows = await response.json();
      const now = this.now();
      const closed = rows.map(parseRow)
        .filter((candle) => Number.isFinite(candle.start)
          && Number.isFinite(candle.closeAt)
          && candle.closeAt < now
          && candle.open > 0
          && candle.close > 0);
      const candlesByStart = new Map(this.closedCandles.map((candle) => [candle.start, candle]));
      for (const candle of closed) {
        if (!candlesByStart.has(candle.start)
          || candlesByStart.get(candle.start).source === 'BINANCE_1M_KLINE') {
          candlesByStart.set(candle.start, candle);
        }
      }
      this.closedCandles = [...candlesByStart.values()]
        .sort((a, b) => a.start - b.start)
        .slice(-HISTORY_LIMIT);
      const currentRow = rows.map(parseRow).find((candle) => candle.closeAt >= now);
      if (currentRow && currentRow.open > 0 && currentRow.close > 0
        && this.currentCandle?.start !== currentRow.start) {
        this.currentCandle = { ...currentRow, closed: false, source: 'BINANCE_1M_KLINE' };
        this.price = currentRow.close;
      }
      this.historyStatus = this.closedCandles.length >= 2 ? 'READY' : 'WAITING';
      if (this.historyStatus === 'READY') this.error = null;
      else this.error = 'Waiting for at least two completed one-minute BTC candles.';
    } catch (error) {
      this.historyStatus = this.closedCandles.length >= 2 ? 'READY' : 'ERROR';
      this.error = error?.message || 'Binance candle history request failed.';
    }
  }

  connect() {
    if (this.stopped) return;
    if (typeof this.WebSocketImpl !== 'function') {
      this.status = 'ERROR';
      this.error = 'WebSocket is unavailable in this Node runtime.';
      return;
    }
    this.status = 'CONNECTING';
    try {
      const socket = new this.WebSocketImpl(STREAM_URL);
      this.socket = socket;
      socket.addEventListener('open', () => {
        this.status = 'CONNECTED';
        this.error = null;
      });
      socket.addEventListener('message', (event) => this.handleMessage(event.data));
      socket.addEventListener('error', () => {
        this.error = 'Binance one-minute kline WebSocket reported an error.';
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null;
        if (this.stopped) return;
        this.status = 'RECONNECTING';
        this.reconnectCount += 1;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), 1_000);
        this.retryTimer.unref?.();
      });
    } catch (error) {
      this.setError(error);
      this.status = 'RECONNECTING';
      this.reconnectCount += 1;
      this.retryTimer = setTimeout(() => this.connect(), 1_000);
      this.retryTimer.unref?.();
    }
  }

  handleMessage(raw) {
    try {
      const message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
      const kline = message.k;
      if (!kline || kline.i !== '1m' || kline.s !== 'BTCUSDT') return;
      const candle = parseKline(kline);
      if (!(candle.start >= 0 && candle.open > 0 && candle.close > 0
        && Number.isFinite(candle.high) && Number.isFinite(candle.low))) return;
      const receivedAt = this.now();
      this.lastMessageAt = receivedAt;
      this.tickAt = Number(message.E) || receivedAt;
      this.price = candle.close;
      this.currentCandle = candle;
      if (candle.closed) {
        const existingIndex = this.closedCandles.findIndex((item) => item.start === candle.start);
        if (existingIndex >= 0) this.closedCandles[existingIndex] = candle;
        else this.closedCandles.push(candle);
        this.closedCandles.sort((a, b) => a.start - b.start);
        this.closedCandles = this.closedCandles.slice(-HISTORY_LIMIT);
        this.historyStatus = this.closedCandles.length >= 2 ? 'READY' : 'WAITING';
      }
    } catch (error) {
      this.setError(error);
    }
  }

  setError(error) {
    this.error = error instanceof Error ? error.message : String(error);
  }

  snapshot() {
    const messageAgeMs = this.lastMessageAt == null
      ? null
      : Math.max(0, this.now() - this.lastMessageAt);
    return {
      status: this.status,
      historyStatus: this.historyStatus,
      error: this.error,
      price: this.price,
      tickAt: this.tickAt,
      lastMessageAt: this.lastMessageAt,
      messageAgeMs,
      currentCandle: this.currentCandle ? { ...this.currentCandle } : null,
      closedCandles: this.closedCandles.map((candle) => ({ ...candle })),
      candleCounts: { '1m': this.closedCandles.length },
      reconnectCount: this.reconnectCount,
    };
  }
}

module.exports = BinanceMinuteFeed;
module.exports.STREAM_URL = STREAM_URL;
module.exports.KLINES_URL = KLINES_URL;
module.exports.STALE_AFTER_MS = STALE_AFTER_MS;
