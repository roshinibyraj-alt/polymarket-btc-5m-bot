'use strict';

// Demo trader reads the public CLOB and simulates immediate taker fills/resting maker exits.
// It never signs, sends an order, or accesses a wallet.
const CLOB_HOST = 'https://clob.polymarket.com';

class DemoTrader {
  constructor() {
    this.address = 'DEMO MODE (no wallet, no real orders)';
    this.depositWallet = null;
    this._n = 0;
    this.orders = new Map();
  }

  async prepareMarket() { return true; }

  async getOrderBook(tokenId) {
    try {
      const response = await fetch(CLOB_HOST + '/book?token_id=' + encodeURIComponent(tokenId));
      if (!response.ok) return null;
      return await response.json();
    } catch (_) { return null; }
  }

  async placeFakMarketOrder(tokenId, side, amount) {
    const book = await this.getOrderBook(tokenId);
    if (!book) return { id: null, status: 'unmatched', isFilled: false, avgPrice: 0, raw: {} };
    const buying = String(side).toUpperCase() === 'BUY';
    const levels = (buying ? (book.asks || []) : (book.bids || []))
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort(buying ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);
    let shares = 0;
    let notional = 0;
    let remaining = Math.max(0, Number(amount) || 0);
    for (const level of levels) {
      if (buying) {
        const spend = Math.min(remaining, level.price * level.size);
        shares += spend / level.price;
        notional += spend;
        remaining -= spend;
      } else {
        const take = Math.min(remaining, level.size);
        shares += take;
        notional += take * level.price;
        remaining -= take;
      }
      if (remaining <= 1e-9) break;
    }
    this._n += 1;
    const id = 'demo-' + this._n;
    const raw = buying
      ? { status: shares > 0 ? 'matched' : 'unmatched', makingAmount: String(notional), takingAmount: String(shares) }
      : { status: shares > 0 ? 'matched' : 'unmatched', makingAmount: String(shares), takingAmount: String(notional) };
    return { id, status: raw.status, isFilled: shares > 0, avgPrice: shares > 0 ? notional / shares : 0, raw };
  }

  async placeGtcOrder(tokenId, side, price, size) {
    const book = await this.getOrderBook(tokenId);
    const bestBid = Math.max(0, ...((book && book.bids) || []).map((level) => Number(level.price) || 0));
    if (String(side).toUpperCase() === 'SELL' && bestBid >= Number(price)) {
      throw new Error('demo: post-only order would take liquidity at the current best bid');
    }
    this._n += 1;
    const id = 'demo-maker-' + this._n;
    this.orders.set(id, { id, tokenId, side: String(side).toUpperCase(), price: Number(price), original_size: Number(size), size_matched: 0, status: 'LIVE' });
    return { id, status: 'LIVE' };
  }

  async getOrder(id) {
    const order = this.orders.get(id);
    if (!order) return null;
    if (order.status === 'LIVE' && order.side === 'SELL') {
      const book = await this.getOrderBook(order.tokenId);
      const bids = ((book && book.bids) || []).map((x) => ({ price: Number(x.price), size: Number(x.size) }))
        .filter((x) => x.price >= order.price && x.size > 0).sort((a, b) => b.price - a.price);
      const liquidity = bids.reduce((sum, x) => sum + x.size, 0);
      const add = Math.min(order.original_size - order.size_matched, liquidity);
      if (add > 0) order.size_matched += add;
      if (order.size_matched >= order.original_size - 1e-9) order.status = 'MATCHED';
    }
    return { ...order, price: String(order.price), original_size: String(order.original_size), size_matched: String(order.size_matched) };
  }

  async cancelOrder(id) {
    const order = this.orders.get(id);
    if (!order) return { canceled: [] };
    if (order.status === 'LIVE') order.status = 'CANCELED';
    return { canceled: [id] };
  }

  async cancelMarketOrders(tokenId) {
    for (const order of this.orders.values()) {
      if (order.tokenId === tokenId && order.status === 'LIVE') order.status = 'CANCELED';
    }
    return { canceled: true };
  }

  async getOpenOrders() {
    return [...this.orders.values()].filter((order) => order.status === 'LIVE').map((order) => ({ ...order }));
  }

  async getBalance() { return null; }
}

module.exports = DemoTrader;
