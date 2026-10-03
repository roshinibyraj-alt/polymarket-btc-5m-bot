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
    this.calls.push({ tokenId, side, amount, targetShares: options.targetShares });
    const buying = side === 'BUY';
    const targetShares = Number(options.targetShares);
    const levels = (buying ? this.books[tokenId].asks : this.books[tokenId].bids)
      .filter((level) => !options.priceLimit
        || (buying ? level.price <= options.priceLimit : level.price >= options.priceLimit));
    let shares = 0;
    let notional = 0;
    let remaining = targetShares;
    for (const level of levels) {
      const take = Math.min(remaining, level.size);
      shares += take;
      notional += take * level.price;
      remaining -= take;
      if (remaining <= 1e-9) break;
    }
    return {
      id: 'demo-' + this.calls.length,
      status: shares > 0 ? 'matched' : 'unmatched',
      isFilled: shares + 1e-9 >= targetShares,
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
  bot.w.status = 'waiting_for_first_candle';
  return { bot, trader };
}

async function feedCandle(bot, index, color, startPrice = 85000) {
  const minuteMs = cfg.STRATEGY_MINUTE_MS;
  const startMs = bot.w.openTs * 1000 + index * minuteMs;
  const closePrice = color === 'G' ? startPrice + 1 : color === 'R' ? startPrice - 1 : startPrice;
  const send = async (price, sampledAt) => bot._onBtcSample({
    price, sampledAt, receivedAt: sampledAt, exchange: 'kraken', symbol: 'BTC/USD',
  });
  await send(startPrice, startMs + 100);
  await send(closePrice, startMs + minuteMs - 100);
  await bot._finalizeDueMinutes(bot.w, startMs + minuteMs);
  return closePrice;
}

async function feedCandles(bot, colors) {
  let price = 85000;
  for (let index = 0; index < colors.length; index += 1) {
    price = await feedCandle(bot, index, colors[index], price);
  }
}

test('completed RG candles buy UP once for exactly 500 shares', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);

  assert.equal(bot.w.candleSequence, 'RG');
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.shares, 500);
  assert.equal(bot.w.position.entryPattern, 'RG');
  assert.equal(bot.w.entryCount, 1);
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side, call.targetShares]), [
    ['up', 'BUY', 500],
  ]);
});

test('RR alone does not enter, but RRG buys UP when its third candle completes', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'R']);
  assert.equal(bot.w.candleSequence, 'RR');
  assert.equal(bot.w.position, null);
  assert.equal(trader.calls.length, 0);

  await feedCandle(bot, 2, 'G', 84998);
  assert.equal(bot.w.candleSequence, 'RRG');
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.entryPattern, 'RRG');
  assert.equal(trader.calls.length, 1);
});

test('GR buys DOWN and GGR also buys DOWN', async (t) => {
  for (const colors of [['G', 'R'], ['G', 'G', 'R']]) {
    await t.test(colors.join(''), async () => {
      const { bot, trader } = makeBot();
      await feedCandles(bot, colors);
      assert.equal(bot.w.position.side, 'DOWN');
      assert.equal(bot.w.position.entryPattern, colors.join(''));
      assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['down', 'BUY']]);
    });
  }
});

test('RGR exits an open UP position with a SELL and never reverses or re-enters', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  assert.equal(bot.w.position.side, 'UP');

  await feedCandle(bot, 2, 'R', 85000);
  assert.equal(bot.w.candleSequence, 'RGR');
  assert.equal(bot.w.position, null);
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].outcome, 'CLOSED');
  assert.equal(bot.trades[0].reason, 'CANDLE_PATTERN_EXIT');
  assert.equal(bot.trades[0].entryPattern, 'RG');
  assert.equal(bot.trades[0].exitPattern, 'RGR');

  await feedCandle(bot, 3, 'G', 84999);
  assert.equal(bot.w.entryCount, 1);
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [
    ['up', 'BUY'], ['up', 'SELL'],
  ]);
});

test('a partial pattern SELL leaves the remainder open and retries on the next quote', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  trader.books.up.bids = [{ price: 0.29, size: 250 }];
  await feedCandle(bot, 2, 'R', 85000);

  assert.equal(bot.w.position.openShares, 250);
  assert.equal(bot.w.status, 'exit_pending');
  assert.equal(bot.w.activeSignal.action, 'SELL');
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.29, ask: 0.30 });
  assert.equal(bot.w.position, null);
  assert.equal(bot.trades[0].exitPattern, 'RGR');
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY', 'SELL', 'SELL']);
});

test('RRGR exits the UP position that was opened by its RRG prefix', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'R', 'G']);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.entryPattern, 'RRG');

  await feedCandle(bot, 3, 'R', 85000);
  assert.equal(bot.w.candleSequence, 'RRGR');
  assert.equal(bot.w.position, null);
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY', 'SELL']);
});

test('GRG and GGRG exit only an open DOWN position', async (t) => {
  for (const colors of [['G', 'R', 'G'], ['G', 'G', 'R', 'G']]) {
    await t.test(colors.join(''), async () => {
      const { bot, trader } = makeBot();
      await feedCandles(bot, colors);
      assert.equal(bot.w.position, null);
      assert.equal(bot.trades[0].side, 'DOWN');
      assert.equal(bot.trades[0].exitPattern, colors.join(''));
      assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [
        ['down', 'BUY'], ['down', 'SELL'],
      ]);
    });
  }
});

test('missing minute data and dojis are neutral and cannot complete a pattern', async () => {
  const { bot, trader } = makeBot();
  const minuteMs = cfg.STRATEGY_MINUTE_MS;
  const openMs = bot.w.openTs * 1000;
  const send = async (price, sampledAt) => bot._onBtcSample({ price, sampledAt, receivedAt: sampledAt });

  // First observed candle is minute two; the skipped opening minutes are neutral.
  await send(85000, openMs + 120_100);
  await send(85001, openMs + 179_900);
  await bot._finalizeDueMinutes(bot.w, openMs + 180_000);
  assert.equal(bot.w.candleSequence, 'NNG');
  assert.equal(bot.w.position, null);
  assert.equal(trader.calls.length, 0);

  // The following candle is a doji, which is also neutral.
  await send(85001, openMs + 180_100);
  await send(85001, openMs + 239_900);
  await bot._finalizeDueMinutes(bot.w, openMs + 240_000);
  assert.equal(bot.w.candleSequence, 'NNGN');
  assert.equal(bot.w.position, null);
  assert.equal(trader.calls.length, 0);
  assert.equal(minuteMs, 60_000);
});

test('an exit signal for the other side cannot sell a position', async () => {
  const { bot, trader } = makeBot();
  bot.w.entryCount = 1;
  bot.w.position = { side: 'DOWN', openShares: 500 };
  await bot._completeMinuteCandle(bot.w, {
    index: 0, startMs: 0, endMs: 60_000, open: 1, high: 2, low: 1, close: 2,
    sampleCount: 2, color: 'R',
  });
  await bot._completeMinuteCandle(bot.w, {
    index: 1, startMs: 60_000, endMs: 120_000, open: 2, high: 3, low: 2, close: 3,
    sampleCount: 2, color: 'G',
  });
  await bot._completeMinuteCandle(bot.w, {
    index: 2, startMs: 120_000, endMs: 180_000, open: 3, high: 3, low: 2, close: 2,
    sampleCount: 2, color: 'R',
  });
  assert.equal(bot.w.position.side, 'DOWN');
  assert.equal(trader.calls.length, 0);
});

test('a Polymarket quote alone cannot enter without a completed candle pattern', async () => {
  const { bot, trader } = makeBot();
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.29, ask: 0.30 });
  await bot._onQuote(bot.w.slug, 'down', { bid: 0.29, ask: 0.30 });
  assert.equal(trader.calls.length, 0);
  assert.equal(bot.w.position, null);
});

test('pattern entries have no strategy price band and still target fixed shares', async () => {
  const { bot, trader } = makeBot();
  trader.books.down.asks[0].price = 0.80;
  await feedCandles(bot, ['G', 'R']);
  assert.equal(bot.w.position.side, 'DOWN');
  assert.equal(bot.w.position.entryPrice, 0.80);
  assert.equal(bot.w.position.shares, 500);
  assert.equal(trader.calls[0].targetShares, 500);

  const low = makeBot();
  low.trader.books.up.asks = [{ price: 0.05, size: 1000 }];
  await feedCandles(low.bot, ['R', 'G']);
  assert.equal(low.bot.w.position.entryPrice, 0.05);
  assert.equal(low.bot.w.position.shares, 500);
});

test('active-window CLOB marks do not replace the candle-pattern exit', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  const position = bot.w.position;
  trader.books.up.bids = [{ price: 0.98, size: 1000 }];
  trader.books.up.asks = [{ price: 1, size: 1000 }];
  await bot._onQuote(bot.w.slug, 'up', { bid: 0.98, ask: 1 });
  await bot._settleClosedPositions(Date.now());
  assert.equal(bot.w.position, position);
  assert.equal(bot.pending.length, 1);
  assert.equal(bot.trades.length, 0);
  assert.equal(trader.calls.length, 1);
});

test('after window close, CLOB threshold settlement remains available', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  const position = bot.w.position;
  const cost = position.cost;
  position.closeTs = Math.floor(Date.now() / 1000) - 1;
  bot.w.window.closeTs = position.closeTs;
  await bot._closeWindow(bot.w);
  trader.books.up.bids = [{ price: 0.98, size: 1000 }];
  trader.books.up.asks = [{ price: 1, size: 1000 }];

  await bot._settleClosedPositions(Date.now());
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].outcome, 'WIN');
  assert.equal(bot.trades[0].reason, 'CLOB_THRESHOLD');
  assert.equal(bot.trades[0].winner, 'UP');
  assert.equal(bot.trades[0].exitProceeds, 500);
  assert.ok(Math.abs(bot.cash - (cfg.DEMO_CAPITAL - cost + 500)) < 1e-8);
});

test('held-side best bid at $0.01 settles the loss after window close', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  const position = bot.w.position;
  const cashAfterEntry = bot.cash;
  position.closeTs = Math.floor(Date.now() / 1000) - 1;
  bot.w.window.closeTs = position.closeTs;
  await bot._closeWindow(bot.w);
  trader.books.up.bids = [{ price: 0.01, size: 1000 }];
  trader.books.up.asks = [{ price: 0.03, size: 1000 }];

  await bot._settleClosedPositions(Date.now());
  assert.equal(bot.pending.length, 0);
  assert.equal(bot.trades[0].outcome, 'LOSS');
  assert.equal(bot.trades[0].reason, 'CLOB_THRESHOLD');
  assert.equal(bot.trades[0].winner, 'DOWN');
  assert.equal(bot.trades[0].exitProceeds, 0);
  assert.equal(bot.cash, cashAfterEntry);
});

test('closed trade accounting reconciles to equity and total P&L', async () => {
  const { bot } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  await feedCandle(bot, 2, 'R', 85000);
  const snapshot = bot.snapshot();
  assert.ok(Math.abs(snapshot.account.totalPnl
    - (snapshot.stats.realizedPnl + snapshot.account.unrealizedPnl)) < 1e-8);
  assert.ok(Math.abs(snapshot.account.equity
    - (cfg.DEMO_CAPITAL + snapshot.account.totalPnl)) < 1e-8);
});

test('equity includes a prior-window CLOB mark', async () => {
  const { bot } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  const oldWindow = bot.w;
  await bot._onQuote(oldWindow.slug, 'up', { bid: 0.60, ask: 0.62 });
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
});

test('delayed CCXT responses are discarded without affecting the candle sequence', async () => {
  const { bot, trader } = makeBot();
  const now = Date.now();
  await bot._onBtcSample({ price: 80000, sampledAt: now - 1500, receivedAt: now });
  await bot._onBtcSample({ price: 80020, sampledAt: now + 500, receivedAt: now + 1000 });
  assert.equal(bot.ccxt.status, 'live');
  assert.equal(bot.w.position, null);
  assert.equal(trader.calls.length, 0);
});

test('live-mode guard blocks pattern entries and does not start the CCXT feed', async () => {
  const trader = new FakeDemoTrader();
  let starts = 0;
  const feed = { exchangeId: 'kraken', symbol: 'BTC/USD', pollMs: 500, start() { starts += 1; return () => {}; } };
  const bot = new Bot(trader, { live: true, ccxtFeed: feed });
  bot.w = makeWindowState('btc-test', Math.floor(Date.now() / 1000) - 1);
  bot.w.window = { tokenUp: 'up', tokenDown: 'down', closeTs: Math.floor(Date.now() / 1000) + 300 };
  bot.w.activeSignal = { action: 'BUY', side: 'UP', pattern: 'RG', sequence: 'RG' };
  bot.start();
  await bot._attemptPatternEntry(bot.w, bot.w.activeSignal);
  bot.stop();
  assert.equal(starts, 0);
  assert.equal(trader.calls.length, 0);
});

test('snapshot exposes candle strategy settings, sequence, and fixed sizing', () => {
  const { bot } = makeBot();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.strategy.pollMs, 500);
  assert.equal(snapshot.strategy.minuteMs, 60_000);
  assert.equal(snapshot.strategy.minSamplesPerCandle, 2);
  assert.equal(snapshot.strategy.maxEntriesPerWindow, 1);
  assert.equal(snapshot.strategy.fixedOrderShares, 500);
  assert.equal(snapshot.strategy.nextEntryShares, 500);
  assert.equal(snapshot.strategy.clobWinSettlementPrice, 0.99);
  assert.equal(snapshot.strategy.clobLossSettlementPrice, 0.01);
  assert.equal(snapshot.window.candleSequence, '');
  assert.equal(snapshot.window.entryTaken, false);
  assert.equal('projection' in snapshot.window, false);
});

test('losses do not change fixed 500-share sizing', async () => {
  const { bot } = makeBot();
  const recordLoss = (openTs) => bot._finalizePosition({
    settled: false, slug: 'loss-' + openTs, openTs, side: 'UP',
    shares: 500, openShares: 0, entryPrice: 0.30, entryNotional: 150,
    entryFee: 0, exitFees: 0, exitProceeds: 0, realizedPnl: 0,
  }, 'LOSS', 'TEST');
  recordLoss(1);
  recordLoss(2);
  await feedCandles(bot, ['R', 'G']);
  assert.equal(bot.w.position.shares, 500);
  assert.equal(bot.snapshot().strategy.nextEntryShares, 500);
});

test('demo BUY can model missing depth at the worst visible ask', async () => {
  const trader = new DemoTrader();
  const order = await trader.placeFakMarketOrder('up', 'BUY', 500, {
    targetShares: 500,
    orderBook: { asks: [{ price: 0.20, size: 4 }, { price: 0.80, size: 10 }], bids: [] },
  });
  assert.equal(order.status, 'matched');
  assert.equal(order.isFilled, true);
  assert.equal(order.raw.takingAmount, '500');
  assert.ok(Math.abs(Number(order.raw.makingAmount) - 397.6) < 1e-8);
  assert.equal(order.raw.requestedShares, '500');
  assert.equal(order.raw.simulatedLiquidityShares, '486');
  assert.ok(Math.abs(order.avgPrice - 0.7952) < 1e-8);
});

test('default bot constructs the configured Coinbase feed at 500 ms', () => {
  const bot = new Bot(new FakeDemoTrader());
  assert.equal(bot.ccxtFeed.exchangeId, 'coinbase');
  assert.equal(bot.ccxtFeed.symbol, 'BTC/USD');
  assert.equal(bot.ccxtFeed.pollMs, 500);
  bot.stop();
});