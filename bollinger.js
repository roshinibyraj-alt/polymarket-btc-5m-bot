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
 * States or        | traded | shares | until
 * -----------------+--------+--------+---------------------------------------
 *  NEUTRAL          | none   | 0      | first touch of either band
 *  UP_200           | UP     | 200    | close reaches the middle band
 *  UP_100           | UP     | 100    | wick touches the upper band (closes back inside)
 *  DOWN_200         | DOWN   | 200    | close reaches the middle band
 *  DOWN_100         | DOWN   | 100    | wick touches the lower band (closes back inside)
 *  BREAK_UP_100     | UP     | 100    | close comes back inside the upper band
 *  BREAK_DOWN_100   | DOWN   | 100    | close comes back inside the lower band
 */

const cfg = require('./config');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    require('https').get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Binance HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Binance bad JSON: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/** Last `limit` CLOSED 5-min BTC candles, oldest first: {openTs (sec), high, low, close}. */
async function fetchClosedCandles(limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${cfg.BB_SYMBOL}&interval=${cfg.BB_INTERVAL}&limit=${limit + 1}`;
  const raw = await httpGetJson(url);
  const closed = raw.slice(0, -1); // Binance's last row is the still-forming candle -- drop it
  return closed.map((k) => ({ openTs: Math.floor(k[0] / 1000), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
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
  return { openTs: candle.openTs, candle, middle: m, upper: m + cfg.BB_STDDEV * sd, lower: m - cfg.BB_STDDEV * sd };
}

/** Advance the state machine by one newly-closed candle. */
function nextState(prevState, bands) {
  const { candle, upper, middle, lower } = bands;
  const brokeUpper = candle.close > upper;
  const brokeLower = candle.close < lower;
  const touchedUpper = !brokeUpper && candle.high >= upper;
  const touchedLower = !brokeLower && candle.low <= lower;

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
  NEUTRAL: 'Neutral — no band touched yet; trading the RSI-favored side at reduced size until one is',
  UP_200: 'Lower band touched — buying UP every window until the middle band',
  UP_100: 'Middle band reached from below — buying UP (reduced size) until the upper band',
  DOWN_200: 'Upper band touched — buying DOWN every window until the middle band',
  DOWN_100: 'Middle band reached from above — buying DOWN (reduced size) until the lower band',
  BREAK_UP_100: 'Upper band broken — trading UP only until price closes back inside',
  BREAK_DOWN_100: 'Lower band broken — trading DOWN only until price closes back inside',
};

/** NEUTRAL tie-break: RSI < 50 (softer recent momentum) leans toward a reversion-up call,
 * RSI >= 50 leans down. Always returns a side -- the bot fires every window, never sits out. */
function sideForNeutral(rsi) { return rsi == null || rsi < 50 ? 'UP' : 'DOWN'; }

module.exports = { fetchClosedCandles, computeBands, computeRSI, nextState, sideForNeutral, SIDE, SHARES, LABEL };
