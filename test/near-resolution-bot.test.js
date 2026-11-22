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
    assert.equal(bot.positions.length, expected);
    assert.equal(bot.pendingOrders.size, 0);
    assert.equal(feedFactory.getFeed().assetIds.length, 2);
  }
});

test('market entry sweeps visible asks for 20 shares without leaving a resting order', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.86, bid: 0.84, askSize: 5 }),
    askLevels: [
      { price: 0.86, size: 5 },
      { price: 0.88, size: 15 },
      { price: 0.90, size: 50 },
    ],
  });
  assert.equal(bot.positions[0].remainingShares, 20);
  assert.equal(bot.pendingOrders.size, 0);
  assert.equal(bot.positions[0].entryOrderType, 'MARKET_SWEEP');
  assert.ok(Math.abs(bot.positions[0].averageEntryPrice - 0.875) < 1e-8);
  assert.equal(bot.trades[0].orderType, 'MARKET_SWEEP');
  assert.equal(bot.trades[0].filledShares, 20);
  assert.equal(bot.positions[0].entryFees, 0);

  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  assert.equal(bot.totalEntries, 1, 'an outcome token gets only one entry');
});

test('market sweep only fills visible ask depth and does not invent the remainder', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.86, bid: 0.84, askSize: 7 }),
    askLevels: [{ price: 0.86, size: 7 }],
  });
  assert.equal(bot.positions[0].remainingShares, 7);
  assert.equal(bot.trades[0].status, 'PARTIAL');
  assert.equal(bot.pendingOrders.size, 0);
});

test('market entry fees reduce cash, cost basis, and P&L using the taker schedule', async () => {
  const item = market();
  item.feesEnabled = true;
  item.takerFeeRate = 0.02;
  const { bot } = makeBot({ markets: [item] });
  await bot.scanNow();
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.86, bid: 0.84, askSize: 20 }),
    askLevels: [{ price: 0.86, size: 20 }],
  });
  const expectedFee = 20 * 0.02 * 0.86 * (1 - 0.86);
  assert.ok(Math.abs(bot.positions[0].entryFees - expectedFee) < 1e-8);
  assert.ok(Math.abs(bot.positions[0].remainingCostBasis - (17.2 + expectedFee)) < 1e-8);
  assert.ok(Math.abs(bot.cash - (10_000 - 17.2 - expectedFee)) < 1e-8);
  assert.ok(Math.abs(bot.totalFees - expectedFee) < 1e-8);
});

test('v4 midpoint-limit migration preserves paper history and cancels remaining limits', async () => {
  const { bot } = makeBot();
  const state = bot.serializePersistentState();
  state.paperStrategyVersion = NearResolutionMarketBot.PREVIOUS_STRATEGY_VERSION;
  state.paperHistoryResetVersion = `|${NearResolutionMarketBot.PREVIOUS_STRATEGY_VERSION}`;
  state.cash = 9_990;
  state.realizedPnl = -10;
  state.totalEntries = 1;
  state.positions = [{
    id: 'preserved-position',
    marketId: 'market-1',
    marketTitle: 'Saved position',
    tokenId: 'saved-token',
    outcomeLabel: 'Yes',
    remainingShares: 10,
    remainingCostBasis: 8,
    status: 'OPEN',
  }];
  state.pendingOrders = [{
    id: 'legacy-limit',
    marketId: 'market-1',
    marketTitle: 'Saved market',
    outcomeLabel: 'No',
    tokenId: 'market-1-b',
    requestedShares: 20,
    filledShares: 0,
    remainingShares: 20,
    limitPrice: 0.85,
    status: 'OPEN',
    createdAt: NOW,
    seenAskSizes: {},
  }];
  state.orderEvents = [{
    id: 'legacy-limit',
    at: NOW,
    kind: 'BUY_LIMIT_PLACED',
    marketTitle: 'Saved market',
    outcome: 'No',
    requestedShares: 20,
    filledShares: 0,
    status: 'OPEN',
  }];
  bot.restorePersistentState(state);

  assert.equal(bot.pendingOrders.size, 0);
  assert.equal(bot.orderEvents[0].kind, 'BUY_LIMIT_CANCELLED');
  assert.equal(bot.orderEvents[0].status, 'STRATEGY_SWITCH_TO_MARKET_SWEEP');
  assert.equal(bot.cash, 9_990);
  assert.equal(bot.realizedPnl, -10);
  assert.equal(bot.positions[0].id, 'preserved-position');
});

test('floating P&L updates from the live best bid and take-profit closes at $0.99', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.85, bid: 0.84, askSize: 20 }),
    askLevels: [{ price: 0.85, size: 20 }],
  });
  bot.handleQuote('market-1-a', quote({ ask: 0.90, bid: 0.88 }));
  assert.ok(Math.abs(bot.snapshot().positions[0].unrealizedPnl - 0.4) < 1e-8);
  assert.ok(Math.abs(bot.snapshot().account.unrealizedPnl - 0.4) < 1e-8);
  bot.handleQuote('market-1-a', quote({ ask: 0.99, bid: 0.99 }));
  assert.equal(bot.positions[0].status, 'TAKE_PROFIT');
  assert.equal(bot.positions[0].remainingShares, 0);
  assert.equal(bot.trades[0].kind, 'TAKE_PROFIT');
  assert.ok(bot.realizedPnl > 0);
});

test('order churn cannot push actual fills out of recent trade history', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));

  assert.equal(bot.trades[0].kind, 'BUY_ENTRY');

  for (let index = 0; index < 120; index += 1) {
    bot.orderEvents.unshift({
      id: `cancel-${index}`,
      at: NOW + index,
      kind: 'BUY_LIMIT_CANCELLED',
      requestedShares: 20,
      filledShares: 0,
      status: 'MIDPOINT_LEFT_ENTRY_BAND',
    });
  }
  bot.trimHistory();

  const snapshot = bot.snapshot();
  assert.equal(snapshot.recentTrades[0].kind, 'BUY_ENTRY');
  assert.equal(snapshot.recentTrades.length, 1);
  assert.equal(snapshot.recentOrderEvents.length, 100);
  assert.equal(snapshot.recentOrderEvents[0].kind, 'BUY_LIMIT_CANCELLED');
});

test('a $0.60 or lower bid stops the position and removes the market from scanning', async () => {
  const { bot, feedFactory } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.86, bid: 0.84 }));
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.85, bid: 0.84, askSize: 20 }),
    askLevels: [{ price: 0.85, size: 20 }],
  });
  bot.handleQuote('market-1-a', quote({ ask: 0.99, bid: 0.6 }));
  assert.equal(bot.positions.find((position) => position.tokenId === 'market-1-a').status, 'STOP_LOSS');
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
  assert.ok(Math.abs(bot.snapshot().positions[0].unrealizedPnl - (-1.6)) < 1e-8);
});

test('multiple outcomes can each have an independent market-sweep entry', async () => {
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
  assert.equal(bot.pendingOrders.size, 0);
  assert.deepEqual(bot.positions.map((position) => position.outcomeLabel), ['Away', 'Home']);
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
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.pendingOrders.size, 0);
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
