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
    exchangeId: 'kraken', symbol: 'BTC/USD', pollMs: cfg.CCXT_POLL_MS,
    start() { return () => {}; },
  };
  const bot = new Bot(trader, { live: !!options.live, ccxtFeed: feed });
  const openTs = Math.floor(Date.now() / 1000) - 170;
  bot.w = makeWindowState('btc-updown-5m-' + openTs, openTs);
  bot.w.window = { tokenUp: 'up', tokenDown: 'down', closeTs: openTs + 300 };
  bot.w.status = 'waiting_for_baseline';
  return { bot, trader };
}

function projectionSignal(bot, side = 'UP') {
  const baselinePrice = 85000;
  const projectedClose = baselinePrice + (side === 'UP' ? 10 : -10);
  const projection = {
    phase: 'projection_ready', baselinePrice,
    initialDriftUsdPer10s: 0.667,
    recentRateUsdPer10s: side === 'UP' ? 1 : -1,
    projectedClose, projectedDeltaUsd: projectedClose - baselinePrice,
    remainingSeconds: 130, observedAt: Date.now(), trendToMs: Date.now(),
    side, currentPrice: baselinePrice,
  };
  const signal = {
    side, changeUsd: projection.projectedDeltaUsd,
    baselinePrice, projectedClose,
    initialDriftUsdPer10s: projection.initialDriftUsdPer10s,
    recentRateUsdPer10s: projection.recentRateUsdPer10s,
    remainingSeconds: projection.remainingSeconds,
    ts: projection.observedAt, projection,
  };
  bot.w.baselinePrice = baselinePrice;
  bot.w.projection = projection;
  bot.w.activeSignal = signal;
  bot.w.lastSignal = signal;
  bot.activeSignal = signal;
  return signal;
}

async function enterWithProjection(bot, side = 'UP') {
  return bot._attemptPriceEntry(bot.w, side, projectionSignal(bot, side));
}

async function feedSyntheticTrend(bot, initialMoveUsd, futureRateUsdPer10s, throughSeconds = 170) {
  const openMs = bot.w.openTs * 1000;
  const baselinePrice = 85000;
  const send = async (elapsedMs) => {
    const price = elapsedMs < 150_000
      ? baselinePrice + initialMoveUsd * elapsedMs / 150_000
      : baselinePrice + initialMoveUsd + futureRateUsdPer10s * (elapsedMs - 150_000) / 10_000;
    const sampledAt = openMs + elapsedMs;
    await bot._onBtcSample({ price, sampledAt, receivedAt: sampledAt, exchange: 'kraken', symbol: 'BTC/USD' });
  };
  await bot._onBtcSample({ price: baselinePrice, sampledAt: openMs - 500, receivedAt: openMs - 500, exchange: 'kraken', symbol: 'BTC/USD' });
  for (let elapsedMs = 0; elapsedMs <= throughSeconds * 1000; elapsedMs += 500) await send(elapsedMs);
}

test('prior close and 150-second average feed a DOWN projection when the future trend crosses below baseline', async () => {
  const { bot, trader } = makeBot();
  await feedSyntheticTrend(bot, 10, -1, 170);
  assert.equal(bot.w.baselinePrice, 85000);
  assert.ok(Math.abs(bot.w.projection.initialDriftUsdPer10s - (10 / 15)) < 0.01);
  assert.ok(bot.w.projection.recentRateUsdPer10s < 0);
  assert.ok(bot.w.projection.projectedClose < bot.w.baselinePrice);
  assert.equal(bot.w.position.side, 'DOWN');
  assert.equal(trader.calls[0].tokenId, 'down');
});

test('the opposite rolling projection buys UP when it forecasts above the previous close', async () => {
  const { bot, trader } = makeBot();
  await feedSyntheticTrend(bot, -10, 1, 170);
  assert.ok(bot.w.projection.projectedClose > bot.w.baselinePrice);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(trader.calls[0].tokenId, 'up');
});

test('no entry occurs before two complete future ten-second blocks', async () => {
  const { bot, trader } = makeBot();
  await feedSyntheticTrend(bot, 10, -1, 169.5);
  assert.equal(bot.w.position, null);
  assert.equal(trader.calls.length, 0);
  const at170 = bot.w.openTs * 1000 + 170_000;
  await bot._onBtcSample({
    price: 85008, sampledAt: at170, receivedAt: at170,
    exchange: 'kraken', symbol: 'BTC/USD',
  });
  assert.equal(bot.w.position.side, 'DOWN');
  assert.equal(trader.calls.length, 1);
});

test('a Polymarket quote alone cannot enter without a BTC close projection', async () => {
  const { bot, trader } = makeBot();
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.29, ask: 0.30 });
  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.equal(trader.calls.length, 0);
  assert.equal(bot.w.position, null);
});

test('only the projected side can buy, and the $0.45 ask cap remains in force', async () => {
  const { bot, trader } = makeBot();
  trader.books.down.asks[0].price = 0.46;
  await enterWithProjection(bot, 'DOWN');
  assert.equal(trader.calls.length, 0);
  assert.equal(bot.w.status, 'waiting_for_price_cap');
  trader.books.down.asks[0].price = 0.45;
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.29, ask: 0.30 });
  assert.equal(trader.calls.length, 0);
  await bot._onQuote(bot.w.slug, 'down', { bid: 0.44, ask: 0.45 });
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['down', 'BUY']]);
  assert.equal(bot.w.position.side, 'DOWN');
  assert.equal(bot.w.position.entryPrice, 0.45);
});

test('the new strategy does not impose the old $0.20 minimum ask', async () => {
  const { bot, trader } = makeBot();
  trader.books.up.asks = [{ price: 0.19, size: 1000 }];
  await enterWithProjection(bot, 'UP');
  assert.equal(trader.calls.length, 1);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.entryPrice, 0.19);
});

test('missing previous-close data skips a window instead of inventing a baseline', async () => {
  const { bot, trader } = makeBot();
  const at = bot.w.openTs * 1000 + 10_000;
  await bot._onBtcSample({ price: 85010, sampledAt: at, receivedAt: at });
  assert.equal(bot.w.baselinePrice, null);
  assert.equal(bot.w.status, 'waiting_for_baseline');
  assert.equal(trader.calls.length, 0);
  assert.ok(bot.log.some((item) => item.event === 'BTC_BASELINE_MISSING'));
});

test('held-side CLOB midpoint at $0.99 settles remaining shares as a $1 win', async () => {
  const { bot, trader } = makeBot();
  await enterWithProjection(bot, 'UP');
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
  await enterWithProjection(bot, 'UP');
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
  await enterWithProjection(bot, 'UP');
  bot._onQuote(bot.w.slug, 'up', { bid: 0.005, ask: 0.03 });
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].outcome, 'LOSS');
  assert.equal(bot.trades[0].reason, 'CLOB_THRESHOLD');
  assert.ok(bot.log.find((item) => item.event === 'CLOB_THRESHOLD_SETTLEMENT')
    .note.includes('best bid reached $0.0050'));
});

test('after window close, CLOB threshold can settle before official resolution returns', async () => {
  const { bot, trader } = makeBot();
  await enterWithProjection(bot, 'UP');
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
  const { bot } = makeBot({ trader });
  await enterWithProjection(bot, 'UP');
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.entryTaken, true);
  bot._onQuote(bot.w.slug, 'up', { bid: 0.98, ask: 1 });
  assert.equal(bot.w.position, null);
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades.length, 1);
  await bot._handleProjection(projectionSignal(bot, 'DOWN').projection);
  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['up', 'BUY']]);
  assert.equal(bot.w.entryTaken, true);
  const snapshot = bot.snapshot();
  assert.ok(Math.abs(snapshot.account.totalPnl - snapshot.stats.realizedPnl) < 1e-8);
  assert.ok(Math.abs(snapshot.account.equity - (cfg.DEMO_CAPITAL + snapshot.account.totalPnl)) < 1e-8);
});

test('equity keeps a prior-window CLOB mark and reconciles to total P&L', async () => {
  const { bot } = makeBot();
  await enterWithProjection(bot, 'UP');
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

test('a delayed CCXT response is discarded and cannot create a baseline or order', async () => {
  const { bot, trader } = makeBot();
  const now = Date.now();
  await bot._onBtcSample({ price: 80000, sampledAt: now - 1500, receivedAt: now });
  await bot._onBtcSample({ price: 80020, sampledAt: now + 500, receivedAt: now + 1000 });
  assert.equal(bot.ccxt.status, 'live');
  assert.equal(bot.w.baselinePrice, null);
  assert.equal(bot.pending.length, 0);
  assert.equal(trader.calls.length, 0);
});

test('the live-mode guard blocks projected entries and does not start the CCXT feed', async () => {
  const trader = new FakeDemoTrader();
  let starts = 0;
  const feed = { exchangeId: 'kraken', symbol: 'BTC/USD', pollMs: 500, start() { starts += 1; return () => {}; } };
  const bot = new Bot(trader, { live: true, ccxtFeed: feed });
  bot.w = makeWindowState('btc-test', Math.floor(Date.now() / 1000) - 1);
  bot.w.window = { tokenUp: 'up', tokenDown: 'down', closeTs: Math.floor(Date.now() / 1000) + 300 };
  bot.start();
  const signal = projectionSignal(bot, 'UP');
  await bot._attemptPriceEntry(bot.w, 'UP', signal);
  bot.stop();
  assert.equal(starts, 0);
  assert.equal(trader.calls.length, 0);
});

test('snapshot exposes rolling projection settings and preserved loss sizing', () => {
  const { bot } = makeBot();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.strategy.pollMs, 500);
  assert.equal(snapshot.strategy.blockMs, 10_000);
  assert.equal(snapshot.strategy.initialBlocks, 15);
  assert.equal(snapshot.strategy.initialWindowSeconds, 150);
  assert.equal(snapshot.strategy.rollingTrendSeconds, 20);
  assert.equal(snapshot.strategy.firstPossibleEntrySeconds, 170);
  assert.equal(snapshot.strategy.maxBuySlippagePercent, 50);
  assert.equal(snapshot.strategy.maxEntryPrice, 0.45);
  assert.equal(snapshot.strategy.sharesIncrementAfterLoss, 200);
  assert.equal(snapshot.strategy.lossStreak, 0);
  assert.equal(snapshot.strategy.nextEntryShares, 500);
  assert.equal(snapshot.strategy.clobWinSettlementPrice, 0.99);
  assert.equal(snapshot.strategy.clobLossSettlementPrice, 0.01);
  assert.equal(snapshot.window.status, 'waiting_for_baseline');
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
  await enterWithProjection(bot, 'DOWN');
  assert.equal(bot.w.position.shares, 900);
  assert.ok(Math.abs(trader.calls[0].amount - (900 * 0.45)) < 1e-8);
  const winningPosition = bot.w.position;
  winningPosition.openShares = 0;
  winningPosition.exitProceeds = winningPosition.entryNotional + winningPosition.entryFee + 10;
  bot._finalizePosition(winningPosition, 'WIN', 'TEST');
  assert.equal(bot.snapshot().strategy.lossStreak, 0);
  assert.equal(bot.snapshot().strategy.nextEntryShares, 500);
});

test('a thin demo book still records the full target shares at the capped order price', async () => {
  const { bot, trader } = makeBot();
  trader.books.up.asks = [
    { price: 0.20, size: 4 },
    { price: 0.30, size: 496 },
    { price: 0.46, size: 1000 },
  ];
  await enterWithProjection(bot, 'UP');
  assert.equal(trader.calls.length, 1);
  assert.ok(Math.abs(trader.calls[0].priceLimit - 0.30) < 1e-8);
  assert.ok(Math.abs(trader.calls[0].amount - (500 * 0.30)) < 1e-8);
  assert.equal(bot.w.position.shares, 500);
  assert.ok(Math.abs(bot.w.position.entryPrice - 0.2992) < 1e-8);
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