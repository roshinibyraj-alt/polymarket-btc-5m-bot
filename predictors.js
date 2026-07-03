// src/predictors.js — each predictor takes the current feed state and returns:
//   { name, direction: 'up' | 'down' | 'flat', confidence: 0..1, raw: <debug info> }
// confidence is a rough, self-reported strength, not a calibrated probability.
// Treat these as independent, cheap heuristics — combine them in strategies.js.

const config = require('../config');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function directionFromSign(x) {
  if (x > 0) return 'up';
  if (x < 0) return 'down';
  return 'flat';
}

// 1. Momentum: recent return over one or more lookback windows.
function momentumPredictor(feed) {
  const now = feed.lastPrice;
  if (!now) return { name: 'momentum', direction: 'flat', confidence: 0 };

  const scores = [];
  for (const secs of config.momentumLookbacks) {
    const trades = feed.getRecentTrades(secs);
    if (trades.length < 2) continue;
    const past = trades[0].price;
    const ret = (now - past) / past;
    scores.push(ret);
  }
  if (!scores.length) return { name: 'momentum', direction: 'flat', confidence: 0 };

  const avgRet = scores.reduce((a, b) => a + b, 0) / scores.length;
  const confidence = clamp(Math.abs(avgRet) / config.momentumThreshold, 0, 1);
  return { name: 'momentum', direction: directionFromSign(avgRet), confidence, raw: { avgRet } };
}

// 2. Order flow imbalance: aggressor buy volume vs sell volume in a recent window.
// Binance trade.isBuyerMaker=true means the taker was a SELLER (hit the bid).
function orderFlowPredictor(feed) {
  const trades = feed.getRecentTrades(config.orderFlowWindowSeconds);
  if (!trades.length) return { name: 'orderFlow', direction: 'flat', confidence: 0 };

  let buyVol = 0, sellVol = 0;
  for (const t of trades) {
    if (t.isBuyerMaker) sellVol += t.qty; // taker sold
    else buyVol += t.qty;                  // taker bought
  }
  const total = buyVol + sellVol;
  if (total === 0) return { name: 'orderFlow', direction: 'flat', confidence: 0 };

  const imbalance = (buyVol - sellVol) / total; // -1..1
  return {
    name: 'orderFlow',
    direction: directionFromSign(imbalance),
    confidence: clamp(Math.abs(imbalance), 0, 1),
    raw: { buyVol, sellVol, imbalance },
  };
}

// 3. Order book imbalance: resting bid depth vs ask depth near the top of book.
function orderBookPredictor(feed) {
  const { bids, asks } = feed.bookTop;
  if (!bids.length || !asks.length) return { name: 'orderBook', direction: 'flat', confidence: 0 };

  const bidDepth = bids.reduce((s, l) => s + l.qty, 0);
  const askDepth = asks.reduce((s, l) => s + l.qty, 0);
  const total = bidDepth + askDepth;
  if (total === 0) return { name: 'orderBook', direction: 'flat', confidence: 0 };

  const imbalance = (bidDepth - askDepth) / total;
  return {
    name: 'orderBook',
    direction: directionFromSign(imbalance),
    confidence: clamp(Math.abs(imbalance), 0, 1),
    raw: { bidDepth, askDepth, imbalance },
  };
}

// 4. Mean reversion: z-score of current price vs short moving average of 1m kline closes.
function meanReversionPredictor(feed) {
  const bars = feed.klines1m.slice(-config.meanReversionPeriod);
  if (bars.length < config.meanReversionPeriod || !feed.lastPrice) {
    return { name: 'meanReversion', direction: 'flat', confidence: 0 };
  }
  const closes = bars.map(b => b.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((s, c) => s + (c - mean) ** 2, 0) / closes.length;
  const std = Math.sqrt(variance);
  if (std === 0) return { name: 'meanReversion', direction: 'flat', confidence: 0 };

  const z = (feed.lastPrice - mean) / std;
  // Reversion bet: if price is stretched above mean (z>0), predict DOWN, and vice versa.
  const confidence = clamp(Math.abs(z) / config.meanReversionZCap, 0, 1);
  return {
    name: 'meanReversion',
    direction: directionFromSign(-z),
    confidence,
    raw: { z, mean, std },
  };
}

// 5. Volatility breakout: is the most recent bar's range much larger than the average
// range of preceding bars, with a directional close? If so, follow the breakout.
function volBreakoutPredictor(feed) {
  const bars = feed.klines1m.slice(-config.volBreakoutLookback - 1);
  if (bars.length < config.volBreakoutLookback + 1) {
    return { name: 'volBreakout', direction: 'flat', confidence: 0 };
  }
  const history = bars.slice(0, -1);
  const latest = bars[bars.length - 1];
  const avgRange = history.reduce((s, b) => s + (b.high - b.low), 0) / history.length;
  const latestRange = latest.high - latest.low;
  if (avgRange === 0) return { name: 'volBreakout', direction: 'flat', confidence: 0 };

  const ratio = latestRange / avgRange;
  const directional = latest.close - latest.open;
  if (ratio < 1.3 || directional === 0) {
    return { name: 'volBreakout', direction: 'flat', confidence: 0, raw: { ratio } };
  }
  const confidence = clamp((ratio - 1) / (config.volBreakoutRatioCap - 1), 0, 1);
  return {
    name: 'volBreakout',
    direction: directionFromSign(directional),
    confidence,
    raw: { ratio, directional },
  };
}

function runAllPredictors(feed) {
  return {
    momentum: momentumPredictor(feed),
    orderFlow: orderFlowPredictor(feed),
    orderBook: orderBookPredictor(feed),
    meanReversion: meanReversionPredictor(feed),
    volBreakout: volBreakoutPredictor(feed),
  };
}

module.exports = {
  momentumPredictor,
  orderFlowPredictor,
  orderBookPredictor,
  meanReversionPredictor,
  volBreakoutPredictor,
  runAllPredictors,
};
