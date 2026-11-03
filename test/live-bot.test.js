'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LiveBot = require('../live-bot');

function setup({ now = 250_000, accountReady = true, fetchStatus = null } = {}) {
  let id = 0;
  const calls = [];
  const exchangeOrders = new Map();
  const trader = {
    authenticate: async () => true,
    listOpenOrders: async () => [],
    getEquitySnapshot: async () => ({ orders: [], positions: [], collateral: 20, positionValue: 0, equity: 20 }),
    placeLimitOrder: async (tokenId, side, price, shares) => {
      const order = { id: `order-${++id}`, tokenId, side, price, shares, status: 'LIVE', sizeMatched: 0 };
      calls.push({ ...order });
      exchangeOrders.set(order.id, order);
      return order;
    },
    fetchOrder: async orderId => {
      const order = exchangeOrders.get(orderId);
      if (!order) return null;
      const status = fetchStatus ? fetchStatus(order) : order.status;
      return { ...order, status, sizeMatched: status === 'MATCHED' ? order.shares : order.sizeMatched };
    },
    cancelOrder: async orderId => {
      calls.push({ cancel: orderId });
      const order = exchangeOrders.get(orderId);
      if (order) order.status = 'CANCELED';
      return { status: 'CANCELED' };
    },
  };
  const marketData = {
    getBtcMarket: async (start, windowMs) => ({
      id: `market-${start}`,
      slug: `btc-updown-${windowMs / 60_000}m-${Math.floor(start / 1000)}`,
      title: 'BTC Up or Down',
      start,
      end: start + windowMs,
      tokens: { UP: 'token-up', DOWN: 'token-down' },
    }),
    getBook: async tokenId => ({
      bids: [{ price: tokenId === 'token-up' ? '0.49' : '0.29', size: '10' }],
      asks: [{ price: tokenId === 'token-up' ? '0.51' : '0.31', size: '10' }],
    }),
  };
  const bot = new LiveBot({
    trader,
    marketData,
    tradingEnabled: true,
    clock: () => now,
    marketPollMs: 1_000,
    accountRefreshMs: 15_000,
    orderPollMs: 500,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  bot.startedAt = 0;
  bot.running = true;
  bot.authenticated = true;
  bot.account.accountReady = accountReady;
  return { bot, trader, calls, exchangeOrders, marketData };
}

const eligible = {
  eligible: true,
  status: 'eligible',
  qualifyingSides: ['UP'],
  upMid: 0.50,
  downMid: 0.30,
  remainingMs: 50_000,
  reason: 'UP midpoint is in range',
};

function fillableMarket(bot) {
  const state = bot.markets['5m'];
  Object.assign(state, {
    windowStart: 0,
    windowEnd: 300_000,
    slug: 'btc-updown-5m-0',
    market: { tokens: { UP: 'token-up', DOWN: 'token-down' } },
    signal: eligible,
  });
  return state;
}

test('one qualifying outcome submits exactly four two-sided limit buys once', async () => {
  const { bot, calls } = setup();
  const state = fillableMarket(bot);
  await bot.fireWindowOrders(state, eligible);
  await bot.fireWindowOrders(state, eligible);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ side, price, shares }) => [side, price, shares]), [
    ['BUY', 0.25, 10],
    ['BUY', 0.15, 10],
    ['BUY', 0.25, 10],
    ['BUY', 0.15, 10],
  ]);
  assert.equal(new Set(calls.map(call => call.tokenId)).size, 2);
  assert.equal(state.triggeredAt, 250_000);
});

test('take-profit sells are submitted only after matched entry shares are confirmed', async () => {
  const { bot, calls, exchangeOrders } = setup();
  const state = fillableMarket(bot);
  await bot.fireWindowOrders(state, eligible);

  await bot.reconcileOrders();
  assert.equal(calls.filter(call => call.side === 'SELL').length, 0);

  for (const order of exchangeOrders.values()) {
    if (order.side === 'BUY') order.status = 'MATCHED';
  }
  await bot.reconcileOrders();

  const sells = calls.filter(call => call.side === 'SELL');
  assert.equal(sells.length, 4);
  assert.deepEqual(sells.map(({ price, shares }) => [price, shares]), [
    [0.75, 10],
    [0.85, 10],
    [0.75, 10],
    [0.85, 10],
  ]);
});

test('an eligible signal waits for account readiness and submits when still eligible', async () => {
  const { bot, calls } = setup({ accountReady: false });
  await bot.scanTimeframe('5m', 250_000);
  assert.equal(calls.length, 0);
  assert.equal(bot.markets['5m'].triggeredAt, null);
  assert.equal(bot.markets['5m'].signal.status, 'eligible_account_blocked');

  bot.account.accountReady = true;
  await bot.scanTimeframe('5m', 251_000);
  assert.equal(calls.filter(call => call.side === 'BUY').length, 4);
});

test('an ambiguous entry submission halts new entries instead of retrying blindly', async () => {
  const { bot, calls } = setup();
  const state = fillableMarket(bot);
  bot.trader.placeLimitOrder = async () => {
    const error = new Error('request timed out after submission');
    error.submissionUncertain = true;
    throw error;
  };
  await bot.fireWindowOrders(state, eligible);
  assert.equal(bot.halted, true);
  assert.equal(bot.account.accountReady, false);
  assert.equal(calls.length, 0);
  assert.equal(state.triggeredAt, 250_000);
});

test('live entry placeholders are persisted before the first exchange submission', async () => {
  const writes = [];
  const store = {
    durable: true,
    load: async () => null,
    save: async document => writes.push(JSON.parse(JSON.stringify(document))),
  };
  const { bot, calls } = setup();
  bot.stateStore = store;
  bot.requirePersistentState = true;
  const state = fillableMarket(bot);
  await bot.fireWindowOrders(state, eligible);

  assert.equal(writes[0].orders.length, 4);
  assert.ok(writes[0].orders.every(order => order.status === 'SUBMITTING'));
  assert.equal(calls.length, 4);
});

test('live trading bootstrap refuses to authenticate without durable order storage', async () => {
  const { bot, trader } = setup();
  bot.requirePersistentState = true;
  bot.stateStore = null;
  let authenticated = false;
  trader.authenticate = async () => { authenticated = true; };
  await bot.bootstrapTrading();
  assert.equal(authenticated, false);
  assert.equal(bot.account.accountReady, false);
  assert.match(bot.account.error, /Persistent live-order storage is required/);
});

test('order polling cannot clear a failed or stale account snapshot', async () => {
  const { bot } = setup();
  bot.account.accountReady = false;
  bot.account.snapshotHealthy = false;
  bot.account.error = 'Positions API 429';
  bot.account.status = 'error';
  bot.account.lastSuccessAt = 200_000;
  await bot.reconcileOrders();
  assert.equal(bot.account.accountReady, false);
  assert.equal(bot.account.error, 'Positions API 429');
});

test('window close cancels entry buys but leaves take-profit sells resting', async () => {
  const { bot, calls } = setup({ now: 300_000 });
  const state = fillableMarket(bot);
  const entry = {
    id: 'entry-1', clientKey: `${state.slug}:UP:0.25`, kind: 'ENTRY', side: 'BUY',
    slug: state.slug, windowEnd: 300_000, status: 'LIVE', matchedShares: 0,
  };
  const exit = {
    id: 'exit-1', clientKey: 'tp:entry-1:1', kind: 'TAKE_PROFIT', side: 'SELL',
    slug: state.slug, windowEnd: 300_000, status: 'LIVE', matchedShares: 0,
  };
  state.orderIds = [entry.clientKey];
  bot.ordersById.set(entry.id, entry);
  bot.ordersById.set(exit.id, exit);
  await bot.cancelWindowEntryOrders(state);
  assert.deepEqual(calls, [{ cancel: 'entry-1' }]);
  assert.equal(exit.status, 'LIVE');
});

test('an order from the account that cannot be classified blocks new entries', async () => {
  const { bot, trader } = setup({ accountReady: false });
  trader.listOpenOrders = async () => [{
    id: 'manual-order',
    assetId: 'unknown-token',
    side: 'BUY',
    price: '0.42',
    originalSize: '10',
    sizeMatched: '0',
    status: 'LIVE',
  }];
  await bot.recoverOpenOrders();
  assert.equal(bot.account.untrackedOpenOrders, 1);
  assert.equal(bot.account.accountReady, false);
});

test('dashboard snapshot identifies the live strategy and separate 5m/15m windows', () => {
  const { bot } = setup();
  const state = bot.snapshot();
  assert.equal(state.mode, 'REAL ORDERS');
  assert.deepEqual(state.strategy.markets, ['BTC 5m', 'BTC 15m']);
  assert.ok(state.markets['5m']);
  assert.ok(state.markets['15m']);
  assert.equal(state.strategy.orderPollMs, 500);
});
