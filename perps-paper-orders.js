'use strict';

const LIMIT_WAIT_MS = 5 * 60_000;
const MAX_BOOK_AGE_MS = 15_000;
const CONFIGURED_LEVERAGE = 5;

// Deliberately conservative snapshot simulation: equality alone never fills a
// previously resting order. Strict trade-through depth is required. This does
// not claim to reproduce an exchange queue or activity between snapshots.
class PaperOrderEngine {
  constructor(bot) {
    this.bot = bot;
  }

  queue(instrument, delta, price, meta) {
    const b = this.bot;
    const quantity = b.roundOrderSize(Math.abs(delta), instrument.quantityDecimals);
    if (!(quantity > 0) || !(price > 0)) return false;
    if (quantity * price < Number(instrument.minNotional || 0)) {
      b.addEvent('ORDER_BELOW_MINIMUM', `${instrument.symbol}: copied size is below the market minimum; no fill invented.`);
      return false;
    }
    if (Number(instrument.maxLeverage || 5) < CONFIGURED_LEVERAGE) {
      b.addEvent('UNSUPPORTED_LEVERAGE', `${instrument.symbol}: market does not support 5×; no order placed.`);
      return false;
    }
    const now = b.clock();
    b.state.orderCounter += 1;
    b.state.orders.push({
      id: `paper-order:${b.state.orderCounter}`,
      instrumentId: instrument.id, symbol: instrument.symbol,
      side: delta > 0 ? 'BUY' : 'SELL',
      quantity, remaining: quantity, filled: 0,
      limitPrice: price, createdAt: now, expiresAt: now + LIMIT_WAIT_MS,
      status: 'PENDING', phase: 'LIMIT', attempted: false,
      ...meta,
    });
    b.addEvent('LIMIT_PLACED', `${instrument.symbol}: ${delta > 0 ? 'BUY' : 'SELL'} ${quantity} limit @ ${price}; force remainder after 5 minutes.`);
    return true;
  }

  cancelOpposing(id, signedDelta) {
    // A master reduction must not leave an unfilled old entry able to reopen
    // exposure later. Cancel only the overlapping unfilled quantity; filled
    // exposure still gets its own master-priced exit order.
    const b = this.bot;
    let remaining = Math.abs(signedDelta);
    for (const order of b.state.orders) {
      if (String(order.instrumentId) !== String(id) || !(order.remaining > 0)
        || (order.side === 'BUY' ? 1 : -1) === Math.sign(signedDelta)) continue;
      const cancel = Math.min(order.remaining, remaining);
      order.remaining = b.roundOrderSize(order.remaining - cancel, b.state.instruments[String(id)]?.quantityDecimals);
      order.cancelledQuantity = (order.cancelledQuantity || 0) + cancel;
      order.quantity -= cancel;
      remaining -= cancel;
      if (order.remaining <= 0) {
        order.status = 'CANCELLED';
        order.completedAt = b.clock();
      }
      b.addEvent('SUPERSEDED_ORDER_CANCELLED', `${order.symbol}: cancelled ${cancel} unfilled ${order.side}; master reversed or reduced exposure.`);
      if (remaining <= 0) break;
    }
  }

  projectedSize(id) {
    const b = this.bot;
    return (b.findPosition(id)?.size || 0) + b.state.orders
      .filter(o => String(o.instrumentId) === String(id) && o.remaining > 0)
      .reduce((sum, o) => sum + (o.side === 'BUY' ? 1 : -1) * o.remaining, 0);
  }

  feeRate(instrument, liquidity) {
    const b = this.bot;
    const rows = b.state.execution.feeSchedule;
    const override = instrument.feeOverride;
    const now = b.clock();
    if (override && now >= Number(override.start_time || 0)
      && (override.end_time == null || now < Number(override.end_time))) {
      const rate = Number(override.tiers?.[0]?.[liquidity === 'MAKER' ? 'maker_fee_rate' : 'taker_fee_rate']);
      if (!Number.isFinite(rate)) throw new Error(`Invalid active fee override for ${instrument.symbol}.`);
      return rate;
    }
    const row = rows.find(r => r.instrument_type === 'perpetual' && r.category === instrument.category);
    if (!row) {
      if (!['crypto', 'index', 'commodity', 'equity'].includes(instrument.category)) {
        throw new Error(`No verified fee schedule for ${instrument.symbol} (${instrument.category}); order retained.`);
      }
      // The live endpoint currently publishes only equity. Do not silently
      // pretend that rate was returned for other categories: explicitly label
      // their estimate from the official published global starting-tier table.
      b.state.execution.feeEstimates[instrument.category] = 'Published standard tier-0 estimate; category absent from live fee API';
      return liquidity === 'MAKER' ? 0.0002 : 0.0005;
    }
    const tier = (row.tiers || []).find(t => Number(t.min_volume_30d) === 0) || row;
    const rate = Number(tier[liquidity === 'MAKER' ? 'maker_fee_rate' : 'taker_fee_rate']);
    if (!Number.isFinite(rate)) throw new Error(`Invalid fee schedule for ${instrument.symbol}.`);
    return rate;
  }

  affordableQuantity(instrument, sign, price, requested, rate) {
    const b = this.bot;
    b.recalculateAccount();
    const current = b.findPosition(instrument.id)?.size || 0;
    const closing = Math.sign(current) === -sign ? Math.min(requested, Math.abs(current)) : 0;
    if (closing >= requested) return requested; // Reductions must remain possible in margin call.
    const mark = b.findPosition(instrument.id)?.markPrice || price;
    const equityAfterClose = b.state.account.equity
      + sign * (mark - price) * closing - closing * price * Math.max(0, rate);
    const marginAfterClose = b.state.account.initialMargin - closing * mark / CONFIGURED_LEVERAGE;
    const available = Math.max(0, equityAfterClose - marginAfterClose);
    const opening = Math.min(requested - closing, available / (price / CONFIGURED_LEVERAGE + price * Math.max(0, rate) + Math.abs(mark - price)));
    return b.roundOrderSize(closing + opening, instrument.quantityDecimals);
  }

  async process() {
    const b = this.bot;
    const ids = [...new Set(b.state.orders.filter(o => o.remaining > 0).map(o => String(o.instrumentId)))];
    const errors = [];
    // Sequential per instrument keeps request pressure bounded and shares each
    // snapshot's liquidity among all orders rather than spending it repeatedly.
    for (const id of ids) {
      try {
        const book = await b.api.book(id);
        const receivedAt = b.clock();
        const timestamp = Number(book.timestamp);
        if (!Number.isFinite(timestamp) || receivedAt - timestamp > MAX_BOOK_AGE_MS || timestamp > receivedAt + 2000) {
          throw new Error(`Stale or invalid book for instrument ${id}; no fill invented.`);
        }
        const key = `${book.sequence ?? ''}:${timestamp}`;
        if (b.state.execution.lastBooks[id] === key) continue;
        const sides = {};
        for (const side of ['bids', 'asks']) {
          if (!Array.isArray(book[side])) throw new Error(`Invalid ${side} for instrument ${id}.`);
          sides[side] = book[side].map(level => ({
            price: Number(Array.isArray(level) ? level[0] : level.price),
            quantity: Number(Array.isArray(level) ? level[1] : level.quantity),
          })).filter(l => l.price > 0 && l.quantity > 0 && Number.isFinite(l.price) && Number.isFinite(l.quantity))
            .sort((a, c) => side === 'asks' ? a.price - c.price : c.price - a.price);
        }
        b.state.execution.lastBooks[id] = key;
        const orders = b.state.orders.filter(o => String(o.instrumentId) === id && o.remaining > 0);
        for (const order of orders) {
          if (timestamp < order.createdAt) continue;
          const instrument = b.state.instruments[id];
          if (!instrument) throw new Error(`Instrument metadata missing for ${id}.`);
          const firstAttempt = !order.attempted;
          if (receivedAt >= order.expiresAt && order.phase !== 'MARKET') {
            order.phase = 'MARKET';
            order.forcedAt = receivedAt;
            b.addEvent('LIMIT_EXPIRED', `${order.symbol}: limit cancelled; market sweep for remaining ${order.remaining}.`);
          }
          const sign = order.side === 'BUY' ? 1 : -1;
          const levels = sides[sign > 0 ? 'asks' : 'bids'];
          // Marketable-on-arrival limits remove liquidity and pay taker fees.
          const liquidity = order.phase === 'MARKET' || firstAttempt ? 'TAKER' : 'MAKER';
          const rate = this.feeRate(instrument, liquidity);
          for (const level of levels) {
            const within = sign > 0 ? level.price <= order.limitPrice : level.price >= order.limitPrice;
            const through = sign > 0 ? level.price < order.limitPrice : level.price > order.limitPrice;
            if (order.phase !== 'MARKET' && !(firstAttempt ? within : through)) break;
            if (level.quantity <= 0 || order.remaining <= 0) continue;
            const price = liquidity === 'MAKER' ? order.limitPrice : level.price;
            const wanted = Math.min(order.remaining, level.quantity);
            const quantity = this.affordableQuantity(instrument, sign, price, wanted, rate);
            if (!(quantity > 0)) {
              order.blockedReason = 'Insufficient 5× initial margin including fees';
              break;
            }
            b.executePaperDelta(instrument, sign * quantity, price, {
              sourceFillId: order.sourceFillId,
              sourceTimestamp: order.sourceTimestamp,
              sourceSide: order.sourceSide,
              orderId: order.id,
              executionPrice: price,
              feeRate: rate,
              liquidity,
              executionType: order.phase === 'MARKET' ? 'FORCED_MARKET' : 'LIMIT',
              masterPrice: order.limitPrice,
              feeSource: b.state.execution.feeEstimates[instrument.category] || 'Official fee API / active instrument override, standard tier 0',
            });
            level.quantity = Math.max(0, level.quantity - quantity);
            order.remaining = b.roundOrderSize(order.remaining - quantity, instrument.quantityDecimals);
            order.filled = b.roundOrderSize(order.quantity - order.remaining, instrument.quantityDecimals);
            order.lastFillAt = receivedAt;
            order.blockedReason = null;
            if (quantity < wanted) {
              order.blockedReason = 'Insufficient 5× initial margin including fees';
              break;
            }
          }
          order.attempted = true;
          order.status = order.remaining <= 0 ? 'FILLED' : order.filled > 0 ? 'PARTIAL' : 'PENDING';
          if (order.remaining <= 0) {
            order.completedAt = receivedAt;
            b.addEvent('ORDER_FILLED', `${order.symbol}: ${order.side} ${order.filled} completed (${order.phase}).`);
          } else if (order.phase === 'MARKET' && !order.blockedReason) {
            order.blockedReason = 'Awaiting sufficient fresh market depth';
          }
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    // Keep all outstanding orders across restarts plus the newest 250 completed.
    const done = b.state.orders.filter(o => o.remaining <= 0).slice(-250);
    b.state.orders = [...done, ...b.state.orders.filter(o => o.remaining > 0)];
    if (errors.length) throw new Error(errors.slice(0, 3).join('; '));
  }
}

module.exports = { PaperOrderEngine, CONFIGURED_LEVERAGE, LIMIT_WAIT_MS };
