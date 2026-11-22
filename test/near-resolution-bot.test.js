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
    eventTitle: 'Team A vs Team B',
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

function makeBot({ markets = [market()], nowRef = { value: NOW }, getMarket } = {}) {
  const feedFactory = makeFeedFactory();
  const scanner = {
    async scanMarkets() {
      return {
        markets,
        complete: true,
        pageCount: 1,
        rowsSeen: markets.length,
        cryptoExcluded: 0,
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
    initialCapital: 10_000,
  });
  return { bot, feedFactory, nowRef };
}

function quote({ ask, bid = ask - 0.01, askSize = 500, bidSize = 500 } = {}) {
  return {
    status: 'LIVE',
    bestAsk: ask,
    bestBid: bid,
    askSize,
    bidSize,
    askLevels: ask == null ? [] : [{ price: ask, size: askSize }],
    bidLevels: bid == null ? [] : [{ price: bid, size: bidSize }],
    updatedAt: NOW,
  };
}

test('best ask boundaries $0.80 and $0.90 qualify; adjacent prices do not', async () => {
  for (const [ask, expected] of [[0.79, 0], [0.8, 1], [0.9, 1], [0.91, 0]]) {
    const { bot, feedFactory } = makeBot();
    await bot.scanNow();
    bot.handleQuote('market-1-a', quote({ ask }));
    assert.equal(bot.positions.filter((position) => position.remainingShares > 0).length, expected);
    assert.equal(feedFactory.getFeed().assetIds.length, 2);
  }
});

test('entry sweeps up to $0.90, records actual shares and average price, and enters once per outcome', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', {
    ...quote({ ask: 0.8, bid: 0.79 }),
    askLevels: [{ price: 0.8, size: 50 }, { price: 0.82, size: 100 }, { price: 0.91, size: 500 }],
  });
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].requestedShares, 100);
  assert.equal(bot.positions[0].remainingShares, 100);
  assert.equal(bot.positions[0].averageEntryPrice, 0.81);
  assert.equal(bot.cash, 9_919);
  bot.handleQuote('market-1-a', quote({ ask: 0.85 }));
  assert.equal(bot.positions.length, 1);
});

test('a shallow ask book produces a clearly labeled partial taker fill', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.85, askSize: 40 }));
  assert.equal(bot.positions[0].requestedShares, 100);
  assert.equal(bot.positions[0].remainingShares, 40);
  assert.equal(bot.trades[0].status, 'PARTIAL');
});

test('a $0.99 bid closes the filled position at the target', async () => {
  const { bot } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.85, bid: 0.84 }));
  bot.handleQuote('market-1-a', quote({ ask: 0.99, bid: 0.99 }));
  assert.equal(bot.positions[0].status, 'TAKE_PROFIT');
  assert.equal(bot.positions[0].remainingShares, 0);
  assert.equal(bot.trades[0].kind, 'TAKE_PROFIT');
  assert.ok(bot.realizedPnl > 0);
});

test('a $0.60 or lower bid stops the market and removes it from active scanning', async () => {
  const { bot, feedFactory } = makeBot();
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.85, bid: 0.84 }));
  bot.handleQuote('market-1-a', quote({ ask: 0.99, bid: 0.6 }));
  assert.equal(bot.positions[0].status, 'STOP_LOSS');
  assert.equal(bot.markets.has('market-1'), false);
  assert.equal(bot.stoppedMarketIds.has('market-1'), true);
  assert.equal(feedFactory.getFeed().assetIds.length, 0);
  await bot.scanNow();
  assert.equal(bot.markets.has('market-1'), false);
});

test('markets with multiple outcomes can enter independently when both asks qualify', async () => {
  const multi = market({
    outcomes: [
      { index: 0, label: 'Home', tokenId: 'multi-home', lastPrice: 0.85 },
      { index: 1, label: 'Draw', tokenId: 'multi-draw', lastPrice: 0.1 },
      { index: 2, label: 'Away', tokenId: 'multi-away', lastPrice: 0.85 },
    ],
  });
  const { bot } = makeBot({ markets: [multi] });
  await bot.scanNow();
  bot.handleQuote('multi-home', quote({ ask: 0.85 }));
  bot.handleQuote('multi-away', quote({ ask: 0.85 }));
  assert.equal(bot.positions.length, 2);
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
  bot.handleQuote('market-1-a', quote({ ask: 0.85 }));
  assert.equal(bot.positions.length, 1);
});

test('unexited shares wait for official resolution and settle by the market outcome index', async () => {
  const item = market({ endAt: NOW + 50 });
  const { bot, nowRef } = makeBot({
    markets: [item],
    getMarket: async () => ({ closed: true, outcomePrices: '["1", "0"]' }),
  });
  await bot.scanNow();
  bot.handleQuote('market-1-a', quote({ ask: 0.85, bid: 0.84 }));
  nowRef.value += 51;
  await bot.resolveMaturedPositions();
  assert.equal(bot.positions[0].status, 'RESOLVED');
  assert.equal(bot.positions[0].settlementPayout, 1);
  assert.equal(bot.totalSettledTrades, 1);
  assert.equal(bot.trades[0].filledShares, 100);
});
