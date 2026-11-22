'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NearResolutionMarketBot = require('../near-resolution-bot');

const NOW = 1_000_000;

function market({ id = 'market-1', endAt = NOW + 60_000, outcomes } = {}) {
  return {
    id,
    slug: id,
    title: `Question for ${id}`,
    eventTitle: 'Candidate event',
    endAt,
    version: 'v1',
    feesEnabled: false,
    outcomes: outcomes || [
      { index: 0, label: 'Team A', tokenId: `${id}-a`, lastPrice: 0.8 },
      { index: 1, label: 'Team B', tokenId: `${id}-b`, lastPrice: 0.2 },
    ],
  };
}

function makeFeedFactory() {
  let feed;
  const factory = (options) => {
    feed = {
      assetIds: [],
      connected: true,
      start() {},
      stop() {},
      updateAssetIds(ids) { this.assetIds = [...ids]; },
      snapshot() {
        return { connected: this.connected, status: this.connected ? 'CONNECTED' : 'STOPPED', assetCount: this.assetIds.length };
      },
      emit(tokenId, quote) { options.onQuote(tokenId, quote); },
    };
    return feed;
  };
  factory.getFeed = () => feed;
  return factory;
}

function makeBot({
  markets = [market()],
  nowRef = { value: NOW },
  getMarket,
  initialCapital = 10_000,
} = {}) {
  const feedFactory = makeFeedFactory();
  const scanner = {
    async scanMarkets() {
      return {
        markets,
        complete: true,
        pageCount: 1,
        rowsSeen: markets.length,
        cryptoExcluded: 0,
        sportsExcluded: 0,
        invalidMarkets: 0,
        scannedAt: nowRef.value,
      };
    },
    async getMarket(id) {
      return getMarket ? getMarket(id) : { closed: false };
    },
  };
  const bot = new NearResolutionMarketBot({
    marketScanner: scanner,
    feedFactory,
    now: () => nowRef.value,
    initialCapital,
  });
  return { bot, feedFactory, nowRef };
}

function quote({ ask, bid = ask - 0.01, askSize = 500, bidSize = 500 } = {}) {
  return {
    status: 'LIVE',
    bestAsk: ask,
    bestBid: bid,
    mid: ask == null || bid == null ? null : (ask + bid) / 2,
    askSize,
    bidSize,
    askLevels: ask == null ? [] : [{ price: ask, size: askSize }],
    bidLevels: bid == null ? [] : [{ price: bid, size: bidSize }],
    updatedAt: NOW,
  };
}

test('midpoint boundaries $0.80 and $0.90 qualify; adjacent prices and bids at the stop do not', async () => {
  for (const [mid, bid, expected] of [
    [0.79, 0.78, 0],
    [0.8, 0.79, 1],
    [0.9, 0.89, 1],
    [0.91, 0.90, 0],
    [0.85, 0.60, 0],
  ]) {
    const { bot, feedFactory } = makeBot();
    await bot.scanNow();
    bot.handleQuote('market-1-a', quote({ ask: mid + 0.01, bid }));
    assert.equal(bot.pendingOrders.size, expected);
    assert.equal(feedFactory.getFeed().assetIds.length, 2);
  }
});

test('rests a 20-share limit at midpoint and only fills from new asks at or below the limit', async () => {
  const { bot, nowRef } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  const order = bot.pendingOrders.get('market-1-a');
  assert.equal(order.limitPrice, 0.85);
  assert.equal(order.requestedShares, 20);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.snapshot().account.reservedCash, 17);

  nowRef.value += 100;
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.84, bid: 0.83, askSize: 10 }),
    askLevels: [{ price: 0.84, size: 10 }],
  });
  assert.equal(bot.positions[0].remainingShares, 10);
  assert.equal(bot.pendingOrders.get('market-1-a').remainingShares, 10);
  assert.ok(Math.abs(bot.positions[0].averageEntryPrice - 0.84) < 1e-8);

  nowRef.value += 100;
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.84, bid: 0.83, askSize: 10 }),
    askLevels: [{ price: 0.84, size: 10 }],
  });
  assert.equal(bot.positions[0].remainingShares, 10, 'unchanged visible size is not counted twice');

  nowRef.value += 100;
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.84, bid: 0.83, askSize: 15 }),
    askLevels: [{ price: 0.84, size: 15 }],
  });
  assert.equal(bot.positions[0].remainingShares, 15);
  assert.equal(bot.pendingOrders.get('market-1-a').remainingShares, 5);

  nowRef.value += 100;
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.84, bid: 0.83, askSize: 20 }),
    askLevels: [{ price: 0.84, size: 20 }],
  });
  assert.equal(bot.positions[0].remainingShares, 20);
  assert.equal(bot.pendingOrders.has('market-1-a'), false);
  assert.equal(bot.positions[0].entryFees, 0);
});

test('cancels unfilled limit when midpoint leaves the band and releases reserved cash', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  assert.equal(bot.pendingOrders.size, 1);
  bot.handleQuote('market-1-a', quote({ ask: 0.92, bid: 0.90 }));
  assert.equal(bot.pendingOrders.size, 0);
  assert.equal(bot.snapshot().account.reservedCash, 0);
  assert.equal(bot.trades[0].kind, 'BUY_LIMIT_CANCELLED');
  assert.equal(bot.trades[0].status, 'MIDPOINT_LEFT_ENTRY_BAND');
});

test('pending limits reserve their full cost and are persisted across restarts', async () => {
  const markets = [market({ id: 'first' }), market({ id: 'second' })];
  const { bot } = makeBot({ markets, initialCapital: 17 });
  await bot.scanNow();
  bot.handleQuote('first-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('second-a', quote({ ask: 0.86, bid: 0.84 }));
  assert.equal(bot.pendingOrders.size, 1);
  assert.equal(bot.snapshot().account.availableCash, 0);

  const saved = bot.serializePersistentState();
  const restored = makeBot({ markets, initialCapital: 17 }).bot;
  restored.restorePersistentState(saved);
  assert.equal(restored.pendingOrders.size, 1);
  assert.equal(restored.snapshot().account.reservedCash, 17);
});

test('best bid guard cancels a resting order if it falls to the stop level', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-a', quote({ ask: 0.94, bid: 0.60 }));
  assert.equal(bot.pendingOrders.size, 0);
  assert.equal(bot.trades[0].status, 'BEST_BID_AT_OR_BELOW_STOP');
});

test('floating P&L updates from the live best bid and take-profit closes at $0.99', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.85, bid: 0.84, askSize: 20 }),
    askLevels: [{ price: 0.85, size: 20 }],
  });
  bot.handleQuote('market-1-a', quote({ ask: 0.88, bid: 0.86 }));
  assert.ok(Math.abs(bot.snapshot().positions[0].unrealizedPnl - 0.2) < 1e-8);
  assert.ok(Math.abs(bot.snapshot().account.unrealizedPnl - 0.2) < 1e-8);
  bot.handleQuote('market-1-a', quote({ ask: 0.99, bid: 0.99 }));
  assert.equal(bot.positions[0].status, 'TAKE_PROFIT');
  assert.equal(bot.positions[0].remainingShares, 0);
  assert.equal(bot.trades[0].kind, 'TAKE_PROFIT');
  assert.ok(bot.realizedPnl > 0);
});

test('a $0.60 or lower bid stops a position, cancels sibling orders, and removes the market', async () => {
  const { bot, feedFactory } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-b', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.85, bid: 0.84, askSize: 20 }),
    askLevels: [{ price: 0.85, size: 20 }],
  });
  bot.handleQuote('market-1-a', quote({ ask: 0.99, bid: 0.6 }));
  assert.equal(bot.positions[0].status, 'STOP_LOSS');
  assert.equal(bot.markets.has('market-1'), false);
  assert.equal(bot.stoppedMarketIds.has('market-1'), true);
  assert.equal(bot.pendingOrders.size, 0);
  assert.equal(feedFactory.getFeed().assetIds.length, 0);
  await bot.scanNow();
  assert.equal(bot.markets.has('market-1'), false);
});

test('a stopped partial remainder stays subscribed and its floating P&L keeps updating', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.85, bid: 0.84, askSize: 20 }),
    askLevels: [{ price: 0.85, size: 20 }],
  });
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.95, bid: 0.60, bidSize: 10 }),
    bidLevels: [{ price: 0.60, size: 10 }],
  });
  assert.equal(bot.positions[0].status, 'STOPPED_PENDING_RESOLUTION');
  assert.equal(bot.positions[0].remainingShares, 10);
  assert.ok(bot.feed.assetIds.includes('market-1-a'));

  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.85, bid: 0.70 }));
  assert.equal(bot.snapshot().positions[0].bestBid, 0.70);
  assert.ok(Math.abs(bot.snapshot().positions[0].unrealizedPnl - (-1.5)) < 1e-8);
});

test('multiple outcomes can each hold an independent midpoint resting order', async () => {
  const multi = market({
    outcomes: [
      { index: 0, label: 'Home', tokenId: 'multi-home', lastPrice: 0.85 },
      { index: 1, label: 'Draw', tokenId: 'multi-draw', lastPrice: 0.1 },
      { index: 2, label: 'Away', tokenId: 'multi-away', lastPrice: 0.85 },
    ],
  });
  const { bot } = makeBot({ markets: [multi] });
  await bot.scanNow();
  bot.handleQuote('multi-home', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('multi-away', quote({ ask: 0.86, bid: 0.84 }));
  assert.equal(bot.pendingOrders.size, 2);
  assert.deepEqual([...bot.pendingOrders.values()].map((order) => order.outcomeLabel), ['Home', 'Away']);
});

test('a page-capped Gamma scan can trade its discovered markets while showing incomplete coverage', async () => {
  const { bot } = makeBot();
  bot.marketScanner.scanMarkets = async () => ({
    markets: [market()],
    complete: false,
    pageCount: 100,
    rowsSeen: 10_000,
  });
  await bot.scanNow();
  assert.equal(bot.snapshot().marketScan.status, 'INCOMPLETE');
  assert.equal(bot.scanHealthy, true);
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  assert.equal(bot.pendingOrders.size, 1);
});

test('unexited shares wait for official resolution and settle by the market outcome index', async () => {
  const item = market({ endAt: NOW + 50 });
  const { bot, nowRef } = makeBot({
    markets: [item],
    getMarket: async () => ({ closed: true, outcomePrices: '["1", "0"]' }),
  });
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.85, bid: 0.84, askSize: 100 }),
    askLevels: [{ price: 0.85, size: 100 }],
  });
  nowRef.value += 51;
  await bot.resolveMaturedPositions();
  assert.equal(bot.positions[0].status, 'RESOLVED');
  assert.equal(bot.positions[0].settlementPayout, 1);
  assert.equal(bot.totalSettledTrades, 1);
  assert.equal(bot.trades[0].filledShares, 20);
});
