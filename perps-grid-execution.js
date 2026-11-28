'use strict';
const EPS = 1e-8;
const roundDown = (n, decimals) => Math.floor((n + 1e-12) * 10 ** decimals) / 10 ** decimals;

function normalizeBook(raw, id, now) {
  const at = Number(raw.timestamp);
  if (Number(raw.instrument_id) !== id || !Number.isFinite(at) || at > now || now - at > 15000)
    throw new Error('Stale, future or mismatched execution book');
  const result = { at };
  for (const side of ['bids', 'asks']) {
    if (!Array.isArray(raw[side])) throw new Error('Missing book side');
    result[side] = raw[side].map(l => ({
      price: Number(Array.isArray(l) ? l[0] : l.price),
      quantity: Number(Array.isArray(l) ? l[1] : l.quantity),
    }));
    if (result[side].some(l => !Number.isFinite(l.price) || !Number.isFinite(l.quantity)
      || l.price <= 0 || l.quantity < 0)
      || new Set(result[side].map(l => l.price)).size !== result[side].length)
      throw new Error('Invalid or duplicated execution depth');
    result[side].sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price);
  }
  if (result.bids.length && result.asks.length && result.bids[0].price >= result.asks[0].price)
    throw new Error('Crossed execution book');
  return result;
}

function availableBook(leg, book) {
  leg.consumedBook ||= { at: 0, bids: {}, asks: {} };
  const old = leg.consumedBook;
  if (book.at < old.at) throw new Error('Execution book moved backwards');
  if (book.at > old.at) {
    for (const side of ['bids', 'asks']) {
      const levels = {};
      for (const l of book[side]) {
        const prior = old[side][l.price];
        levels[l.price] = { seen: l.quantity, available: prior
          ? Math.min(l.quantity, prior.available + Math.max(0, l.quantity - prior.seen)) : l.quantity };
      }
      old[side] = levels;
    }
    old.at = book.at;
  }
  return old;
}

async function executePending(bot, leg) {
  const pending = leg.pending, now = bot.clock();
  if (!pending || now - pending.createdAt < 500) return;
  const book = normalizeBook(await bot.api.book(leg.instrumentId), leg.instrumentId, bot.clock());
  if (book.at < pending.createdAt || (pending.lastBookAt && book.at <= pending.lastBookAt)) {
    leg.decision = 'Waiting for a later execution book.'; return;
  }
  const consumed = availableBook(leg, book);
  const reducing = ['REDUCE', 'LIQUIDATE'].includes(pending.kind);
  const sign = (leg.direction === 'LONG' ? 1 : -1) * (reducing ? -1 : 1);
  const side = sign > 0 ? 'asks' : 'bids';
  const instrument = bot.state.instruments[String(leg.instrumentId)];
  const feeRate = bot.feeEngine.feeRate(instrument, 'TAKER')
    + (pending.kind === 'LIQUIDATE' ? Number(instrument.liquidationFee) : 0);
  if (!(feeRate >= 0 && feeRate < 1)) throw new Error('Invalid taker or liquidation fee');
  for (const l of book[side]) {
    const depth = consumed[side][l.price];
    let wanted = reducing ? Math.min(pending.quantityRemaining, leg.quantity)
      : pending.notionalRemaining / l.price;
    wanted = Math.min(wanted, depth.available);
    if (!reducing) {
      const a = bot.account();
      if (!a.equityKnown) break;
      const ownReserve = bot.reserve(pending);
      const free = a.freeMargin + ownReserve;
      const direction = leg.direction === 'LONG' ? 1 : -1;
      const unitRequirement = leg.mark / 5 + l.price * feeRate + direction * (l.price - leg.mark);
      wanted = Math.min(wanted, Math.max(0, free) / Math.max(EPS, unitRequirement));
      const nextNotional = (leg.quantity + wanted) * leg.mark;
      const tiers = instrument.riskTiers || [];
      const tier = tiers.filter(t => nextNotional >= Number(t.lower_bound))
        .sort((a, b) => Number(b.lower_bound) - Number(a.lower_bound))[0];
      if (tier && Number(tier.max_leverage) < 5) { leg.decision = 'Market risk tier rejects 5× leverage.'; break; }
    }
    const quantity = roundDown(wanted, instrument.quantityDecimals);
    if (!(quantity > 0)) continue;
    const notional = quantity * l.price, fee = notional * feeRate;
    let realizedPnl = 0;
    if (reducing) {
      realizedPnl = quantity * (leg.direction === 'LONG' ? 1 : -1) * (l.price - leg.entryPrice);
      leg.quantity = Math.max(0, leg.quantity - quantity);
      pending.quantityRemaining = Math.max(0, pending.quantityRemaining - quantity);
      pending.notionalRemaining = pending.quantityRemaining * leg.mark;
    } else {
      leg.entryPrice = (leg.quantity * (leg.entryPrice || 0) + notional) / (leg.quantity + quantity);
      leg.quantity += quantity;
      pending.notionalRemaining = Math.max(0, pending.notionalRemaining - notional);
    }
    depth.available = Math.max(0, depth.available - quantity);
    pending.filledNotional += notional; pending.filledQuantity += quantity;
    pending.fillCost += notional;
    bot.state.account.cash += realizedPnl - fee;
    bot.state.account.realizedPnl += realizedPnl; bot.state.account.fees += fee;
    bot.state.tradeCounter += 1;
    bot.state.trades.unshift({
      id: `grid-${bot.state.tradeCounter}`, timestamp: bot.clock(), symbol: leg.symbol,
      action: pending.kind, side: sign > 0 ? 'BUY' : 'SELL', quantity, price: l.price, notional,
      fee, realizedPnl, netRealizedPnl: realizedPnl - fee, level: pending.level,
      triggerPrice: pending.triggerPrice, unitValue: pending.unitValue,
      equityAtSignal: pending.equityAtSignal, reason: pending.reason, liquidity: 'TAKER',
    });
    if (pending.level != null) leg.levels[String(pending.level)].filledNotional = pending.filledNotional;
    if (reducing && leg.quantity <= EPS) {
      leg.quantity = 0; leg.closedPermanently = true;
      bot.event('SIDE_CLOSED', `${leg.symbol}: fully closed and will not reopen.`);
      break;
    }
    if (reducing ? pending.quantityRemaining <= EPS : pending.notionalRemaining < l.price * 10 ** -instrument.quantityDecimals) break;
  }
  pending.lastBookAt = book.at;
  const remainderSmall = reducing ? pending.quantityRemaining < 10 ** -instrument.quantityDecimals
    : pending.notionalRemaining < (book[side][0]?.price || leg.mark) * 10 ** -instrument.quantityDecimals;
  if (remainderSmall || leg.closedPermanently) bot.finish(leg);
  else {
    leg.decision = `Partial/waiting ${pending.kind}: $${pending.notionalRemaining.toFixed(2)} exposure remains.`;
    if (!reducing && bot.account().freeMargin + bot.reserve(pending) < 1) {
      if (pending.filledQuantity > 0) bot.finish(leg, 'PARTIAL');
      else {
        if (pending.level != null) delete leg.levels[String(pending.level)];
        leg.pending = null; leg.decision = 'Addition skipped: insufficient margin; retry only if margin frees.';
      }
    }
  }
}

module.exports = { executePending, normalizeBook, roundDown };
