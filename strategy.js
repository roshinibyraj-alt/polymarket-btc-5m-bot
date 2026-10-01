'use strict';

function buyLimitTouched(bestAsk, limitPrice) {
  const ask = Number(bestAsk);
  const limit = Number(limitPrice);
  return Number.isFinite(ask) && Number.isFinite(limit) && ask > 0 && ask <= limit;
}

function takeProfitTouched(bestBid, limitPrice) {
  const bid = Number(bestBid);
  const limit = Number(limitPrice);
  return Number.isFinite(bid) && Number.isFinite(limit) && bid > 0 && bid >= limit;
}

module.exports = { buyLimitTouched, takeProfitTouched };