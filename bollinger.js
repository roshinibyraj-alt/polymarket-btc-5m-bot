'use strict';

/**
 * Bollinger Band strategy on BTC's 5-minute candles (Binance public klines --
 * Polymarket's 5-min windows don't carry a BTC price history of their own).
 *
 * Rules (as specified):
 *  - "Touch"  = a candle's wick reaches a band but the candle CLOSES back inside it -> fade
 *               back toward the middle band.
 *  - "Break"  = a candle CLOSES beyond a band -> follow that side instead of fading.
 *
 * States or        | signal | entry | shares | until
 * -----------------+--------+-------+--------+---------------------------------------
 *  NEUTRAL          | RSI    | opp.  | cfg    | first touch of either band
 *  UP_200           | UP     | DOWN  | 200    | close reaches the middle band
 *  UP_100           | UP     | DOWN  | 100    | wick touches the upper band (closes back inside)
 *  DOWN_200         | DOWN   | UP    | 200    | close reaches the middle band
 *  DOWN_100         | DOWN   | UP    | 100    | wick touches the lower band (closes back inside)
 *  BREAK_UP_100     | UP     | DOWN  | 100    | close comes back inside the upper band
 *  BREAK_DOWN_100   | DOWN   | UP    | 100    | close comes back inside the lower band
 */

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
  const url = 'https://api.binance.com/api/v3/klines?symbol=' + cfg.BB_SYMBOL
    + '&interval=' + cfg.BB_INTERVAL + '&limit=' + (limit + 1);
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
    const stream = 'wss://stream.binance.com:9443/ws/' + cfg.BB_SYMBOL.toLowerCase() + '@kline_' + cfg.BB_INTERVAL;
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

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stddev = (a, m) => Math.sqrt(mean(a.map((x) => (x - m) ** 2)));

/** RSI(period) for the most recently closed candle (classic average-gain/average-loss version). */
function computeRSI(candles, period) {
  if (candles.length < period + 1) return null;
  const closes = candles.slice(-(period + 1)).map((c) => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses += -d;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Bollinger Bands for the most recently closed candle, from the BB_PERIOD candles ending there. */
function computeBands(candles) {
  const period = cfg.BB_PERIOD;
  if (candles.length < period) return null;
  const window = candles.slice(-period);
  const closes = window.map((c) => c.close);
  const m = mean(closes), sd = stddev(closes, m);
  const candle = candles[candles.length - 1];
  return { openTs: candle.openTs, candle, middle: m, stddev: sd, upper: m + cfg.BB_STDDEV * sd, lower: m - cfg.BB_STDDEV * sd };
}

/** Advance the state machine by one newly-closed candle. */
function nextState(prevState, bands) {
  const { candle, upper, middle, lower } = bands;
  const brokeUpper = candle.close > upper;
  const brokeLower = candle.close < lower;
  const nearTouchDistance = cfg.BB_NEAR_TOUCH_SIGMA * (Number.isFinite(bands.stddev) ? bands.stddev : 0);
  const nearUpper = candle.close < candle.open && candle.high < upper && upper - candle.high <= nearTouchDistance;
  const nearLower = candle.close > candle.open && candle.low > lower && candle.low - lower <= nearTouchDistance;
  const touchedUpper = !brokeUpper && (candle.high >= upper || nearUpper);
  const touchedLower = !brokeLower && (candle.low <= lower || nearLower);

  if (brokeUpper) return 'BREAK_UP_100';
  if (brokeLower) return 'BREAK_DOWN_100';
  if (prevState === 'BREAK_UP_100') return 'DOWN_200';   // back inside from above -> fade down
  if (prevState === 'BREAK_DOWN_100') return 'UP_200';   // back inside from below -> fade up
  if (touchedUpper) return 'DOWN_200';
  if (touchedLower) return 'UP_200';
  if (prevState === 'UP_200' && candle.close >= middle) return 'UP_100';
  if (prevState === 'DOWN_200' && candle.close <= middle) return 'DOWN_100';
  return prevState || 'NEUTRAL';
}

const SIDE = {
  NEUTRAL: null,  // resolved per-window by the RSI filter in bot.js -- see sideForNeutral()
  UP_200: 'UP', UP_100: 'UP', BREAK_UP_100: 'UP',
  DOWN_200: 'DOWN', DOWN_100: 'DOWN', BREAK_DOWN_100: 'DOWN',
};
const SHARES = {
  NEUTRAL: 0,     // real size comes from cfg.SHARES_NEUTRAL once a side is picked -- see bot.js
  UP_200: cfg.SHARES_STAGE1, DOWN_200: cfg.SHARES_STAGE1,
  UP_100: cfg.SHARES_STAGE2, DOWN_100: cfg.SHARES_STAGE2,
  BREAK_UP_100: cfg.SHARES_BREAK, BREAK_DOWN_100: cfg.SHARES_BREAK,
};
const LABEL = {
  NEUTRAL: 'Neutral — RSI selects a signal; buying the opposite side at reduced size until a band is touched',
  UP_200: 'Lower band touched — signal UP, buy DOWN every window until the middle band',
  UP_100: 'Middle band reached from below — signal UP, buy DOWN (reduced size) until the upper band',
  DOWN_200: 'Upper band touched — signal DOWN, buy UP every window until the middle band',
  DOWN_100: 'Middle band reached from above — signal DOWN, buy UP (reduced size) until the lower band',
  BREAK_UP_100: 'Upper band broken — signal UP, buy DOWN until price closes back inside',
  BREAK_DOWN_100: 'Lower band broken — signal DOWN, buy UP until price closes back inside',
};

/** NEUTRAL tie-break: RSI < 50 signals UP; RSI >= 50 signals DOWN.
 * bot.js reverses that signal for the purchased side. Always returns a signal; the bot never sits out. */
function sideForNeutral(rsi) { return rsi == null || rsi < 50 ? 'UP' : 'DOWN'; }

module.exports = { fetchClosedCandles, startClosedCandleFeed, computeBands, computeRSI, nextState, sideForNeutral, SIDE, SHARES, LABEL };
