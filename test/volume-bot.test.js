'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const VolumeBot = require('../volume-bot');
const RewardsMarketClient = require('../rewards-market-client');
const config = require('../config');

const WINDOW_MS = config.WINDOW_MS_5M;

function makeFixture({ upAsk = 0.40, downAsk = 0.60, depth = 100 } = {}) {
  const now = 1_800_000_000_000;
  const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const price = 67_100;
  const samples = Array.from({ length: 40 }, (_, index) => ({
    ts: now - 39_000 + index * 1_000,
    price: price - 50 + index * 2.5,
  }));
  const feed = {
    snapshot: () => ({
      status: 'CONNECTED',
      price,
      tickAt: now,
      tickAgeMs: 0,
      currentCandle: { start, open: price - 100, high: price, low: price - 120, close: price },
      priceSamples: samples,
      tradeFlow: { imbalance: 0.2, tradeCount: 12 },
    }),
  };
  const bot = new VolumeBot({
    now: () => now,
    priceFeed: feed,
    marketData: { getBtcMarket: async () => null, getMarket: async () => null },
    rewardsClient: { getMarketRewards: async () => ({ status: 'NO_ACTIVE_ALLOCATION' }) },
  });
  bot.market = {
    id: 'condition-1',
    slug: `btc-updown-5m-${Math.floor(start / 1000)}`,
    title: 'Bitcoin Up or Down - test window',
    start,
    end: start + WINDOW_MS,
    tokens: { UP: 'token-up', DOWN: 'token-down' },
    feesEnabled: true,
    feeSchedule: { rate: 0.05, exponent: 1 },
    takerFeeRate: 0.05,
  };
  bot.orderWindowStart = start;
  bot.volumeWindowStart = start;
  bot.liveQuotes = {
    UP: {
      status: 'LIVE', stale: false, updatedAt: now, bestBid: upAsk - 0.01, bestAsk: upAsk,
      bidLevels: [{ price: upAsk - 0.01, size: depth }],
      askLevels: [{ price: upAsk, size: depth }],
    },
    DOWN: {
      status: 'LIVE', stale: false, updatedAt: now, bestBid: downAsk - 0.01, bestAsk: downAsk,
      bidLevels: [{ price: downAsk - 0.01, size: depth }],
      askLevels: [{ price: downAsk, size: depth }],
    },
  };
  return { bot, now, start };
}

test('published taker tiers use the documented thresholds and rates', () => {
  assert.equal(VolumeBot._test.tierFor(199_999).name, 'None');
  assert.equal(VolumeBot._test.tierFor(200_000).name, 'Gold');
  assert.equal(VolumeBot._test.tierFor(200_000).rate, 0.10);
  assert.equal(VolumeBot._test.tierFor(1_000_000).name, 'Platinum');
  assert.equal(VolumeBot._test.tierFor(4_000_000).name, 'Diamond');
  assert.equal(VolumeBot._test.tierFor(10_000_000).name, 'Obsidian');
  assert.equal(VolumeBot._test.tierFor(75_000_000).name, 'Onyx');
});

test('volatility estimate requires enough recent Binance samples', () => {
  const { now } = makeFixture();
  assert.equal(VolumeBot._test.estimateVolatility([], now).ready, false);
  const samples = Array.from({ length: 40 }, (_, index) => ({
    ts: now - 39_000 + index * 1_000,
    price: 67_000 + index * 2,
  }));
  const estimate = VolumeBot._test.estimateVolatility(samples, now);
  assert.equal(estimate.ready, true);
  assert.ok(estimate.sigmaPerSecond > 0);
});

test('takes a paper entry only when a full visible-book sweep clears fees and edge', () => {
  const { bot, now } = makeFixture({ upAsk: 0.40, downAsk: 0.60 });
  bot.processEngineTriggers(now);

  assert.equal(bot.positions.length, 1);
  const position = bot.positions[0];
  assert.equal(position.side, 'UP');
  assert.equal(position.shares, config.VOLUME_ENTRY_SHARES);
  assert.equal(position.entryType, 'PAPER_TAKER_VOLUME');
  assert.ok(position.fees > 0);
  assert.equal(position.fees, 0.12, '10 shares at $0.40 use the 5% fee formula');
  assert.ok(position.netEdgePerShare >= config.VOLUME_MIN_NET_EDGE);
  assert.equal(bot.orders[0].status, 'FILLED');
  assert.equal(bot.orders[0].orderType, 'PAPER_TAKER_VISIBLE_ASK_SWEEP');
  assert.ok(bot.volumeTradeEvents[0].weightedVolume > 0);
});

test('does not invent a fill when the visible ask depth cannot fill the clip', () => {
  const { bot, now } = makeFixture({ upAsk: 0.40, downAsk: 0.60, depth: 3 });
  bot.processEngineTriggers(now);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.length, 0);
});

test('models a partial FAK entry only when minimum shares and notional actually match', () => {
  const { bot, now } = makeFixture({ upAsk: 0.40, downAsk: 0.60, depth: 7 });
  bot.processEngineTriggers(now);

  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].shares, 7);
  assert.equal(bot.orders[0].requestedShares, 10);
  assert.equal(bot.orders[0].matchedShares, 7);
  assert.equal(bot.orders[0].fillStatus, 'PARTIAL_FAK_REMAINDER_CANCELLED');
  assert.equal(bot.positions[0].totalCost, bot.orders[0].totalCost);
});

test('fee-aware take profit sweeps visible bids and applies cooldown before re-entry', () => {
  const { bot, now } = makeFixture({ upAsk: 0.40, downAsk: 0.60 });
  bot.processEngineTriggers(now);
  const position = bot.positions[0];
  assert.ok(position);

  const quote = bot.liveQuotes.UP;
  quote.bestBid = 0.99;
  quote.bidLevels = [{ price: 0.99, size: 10 }];
  quote.updatedAt = now + 1_000;
  bot.processEngineTriggers(now + 1_000);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'NET_TAKE_PROFIT_AFTER_ENTRY_AND_EXIT_FEES');
  assert.ok(position.exitFees > 0);
  assert.ok(position.realizedPnl >= 0.30);
  assert.equal(bot.positions.length, 1, 'cooldown prevents immediate re-entry');
});

test('strategy migration preserves the existing paper wallet and position history', () => {
  const { bot, now, start } = makeFixture();
  const legacyPosition = { id: 'old-position', windowStart: start, status: 'OPEN', totalCost: 12 };
  bot.restorePersistentState({
    schemaVersion: 1,
    strategyVersion: 'BTC_DUAL_ENGINE_071_030_SWAP_065_V1',
    capital: 10_000,
    cash: 9_988,
    startedAt: now - 1_000_000,
    positions: [legacyPosition],
    orders: [{ id: 'old-resting-order', windowStart: start, status: 'LIVE' }],
    events: [],
    resolutions: [],
    market: bot.market,
    orderWindowStart: start,
  });

  assert.equal(bot.cash, 9_988);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0], legacyPosition);
  assert.equal(bot.orders[0].status, 'CANCELLED_STRATEGY_REPLACED');
  assert.equal(bot.serializePersistentState().strategyVersion, VolumeBot._test.STRATEGY_VERSION);
});

test('reward lookup treats an empty reward allocation as no direct market reward', async () => {
  const client = new RewardsMarketClient({
    now: () => 1_800_000_000_000,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{
          market_slug: 'btc-updown-5m-test',
          rewards_config: [],
          rewards_min_size: 50,
          rewards_max_spread: 4.5,
        }],
      }),
    }),
  });
  const result = await client.getMarketRewards({ slug: 'btc-updown-5m-test' });
  assert.equal(result.status, 'NO_ACTIVE_ALLOCATION');
  assert.equal(result.minimumDisplayedShares, 50);
  assert.equal(result.activeAllocations.length, 0);
});

test('snapshot identifies a demo-only volume strategy with live trading disabled', () => {
  const { bot } = makeFixture();
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO ONLY');
  assert.equal(state.liveTrading.enabled, false);
  assert.equal(state.strategy.realOrderModulesLoaded, false);
  assert.equal(state.strategy.name, 'BTC 5-minute edge-gated volume paper bot');
  assert.equal(state.volumeMetrics.activeTakerTier.name, 'None');
});
