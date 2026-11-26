'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PerpsCopyBot, attributedExposure } = require('../perps-copy-bot');
const { PerpsPublicApi } = require('../perps-public-api');

function makeApi({
  equity = '1000',
  portfolioPositions = [],
  baselineFills = [],
  fillPages = [],
} = {}) {
  let fillCall = 0;
  return {
    async registration() {
      return { registered: true };
    },
    async instruments() {
      return [{
        instrument_id: 1,
        symbol: 'BTC-USD',
        price_decimals: 2,
        quantity_decimals: 4,
        min_notional: '1',
      }];
    },
    async portfolio() {
      return {
        equity,
        timestamp: 1_000_000,
        positions: portfolioPositions,
      };
    },
    async fills() {
      const result = fillCall++ === 0
        ? { data: baselineFills, more: false }
        : (fillPages.shift() || { data: [], more: false });
      return result;
    },
  };
}

function fill({ id, timestamp, side, quantity, price, previousSize = '0', instrumentId = 1 }) {
  return {
    trade_id: id,
    timestamp,
    instrument_id: instrumentId,
    side,
    quantity: String(quantity),
    price: String(price),
    previous_size: String(previousSize),
    taker: true,
    fee: '0',
    pnl: '0',
  };
}

async function readyBot(api, now = 1_000_000) {
  const bot = new PerpsCopyBot({ api, clock: () => now, pollIntervalMs: 60_000 });
  await bot.initialize();
  assert.equal(bot.state.status, 'running');
  return bot;
}

test('computes source exposure beyond the startup baseline without adopting old positions', async () => {
  assert.equal(attributedExposure(5, 10), 0);
  assert.equal(attributedExposure(13, 10), 3);
  assert.equal(attributedExposure(-2, 10), -2);

  const api = makeApi({
    portfolioPositions: [{
      instrument_id: 1,
      symbol: 'BTC-USD',
      size: '10',
      entry_price: '100',
      unrealized_pnl: '0',
    }],
    baselineFills: [fill({
      id: 'old',
      timestamp: 999_000,
      side: 'long',
      quantity: 10,
      price: 100,
    })],
    fillPages: [{
      data: [
        fill({ id: 'close-old', timestamp: 1_000_100, side: 'short', quantity: 5, price: 100, previousSize: 10 }),
        fill({ id: 'flip-new', timestamp: 1_000_200, side: 'short', quantity: 7, price: 99, previousSize: 5 }),
      ],
      more: false,
    }],
  });
  const bot = await readyBot(api);
  assert.equal(bot.state.positions.length, 0, 'startup positions remain unadopted');
  await bot.pollOnce();
  assert.equal(bot.state.positions.length, 1);
  assert.equal(bot.state.positions[0].size, -1, 'only the new short exposure is mirrored at 0.5x');
  assert.equal(bot.state.stats.copiedFills, 1);
  assert.equal(bot.state.stats.ignoredZeroChangeFills, 1);
});

test('scales long fills, estimates fees, and reduces on source exits', async () => {
  const api = makeApi({
    fillPages: [
      { data: [fill({ id: 'open', timestamp: 1_000_100, side: 'long', quantity: 2, price: 100 })], more: false },
      { data: [fill({ id: 'close', timestamp: 1_000_200, side: 'short', quantity: 1, price: 100, previousSize: 2 })], more: false },
    ],
  });
  let now = 1_000_000;
  const bot = new PerpsCopyBot({ api, clock: () => now, pollIntervalMs: 60_000 });
  await bot.initialize();
  now += 1_000;
  await bot.pollOnce();
  assert.equal(bot.state.positions[0].size, 1);
  assert.equal(bot.state.positions[0].averageEntryPrice, 100.01);
  assert.ok(bot.state.account.fees > 0);
  const openedFees = bot.state.account.fees;

  now += 1_000;
  await bot.pollOnce();
  assert.equal(bot.state.positions[0].size, 0.5);
  assert.ok(bot.state.account.fees > openedFees);
  assert.equal(bot.state.trades[0].action, 'CLOSE');
});

test('clips entries to the aggregate open-notional cap', async () => {
  const api = makeApi({
    fillPages: [{
      data: [fill({ id: 'oversized', timestamp: 1_000_100, side: 'long', quantity: 200, price: 10 })],
      more: false,
    }],
  });
  let now = 1_000_000;
  const bot = new PerpsCopyBot({
    api,
    clock: () => now,
    pollIntervalMs: 60_000,
    maxOpenNotional: 500,
  });
  await bot.initialize();
  now += 1_000;
  await bot.pollOnce();
  assert.equal(bot.state.positions.length, 1);
  assert.ok(bot.state.account.openNotional <= 500.01);
  assert.equal(bot.state.stats.capLimitedEntries, 1);
});

test('deduplicates fills that appear again on the next poll', async () => {
  const sourceFill = fill({ id: 'repeat-me', timestamp: 1_000_100, side: 'long', quantity: 2, price: 100 });
  const api = makeApi({
    fillPages: [
      { data: [sourceFill], more: false },
      { data: [sourceFill], more: false },
    ],
  });
  let now = 1_000_000;
  const bot = new PerpsCopyBot({ api, clock: () => now, pollIntervalMs: 60_000 });
  await bot.initialize();
  now += 1_000;
  await bot.pollOnce();
  const sizeAfterFirstRead = bot.state.positions[0].size;
  now += 1_000;
  await bot.pollOnce();
  assert.equal(bot.state.positions[0].size, sizeAfterFirstRead);
  assert.equal(bot.state.stats.copiedFills, 1);
});

test('public API uses the official Perps paths and sends no credentials', async () => {
  const seen = [];
  const api = new PerpsPublicApi({
    baseUrl: 'https://unit.test',
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{"registered":true}',
      };
    },
  });
  await api.registration('0xabc');
  assert.equal(seen[0].url, 'https://unit.test/v1/info/registered?address=0xabc');
  assert.deepEqual(seen[0].options.headers, { accept: 'application/json' });
  assert.equal(seen[0].options.headers.authorization, undefined);
});
