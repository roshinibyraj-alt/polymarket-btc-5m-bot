'use strict';

const BINANCE_STREAM_URL = 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade';
const BINANCE_KLINE_ENDPOINT = 'https://data-api.binance.vision/api/v3/klines';
const CANDLE_LOOKBACKS = Object.freeze({ '5m': 6, '15m': 4, '1h': 2 });
const CANDLE_REQUESTS = Object.freeze({
  '5m': { interval: '5m', limit: 7 },
  '15m': { interval: '15m', limit: 5 },
  '1h': { interval: '1h', limit: 3 },
});
const WINDOW_MS = 5 * 60 * 1000;

class BinanceTickFeed {
  constructor({
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    includeTradeFlow = true,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.status = 'WAITING';
    this.historyStatus = 'WAITING';
    this.error = null;
    this.price = null;
    this.tickAt = null;
    this.currentCandle = null;
    this.candles = [];
    this.candleSets = { '5m': [], '15m': [], '1h': [] };
    this.includeTradeFlow = includeTradeFlow;
    this.recentTrades = includeTradeFlow ? [] : null;
    this.socket = null;
    this.retryTimer = null;
    this.historyTimer = null;
    this.stopped = true;
    this.reconnectCount = 0;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refreshHistory();
    this.connect();
    this.historyTimer = setInterval(() => {
      this.refreshHistory().catch((error) => this.setError(error));
    }, 60 * 1000);
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
      this.error = 'Fetch is unavailable for Binance candle history.';
      return;
    }
    const now = this.now();
    const results = await Promise.all(Object.entries(CANDLE_REQUESTS).map(async ([timeframe, request]) => {
      const url = new URL(BINANCE_KLINE_ENDPOINT);
      url.search = new URLSearchParams({
        symbol: 'BTCUSDT',
        interval: request.interval,
        limit: String(request.limit),
      }).toString();
      try {
        const response = await this.fetchImpl(url.toString(), {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`Binance ${timeframe} candle request failed (${response.status}).`);
        const rows = await response.json();
        const closed = rows.map((row) => ({
          start: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          closeAt: Number(row[6]),
        })).filter((candle) => Number.isFinite(candle.start)
          && Number.isFinite(candle.closeAt)
          && candle.closeAt < now
          && candle.open > 0
          && candle.close > 0)
          .slice(-CANDLE_LOOKBACKS[timeframe]);
        return { timeframe, candles: closed, error: null };
      } catch (error) {
        return { timeframe, candles: null, error };
      }
    }));

    const errors = [];
    for (const result of results) {
      if (result.candles) this.candleSets[result.timeframe] = result.candles;
      else errors.push(result.error);
    }
    this.candles = this.candleSets['5m'];
    const ready = Object.entries(CANDLE_LOOKBACKS).every(([timeframe, count]) =>
      this.candleSets[timeframe].length >= count);
    try {
      const currentStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      const live = this.candleSets['5m'].find((candle) => candle.start === currentStart);
      if (live && (!this.currentCandle
        || this.currentCandle.start !== currentStart
        || this.currentCandle.openSource !== 'BINANCE_KLINE')) {
        this.currentCandle = {
          start: live.start,
          open: live.open,
          high: Math.max(live.high, this.currentCandle?.start === currentStart ? this.currentCandle.high : live.high),
          low: Math.min(live.low, this.currentCandle?.start === currentStart ? this.currentCandle.low : live.low),
          close: this.currentCandle?.start === currentStart ? this.currentCandle.close : live.close,
          openSource: 'BINANCE_KLINE',
        };
        if (this.price == null) this.price = live.close;
      }
      this.historyStatus = ready ? 'READY' : errors.length ? 'ERROR' : 'WAITING';
      this.error = errors.length
        ? errors.map((error) => error?.message || String(error)).join(' · ')
        : ready ? null : 'Waiting for enough fully closed BTC candles across 5m, 15m, and 1h.';
    } catch (error) {
      this.setError(error);
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
      const socket = new this.WebSocketImpl(BINANCE_STREAM_URL);
      this.socket = socket;
      socket.addEventListener('open', () => {
        this.status = 'CONNECTED';
        this.error = null;
      });
      socket.addEventListener('message', (event) => this.handleMessage(event.data));
      socket.addEventListener('error', () => {
        this.error = 'Binance tick stream reported a WebSocket error.';
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null;
        if (this.stopped) return;
        this.status = 'RECONNECTING';
        this.reconnectCount += 1;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), 1000);
      });
    } catch (error) {
      this.setError(error);
      this.status = 'RECONNECTING';
      this.reconnectCount += 1;
      this.retryTimer = setTimeout(() => this.connect(), 1000);
    }
  }

  handleMessage(raw) {
    try {
      const message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
      const price = Number(message.p);
      const tickAt = Number(message.T || message.E || this.now());
      if (!(price > 0) || !Number.isFinite(tickAt)) return;
      this.price = price;
      this.tickAt = tickAt;
      const quantity = Number(message.q);
      if (this.includeTradeFlow && quantity > 0 && typeof message.m === 'boolean') {
        this.recentTrades.push({
          price,
          quantity,
          notional: price * quantity,
          aggressor: message.m ? 'SELL' : 'BUY',
          timestamp: tickAt,
        });
        this.pruneRecentTrades(tickAt);
      }
      const start = Math.floor(tickAt / WINDOW_MS) * WINDOW_MS;
      if (!this.currentCandle || this.currentCandle.start !== start) {
        const previousStart = this.currentCandle?.start;
        this.currentCandle = {
          start,
          open: price,
          high: price,
          low: price,
          close: price,
          openSource: 'FIRST_TICK',
        };
        if (previousStart !== start) {
          void this.refreshHistory();
        }
      }
      this.currentCandle.high = Math.max(this.currentCandle.high, price);
      this.currentCandle.low = Math.min(this.currentCandle.low, price);
      this.currentCandle.close = price;
    } catch (error) {
      this.setError(error);
    }
  }

  setError(error) {
    this.error = error instanceof Error ? error.message : String(error);
  }

  pruneRecentTrades(now = this.now()) {
    this.recentTrades = this.recentTrades
      .filter((trade) => now - trade.timestamp <= 10_000)
      .slice(-5000);
  }

  tradeFlow(now = this.now()) {
    this.pruneRecentTrades(now);
    const trades = this.recentTrades.filter((trade) => trade.timestamp >= now - 5000);
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
      windowMs: 5000,
      tradeCount: trades.length,
      buyCount: trades.filter((trade) => trade.aggressor === 'BUY').length,
      sellCount: trades.filter((trade) => trade.aggressor === 'SELL').length,
      buyNotional,
      sellNotional,
      signedNotional: buyNotional - sellNotional,
      totalNotional,
      imbalance: totalNotional > 0 ? (buyNotional - sellNotional) / totalNotional : null,
      priceChangePct: first && last && first.price > 0
        ? (last.price - first.price) / first.price
        : null,
      firstTradeAt: first?.timestamp ?? null,
      lastTradeAt: last?.timestamp ?? null,
    };
  }

  snapshot() {
    const tickAgeMs = this.tickAt == null ? null : Math.max(0, this.now() - this.tickAt);
    return {
      status: this.status,
      historyStatus: this.historyStatus,
      error: this.error,
      price: this.price,
      tickAt: this.tickAt,
      tickAgeMs,
      currentCandle: this.currentCandle ? { ...this.currentCandle } : null,
      candles: this.candles.map((candle) => ({ ...candle })),
      candleSets: Object.fromEntries(Object.entries(this.candleSets)
        .map(([timeframe, candles]) => [timeframe, candles.map((candle) => ({ ...candle }))])),
      candleCounts: Object.fromEntries(Object.entries(this.candleSets)
        .map(([timeframe, candles]) => [timeframe, candles.length])),
      ...(this.includeTradeFlow ? { tradeFlow: this.tradeFlow() } : {}),
      reconnectCount: this.reconnectCount,
    };
  }
}

module.exports = BinanceTickFeed;
module.exports.BINANCE_STREAM_URL = BINANCE_STREAM_URL;
module.exports.BINANCE_KLINES_URL = `${BINANCE_KLINE_ENDPOINT}?symbol=BTCUSDT&interval=5m&limit=7`;
module.exports.CANDLE_LOOKBACKS = CANDLE_LOOKBACKS;
