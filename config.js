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
  BB_NEAR_TOUCH_SIGMA: 0.1,      // directional near-miss tolerance in standard deviations

  // Position size by strategy state (see bollinger.js for the full state machine).
  SHARES_STAGE1: 200,           // just touched a band, heading back to the middle
  SHARES_STAGE2: 100,           // passed the middle band, heading to the far band
  SHARES_BREAK: 100,            // a band broke (candle closed beyond it) -- trade that side only
  SHARES_NEUTRAL: 100,          // before the first band touch -- side picked by the RSI filter below

  // RSI is only used to break a NEUTRAL Bollinger state; first entry has no price-confirmation filter.
  RSI_PERIOD: 14,                // RSI on the same BTC 5m candles, used only to break the NEUTRAL state

  // Who won a window: in the last END_WATCH_MS before it closes, a side priced above WIN_PRICE wins,
  // and the other side is the loser (~0), counted as $1/share won, $0/share lost. If no side crosses
  // WIN_PRICE in time, the bot decides at the moment the window actually closes by comparing the last
  // known UP vs DOWN price -- whichever is higher wins. Either way every window gets a winner, so every
  // pending bet always settles (no more stuck trades). Still 100% our own price reads, no Polymarket API.
  END_WATCH_MS: 3000,
  WIN_PRICE: 0.95,          // checked from 297s onward (WINDOW_SECONDS - END_WATCH_MS)

  // Entry: wait at least 3s, then keep watching the whole window for a signalled-side ask at or below $0.40.
  ENTRY_DELAY_MS: 3000,
  SIGNAL_DEADLINE_MS: 30000,   // skip only if the Bollinger signal is not ready within 30s of open
  PRICE_CAP: 0.40,             // maximum BUY limit; the FOK order cannot pay more than $0.40
  EXIT_PRICE_FLOOR: 0.01,       // sell floor when closing a position on a reversal
  REVERSAL_RETRY_MS: 3000,      // retry an unfilled reversal after 3 seconds

  TAKER_FEE_RATE: 0.07,        // fee = shares * rate * p * (1-p), used for P&L estimate only
};
