'use strict';

// Demo stand-in for PolymarketTrader: reads the REAL public order book, simulates the fill
// (walks the asks up to the limit, exactly like the live FOK), and never signs or sends
// anything. No private key or wallet is touched.
const CLOB_HOST = 'https://clob.polymarket.com';

class DemoTrader {
  constructor() {
    this.address = 'DEMO MODE (no wallet, no real orders)';
    this.depositWallet = null;
    this._n = 0;
  }

  async getOrderBook(tokenId) {
    try {
      const res = await fetch(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  async placeFokLimitOrder(tokenId, side, price, size) {
    const book = await this.getOrderBook(tokenId);
    const selling = String(side).toUpperCase() === 'SELL';
    const levels = (selling ? ((book && book.bids) || []) : ((book && book.asks) || []))
      .map((level) => ({ p: parseFloat(level.price), s: parseFloat(level.size) }))
      .filter((level) => level.p > 0 && level.s > 0 && (selling ? level.p >= price : level.p <= price))
      .sort(selling ? (a, b) => b.p - a.p : (a, b) => a.p - b.p);
    let need = size, amount = 0;
    for (const level of levels) {
      const take = Math.min(need, level.s);
      amount += take * level.p;
      need -= take;
      if (need <= 1e-9) break;
    }
    if (need > 1e-9) {
      const bound = selling ? 'above ' : 'up to ';
      throw new Error('demo: only ' + (size - need).toFixed(0) + ' of ' + size + ' shares available ' + bound + price);
    }
    this._n += 1;
    const avgPrice = amount / size;
    const raw = selling
      ? { status: 'matched', makingAmount: String(size), takingAmount: String(amount) }
      : { status: 'matched', makingAmount: String(amount), takingAmount: String(size) };
    return { id: 'demo-' + this._n, status: 'matched', isFilled: true, avgPrice, raw };
  }

  async getOrder() { return { status: 'matched' }; }
  async getBalance() { return null; }
}

module.exports = DemoTrader;
