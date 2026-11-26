'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PerpsCopyBot } = require('../perps-copy-bot');
const { PerpsPublicApi } = require('../perps-public-api');

async function fixture({ positions = [], saved = null, capital = 5000 } = {}) {
  let now = 1_000_000;
  let sequence = 0;
  let fills = [];
  let levels = { bids: [['99', '1000']], asks: [['101', '1000']] };
  let stale = false;
  let frozen = false;
  let lastBook;
  const api = {
    registration: async () => ({ registered: true }),
    instruments: async () => [{
      instrument_id: 1, symbol: 'TEST-PERP', category: 'equity',
      price_decimals: 2, quantity_decimals: 4, min_notional: '1', max_leverage: 10,
    }],
    fees: async () => ({ fee_schedule: [{
      instrument_type: 'perpetual', category: 'equity',
      tiers: [{ min_volume_30d: '0', maker_fee_rate: '0.0002', taker_fee_rate: '0.0005' }],
    }] }),
    portfolio: async () => ({ equity: '10000', positions, timestamp: now }),
    tickers: async () => [{ instrument_id: 1, mark_price: '100', timestamp: now }],
    fills: async () => ({ data: fills, more: false }),
    book: async () => {
      if (frozen && lastBook) return structuredClone(lastBook);
      lastBook = { instrument_id: 1, ...levels, timestamp: stale ? now - 30_000 : now, sequence: ++sequence };
      return structuredClone(lastBook);
    },
  };
  const store = {
    load: async () => saved && structuredClone(saved),
    save: async state => { saved = structuredClone(state); },
  };
  const bot = new PerpsCopyBot({ api, store, paperCapital: capital, clock: () => now });
  await bot.initialize();
  assert.equal(bot.state.status, 'running', bot.state.source.lastError);
  return {
    bot, api, store,
    advance: ms => { now += ms; },
    setBook: value => { levels = value; },
    setStale: value => { stale = value; },
    freeze: value => { frozen = value; },
    setFills: value => { fills = value; },
    fill: (id, side, quantity, price = 100, previousSize = 0) => ({
      trade_id: id, instrument_id: 1, side, quantity: String(quantity),
      price: String(price), previous_size: String(previousSize), timestamp: now,
    }),
  };
}

function queue(bot, delta = 1, price = 100, id = 'master') {
  return bot.orders.queue(bot.state.instruments['1'], delta, price, {
    sourceFillId: id, sourceTimestamp: bot.clock(), sourceSide: delta > 0 ? 'long' : 'short',
  });
}

test('master fill queues an exact-priced limit, not an immediate fictional fill', async () => {
  const f = await fixture();
  f.advance(1000);
  f.setFills([f.fill('one', 'long', 2)]);
  await f.bot.pollOnce();
  assert.equal(f.bot.state.positions.length, 0);
  assert.equal(f.bot.state.orders[0].quantity, 1);
  assert.equal(f.bot.state.orders[0].limitPrice, 100);
  assert.equal(f.bot.state.orders[0].expiresAt - f.bot.state.orders[0].createdAt, 300000);
  assert.equal(f.bot.state.account.fees, 0);
});

test('marketable limit uses real book prices, partial depth and taker fees', async () => {
  const f = await fixture();
  queue(f.bot);
  f.setBook({ asks: [['99', '0.3'], ['100', '0.2'], ['101', '50']], bids: [['98', '10']] });
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1).size, 0.5);
  assert.equal(f.bot.state.orders[0].remaining, 0.5);
  assert.equal(f.bot.state.orders[0].status, 'PARTIAL');
  assert.ok(Math.abs(f.bot.state.account.fees - (99 * 0.3 + 100 * 0.2) * 0.0005) < 1e-10);
  assert.ok(f.bot.state.trades.every(t => t.liquidity === 'TAKER' && t.price <= 100));
});

test('resting equality is not a fill; strictly-through depth fills at master limit with maker fee', async () => {
  const f = await fixture();
  queue(f.bot);
  await f.bot.orders.process();
  f.advance(1000);
  f.setBook({ asks: [['100', '10']], bids: [['99', '10']] });
  await f.bot.orders.process();
  assert.equal(f.bot.state.positions.length, 0);
  f.advance(1000);
  f.setBook({ asks: [['99', '0.4']], bids: [['98', '10']] });
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1).size, 0.4);
  assert.equal(f.bot.findPosition(1).averageEntryPrice, 100);
  assert.equal(f.bot.state.trades[0].liquidity, 'MAKER');
  assert.equal(f.bot.state.account.fees, 0.008);
});

test('five-minute timeout market-sweeps only unfilled remainder at depth-weighted prices', async () => {
  const f = await fixture();
  queue(f.bot);
  f.setBook({ asks: [['100', '0.25']], bids: [['99', '10']] });
  await f.bot.orders.process();
  f.advance(299999);
  f.setBook({ asks: [['104', '1']], bids: [['103', '1']] });
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1).size, 0.25);
  f.advance(1);
  f.setBook({ asks: [['104', '0.25'], ['106', '0.5']], bids: [['103', '1']] });
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1).size, 1);
  assert.equal(f.bot.findPosition(1).averageEntryPrice, 104);
  assert.equal(f.bot.state.orders[0].status, 'FILLED');
  assert.ok(Math.abs(f.bot.state.account.fees - 104 * 0.0005) < 1e-10);
  assert.equal(f.bot.state.trades[0].executionType, 'FORCED_MARKET');
});

test('sell exits wait at master price then sweep bids after timeout', async () => {
  const f = await fixture();
  queue(f.bot);
  f.setBook({ asks: [['100', '10']], bids: [['99', '10']] });
  await f.bot.orders.process();
  queue(f.bot, -1, 105, 'exit');
  f.advance(1000);
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1).size, 1);
  f.advance(300000);
  f.setBook({ asks: [['96', '10']], bids: [['95', '10']] });
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1), undefined);
  assert.equal(f.bot.state.account.realizedPnl, -5);
  assert.equal(f.bot.state.trades[0].price, 95);
  assert.equal(f.bot.state.trades[0].action, 'CLOSE');
});

test('short entries and buy-to-close use correct sides and profit arithmetic', async () => {
  const f = await fixture();
  queue(f.bot, -2);
  f.setBook({ bids: [['100', '10']], asks: [['101', '10']] });
  await f.bot.orders.process();
  queue(f.bot, 2, 90, 'cover');
  f.advance(1000);
  f.setBook({ bids: [['88', '10']], asks: [['89', '10']] });
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1), undefined);
  assert.equal(f.bot.state.account.realizedPnl, 22);
  assert.ok(Math.abs(f.bot.state.account.fees - (200 + 178) * 0.0005) < 1e-10);
});

test('duplicate book snapshot cannot be consumed again or by multiple orders', async () => {
  const f = await fixture();
  queue(f.bot, 1, 100, 'a'); queue(f.bot, 1, 100, 'b');
  f.setBook({ asks: [['99', '0.5']], bids: [['98', '10']] });
  await f.bot.orders.process();
  f.freeze(true);
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1).size, 0.5);
  assert.equal(f.bot.state.orders.reduce((s, o) => s + o.remaining, 0), 1.5);
});

test('stale, absent and insufficient market depth never invent a forced fill', async () => {
  const f = await fixture();
  queue(f.bot);
  f.advance(300000); f.setStale(true);
  await assert.rejects(f.bot.orders.process(), /Stale/);
  assert.equal(f.bot.state.positions.length, 0);
  f.setStale(false); f.setBook({ bids: [], asks: [] });
  await f.bot.orders.process();
  assert.equal(f.bot.state.orders[0].remaining, 1);
  assert.match(f.bot.state.orders[0].blockedReason, /depth/);
  f.advance(1000);
  f.setBook({ bids: [], asks: [['110', '0.2']] });
  await f.bot.orders.process();
  assert.equal(f.bot.state.orders[0].remaining, 0.8);
});

test('margin uses 5× notional and allows reductions when new exposure is blocked', async () => {
  const f = await fixture({ capital: 100 });
  queue(f.bot, 10);
  f.setBook({ asks: [['100', '100']], bids: [['100', '100']] });
  await f.bot.orders.process();
  assert.ok(f.bot.findPosition(1).size < 5);
  assert.ok(f.bot.findPosition(1).size > 4.9);
  assert.equal(f.bot.state.account.initialMargin, f.bot.state.account.openNotional / 5);
  assert.ok(f.bot.state.account.equity >= f.bot.state.account.initialMargin);
  f.bot.orders.cancelOpposing(1, -100);
  const size = f.bot.findPosition(1).size;
  f.bot.state.account.cash = 1;
  queue(f.bot, -size, 100, 'close');
  f.advance(1);
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1), undefined);
});

test('opposing master target cancels old unfilled exposure instead of reopening stale position', async () => {
  const f = await fixture();
  queue(f.bot, 1);
  assert.equal(f.bot.orders.projectedSize(1), 1);
  f.bot.movePositionToTarget(f.bot.state.instruments['1'], 0, 99, { sourceFillId: 'close', sourceSide: 'short' });
  assert.equal(f.bot.orders.projectedSize(1), 0);
  assert.equal(f.bot.state.orders[0].status, 'CANCELLED');
  assert.equal(f.bot.state.positions.length, 0);
});

test('portfolio refresh never bypasses a pending limit or creates automatic equity rebalance orders', async () => {
  const f = await fixture();
  queue(f.bot);
  await f.bot.refreshPortfolio();
  assert.equal(f.bot.state.positions.length, 0);
  assert.equal(f.bot.state.orders.length, 1);
  assert.equal(f.bot.state.orders[0].remaining, 1);
});

test('restart preserves remaining quantity, original deadline and all prior P&L', async () => {
  const f = await fixture();
  queue(f.bot);
  f.setBook({ asks: [['100', '0.3']], bids: [['99', '10']] });
  await f.bot.orders.process();
  await f.bot.persist();
  const expected = structuredClone(f.bot.state);
  f.setBook({ asks: [['101', '10']], bids: [['99', '10']] });
  f.advance(10000);
  const restored = new PerpsCopyBot({ api: f.api, store: f.store, clock: () => 1010000 });
  await restored.initialize();
  assert.equal(restored.state.orders[0].expiresAt, expected.orders[0].expiresAt);
  assert.equal(restored.state.orders[0].remaining, 0.7);
  assert.equal(restored.state.account.fees, expected.account.fees);
  assert.equal(restored.state.account.cash, expected.account.cash);
  assert.equal(restored.state.trades.length, expected.trades.length);
});

test('legacy migration preserves history and positions without fake expansion fills', async () => {
  const f = await fixture();
  const saved = structuredClone(f.bot.state);
  delete saved.execution; delete saved.orders; delete saved.orderCounter;
  saved.account.realizedPnl = 12; saved.account.fees = 2; saved.account.cash = 5010;
  saved.trades.push({ id: 'historic' });
  const next = await fixture({ saved });
  assert.equal(next.bot.state.account.cash, 5010);
  assert.equal(next.bot.state.account.realizedPnl, 12);
  assert.equal(next.bot.state.account.fees, 2);
  assert.equal(next.bot.state.trades[0].id, 'historic');
  assert.equal(next.bot.state.orders.length, 0);
  assert.equal(next.bot.state.execution.configuredLeverage, 5);
});

test('same master fill is copied once; pending target prevents duplicates', async () => {
  const f = await fixture();
  f.advance(1000); f.setFills([f.fill('once', 'long', 2)]);
  await f.bot.pollOnce(); f.advance(1000); await f.bot.pollOnce();
  assert.equal(f.bot.state.orders.length, 1);
  assert.equal(f.bot.state.stats.copiedFills, 1);
});

test('unknown fee category fails explicitly without a fabricated free fill', async () => {
  const f = await fixture();
  f.bot.state.instruments['1'].category = 'unknown';
  queue(f.bot); f.setBook({ asks: [['99', '10']], bids: [['98', '10']] });
  await assert.rejects(f.bot.orders.process(), /No verified fee schedule/);
  assert.equal(f.bot.state.positions.length, 0);
});

test('one order flipping through zero charges fees exactly once', async () => {
  const f = await fixture();
  queue(f.bot);
  f.setBook({ asks: [['100', '10']], bids: [['100', '10']] });
  await f.bot.orders.process();
  queue(f.bot, -3, 100, 'flip'); f.advance(1);
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1).size, -2);
  assert.ok(Math.abs(f.bot.state.account.fees - 400 * 0.0005) < 1e-10);
  assert.ok(Math.abs(f.bot.state.trades.reduce((sum, t) => sum + t.fee, 0) - f.bot.state.account.fees) < 1e-10);
});

test('official public book, fees, ticker and fill requests never send credentials', async () => {
  const requests = [];
  const api = new PerpsPublicApi({ baseUrl: 'https://unit.test', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  } });
  await api.book(1); await api.fees(); await api.tickers(); await api.fills('0xabc');
  assert.ok(requests[0].url.endsWith('/v1/info/book?instrument_id=1&depth=100'));
  assert.ok(requests[1].url.endsWith('/v1/info/fees'));
  assert.ok(requests[2].url.endsWith('/v1/info/tickers'));
  for (const request of requests) assert.deepEqual(request.options.headers, { accept: 'application/json' });
});

test('adoption queues current exposure without importing old source gains', async () => {
  const f = await fixture({ positions: [
    { instrument_id: 1, size: '2', entry_price: '80', unrealized_pnl: '40' },
  ] });
  assert.equal(f.bot.state.orders.length, 1);
  assert.equal(f.bot.state.orders[0].limitPrice, 100);
  assert.equal(f.bot.state.orders[0].quantity, 1);
  assert.equal(f.bot.state.positions.length, 0);
  assert.equal(f.bot.state.account.equity, 5000);
});

test('source closes after partial copy: cancel remaining entry and exit only actual filled size', async () => {
  const f = await fixture();
  queue(f.bot);
  f.setBook({ asks: [['100', '0.3']], bids: [['99', '10']] });
  await f.bot.orders.process();
  f.bot.movePositionToTarget(f.bot.state.instruments['1'], 0, 105, { sourceFillId: 'close', sourceSide: 'short' });
  const pending = f.bot.state.orders.filter(o => o.remaining > 0);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].side, 'SELL');
  assert.equal(pending[0].remaining, 0.3);
  f.advance(300000);
  f.setBook({ asks: [['103', '10']], bids: [['102', '10']] });
  await f.bot.orders.process();
  assert.equal(f.bot.findPosition(1), undefined);
  assert.equal(f.bot.state.orders.filter(o => o.remaining > 0).length, 0);
});

test('omitted live fee categories use explicitly labelled published standard estimates', async () => {
  const f = await fixture();
  f.bot.state.instruments['1'].category = 'crypto';
  queue(f.bot); f.setBook({ asks: [['100', '10']], bids: [['99', '10']] });
  await f.bot.orders.process();
  assert.equal(f.bot.state.account.fees, 0.05);
  assert.match(f.bot.state.trades[0].feeSource, /absent from live fee API/);
});

test('active per-instrument fee override applies and expires at its end time', async () => {
  const f = await fixture();
  const instrument = f.bot.state.instruments['1'];
  instrument.feeOverride = { start_time: 999000, end_time: 1001000,
    tiers: [{ maker_fee_rate: '0.0001', taker_fee_rate: '0.0003' }] };
  assert.equal(f.bot.orders.feeRate(instrument, 'TAKER'), 0.0003);
  f.advance(1000);
  assert.equal(f.bot.orders.feeRate(instrument, 'TAKER'), 0.0005);
});
