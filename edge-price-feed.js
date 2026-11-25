'use strict';

const BinanceMinuteFeed = require('./binance-minute-feed');
const STREAM = 'wss://data-stream.binance.vision/stream?streams=btcusdt@aggTrade/btcusdt@kline_1m';

// Candles seed volatility; only live aggregate trades establish current-price freshness.
class EdgePriceFeed extends BinanceMinuteFeed {
  constructor(options = {}) {
    super({ ...options, streamUrl: STREAM, historyLimit: 120 });
    this.tradeAt = null;
    this.tradeReceivedAt = null;
    this.tradePrice = null;
    this.lastTradeId = null;
    this.points = [];
    this.watchdog = null;
    this.connectedStartAt = null;
  }

  async start() {
    if (!this.stopped) return;
    await super.start();
    this.connectedStartAt = this.now();
    this.watchdog = setInterval(() => {
      const age = this.now() - (this.tradeReceivedAt || this.connectedStartAt);
      if (age > 15_000 && this.socket) {
        this.connectedStartAt = this.now();
        this.tradeReceivedAt = null;
        try { this.socket.close(); } catch {}
      }
    }, 5000);
    this.watchdog.unref?.();
  }

  stop() {
    clearInterval(this.watchdog);
    this.watchdog = null;
    super.stop();
  }

  handleMessage(raw) {
    try {
      const envelope = JSON.parse(String(raw?.data ?? raw));
      const data = envelope.data || envelope;
      if (data.k) {
        super.handleMessage(JSON.stringify(data));
        return;
      }
      if (data.e !== 'aggTrade' || data.s !== 'BTCUSDT') return;
      const at = Number(data.T);
      const price = Number(data.p);
      if (!(price > 0) || !Number.isFinite(at) || at > this.now() + 1000) return;
      if (this.tradeAt != null && at < this.tradeAt) return;
      if (data.a != null && Number(data.a) === this.lastTradeId) return;
      this.lastTradeId = Number(data.a);
      this.tradePrice = price;
      this.tradeAt = at;
      this.tradeReceivedAt = this.now();
      const second = Math.floor(at / 1000) * 1000;
      if (this.points.at(-1)?.at === second) this.points[this.points.length - 1] = { at: second, price };
      else this.points.push({ at: second, price });
      this.points = this.points.filter(p => p.at >= at - 10 * 60_000).slice(-601);
    } catch (error) {
      this.setError(error);
    }
  }

  snapshot() {
    return {
      ...super.snapshot(),
      price: this.tradePrice,
      tickAt: this.tradeAt,
      receivedAt: this.tradeReceivedAt,
      messageAgeMs: this.tradeReceivedAt == null ? null
        : Math.max(this.now() - this.tradeReceivedAt, this.now() - this.tradeAt, 0),
      points: this.points.map(p => ({ ...p })),
    };
  }
}

module.exports = EdgePriceFeed;
