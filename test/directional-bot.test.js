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
  bot._completedMinuteCandles = Array.from({ length: 15 }, (_, index) => ({
    index, endMs: openTs * 1000 - (15 - index) * cfg.STRATEGY_MINUTE_MS,
    high: 85002, low: 84998, close: 85000, sampleCount: 2,
  }));
  bot._btcSamples.push({
    price: 85000, sampledAt: openTs * 1000 - 500, receivedAt: openTs * 1000 - 500,
  });
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
  const side = colors[0] === 'R' && colors.at(-1) === 'G' ? 'UP'
    : colors[0] === 'G' && colors.at(-1) === 'R' ? 'DOWN' : null;
  if (side) await triggerRetest(bot, side, colors.length);
}

async function triggerRetest(bot, side, minuteIndex) {
  const openMs = bot.w.openTs * 1000;
  const send = async (value, offset) => bot._onBtcSample({
    price: value, sampledAt: openMs + offset, receivedAt: openMs + offset,
    exchange: 'kraken', symbol: 'BTC/USD',
  });
  await send(side === 'UP' ? 84997.9 : 85002.1, minuteIndex * cfg.STRATEGY_MINUTE_MS + 100);
  await send(85000, minuteIndex * cfg.STRATEGY_MINUTE_MS + 600);
}

function feedClobPair(bot, observedAt, upPrice, downPrice) {
  bot._onQuote(bot.w.slug, 'up', { bid: upPrice, ask: upPrice }, observedAt);
  bot._onQuote(bot.w.slug, 'down', { bid: downPrice, ask: downPrice }, observedAt);
}

test('retest setup recovers from a current-window tick racing the opening boundary', async () => {
  const { bot } = makeBot();
  const openMs = bot.w.openTs * 1000;
  bot._btcSamples.push({
    price: 85002, sampledAt: openMs + 100, receivedAt: openMs + 100,
  });

  await bot._evaluateRetest(bot.w, openMs + 200, 85000);

  assert.equal(bot.w.retestState.referencePrice, 85000);
  assert.ok(bot.w.retestState.atr > 0);
  assert.equal(bot.w.retestState.phase, 'WAITING_FOR_MOVE');
});

test('retest setup retries when boundary reference data arrives after an invalid initialization', async () => {
  const { bot } = makeBot();
  const openMs = bot.w.openTs * 1000;
  bot._btcSamples = [];

  await bot._evaluateRetest(bot.w, openMs + 100, 85000);
  assert.equal(bot.w.retestState.referencePrice, null);

  bot._btcSamples.push({
    price: 85000, sampledAt: openMs - 500, receivedAt: openMs - 500,
  });
  await bot._evaluateRetest(bot.w, openMs + 200, 85000);

  assert.equal(bot.w.retestState.referencePrice, 85000);
  assert.ok(bot.w.retestState.atr > 0);
});

test('signal ask above 0.80 waits for a pullback to 0.65 before buying', async () => {
  const { bot, trader } = makeBot();
  const signal = { action: 'BUY', side: 'UP', pattern: 'LOWER_RETEST', sequence: 'RG' };
  bot.w.activeSignal = signal;
  trader.books.up.asks = [{ price: 0.81, size: 1000 }];
  assert.equal(await bot._attemptPatternEntry(bot.w, signal), false);
  assert.equal(bot.w.position, null);
  assert.equal(bot.w.status, 'waiting_for_signal_price_pullback');

  trader.books.up.asks = [{ price: 0.66, size: 1000 }];
  bot.w.activeSignal = { ...signal };
  assert.equal(await bot._attemptPatternEntry(bot.w, bot.w.activeSignal), false);
  assert.equal(bot.w.position, null);
  trader.books.up.asks = [{ price: 0.65, size: 1000 }];
  assert.equal(await bot._attemptPatternEntry(bot.w, signal), true);
  assert.equal(bot.w.position.entryPrice, 0.65);
});

test('entries above 0.60 sell when the held-side bid reaches 0.30', async () => {
  const { bot, trader } = makeBot();
  const signal = { action: 'BUY', side: 'UP', pattern: 'LOWER_RETEST', sequence: 'RG' };
  bot.w.activeSignal = signal;
  trader.books.up.asks = [{ price: 0.65, size: 1000 }];
  trader.books.up.bids = [{ price: 0.30, size: 1000 }];
  assert.equal(await bot._attemptPatternEntry(bot.w, signal), true);
  const position = bot.w.position;
  assert.equal(await bot._attemptStopLoss(bot.w, position), true);
  assert.equal(bot.w.position, null);
  assert.equal(position.openShares, 0);
  assert.equal(bot.trades.at(-1).reason, 'STOP_LOSS');
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY', 'SELL']);
});

test('entries at or below 0.60 do not use the high-entry stop loss', async () => {
  const { bot, trader } = makeBot();
  const signal = { action: 'BUY', side: 'UP', pattern: 'LOWER_RETEST', sequence: 'RG' };
  bot.w.activeSignal = signal;
  trader.books.up.asks = [{ price: 0.60, size: 1000 }];
  trader.books.up.bids = [{ price: 0.30, size: 1000 }];
  assert.equal(await bot._attemptPatternEntry(bot.w, signal), true);
  assert.equal(await bot._attemptStopLoss(bot.w, bot.w.position), false);
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY']);
});

test('completed RG candles buy UP once for exactly 500 shares', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);

  assert.equal(bot.w.candleSequence, 'RG');
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.shares, 500);
  assert.equal(bot.w.position.entryPattern, 'LOWER_RETEST');
  assert.equal(bot.w.entryCount, 1);
  assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side, call.targetShares]), [
    ['up', 'BUY', 500],
  ]);
});

test('candle colors do not signal; a downside ATR retest buys UP', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'R']);
  assert.equal(bot.w.candleSequence, 'RR');
  assert.equal(bot.w.position, null);
  assert.equal(trader.calls.length, 0);

  await feedCandle(bot, 2, 'G', 84998);
  assert.equal(bot.w.candleSequence, 'RRG');
  assert.equal(bot.w.position, null);
  await triggerRetest(bot, 'UP', 3);
  assert.equal(bot.w.position.side, 'UP');
  assert.equal(bot.w.position.entryPattern, 'LOWER_RETEST');
  assert.equal(trader.calls.length, 1);
});

test('GR buys DOWN and GGR also buys DOWN', async (t) => {
  for (const colors of [['G', 'R'], ['G', 'G', 'R']]) {
    await t.test(colors.join(''), async () => {
      const { bot, trader } = makeBot();
      await feedCandles(bot, colors);
      assert.equal(bot.w.position.side, 'DOWN');
      assert.equal(bot.w.position.entryPattern, 'UPPER_RETEST');
      assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [['down', 'BUY']]);
    });
  }
});

test('exit-shaped sequences never SELL; the entry position stays open for settlement', async (t) => {
  const scenarios = [
    { entry: ['R', 'G'], followup: ['R'], pattern: 'RGR', side: 'UP', tokenId: 'up' },
    { entry: ['R', 'R', 'G'], followup: ['R'], pattern: 'RRGR', side: 'UP', tokenId: 'up' },
    { entry: ['G', 'R'], followup: ['G'], pattern: 'GRG', side: 'DOWN', tokenId: 'down' },
    { entry: ['G', 'G', 'R'], followup: ['G'], pattern: 'GGRG', side: 'DOWN', tokenId: 'down' },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.pattern, async () => {
      const { bot, trader } = makeBot();
      await feedCandles(bot, scenario.entry);
      const position = bot.w.position;
      assert.equal(position.side, scenario.side);

      for (let i = 0; i < scenario.followup.length; i += 1) {
        await feedCandle(bot, scenario.entry.length + i, scenario.followup[i]);
      }

      assert.equal(bot.w.lastSignal.action, 'BUY');
      assert.equal(bot.w.position, position);
      assert.equal(position.openShares, 500);
      assert.equal(bot.pending.length, 1);
      assert.equal(bot.trades.length, 0);
      assert.deepEqual(trader.calls.map((call) => [call.tokenId, call.side]), [
        [scenario.tokenId, 'BUY'],
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

test('active-window CLOB prices only mark a position; they do not settle or sell it', async () => {
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
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY']);
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
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY']);
  assert.equal(bot.cash, cashAfterEntry);
});

test('paired final-window CLOB prices settle at $1/$0 after holding the threshold for two seconds', async (t) => {
  const scenarios = [
    { name: 'UP wins and held UP shares pay $1 each', up: 0.98, down: 0.02, outcome: 'WIN', winner: 'UP', payout: 500 },
    { name: 'DOWN wins and held UP shares pay $0 each', up: 0.02, down: 0.98, outcome: 'LOSS', winner: 'DOWN', payout: 0 },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { bot, trader } = makeBot();
      await feedCandles(bot, ['R', 'G']);
      const position = bot.w.position;
      const closeMs = (Math.floor(Date.now() / 1000) + 10) * 1000;
      position.closeTs = closeMs / 1000;
      bot.w.window.closeTs = position.closeTs;

      feedClobPair(bot, closeMs - cfg.CLOB_FINAL_CONFIRMATION_MS, scenario.up, scenario.down);
      feedClobPair(bot, closeMs - 500, scenario.up, scenario.down);
      await bot._closeWindow(bot.w);
      await bot._settleClosedPositions(closeMs + 100);

      assert.equal(bot.pending.length, 0);
      assert.equal(bot.trades[0].outcome, scenario.outcome);
      assert.equal(bot.trades[0].winner, scenario.winner);
      assert.equal(bot.trades[0].reason, 'CLOB_FINAL_2S');
      assert.equal(bot.trades[0].exitProceeds, scenario.payout);
      assert.deepEqual(trader.calls.map((call) => call.side), ['BUY']);
    });
  }
});

test('final-window CLOB prices must remain decisive for the full two seconds', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  const position = bot.w.position;
  const closeMs = (Math.floor(Date.now() / 1000) + 10) * 1000;
  position.closeTs = closeMs / 1000;
  bot.w.window.closeTs = position.closeTs;

  feedClobPair(bot, closeMs - cfg.CLOB_FINAL_CONFIRMATION_MS, 0.98, 0.02);
  bot._onQuote(bot.w.slug, 'up', { bid: 0.96, ask: 0.98 }, closeMs - 1500);
  feedClobPair(bot, closeMs - 500, 0.98, 0.02);
  await bot._closeWindow(bot.w);
  const settleAt = closeMs + 100;
  bot._clobTried.set(position, settleAt);
  bot._resolveTried.set(position.openTs, settleAt);
  await bot._settleClosedPositions(settleAt);

  assert.equal(bot.pending.length, 1);
  assert.equal(position.openShares, 500);
  assert.equal(bot.trades.length, 0);
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY']);
});

test('stale paired prices cannot settle at expiry', async () => {
  const { bot, trader } = makeBot();
  await feedCandles(bot, ['R', 'G']);
  const position = bot.w.position;
  const closeMs = (Math.floor(Date.now() / 1000) + 10) * 1000;
  position.closeTs = closeMs / 1000;
  bot.w.window.closeTs = position.closeTs;

  feedClobPair(bot, closeMs - 5000, 0.98, 0.02);
  feedClobPair(bot, closeMs - 4000, 0.98, 0.02);
  await bot._closeWindow(bot.w);
  const settleAt = closeMs + 100;
  bot._clobTried.set(position, settleAt);
  bot._resolveTried.set(position.openTs, settleAt);
  await bot._settleClosedPositions(settleAt);

  assert.equal(bot.pending.length, 1);
  assert.equal(position.openShares, 500);
  assert.equal(bot.trades.length, 0);
  assert.deepEqual(trader.calls.map((call) => call.side), ['BUY']);
});

test('open-position accounting reconciles to equity and total P&L', async () => {
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

test('snapshot exposes candle strategy settings and adaptive share sizing', () => {
  const { bot } = makeBot();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.strategy.pollMs, 500);
  assert.equal(snapshot.strategy.minuteMs, 60_000);
  assert.equal(snapshot.strategy.minSamplesPerCandle, 2);
  assert.equal(snapshot.strategy.maxEntriesPerWindow, 1);
  assert.equal(snapshot.strategy.minShares, 500);
  assert.equal(snapshot.strategy.shareSizeStep, 200);
  assert.equal(snapshot.strategy.nextEntryShares, 500);
  assert.equal(snapshot.strategy.clobWinSettlementPrice, 0.99);
  assert.equal(snapshot.strategy.clobLossSettlementPrice, 0.01);
  assert.equal(snapshot.strategy.clobFinalWinPrice, 0.98);
  assert.equal(snapshot.strategy.clobFinalLossPrice, 0.02);
  assert.equal(snapshot.strategy.clobFinalConfirmationMs, 2000);
  assert.equal(snapshot.window.candleSequence, '');
  assert.equal(snapshot.window.entryTaken, false);
  assert.equal('projection' in snapshot.window, false);
});

test('losses increase next sizing by 200, wins step back 200, and floor stays at 500', () => {
  const { bot } = makeBot();
  const settle = (openTs, outcome) => bot._finalizePosition({
    settled: false, slug: outcome.toLowerCase() + '-' + openTs, openTs, side: 'UP',
    shares: 500, openShares: 0, entryPrice: 0.30, entryNotional: 150,
    entryFee: 0, exitFees: 0, exitProceeds: outcome === 'WIN' ? 200 : 0, realizedPnl: 0,
  }, outcome, 'TEST');
  settle(1, 'LOSS');
  assert.equal(bot.snapshot().strategy.nextEntryShares, 700);
  settle(2, 'LOSS');
  assert.equal(bot.snapshot().strategy.nextEntryShares, 900);
  settle(3, 'WIN');
  assert.equal(bot.snapshot().strategy.nextEntryShares, 700);
  settle(4, 'WIN');
  assert.equal(bot.snapshot().strategy.nextEntryShares, 500);
  settle(5, 'WIN');
  assert.equal(bot.snapshot().strategy.nextEntryShares, 500);
});

test('the next entry uses the increased share target after a loss', async () => {
  const { bot, trader } = makeBot();
  bot._finalizePosition({
    settled: false, slug: 'prior-loss', openTs: 1, side: 'UP',
    shares: 500, openShares: 0, entryPrice: 0.30, entryNotional: 150,
    entryFee: 0, exitFees: 0, exitProceeds: 0, realizedPnl: 0,
  }, 'LOSS', 'TEST');
  await feedCandles(bot, ['R', 'G']);
  assert.equal(bot.w.position.shares, 700);
  assert.equal(trader.calls[0].targetShares, 700);
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