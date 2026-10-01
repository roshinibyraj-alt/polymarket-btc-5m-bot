'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Bot = require('../directional-bot');
const { makeWindowState } = require('../directional-bot');

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.calls = [];
    this.books = {
      up: {
        bids: [{ price: 0.49, size: 1000 }],
        asks: [{ price: 0.50, size: 1000 }],
      },
      down: {
        bids: [{ price: 0.49, size: 1000 }],
        asks: [{ price: 0.50, size: 1000 }],
      },
    };
  }

  async getOrderBook(tokenId) { return this.books[tokenId]; }

  async placeFakMarketOrder(tokenId, side, amount, options = {}) {
    this.calls.push({ tokenId, side, amount, priceLimit: options.priceLimit });
    const buying = side === 'BUY';
    const levels = (buying ? this.books[tokenId].asks : this.books[tokenId].bids)
      .filter((level) => !options.priceLimit
        || (buying ? level.price <= options.priceLimit : level.price >= options.priceLimit));
    let shares = 0;
    let notional = 0;
    let remaining = Number(amount);
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
    return {
      id: 'demo-' + this.calls.length,
      status: shares > 0 ? 'matched' : 'unmatched',
      isFilled: shares > 0,
      avgPrice: shares > 0 ? notional / shares : 0,
      raw: buying
        ? { makingAmount: String(notional), takingAmount: String(shares) }
        : { makingAmount: String(shares), takingAmount: String(notional) },
    };
  }

  async getBalance() { return null; }
}

function makeBot(options = {}) {
  const trader = options.trader || new FakeDemoTrader();
  const feed = {
    exchangeId: 'kraken', symbol: 'BTC/USD',
    start() { return () => {}; },
  };
  const bot = new Bot(trader, { live: !!options.live, ccxtFeed: feed });
  const openTs = Math.floor(Date.now() / 1000) - 1;
  bot.w = makeWindowState('btc-updown-5m-' + openTs, openTs);
  bot.w.window = { tokenUp: 'up', tokenDown: 'down', closeTs: openTs + 300 };
  bot.w.status = 'watching_signal';
  return { bot, trader };
}

test('a +$10 one-second move buys UP, then a -$10 move sells UP before buying DOWN', async () => {
  const { bot, trader } = makeBot();
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start, exchange: 'kraken', symbol: 'BTC/USD' });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500, exchange: 'kraken', symbol: 'BTC/USD' });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000, exchange: 'kraken', symbol: 'BTC/USD' });

  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].side, 'UP');
  assert.equal(bot.pending[0].shares, 500);
  assert.equal(trader.calls.length, 1);
  assert.equal(trader.calls[0].tokenId, 'up');
  assert.equal(trader.calls[0].side, 'BUY');

  await bot._onBtcSample({ price: 79990, receivedAt: start + 1500, exchange: 'kraken', symbol: 'BTC/USD' });
  assert.equal(trader.calls.length, 3);
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [
    ['up', 'BUY'], ['up', 'SELL'], ['down', 'BUY'],
  ]);
  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].side, 'DOWN');
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].reason, 'SIGNAL_REVERSAL');
  assert.equal(bot.w.position.side, 'DOWN');
});

test('a partial sell blocks opening the opposite side', async () => {
  const trader = new FakeDemoTrader();
  const { bot } = makeBot({ trader });
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80001, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });
  trader.books.up.bids[0].size = 100;

  await bot._onBtcSample({ price: 79990, receivedAt: start + 1500 });
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [
    ['up', 'BUY'], ['up', 'SELL'],
  ]);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.openShares, 400);
});

test('a delayed CCXT response is discarded and cannot trigger an order', async () => {
  const { bot, trader } = makeBot();
  const now = Date.now();
  await bot._onBtcSample({ price: 80000, sampledAt: now - 1500, receivedAt: now });
  await bot._onBtcSample({ price: 80020, sampledAt: now - 500, receivedAt: now + 1000 });
  assert.equal(bot.ccxt.status, 'stale');
  assert.equal(bot.pending.length, 0);
  assert.equal(trader.calls.length, 0);
});

test('the live-mode guard blocks signal orders and does not start the CCXT feed', async () => {
  const trader = new FakeDemoTrader();
  let starts = 0;
  const feed = { exchangeId: 'kraken', symbol: 'BTC/USD', start() { starts += 1; return () => {}; } };
  const bot = new Bot(trader, { live: true, ccxtFeed: feed });
  bot.w = makeWindowState('btc-test', Math.floor(Date.now() / 1000) - 1);
  bot.w.window = { tokenUp: 'up', tokenDown: 'down', closeTs: Math.floor(Date.now() / 1000) + 300 };

  bot.start();
  await bot._onBtcSample({ price: 80000, receivedAt: Date.now() });
  await bot._onBtcSample({ price: 80010, receivedAt: Date.now() + 1000 });
  bot.stop();
  assert.equal(starts, 0);
  assert.equal(trader.calls.length, 0);
});

test('snapshot exposes the feed and strategy settings', () => {
  const { bot } = makeBot();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.strategy.pollMs, 500);
  assert.equal(snapshot.strategy.thresholdUsd, 10);
  assert.equal(snapshot.window.status, 'watching_signal');
});

test('default bot constructs the configured Coinbase feed at 500 ms', () => {
  const bot = new Bot(new FakeDemoTrader());
  assert.equal(bot.ccxtFeed.exchangeId, 'coinbase');
  assert.equal(bot.ccxtFeed.symbol, 'BTC/USD');
  assert.equal(bot.ccxtFeed.pollMs, 500);
  bot.stop();
});