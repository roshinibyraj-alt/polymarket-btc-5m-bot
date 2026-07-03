// src/paperEngine.js — simulates a binary (UP/DOWN) market per strategy with a
// configurable spread standing in for Polymarket's real YES/NO order book.
// Swap `quotePrice()` for a real Polymarket CLOB fetch when you're ready to go live.

const fs = require('fs');
const config = require('../config');

function quotePrice(side) {
  // Simple symmetric-spread model: buying either side costs slightly more than fair
  // value (0.5) to approximate the round-trip cost of crossing the spread.
  return 0.5 + config.simulatedSpread / 2;
}

class StrategyLedger {
  constructor(name) {
    this.name = name;
    this.bankroll = config.startingBankrollPerStrategy;
    this.trades = [];       // history of resolved trades
    this.openPosition = null; // { side, stake, price, shares, windowStart }
    this.wins = 0;
    this.losses = 0;
  }

  place(side, confidence, windowStart) {
    if (this.openPosition) return; // one position per window
    const price = quotePrice(side);
    const stakeFraction = Math.min(config.maxStakeFraction, config.maxStakeFraction * confidence);
    const stake = this.bankroll * stakeFraction;
    if (stake <= 0) return;
    const fee = stake * config.simulatedFee;
    const netStake = stake - fee;
    const shares = netStake / price;
    this.openPosition = { side, stake, price, shares, windowStart, confidence };
    this.bankroll -= stake; // deduct stake now; settle on resolution
  }

  resolve(actualDirection, openPrice, closePrice) {
    if (!this.openPosition) return null;
    const pos = this.openPosition;
    const won = pos.side === actualDirection;
    const payout = won ? pos.shares * 1.0 : 0;
    const pnl = payout - pos.stake;
    this.bankroll += payout;
    if (won) this.wins++; else this.losses++;

    const record = {
      windowStart: pos.windowStart,
      side: pos.side,
      confidence: pos.confidence,
      stake: pos.stake,
      price: pos.price,
      won,
      pnl,
      openPrice,
      closePrice,
      bankrollAfter: this.bankroll,
    };
    this.trades.push(record);
    this.openPosition = null;
    return record;
  }

  stats() {
    const total = this.wins + this.losses;
    const winRate = total ? this.wins / total : 0;
    const totalPnl = this.bankroll - config.startingBankrollPerStrategy;
    const roi = totalPnl / config.startingBankrollPerStrategy;
    return { name: this.name, bankroll: this.bankroll, trades: total, wins: this.wins, losses: this.losses, winRate, totalPnl, roi };
  }
}

class PaperEngine {
  constructor(strategyNames) {
    this.ledgers = {};
    for (const name of strategyNames) this.ledgers[name] = new StrategyLedger(name);
  }

  placeTrade(strategyName, side, confidence, windowStart) {
    this.ledgers[strategyName].place(side, confidence, windowStart);
  }

  resolveAll(actualDirection, openPrice, closePrice) {
    const results = {};
    for (const [name, ledger] of Object.entries(this.ledgers)) {
      const rec = ledger.resolve(actualDirection, openPrice, closePrice);
      if (rec) results[name] = rec;
    }
    return results;
  }

  summary() {
    return Object.values(this.ledgers).map(l => l.stats());
  }

  persist() {
    const snapshot = {
      updatedAt: new Date().toISOString(),
      strategies: this.summary(),
      trades: Object.fromEntries(
        Object.entries(this.ledgers).map(([name, l]) => [name, l.trades])
      ),
    };
    fs.writeFileSync(config.resultsFile, JSON.stringify(snapshot, null, 2));
  }
}

module.exports = { PaperEngine, quotePrice };
