'use strict';

// All strategy constants live here. Real orders only when LIVE_TRADING=true (demo otherwise).
module.exports = {
  DEMO_CAPITAL: 5000,          // play-money starting balance in DEMO mode (USD)

  // Bollinger Bands, computed on BTC's own 5-minute candles (Binance public klines --
  // Polymarket's windows resolve BTC up/down but don't carry a BTC price history of their own).
  BB_SYMBOL: 'BTCUSDT',
  BB_INTERVAL: '5m',
  BB_PERIOD: 20,                // candles in the moving average
  BB_STDDEV: 2,                 // band width, in standard deviations

  // Position size by strategy state (see bollinger.js for the full state machine).
  SHARES_STAGE1: 200,           // just touched a band, heading back to the middle
  SHARES_STAGE2: 100,           // passed the middle band, heading to the far band
  SHARES_BREAK: 100,            // a band broke (candle closed beyond it) -- trade that side only

  // Who won a window: in the last END_WATCH_MS before it closes, a side priced above WIN_PRICE wins.
  // The other side is the loser (~0). No fallback: a window not seen ending >WIN_PRICE stays unknown.
  END_WATCH_MS: 3000,
  WIN_PRICE: 0.96,

  // Entry: no price filter. One order, ENTRY_DELAY_MS after the window opens, filled at any price.
  ENTRY_DELAY_MS: 3000,
  SIGNAL_DEADLINE_MS: 30000,   // if the Bollinger signal isn't ready within 30s of open, skip the window
  PRICE_CAP: 0.99,             // order limit = highest tick, so a fired order fills at any price

  TAKER_FEE_RATE: 0.07,        // fee = shares * rate * p * (1-p), used for P&L estimate only
};
