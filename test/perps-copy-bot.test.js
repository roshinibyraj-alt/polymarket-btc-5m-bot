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
  const bot = new PerpsCopyBot({ api, paperCapital: 500, clock: () => now, pollIntervalMs: 60_000 });
  await bot.initialize();
  assert.equal(bot.state.status, 'running');
  return bot;
}

test('adopts the startup position and copies its later reduction and flip', async () => {
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
  assert.equal(bot.state.positions.length, 1, 'startup positions are adopted');
  await bot.pollOnce();
  assert.equal(bot.state.positions.length, 1);
  assert.ok(Math.abs(bot.state.positions[0].size + 1) < 0.02, 'new short exposure uses the live equity ratio after costs');
  assert.equal(bot.state.stats.copiedFills, 2);
  assert.equal(bot.state.stats.ignoredZeroChangeFills, 0);
});

test('scales long fills, estimates fees, and reduces on source exits', async () => {
  const api = makeApi({
    fillPages: [
      { data: [fill({ id: 'open', timestamp: 1_000_100, side: 'long', quantity: 2, price: 100 })], more: false },
      { data: [fill({ id: 'close', timestamp: 1_000_200, side: 'short', quantity: 1, price: 100, previousSize: 2 })], more: false },
    ],
  });
  let now = 1_000_000;
  const bot = new PerpsCopyBot({ api, paperCapital: 500, clock: () => now, pollIntervalMs: 60_000 });
  await bot.initialize();
  now += 1_000;
  await bot.pollOnce();
  assert.equal(bot.state.positions[0].size, 1);
  assert.equal(bot.state.positions[0].averageEntryPrice, 100.01);
  assert.ok(bot.state.account.fees > 0);
  const openedFees = bot.state.account.fees;

  now += 1_000;
  await bot.pollOnce();
  assert.ok(Math.abs(bot.state.positions[0].size - 0.5) < 0.001);
  assert.ok(bot.state.account.fees > openedFees);
  assert.equal(bot.state.trades[0].action, 'CLOSE');
});

test('copies exposure over $500 without clipping or imposing a capital notional limit', async () => {
  const api = makeApi({
    fillPages: [{
      data: [fill({ id: 'oversized', timestamp: 1_000_100, side: 'long', quantity: 200, price: 10 })],
      more: false,
    }],
  });
  let now = 1_000_000;
  const bot = new PerpsCopyBot({
    api,
    paperCapital: 500,
    clock: () => now,
    pollIntervalMs: 60_000,
  });
  await bot.initialize();
  now += 1_000;
  await bot.pollOnce();
  assert.equal(bot.state.positions.length, 1);
  assert.equal(bot.state.account.openNotional, 1000);
  assert.equal(bot.state.positions[0].size, 100);
  assert.equal(bot.state.stats.capLimitedEntries, 0);
  assert.equal(bot.state.sizing.maxOpenNotional, null);
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
  const bot = new PerpsCopyBot({ api, paperCapital: 500, clock: () => now, pollIntervalMs: 60_000 });
  await bot.initialize();
  now += 1_000;
  await bot.pollOnce();
  const sizeAfterFirstRead = bot.state.positions[0].size;
  now += 1_000;
  await bot.pollOnce();
  assert.equal(bot.state.positions[0].size, sizeAfterFirstRead);
  assert.equal(bot.state.stats.copiedFills, 1);
});

test('adopts current positions at live marks without importing earlier P&L', async () => {
  const api = makeApi({
    portfolioPositions: [{
      instrument_id: 1,
      symbol: 'BTC-USD',
      size: '2',
      entry_price: '100',
      unrealized_pnl: '10',
    }],
  });
  const bot = await readyBot(api);
  assert.equal(bot.state.positions.length, 1);
  assert.equal(bot.state.positions[0].size, 1);
  assert.equal(bot.state.positions[0].markPrice, 105);
  assert.equal(bot.state.positions[0].averageEntryPrice, 105.01);
  assert.equal(bot.state.trades[0].action, 'ADOPT');
  assert.ok(bot.state.account.fees > 0);
  assert.ok(bot.state.positions[0].unrealizedPnl < 0, 'only the adverse entry tick, not the source’s earlier gain, is reflected');
  assert.ok(bot.state.source.existingPositionsAdoptedAt);
});

test('migrates an earlier clean-baseline ledger to adopted positions only once', async () => {
  const api = makeApi({
    portfolioPositions: [{
      instrument_id: 1,
      symbol: 'BTC-USD',
      size: '2',
      entry_price: '100',
      unrealized_pnl: '10',
    }],
  });
  const original = await readyBot(api);
  const oldState = JSON.parse(JSON.stringify(original.state));
  delete oldState.source.existingPositionsAdoptedAt;
  const expectedTrades = oldState.trades.map(t => t.id);
  const store = { load: async () => oldState, save: async () => {} };
  const restored = new PerpsCopyBot({ api: makeApi({
    portfolioPositions: [{
      instrument_id: 1,
      symbol: 'BTC-USD',
      size: '2',
      entry_price: '100',
      unrealized_pnl: '10',
    }],
  }), store, paperCapital: 500, clock: () => 1_000_000 });
  await restored.initialize();
  assert.ok(restored.state.source.existingPositionsAdoptedAt);
  assert.ok(Math.abs(restored.state.positions[0].size - 1) < 0.001);
  for (const id of expectedTrades) assert.ok(restored.state.trades.some(t => t.id === id));
  assert.equal(restored.state.trades.filter(t => t.action === 'ADOPT').length, 1);
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

test('defaults to $5000 capital with live equity sizing and no exposure cap', async () => {
  const bot = new PerpsCopyBot({ api: makeApi(), clock: () => 1_000_000 });
  await bot.initialize();
  assert.equal(bot.state.account.startingCapital, 5000);
  assert.equal(bot.state.account.cash, 5000);
  assert.equal(bot.state.sizing.paperCapital, 5000);
  assert.equal(bot.state.sizing.multiplier, 5);
  assert.equal(bot.state.sizing.maxOpenNotional, null);
  assert.equal(bot.state.sizing.mode, 'equity_ratio');
});

test('capital migration preserves P&L and is idempotent', async () => {
  const previous = await readyBot(makeApi());
  previous.state.account.cash = 487;
  previous.state.account.realizedPnl = -12;
  previous.state.account.fees = 1;
  previous.recalculateAccount();
  let saved = JSON.parse(JSON.stringify(previous.state));
  const store = {
    load: async () => JSON.parse(JSON.stringify(saved)),
    save: async (state) => { saved = JSON.parse(JSON.stringify(state)); },
  };
  const upgraded = new PerpsCopyBot({ api: makeApi(), store, clock: () => 1_000_000 });
  await upgraded.initialize();
  assert.equal(upgraded.state.account.startingCapital, 5000);
  assert.equal(upgraded.state.account.cash, 4987);
  assert.equal(upgraded.state.account.realizedPnl, -12);
  assert.equal(upgraded.state.account.fees, 1);
  assert.equal(upgraded.state.sizing.maxOpenNotional, null);
  const restarted = new PerpsCopyBot({ api: makeApi(), store, clock: () => 1_000_000 });
  await restarted.initialize();
  assert.equal(restarted.state.account.cash, 4987);
});

test('rebalances all long and short positions to current equity ratio', async () => {
  const positions = [
    { instrument_id: 1, size: '20', entry_price: '100', unrealized_pnl: '0' },
    { instrument_id: 2, size: '-10', entry_price: '100', unrealized_pnl: '0' },
  ];
  const api = makeApi({ portfolioPositions: positions });
  const bot = await readyBot(api);
  assert.equal(bot.state.account.openNotional, 1500);
  bot.state.account.cash = 400;
  api.portfolio = async () => ({ equity: '2000', positions, timestamp: 1_000_100 });
  const equityBefore = bot.snapshot().account.equity;
  await bot.refreshPortfolio();
  const ratio = equityBefore / 2000;
  assert.equal(bot.state.sizing.multiplier, ratio);
  assert.ok(Math.abs(bot.findPosition('1').size - 20 * ratio) < 0.00011);
  assert.ok(Math.abs(bot.findPosition('2').size + 10 * ratio) < 0.000001);
  assert.ok(bot.state.account.fees > 0);
  assert.ok(!bot.state.trades.some(t => t.action === 'CAP_TRIM'));
});

test('source closure removes copied position and preserves the closed trade record', async () => {
  const bot = await readyBot(makeApi({ portfolioPositions: [
    { instrument_id: 1, size: '20', entry_price: '100', unrealized_pnl: '0' },
  ] }));
  bot.api.portfolio = async () => ({ equity: '1000', positions: [], timestamp: 1_000_100 });
  await bot.refreshPortfolio();
  assert.equal(bot.state.positions.length, 0);
  assert.equal(bot.state.account.openNotional, 0);
  assert.equal(bot.state.trades[0].action, 'CLOSE');
  assert.ok(bot.state.trades.some(t => t.action === 'ADOPT'));
});

test('invalid source equity pauses rather than using the old fixed ratio', async () => {
  const bot = await readyBot(makeApi());
  bot.api.portfolio = async () => ({ equity: '0', positions: [], timestamp: 1_000_100 });
  await assert.rejects(bot.refreshPortfolio(), /valid source equity/);
  bot.state.source.equity = 0;
  assert.throws(() => bot.updateSizingRatio(), /paused/);
});

test('restored capped history is retained while positions expand to the new ratio', async () => {
  const api = makeApi({ portfolioPositions: [
    { instrument_id: 1, size: '20', entry_price: '100', unrealized_pnl: '0' },
  ] });
  const original = await readyBot(api);
  const saved = JSON.parse(JSON.stringify(original.state));
  saved.positions[0].size = 1;
  saved.positions[0].averageEntryPrice = 100;
  saved.sizing.maxOpenNotional = 500;
  saved.sizing.startupAdoptionScale = 0.1;
  const originalIds = saved.trades.map(t => t.id);
  const restored = new PerpsCopyBot({
    api, paperCapital: 500, clock: () => 1_000_000,
    store: { load: async () => saved, save: async () => {} },
  });
  await restored.initialize();
  assert.equal(restored.state.sizing.maxOpenNotional, null);
  assert.equal(restored.state.sizing.startupAdoptionScale, undefined);
  assert.ok(restored.state.account.openNotional > 990);
  assert.ok(originalIds.every(id => restored.state.trades.some(t => t.id === id)));
});
