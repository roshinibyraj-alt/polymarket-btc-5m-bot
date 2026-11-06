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
      bids: [{ price: tokenId === 'token-up' ? '0.80' : '0.18', size: '10' }],
      asks: [{ price: tokenId === 'token-up' ? '0.82' : '0.20', size: '10' }],
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
  bot.stateReady = true;
  bot.account.accountReady = accountReady;
  return { bot, trader, calls, exchangeOrders, marketData };
}

const eligible = {
  eligible: true,
  status: 'eligible',
  strategyVersion: 'btc-midpoint-trigger-ladder-v1',
  selectedSide: 'UP',
  qualifyingSides: ['UP'],
  upMid: 0.81,
  downMid: 0.19,
  triggeringPrice: 0.81,
  reason: 'UP midpoint reached $0.810 after the 120-second delay',
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

function armFlowTest(bot, armedAt = 0) {
  bot.flowTestEnabled = true;
  bot.flowTestState = {
    ...bot.flowTestState,
    status: 'armed',
    armedAt,
    windowStart: null,
    windowEnd: null,
    slug: null,
    side: null,
    orderClientKey: null,
    orderId: null,
    takeProfitOrderId: null,
    result: null,
    error: null,
    completedAt: null,
  };
}

test('the new strategy waits 120 seconds, then submits only the selected-side ladder once', async () => {
  const { bot, calls } = setup({ now: 100_000 });
  await bot.scanTimeframe('5m', 100_000);
  await bot.scanTimeframe('5m', 100_000);
  assert.equal(calls.length, 0);

  bot.clock = () => 120_000;
  await bot.scanTimeframe('5m', 120_000);
  await bot.scanTimeframe('5m', 120_000);

  const buys = calls.filter(call => call.side === 'BUY');
  assert.equal(buys.length, 2);
  assert.deepEqual(buys.map(({ price, shares }) => [price, shares]), [
    [0.40, 10],
    [0.60, 20],
  ]);
  assert.ok(buys.every(call => call.tokenId === 'token-up'));
  assert.equal(bot.markets['5m'].signal.status, 'triggered_once');
});

test('restart recovery recognizes new entries and still tracks legacy orders', () => {
  const newEntry = LiveBot.recoveredOrder({
    id: 'new-rung-buy',
    asset_id: 'token-down',
    side: 'BUY',
    price: '0.60',
    original_size: '20',
    size_matched: '6',
    status: 'PARTIALLY_FILLED',
    market: 'btc-updown-5m-1000',
  });
  const entry = LiveBot.recoveredOrder({
    id: 'recovered-buy',
    asset_id: 'token-up',
    side: 'BUY',
    price: '0.30',
    original_size: '20',
    size_matched: '6',
    status: 'PARTIALLY_FILLED',
    market: 'btc-updown-5m-1000',
  });
  const oldLadderEntry = LiveBot.recoveredOrder({
    id: 'legacy-ladder-buy',
    asset_id: 'token-up',
    side: 'BUY',
    price: '0.25',
    original_size: '10',
    size_matched: '0',
    status: 'LIVE',
    market: 'btc-updown-5m-1000',
  });
  const exit = LiveBot.recoveredOrder({
    id: 'recovered-sell',
    asset_id: 'token-up',
    side: 'SELL',
    price: '0.99',
    original_size: '6',
    size_matched: '0',
    status: 'LIVE',
    market: 'btc-updown-5m-1000',
  });

  assert.equal(newEntry.kind, 'ENTRY');
  assert.equal(newEntry.entryType, 'MIDPOINT_TRIGGER_LADDER');
  assert.equal(newEntry.takeProfitPrice, 0.85);
  assert.equal(newEntry.shares, 20);
  assert.equal(newEntry.matchedShares, 6);
  assert.equal(entry.kind, 'ENTRY');
  assert.equal(entry.entryType, 'WINDOW_START_PAIR');
  assert.equal(entry.takeProfitPrice, 0.99);
  assert.equal(entry.matchedShares, 6);
  assert.equal(oldLadderEntry.entryType, 'LEGACY_MIDPOINT_LADDER');
  assert.equal(oldLadderEntry.takeProfitPrice, 0.75);
  assert.equal(exit.kind, 'TAKE_PROFIT');
});

test('a legacy paired order fill still cancels its peer after strategy replacement', async () => {
  const { bot, calls } = setup();
  const state = bot.markets['5m'];
  Object.assign(state, { slug: 'btc-updown-5m-0', timeframe: '5m' });
  const group = 'window-start-pair:btc-updown-5m-0';
  const first = {
    id: 'legacy-up', clientKey: 'legacy-up', kind: 'ENTRY', side: 'BUY',
    outcome: 'UP', pairedEntryGroup: group, tokenId: 'token-up', price: 0.30,
    shares: 20, matchedShares: 1, slug: state.slug, timeframe: '5m',
    windowEnd: 300_000, status: 'PARTIALLY FILLED', exits: [],
  };
  const peer = {
    id: 'legacy-down', clientKey: 'legacy-down', kind: 'ENTRY', side: 'BUY',
    outcome: 'DOWN', pairedEntryGroup: group, tokenId: 'token-down', price: 0.30,
    shares: 20, matchedShares: 0, slug: state.slug, timeframe: '5m',
    windowEnd: 300_000, status: 'LIVE', exits: [],
  };
  bot.ordersById.set(first.id, first);
  bot.ordersById.set(peer.id, peer);

  await bot.cancelPairedEntryOrders(first);

  assert.deepEqual(calls.filter(call => call.cancel).map(call => call.cancel), ['legacy-down']);
});

test('old pending pair and old-strategy trigger intents are not re-fired after restart', async () => {
  let ledger = null;
  const store = {
    durable: true,
    load: async () => ledger,
    save: async document => { ledger = JSON.parse(JSON.stringify(document)); },
  };
  ledger = {
    version: 1,
    entryKeys: [],
    orders: [],
    markets: {
      '5m': {
        windowStart: 0,
        windowEnd: 300_000,
        slug: 'btc-updown-5m-0',
        windowStartPairPending: true,
        pendingTrigger: {
          observedAt: 110_000,
          windowStart: 0,
          windowEnd: 300_000,
          evaluation: { eligible: true, qualifyingSides: ['UP'] },
        },
      },
    },
  };
  const second = setup({ now: 121_000 });
  second.bot.startedAt = 121_000;
  second.bot.stateStore = store;
  second.bot.requirePersistentState = true;
  await second.bot.bootstrapTrading();
  await second.bot.scanTimeframe('5m', 121_000);

  assert.equal(second.calls.filter(call => call.side === 'BUY').length, 0);
  assert.equal(second.bot.markets['5m'].pendingTrigger, null);
  assert.equal(second.bot.markets['5m'].legacyWindowStartPairStatus, 'retired_by_strategy');
});

test('an already-open window is skipped after a restart', async () => {
  const { bot, calls } = setup({ now: 101_000 });
  bot.startedAt = 100_000;
  await bot.scanTimeframe('5m', 101_000);

  assert.equal(calls.length, 0);
  assert.equal(bot.markets['5m'].signal.status, 'skipped_restart_window');
});

test('one qualifying signal submits the two limit buys on the selected side once', async () => {
  const { bot, calls } = setup();
  const state = fillableMarket(bot);
  await bot.fireWindowOrders(state, eligible);
  await bot.fireWindowOrders(state, eligible);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ side, price, shares }) => [side, price, shares]), [
    ['BUY', 0.40, 10],
    ['BUY', 0.60, 20],
  ]);
  assert.ok(calls.every(call => call.tokenId === 'token-up'));
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
  assert.equal(sells.length, 2);
  assert.deepEqual(sells.map(({ price, shares }) => [price, shares]), [
    [0.75, 10],
    [0.85, 20],
  ]);
});

test('terminal matched entries retry a take-profit after the exchange releases shares', async () => {
  const { bot, trader, calls, exchangeOrders } = setup();
  const state = fillableMarket(bot);
  await bot.fireWindowOrders(state, eligible);
  let rejectFirstSell = true;
  const placeLimitOrder = trader.placeLimitOrder;
  trader.placeLimitOrder = async (tokenId, side, price, shares) => {
    if (side === 'SELL' && rejectFirstSell) {
      rejectFirstSell = false;
      const error = new Error('not enough balance / allowance: balance: 0');
      error.submissionUncertain = false;
      throw error;
    }
    return placeLimitOrder(tokenId, side, price, shares);
  };

  const entry = [...bot.ordersById.values()].find(order => order.kind === 'ENTRY');
  exchangeOrders.get(entry.id).status = 'MATCHED';
  await bot.reconcileOrders();
  assert.equal(calls.filter(call => call.side === 'SELL').length, 0);
  assert.ok(entry.retryAt > bot.clock());

  entry.retryAt = bot.clock() - 1;
  await bot.reconcileOrders();
  const sells = calls.filter(call => call.side === 'SELL');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].price, entry.takeProfitPrice);
  assert.equal(sells[0].shares, 10);
  assert.equal(entry.exits.length, 1);
  assert.equal(entry.exitBlockedReason, null);
});

test('resolved-market orders are terminal and pending sell retries are not repeated', async () => {
  const { bot, trader, calls } = setup();
  const slug = 'btc-updown-5m-0';
  const entry = {
    id: 'matched-entry', kind: 'ENTRY', side: 'BUY', outcome: 'UP',
    tokenId: 'token-up', price: 0.25, shares: 10, matchedShares: 9.996466,
    takeProfitPrice: 0.75, slug, windowEnd: 300_000, status: 'MATCHED',
    error: 'The resolved order is no longer available from CLOB lookup',
    retryAt: bot.clock() - 1_000, exitSubmittingShares: 0, exits: [],
  };
  const resolvedExit = {
    id: 'resolved-exit', kind: 'TAKE_PROFIT', side: 'SELL', outcome: 'UP',
    tokenId: 'token-up', price: 0.85, shares: 10, matchedShares: 0,
    slug, status: 'CANCELED MARKET RESOLVED',
  };
  bot.ordersById.set(entry.id, entry);
  bot.ordersById.set(resolvedExit.id, resolvedExit);
  const polled = [];
  trader.fetchOrder = async id => {
    polled.push(id);
    throw new Error('invalid token id');
  };

  await bot.reconcileOrders();

  assert.deepEqual(polled, []);
  assert.deepEqual(calls, []);
  assert.equal(entry.exits.length, 0);
  assert.equal(entry.error, null);
});

test('startup does not submit take-profit orders for a resolved market', async () => {
  const { bot, calls } = setup();
  const slug = 'btc-updown-5m-0';
  bot.ordersById.set('matched-entry', {
    id: 'matched-entry', kind: 'ENTRY', side: 'BUY', outcome: 'UP',
    tokenId: 'token-up', price: 0.25, shares: 10, matchedShares: 10,
    takeProfitPrice: 0.75, slug, windowEnd: 300_000, status: 'MATCHED',
    retryAt: 0, exitSubmittingShares: 0, exits: [],
  });
  bot.ordersById.set('resolved-exit', {
    id: 'resolved-exit', kind: 'TAKE_PROFIT', side: 'SELL', outcome: 'UP',
    tokenId: 'token-up', price: 0.85, shares: 10, matchedShares: 0,
    slug, status: 'CANCELED MARKET RESOLVED',
  });

  await bot.bootstrapTrading();

  assert.equal(bot.account.accountReady, true);
  assert.deepEqual(calls, []);
});

test('a qualifying tick stays latched and submits after prices fall below the threshold', async () => {
  const { bot, calls, marketData } = setup();
  bot.authenticated = false;
  bot.account.accountReady = false;
  await bot.scanTimeframe('5m', 250_000);
  assert.equal(calls.length, 0);
  assert.equal(bot.markets['5m'].triggeredAt, null);
  assert.equal(bot.markets['5m'].signal.status, 'trigger_latched_waiting_order_path');
  assert.ok(bot.markets['5m'].pendingTrigger);

  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === 'token-up' ? '0.49' : '0.19', size: '10' }],
    asks: [{ price: tokenId === 'token-up' ? '0.51' : '0.21', size: '10' }],
  });
  bot.authenticated = true;
  bot.refreshOrderReadiness();
  await bot.scanTimeframe('5m', 251_000);
  assert.equal(calls.filter(call => call.side === 'BUY').length, 2);
});

test('a latched signal expires rather than submitting after the window ends', async () => {
  const { bot, calls } = setup({ now: 299_000 });
  bot.clock = () => 300_000;

  await bot.scanTimeframe('5m', 299_000);

  assert.equal(calls.length, 0);
  assert.equal(bot.markets['5m'].signal.status, 'trigger_expired');
  assert.equal(bot.markets['5m'].pendingTrigger, null);
});

test('a latched trigger survives a process restart until its window closes', async () => {
  let ledger = null;
  const store = {
    durable: true,
    load: async () => ledger,
    save: async document => { ledger = JSON.parse(JSON.stringify(document)); },
  };
  const first = setup();
  first.bot.stateStore = store;
  first.bot.requirePersistentState = true;
  first.bot.authenticated = false;
  first.bot.account.accountReady = false;
  await first.bot.scanTimeframe('5m', 250_000);
  assert.equal(ledger.markets['5m'].pendingTrigger.observedAt, 250_000);

  const second = setup({ now: 251_000 });
  second.bot.startedAt = 251_000;
  second.bot.stateStore = store;
  second.bot.requirePersistentState = true;
  second.marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === 'token-up' ? '0.80' : '0.18', size: '10' }],
    asks: [{ price: tokenId === 'token-up' ? '0.82' : '0.20', size: '10' }],
  });
  await second.bot.bootstrapTrading();
  await second.bot.scanTimeframe('5m', 251_000);

  assert.equal(second.bot.markets['5m'].triggeredAt, 251_000);
  assert.equal(second.bot.markets['5m'].pendingTrigger.observedAt, 250_000);
  assert.equal(second.calls.filter(call => call.side === 'BUY').length, 2);
});

test('an account snapshot 429 does not block an authenticated qualifying entry', async () => {
  const { bot, trader, calls } = setup();
  trader.getEquitySnapshot = async () => { throw new Error('Positions API 429'); };

  await bot.refreshAccountSnapshot();

  assert.equal(bot.account.snapshotHealthy, false);
  assert.equal(bot.account.accountReady, true);
  assert.match(bot.account.error, /429/);
  await bot.scanTimeframe('5m', 250_000);
  assert.equal(calls.filter(call => call.side === 'BUY').length, 2);
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

  assert.equal(writes[0].orders.length, 2);
  assert.ok(writes[0].orders.every(order => order.status === 'SUBMITTING'));
  assert.equal(calls.length, 2);
});

test('live trading bootstrap refuses to authenticate without durable order storage', async () => {
  const { bot, trader } = setup();
  bot.authenticated = false;
  bot.account.accountReady = false;
  bot.requirePersistentState = true;
  bot.stateStore = null;
  let authenticated = false;
  trader.authenticate = async () => { authenticated = true; };
  await bot.bootstrapTrading();
  assert.equal(authenticated, false);
  assert.equal(bot.account.accountReady, false);
  assert.match(bot.account.error, /Persistent live-order storage is required/);
});

test('startup waits for the durable ledger before market scans can write state', async () => {
  const { bot, marketData } = setup();
  let releaseLoad;
  let lookups = 0;
  let saves = 0;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const originalLookup = marketData.getBtcMarket;
  marketData.getBtcMarket = async (...args) => {
    lookups++;
    return originalLookup(...args);
  };
  bot.running = false;
  bot.requirePersistentState = true;
  bot.stateStore = {
    durable: true,
    load: () => loadGate,
    save: async () => { saves++; },
  };
  bot.stateReady = false;

  bot.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 0);
  assert.equal(saves, 0);

  releaseLoad({ version: 1, entryKeys: [], orders: [], markets: {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(saves > 0);
  assert.ok(lookups > 0);
  bot.stop();
});

test('stale account snapshots do not change authenticated CLOB readiness', async () => {
  const { bot } = setup();
  bot.account.snapshotHealthy = false;
  bot.account.snapshotError = 'Positions API 429';
  bot.account.error = 'Positions API 429';
  bot.account.status = 'error';
  bot.account.lastSuccessAt = 200_000;
  await bot.reconcileOrders();
  assert.equal(bot.account.accountReady, true);
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

test('unclassified account orders warn but do not block the authenticated order path', async () => {
  const { bot, trader, calls } = setup();
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
  assert.equal(bot.account.accountReady, true);
  await bot.scanTimeframe('5m', 250_000);
  assert.equal(calls.filter(call => call.side === 'BUY').length, 2);
});

test('dashboard snapshot identifies the live strategy and separate 5m/15m windows', () => {
  const { bot } = setup();
  const state = bot.snapshot();
  assert.equal(state.mode, 'REAL ORDERS');
  assert.deepEqual(state.strategy.markets, ['BTC 5m', 'BTC 15m']);
  assert.equal(state.strategy.version, 'btc-midpoint-trigger-ladder-v1');
  assert.match(state.strategy.windowRule, /Wait 120 seconds/);
  assert.match(state.strategy.trigger, /at or above \$0\.80/);
  assert.deepEqual(state.strategy.orders.map(order => [order.buyPrice, order.shares, order.takeProfitPrice]), [
    [0.40, 10, 0.75],
    [0.60, 20, 0.85],
  ]);
  assert.match(state.strategy.rearm, /no opening pair/);
  assert.ok(state.markets['5m']);
  assert.ok(state.markets['15m']);
  assert.equal(state.strategy.orderPollMs, 500);
});

test('one-shot smoke test submits one five-share buy and pauses strategy entries', async () => {
  const { bot, calls } = setup();
  armFlowTest(bot);
  const state = fillableMarket(bot);

  await bot.scanTimeframe('5m', 250_000);
  await bot.scanTimeframe('15m', 250_000);

  assert.deepEqual(calls.map(({ side, price, shares }) => [side, price, shares]), [
    ['BUY', 0.70, 5],
  ]);
  assert.equal(bot.flowTestState.status, 'awaiting_fill');
  assert.equal(bot.flowTestState.side, 'DOWN');
  assert.equal(bot.flowTestPausesStrategy(), true);
  assert.equal(state.triggeredAt, 250_000);
  assert.equal(bot.snapshot().flowTest.maxBuyNotional, 3.5);
});

test('smoke test submits its take-profit only after Polymarket confirms the buy fill', async () => {
  const { bot, calls, exchangeOrders } = setup();
  armFlowTest(bot);
  fillableMarket(bot);
  await bot.scanTimeframe('5m', 250_000);

  const buy = [...bot.ordersById.values()].find(order => order.testOnly);
  exchangeOrders.get(buy.id).status = 'MATCHED';
  await bot.reconcileOrders();

  const sells = calls.filter(call => call.side === 'SELL');
  assert.deepEqual(sells.map(({ price, shares }) => [price, shares]), [[0.75, 5]]);
  assert.equal(bot.flowTestState.status, 'complete');
  assert.equal(bot.flowTestState.result, 'take_profit_sell_submitted');
  assert.ok(bot.flowTestState.takeProfitOrderId);
  assert.equal(bot.flowTestPausesStrategy(), false);
});

test('MATCHED placement status continues polling until the matched share count is confirmed', async () => {
  const { bot, trader, calls, exchangeOrders } = setup();
  armFlowTest(bot);
  fillableMarket(bot);
  const placeLimitOrder = trader.placeLimitOrder;
  trader.placeLimitOrder = async (tokenId, side, price, shares) => {
    const accepted = await placeLimitOrder(tokenId, side, price, shares);
    if (side === 'BUY') return { id: accepted.id, status: 'MATCHED' };
    return accepted;
  };

  let fetchCount = 0;
  trader.fetchOrder = async id => {
    const order = exchangeOrders.get(id);
    fetchCount++;
    const response = { ...order, status: 'MATCHED' };
    delete response.sizeMatched;
    response.size_matched = fetchCount === 1 ? '0' : '5';
    return response;
  };

  await bot.scanTimeframe('5m', 250_000);
  const entry = [...bot.ordersById.values()].find(order => order.testOnly);
  assert.equal(entry.status, 'MATCHED');
  assert.equal(entry.matchedShares, 0);

  await bot.reconcileOrders();
  assert.equal(fetchCount, 1);
  assert.equal(entry.matchedShares, 0);
  assert.equal(calls.some(call => call.side === 'SELL'), false);

  await bot.reconcileOrders();
  assert.equal(fetchCount, 2);
  assert.equal(entry.matchedShares, 5);
  assert.deepEqual(calls.filter(call => call.side === 'SELL').map(({ price, shares }) => [price, shares]), [
    [0.75, 5],
  ]);
  assert.equal(bot.flowTestState.status, 'complete');
});

test('smoke-test order is not submitted again after restart', async () => {
  let ledger = null;
  const store = {
    durable: true,
    load: async () => ledger,
    save: async document => { ledger = JSON.parse(JSON.stringify(document)); },
  };
  const first = setup();
  armFlowTest(first.bot);
  first.bot.stateStore = store;
  first.bot.requirePersistentState = true;
  fillableMarket(first.bot);
  await first.bot.scanTimeframe('5m', 250_000);
  assert.equal(ledger.flowTest.status, 'awaiting_fill');
  assert.equal(first.calls.length, 1);

  const second = setup({ now: 251_000 });
  second.bot.startedAt = 251_000;
  second.bot.flowTestEnabled = true;
  second.bot.stateStore = store;
  second.bot.requirePersistentState = true;
  await second.bot.bootstrapTrading();
  await second.bot.scanTimeframe('5m', 251_000);

  assert.equal(second.calls.length, 0);
  assert.equal(second.bot.flowTestState.status, 'awaiting_fill');
  assert.equal(second.bot.flowTestPausesStrategy(), true);
});
