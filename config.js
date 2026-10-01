'use strict';

module.exports = {
  DEMO_CAPITAL: 10000,
  ENTRY_RUNGS: [
    { entryPrice: 0.45, takeProfitPrice: 0.55 },
    { entryPrice: 0.40, takeProfitPrice: 0.60 },
    { entryPrice: 0.35, takeProfitPrice: 0.65 },
    { entryPrice: 0.30, takeProfitPrice: 0.70 },
  ],
  SECOND_FILL_TAKE_PROFIT_PRICE: 0.99,
  BASE_SHARES: 500,
  ENTRY_RETRY_MS: 750,
  LOOP_MS: 100,
  ORDER_STATUS_POLL_MS: 500,
  PRICE_FEED_FALLBACK_MS: 1000,
  PRICE_STALE_MS: 2500,
  SETTLEMENT_POLL_MS: 1000,
  RESOLUTION_RETRY_MS: 5000,
  SETTLEMENT_GIVE_UP_MS: 15 * 60_000,
  MAKER_FEE_RATE: 0,
  CRYPTO_TAKER_FEE_RATE: 0.07,
  CRYPTO_MAKER_REBATE_POOL_SHARE: 0.20,
};
