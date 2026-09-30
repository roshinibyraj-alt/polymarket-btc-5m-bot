'use strict';

/** Closed BTC candle feed used to classify the candle immediately before each market window. */

const cfg = require('./config');
const https = require('node:https');
const WebSocket = require('ws');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const error = new Error('Binance HTTP ' + res.statusCode + ': ' + data.slice(0, 200));
          error.statusCode = res.statusCode;
          const banMatch = data.match(/banned until\s+(\d{13})/i);
          let retryAt = banMatch ? Number(banMatch[1]) : 0;
          const retryAfter = res.headers && res.headers['retry-after'];
          if (retryAfter) {
            const seconds = Number(retryAfter);
            const headerAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter);
            if (Number.isFinite(headerAt)) retryAt = Math.max(retryAt, headerAt);
          }
          if (retryAt > 0) error.retryAt = retryAt;
          reject(error);
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Binance bad JSON: ' + e.message)); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Binance request timed out')));
    req.on('error', reject);
  });
}

/** Last `limit` CLOSED 5-minute BTC candles, oldest first. Used only to seed history. */
async function fetchClosedCandles(limit) {
  const url = 'https://api.binance.com/api/v3/klines?symbol=' + cfg.CANDLE_SYMBOL
    + '&interval=' + cfg.CANDLE_INTERVAL + '&limit=' + (limit + 1);
  const raw = await httpGetJson(url);
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('Binance returned no candle history');
  const closed = raw.slice(0, -1);
  return closed.map((k) => ({ openTs: Math.floor(Number(k[0]) / 1000), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) }));
}

/**
 * Seed historical candles once, then follow Binance's kline WebSocket stream.
 * REST retries are backed off and honor Binance's ban/Retry-After timestamp.
 */
function startClosedCandleFeed(limit, onCandles, onError = () => {}) {
  if (typeof onCandles !== 'function') throw new TypeError('onCandles must be a function');
  let candles = [];
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let seedRetryTimer = null;
  let reconnectDelayMs = 1000;
  let seedRetryDelayMs = 60000;
  const maxCandles = Math.max(limit * 4, 200);

  function report(error) {
    if (stopped) return;
    try { onError(error instanceof Error ? error : new Error(String(error))); } catch (_) {}
  }

  function publish() {
    if (stopped) return;
    try { onCandles(candles.slice()); } catch (error) { report(error); }
  }

  function merge(batch) {
    let changed = false;
    const byOpen = new Map(candles.map((c) => [c.openTs, c]));
    for (const candle of batch) {
      if (!Number.isFinite(candle.openTs) || !Number.isFinite(candle.open) || !Number.isFinite(candle.high)
        || !Number.isFinite(candle.low) || !Number.isFinite(candle.close)) continue;
      const previous = byOpen.get(candle.openTs);
      if (!previous || previous.high !== candle.high || previous.low !== candle.low || previous.close !== candle.close) {
        byOpen.set(candle.openTs, candle);
        changed = true;
      }
    }
    if (!changed) return;
    candles = [...byOpen.values()].sort((a, b) => a.openTs - b.openTs).slice(-maxCandles);
    publish();
  }

  async function seed() {
    try {
      const history = await fetchClosedCandles(limit);
      if (stopped) return;
      merge(history);
    } catch (error) {
      if (stopped) return;
      report(error);
      const now = Date.now();
      let delay = seedRetryDelayMs;
      if (error.retryAt && error.retryAt > now) delay = error.retryAt - now + 1000;
      else if (error.statusCode === 418) delay = Math.max(delay, 5 * 60 * 1000);
      seedRetryDelayMs = Math.min(Math.max(seedRetryDelayMs * 2, 60000), 15 * 60 * 1000);
      seedRetryTimer = setTimeout(seed, Math.min(delay, 2147000000));
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (stopped) return;
    const stream = 'wss://stream.binance.com:9443/ws/' + cfg.CANDLE_SYMBOL.toLowerCase() + '@kline_' + cfg.CANDLE_INTERVAL;
    try {
      socket = new WebSocket(stream);
    } catch (error) {
      report(new Error('Binance WebSocket connection failed: ' + error.message));
      scheduleReconnect();
      return;
    }
    socket.on('open', () => { reconnectDelayMs = 1000; });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const k = message && message.k;
        if (!k || !k.x) return;
        merge([{ openTs: Math.floor(Number(k.t) / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c) }]);
      } catch (error) {
        report(new Error('Binance WebSocket message error: ' + error.message));
      }
    });
    socket.on('error', (error) => report(new Error('Binance WebSocket error: ' + error.message)));
    socket.on('close', () => { if (!stopped) scheduleReconnect(); });
  }

  void seed();
  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(seedRetryTimer);
    if (socket) { try { socket.close(); } catch (_) {} }
  };
}

module.exports = { fetchClosedCandles, startClosedCandleFeed };
