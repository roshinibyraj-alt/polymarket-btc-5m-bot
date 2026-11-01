'use strict';

const cfg = require('./config');

function isMarketConfused(up, down, now = Date.now()) {
  const fresh = (quote) => quote?.status === 'LIVE'
    && Number.isFinite(quote.updatedAt)
    && now >= quote.updatedAt
    && now - quote.updatedAt <= 5000
    && Number.isFinite(Number(quote.mid));
  if (!fresh(up) || !fresh(down)) {
    return { eligible: false, upMid: null, downMid: null, reason: 'Waiting for fresh UP and DOWN quotes' };
  }
  const upMid = Number(up.mid);
  const downMid = Number(down.mid);
  const eligible = [upMid, downMid].every((price) =>
    price >= cfg.MARKET_CONFUSION_MIN_PRICE && price <= cfg.MARKET_CONFUSION_MAX_PRICE);
  return {
    eligible, upMid, downMid,
    reason: eligible ? 'Both fresh outcome midpoints are in the confusion band'
      : 'One or both outcome midpoints are outside the confusion band',
  };
}

module.exports = { isMarketConfused };
