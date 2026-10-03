'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../directional-bot');
const DemoTrader = require('../demo-trader');
const { makeWindowState } = require('../directional-bot');

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.calls = [];
    this.books = {
      up: {
        bids: [{ price: 0.29, size: 1000 }],
        asks: [{ price: 0.30, size: 1000 }],
      },
      down: {
        bids: [{ price: 0.29, size: 1000 }],
        asks: [{ price: 0.30, size: 1000 }],
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
    if (buying && Number(options.priceLimit) > 0) remaining /= Number(options.priceLimit);
    for (const level of levels) {
      if (buying) {
        if (Number(options.priceLimit) > 0) {
          const take = Math.min(remaining, level.size);
          shares += take;
          notional += take * level.price;
          remaining -= take;
        } else {
          const spend = Math.min(remaining, level.price * level.size);
          shares += spend / level.price;
          notional += spend;
          remaining -= spend;
        }
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
  if (options.seedHistory !== false) {
    const now = Date.now();
    bot._btcMoveHistory = Array.from(
      { length: cfg.BTC_MOVE_THRESHOLD_MIN_SAMPLES },
      (_, index) => ({ at: now - (index + 1) * 500, absMoveUsd: 2 }),
    );
  }
  const openTs = Math.floor(Date.now() / 1000) - cfg.ENTRY_DELAY_AFTER_WINDOW_START_SECONDS - 1;
  bot.w = makeWindowState('btc-updown-5m-' + openTs, openTs);
  bot.w.window = { tokenUp: 'up', tokenDown: 'down', closeTs: openTs + 300 };
  bot.w.status = 'waiting_for_price_entry';
  return { bot, trader };
}

test('an opposite signal does not sell or open a second position in the same window', async () => {
  const { bot, trader } = makeBot();
  trader.books.up.asks[0].price = 0.45;
  trader.books.up.asks[0].size = 100;
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start, exchange: 'kraken', symbol: 'BTC/USD' });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500, exchange: 'kraken', symbol: 'BTC/USD' });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000, exchange: 'kraken', symbol: 'BTC/USD' });

  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].side, 'UP');
  assert.equal(bot.pending[0].shares, 500);
  assert.equal(bot.ccxt.thresholdUsd, 2);
  assert.equal(bot.ccxt.thresholdReady, true);
  assert.equal(trader.calls.length, 1);
  assert.equal(trader.calls[0].tokenId, 'up');
  assert.equal(trader.calls[0].side, 'BUY');

  await bot._onBtcSample({ price: 79990, receivedAt: start + 1500, exchange: 'kraken', symbol: 'BTC/USD' });
  assert.equal(trader.calls.length, 1);
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['up', 'BUY']]);
  assert.equal(bot.pending.length, 1);
  assert.equal(bot.pending[0].side, 'UP');
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.openShares, 500);
  assert.equal(bot.w.position.simulatedLiquidityShares, 400);
  assert.equal(bot.log.find((entry) => entry.event === 'PRICE_BUY_FILLED').simulatedLiquidityShares, 400);
  assert.equal(bot.w.activeSignal.side, 'DOWN');
  assert.equal(bot.w.entryTaken, true);
});

test('price entry waits 180 seconds from window open', async () => {
  const { bot, trader } = makeBot();
  const nowSeconds = Math.floor(Date.now() / 1000);
  bot.w.openTs = nowSeconds - 179;
  bot.w.window.closeTs = bot.w.openTs + 300;
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });

  assert.equal(bot.trader.calls.length, 0);
  assert.equal(bot.w.activeSignal.side, 'UP');
  assert.equal(bot.w.status, 'waiting_for_window_delay');

  await bot._onQuote(bot.w.slug, 'up', { bid: 0.29, ask: 0.30 });
  assert.equal(trader.calls.length, 0);

  bot.w.openTs = Math.floor(Date.now() / 1000) - 180;
  bot.w.window.closeTs = bot.w.openTs + 300;
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.29, ask: 0.30 });
  assert.equal(trader.calls.length, 1);
  assert.equal(bot.w.position.side, 'UP');
});

test('a BUY respects the slippage cap inside the $0.20-$0.45 band', async () => {
  const { bot, trader } = makeBot();
  trader.books.up.asks = [
    { price: 0.20, size: 4 },
    { price: 0.30, size: 496 },
    { price: 0.46, size: 1000 },
  ];
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.19, ask: 0.20 });

  assert.equal(trader.calls.length, 1);
  assert.equal(trader.calls[0].priceLimit, 0.30);
  assert.equal(trader.calls[0].amount, 500 * 0.30);
  assert.equal(bot.w.position.shares, 500);
  assert.ok(bot.w.position.entryPrice >= 0.20);
  assert.ok(bot.w.position.entryPrice <= 0.30);
  assert.ok(Math.abs(bot.w.position.entryNotional - 149.6) < 1e-8);
});

test('price-only entry waits until either side has a best ask in the $0.20-$0.45 band', async () => {
  const { bot, trader } = makeBot();
  trader.books.up.asks = [{ price: 0.46, size: 1000 }];
  trader.books.down.asks = [{ price: 0.50, size: 1000 }];
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.45, ask: 0.46 });
  await bot._onQuote(bot.w.slug, 'down', { bid: 0.49, ask: 0.50 });
  assert.equal(trader.calls.length, 0);
  assert.equal(bot.w.status, 'waiting_for_price_band');
  assert.equal(bot.w.position, null);

  trader.books.up.asks = [{ price: 0.19, size: 1000 }];
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.18, ask: 0.19 });
  assert.equal(trader.calls.length, 0);

  trader.books.up.asks = [{ price: 0.45, size: 1000 }];
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.44, ask: 0.45 });
  assert.equal(trader.calls.length, 1);
  assert.equal(trader.calls[0].tokenId, 'up');
  assert.equal(trader.calls[0].priceLimit, 0.45);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.entryPrice, 0.45);
});

test('a best ask below $0.20 is outside the entry band', async () => {
  const { bot, trader } = makeBot();
  trader.books.up.asks = [{ price: 0.19, size: 1000 }];
  trader.books.down.asks = [{ price: 0.50, size: 1000 }];
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.18, ask: 0.19 });
  assert.equal(trader.calls.length, 0);
  assert.equal(bot.w.status, 'waiting_for_price_band');
  assert.equal(bot.w.position, null);
});

test('price-only entry can choose DOWN after the 180-second delay without a BTC signal', async () => {
  const { bot, trader } = makeBot();
  const nowSeconds = Math.floor(Date.now() / 1000);
  bot.w.openTs = nowSeconds - 179;
  bot.w.window.closeTs = bot.w.openTs + 300;
  trader.books.up.asks = [{ price: 0.50, size: 1000 }];
  trader.books.down.asks = [{ price: 0.30, size: 1000 }];

  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.equal(trader.calls.length, 0);
  assert.equal(bot.w.status, 'waiting_for_window_delay');
  assert.equal(bot.w.activeSignal, null);

  bot.w.openTs = nowSeconds - 180;
  bot.w.window.closeTs = bot.w.openTs + 300;
  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['down', 'BUY']]);
  assert.equal(bot.w.position.side, 'DOWN');
});

test('held-side CLOB midpoint at $0.99 settles remaining shares as a $1 win', async () => {
  const { bot, trader } = makeBot();
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });
  const cost = bot.w.position.cost;

  bot._onQuote(bot.w.slug, 'up', { bid: null, ask: 0.50 });
  assert.equal(bot.pending.length, 1);
  bot._onQuote(bot.w.slug, 'up', { bid: 0.97, ask: 0.99 });
  assert.equal(bot.pending.length, 1);
  bot._onQuote(bot.w.slug, 'up', { bid: 0.98, ask: 1 });

  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].outcome, 'WIN');
  assert.equal(bot.trades[0].reason, 'CLOB_THRESHOLD');
  assert.equal(bot.trades[0].winner, 'UP');
  assert.equal(bot.trades[0].exitProceeds, 500);
  assert.ok(Math.abs(bot.cash - (cfg.DEMO_CAPITAL - cost + 500)) < 1e-8);
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['up', 'BUY']]);
  assert.ok(bot.log.some((item) => item.event === 'CLOB_THRESHOLD_SETTLEMENT'));
});

test('held-side best bid at $0.01 settles remaining shares as a $0 loss', async () => {
  const { bot, trader } = makeBot();
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });
  const cashAfterEntry = bot.cash;

  bot._onQuote(bot.w.slug, 'up', { bid: 0.01, ask: 0.03 });
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].outcome, 'LOSS');
  assert.equal(bot.trades[0].reason, 'CLOB_THRESHOLD');
  assert.equal(bot.trades[0].winner, 'DOWN');
  assert.equal(bot.trades[0].exitProceeds, 0);
  const settlement = bot.log.find((item) => item.event === 'CLOB_THRESHOLD_SETTLEMENT');
  assert.equal(settlement.settlementBasis, 'BEST_BID');
  assert.equal(settlement.price, 0.01);
  assert.equal(bot.cash, cashAfterEntry);
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['up', 'BUY']]);
});

test('a best bid below $0.01 settles the loss even when midpoint remains above $0.01', async () => {
  const { bot } = makeBot();
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });

  bot._onQuote(bot.w.slug, 'up', { bid: 0.005, ask: 0.03 });

  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].outcome, 'LOSS');
  assert.equal(bot.trades[0].reason, 'CLOB_THRESHOLD');
  assert.ok(bot.log.find((item) => item.event === 'CLOB_THRESHOLD_SETTLEMENT')
    .note.includes('best bid reached $0.0050'));
});

test('after window close, CLOB threshold can settle before official resolution returns', async () => {
  const { bot, trader } = makeBot();
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });
  const position = bot.w.position;
  position.closeTs = Math.floor(Date.now() / 1000) - 1;
  bot.w.window.closeTs = position.closeTs;
  await bot._closeWindow(bot.w);
  trader.books.up.bids = [{ price: 0.98, size: 1000 }];
  trader.books.up.asks = [{ price: 1, size: 1000 }];

  await bot._settleClosedPositions(Date.now());

  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].reason, 'CLOB_THRESHOLD');
  assert.equal(bot.trades[0].outcome, 'WIN');
  assert.equal(bot._resolveTried.has(position.openTs), false);
});

test('a settled position cannot be re-entered in the same window', async () => {
  const trader = new FakeDemoTrader();
  trader.books.up.asks[0].price = 0.30;
  const { bot } = makeBot({ trader });
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80001, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });

  await bot._onBtcSample({ price: 79990, receivedAt: start + 1500 });
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['up', 'BUY']]);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.entryTaken, true);
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.98, ask: 1 });
  assert.equal(bot.w.position, null);
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades.length, 1);

  trader.books.down.asks[0].price = 0.30;
  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['up', 'BUY']]);
  assert.equal(bot.w.entryTaken, true);
  const snapshot = bot.snapshot();
  assert.ok(Math.abs(snapshot.account.totalPnl - snapshot.stats.realizedPnl) < 1e-8);
  assert.ok(Math.abs(snapshot.account.equity
    - (cfg.DEMO_CAPITAL + snapshot.account.totalPnl)) < 1e-8);
});

test('equity keeps a prior-window CLOB mark and reconciles to total P&L', async () => {
  const { bot } = makeBot();
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80004, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80010, receivedAt: start + 1000 });
  const oldWindow = bot.w;
  bot._onQuote(oldWindow.slug, 'up', { bid: 0.60, ask: 0.62 });
  bot.w = makeWindowState('next-window', oldWindow.openTs + 300);
  bot.w.window = { tokenUp: 'next-up', tokenDown: 'next-down', closeTs: oldWindow.openTs + 600 };
  bot.prices = {
    slug: bot.w.slug, ts: Date.now(),
    up: { bid: null, ask: null, mid: null },
    down: { bid: null, ask: null, mid: null },
  };

  const snapshot = bot.snapshot();
  assert.equal(snapshot.pending[0].mark, 0.60);
  assert.equal(snapshot.account.openValue, 300);
  assert.ok(Math.abs(snapshot.account.equity - (snapshot.account.cash + 300)) < 1e-8);
  assert.ok(Math.abs(snapshot.account.equity
    - (cfg.DEMO_CAPITAL + snapshot.stats.realizedPnl + snapshot.account.unrealizedPnl)) < 1e-8);
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

test('price-only entry does not require BTC threshold warm-up', async () => {
  const { bot, trader } = makeBot({ seedHistory: false });
  const start = Date.now();
  await bot._onBtcSample({ price: 80000, receivedAt: start });
  await bot._onBtcSample({ price: 80005, receivedAt: start + 500 });
  await bot._onBtcSample({ price: 80020, receivedAt: start + 1000 });
  assert.equal(bot.ccxt.thresholdReady, false);
  assert.equal(bot.ccxt.thresholdUsd, null);
  assert.equal(trader.calls.length, 0);

  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['down', 'BUY']]);
  assert.equal(bot.w.position.side, 'DOWN');
});

test('the live-mode guard blocks price entries and does not start the CCXT feed', async () => {
  const trader = new FakeDemoTrader();
  let starts = 0;
  const feed = { exchangeId: 'kraken', symbol: 'BTC/USD', start() { starts += 1; return () => {}; } };
  const bot = new Bot(trader, { live: true, ccxtFeed: feed });
  const now = Date.now();
  bot._btcMoveHistory = Array.from(
    { length: cfg.BTC_MOVE_THRESHOLD_MIN_SAMPLES },
    (_, index) => ({ at: now - (index + 1) * 500, absMoveUsd: 2 }),
  );
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
  assert.equal(snapshot.strategy.thresholdUsd, null);
  assert.equal(snapshot.strategy.thresholdReady, false);
  assert.equal(snapshot.strategy.thresholdMinSamples, 120);
  assert.equal(snapshot.strategy.thresholdWindowMs, 5 * 60 * 1000);
  assert.equal(snapshot.strategy.maxBuySlippagePercent, 50);
  assert.equal(snapshot.strategy.entryDelayAfterWindowStartSeconds, 180);
  assert.equal(snapshot.strategy.minEntryPrice, 0.20);
  assert.equal(snapshot.strategy.maxEntryPrice, 0.45);
  assert.equal(snapshot.strategy.sharesIncrementAfterLoss, 200);
  assert.equal(snapshot.strategy.lossStreak, 0);
  assert.equal(snapshot.strategy.nextEntryShares, 500);
  assert.equal('minBuyEntryPrice' in snapshot.strategy, false);
  assert.equal('maxBuyEntryPrice' in snapshot.strategy, false);
  assert.equal(snapshot.strategy.clobWinSettlementPrice, 0.99);
  assert.equal(snapshot.strategy.clobLossSettlementPrice, 0.01);
  assert.equal(snapshot.window.status, 'waiting_for_price_entry');
  assert.equal(snapshot.window.entryTaken, false);
});

test('losses add 200 shares to the next entry and one win resets to 500', async () => {
  const { bot, trader } = makeBot();
  const recordLoss = (openTs) => bot._finalizePosition({
    settled: false, slug: 'loss-' + openTs, openTs, side: 'UP',
    shares: 500, openShares: 0, entryPrice: 0.30, entryNotional: 150,
    entryFee: 0, exitFees: 0, exitProceeds: 0, realizedPnl: 0,
  }, 'LOSS', 'TEST');

  recordLoss(1);
  assert.equal(bot.snapshot().strategy.nextEntryShares, 700);
  recordLoss(2);
  assert.equal(bot.snapshot().strategy.nextEntryShares, 900);

  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.equal(bot.w.position.shares, 900);
  assert.equal(trader.calls[0].amount, 900 * 0.45);

  const winningPosition = bot.w.position;
  winningPosition.openShares = 0;
  winningPosition.exitProceeds = winningPosition.entryNotional + winningPosition.entryFee + 10;
  bot._finalizePosition(winningPosition, 'WIN', 'TEST');
  assert.equal(bot.snapshot().strategy.lossStreak, 0);
  assert.equal(bot.snapshot().strategy.nextEntryShares, 500);
});

test('demo BUY sweeps visible asks and models missing depth so every target share fills', async () => {
  const trader = new DemoTrader();
  const order = await trader.placeFakMarketOrder('up', 'BUY', 150, {
    priceLimit: 0.30, targetShares: 500,
    orderBook: { asks: [{ price: 0.20, size: 4 }, { price: 0.46, size: 1000 }], bids: [] },
  });

  assert.equal(order.status, 'matched');
  assert.equal(order.isFilled, true);
  assert.equal(order.raw.takingAmount, '500');
  assert.ok(Math.abs(Number(order.raw.makingAmount) - 149.6) < 1e-8);
  assert.equal(order.raw.requestedShares, '500');
  assert.equal(order.raw.simulatedLiquidityShares, '496');
  assert.ok(order.avgPrice <= 0.30);
});

test('default bot constructs the configured Coinbase feed at 500 ms', () => {
  const bot = new Bot(new FakeDemoTrader());
  assert.equal(bot.ccxtFeed.exchangeId, 'coinbase');
  assert.equal(bot.ccxtFeed.symbol, 'BTC/USD');
  assert.equal(bot.ccxtFeed.pollMs, 500);
  bot.stop();
});