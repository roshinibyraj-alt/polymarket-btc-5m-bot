'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LiveBot = require('../live-bot');
const { STRATEGY_VERSION } = require('../live-strategy');

function setup({
  now = 250_000,
  accountReady = true,
  fetchStatus = null,
  previousColor = 'DOJI',
  quotes = { UP: 0.81, DOWN: 0.19 },
  missingCandleData = false,
} = {}) {
  let id = 0;
  const calls = [];
  const exchangeOrders = new Map();
  const trader = {
    authenticate: async () => true,
    listOpenOrders: async () => [],
    getEquitySnapshot: async () => ({ orders: [], positions: [], collateral: 20, positionValue: 0, equity: 20 }),
    getMarket: async id => ({ id: String(id), closed: false, umaResolutionStatus: 'proposed' }),
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
      bids: [{ price: (quotes[tokenId === 'token-up' ? 'UP' : 'DOWN'] - 0.01).toFixed(2), size: '10' }],
      asks: [{ price: (quotes[tokenId === 'token-up' ? 'UP' : 'DOWN'] + 0.01).toFixed(2), size: '10' }],
    }),
  };
  const priceFeed = {
    getMinuteCandles: () => {
      if (missingCandleData) throw new Error('Test feed has no candle history');
      const windowStart = Math.floor(now / 300_000) * 300_000;
      const start = windowStart - 300_000;
      return Array.from({ length: 5 }, (_, index) => {
        const open = previousColor === 'GREEN' ? 100 + index : 100;
        const close = previousColor === 'GREEN' ? open + 1
          : previousColor === 'RED' ? open - 1
            : open;
        return {
          t: start + index * 60_000,
          o: open,
          h: Math.max(open, close) + (previousColor === 'DOJI' ? 1 : 0.2),
          l: Math.min(open, close) - (previousColor === 'DOJI' ? 1 : 0.2),
          c: close,
        };
      });
    },
  };
  const bot = new LiveBot({
    trader,
    marketData,
    priceFeed,
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
  return { bot, trader, calls, exchangeOrders, marketData, priceFeed };
}

const eligible = {
  eligible: true,
  status: 'eligible',
  strategyVersion: STRATEGY_VERSION,
  selectedSide: 'UP',
  qualifyingSides: ['UP'],
  upMid: 0.81,
  downMid: 0.19,
  triggeringPrice: 0.81,
  reason: 'UP midpoint reached $0.810 during the window',
};

function fillableMarket(bot) {
  const state = bot.markets['5m'];
  Object.assign(state, {
    windowStart: 0,
    windowEnd: 300_000,
    slug: 'btc-updown-5m-0',
    market: { id: 'market-0', tokens: { UP: 'token-up', DOWN: 'token-down' } },
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

test('the new strategy submits from window start and only once on the selected side', async () => {
  const { bot, calls } = setup({ now: 100_000 });
  await bot.scanTimeframe('5m', 100_000);
  await bot.scanTimeframe('5m', 100_000);

  const buys = calls.filter(call => call.side === 'BUY');
  assert.equal(buys.length, 2);
  assert.deepEqual(buys.map(({ price, shares }) => [price, shares]), [
    [0.40, 10],
    [0.45, 20],
  ]);
  assert.ok(buys.every(call => call.tokenId === 'token-up'));
  assert.equal(bot.markets['5m'].signal.status, 'triggered_once');
});

test('the candle-only opening order submits at $0.30 on the candle-selected side without a price trigger', async () => {
  const { bot, calls } = setup({
    now: 100_000,
    previousColor: 'GREEN',
    quotes: { UP: 0.52, DOWN: 0.48 },
  });
  await bot.scanTimeframe('5m', 100_000);
  await bot.scanTimeframe('5m', 100_000);

  const buys = calls.filter(call => call.side === 'BUY');
  assert.deepEqual(buys.map(({ tokenId, price, shares }) => [tokenId, price, shares]), [
    ['token-up', 0.30, 10],
  ]);
  assert.equal(bot.markets['5m'].windowOpenEntry.status, 'submitted');
  assert.equal(bot.markets['5m'].windowOpenEntry.candleColor, 'GREEN');
  assert.equal(bot.markets['5m'].signal.status, 'watching_for_trigger');
});

test('the candle-only opening order skips a doji and does not buy both sides', async () => {
  const { bot, calls } = setup({
    now: 100_000,
    previousColor: 'DOJI',
    quotes: { UP: 0.52, DOWN: 0.48 },
  });
  await bot.scanTimeframe('5m', 100_000);

  assert.equal(calls.length, 0);
  assert.equal(bot.markets['5m'].windowOpenEntry.status, 'skipped_doji');
});

test('restart recovery recognizes new entries and still tracks legacy orders', () => {
  const newEntry = LiveBot.recoveredOrder({
    id: 'new-rung-buy',
    asset_id: 'token-down',
    side: 'BUY',
    price: '0.45',
    original_size: '20',
    size_matched: '6',
    status: 'PARTIALLY_FILLED',
    market: 'btc-updown-5m-1000',
  });
  const openingEntry = LiveBot.recoveredOrder({
    id: 'candle-open-buy',
    asset_id: 'token-up',
    side: 'BUY',
    price: '0.30',
    original_size: '10',
    size_matched: '0',
    status: 'LIVE',
    market: 'btc-updown-5m-1000',
  });
  const priorTriggerRung = LiveBot.recoveredOrder({
    id: 'prior-trigger-rung',
    asset_id: 'token-down',
    side: 'BUY',
    price: '0.60',
    original_size: '20',
    size_matched: '0',
    status: 'LIVE',
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
  assert.equal(newEntry.takeProfitPrice, null);
  assert.equal(newEntry.shares, 20);
  assert.equal(newEntry.matchedShares, 6);
  assert.equal(openingEntry.entryType, 'CANDLE_OPEN_ENTRY');
  assert.equal(openingEntry.takeProfitPrice, null);
  assert.equal(openingEntry.shares, 10);
  assert.equal(priorTriggerRung.entryType, 'LEGACY_MIDPOINT_TRIGGER_LADDER');
  assert.equal(priorTriggerRung.takeProfitPrice, null);
  assert.equal(entry.kind, 'ENTRY');
  assert.equal(entry.entryType, 'WINDOW_START_PAIR');
  assert.equal(entry.takeProfitPrice, 0.99);
  assert.equal(entry.matchedShares, 6);
  assert.equal(oldLadderEntry.entryType, 'LEGACY_MIDPOINT_LADDER');
  assert.equal(oldLadderEntry.takeProfitPrice, 0.75);
  assert.equal(exit.kind, 'TAKE_PROFIT');
});

test('recovered matched entry records its confirmation time for source exits', async () => {
  const { bot, trader } = setup({ now: 250_000 });
  trader.listOpenOrders = async () => [{
    id: 'recovered-partial-buy',
    assetId: 'token-down',
    side: 'BUY',
    price: '0.60',
    originalSize: '20',
    sizeMatched: '6',
    status: 'PARTIALLY_FILLED',
    market: 'btc-updown-5m-1000',
  }];

  await bot.recoverOpenOrders();

  const recovered = bot.ordersById.get('recovered-partial-buy');
  assert.equal(recovered.kind, 'ENTRY');
  assert.equal(recovered.fillConfirmedAt, 250_000);
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
    ['BUY', 0.45, 20],
  ]);
  assert.ok(calls.every(call => call.tokenId === 'token-up'));
  assert.equal(state.triggeredAt, 250_000);
});

test('a green BTC candle filters live entries to UP without changing the rung orders', async () => {
  const { bot, calls } = setup({ previousColor: 'GREEN' });
  await bot.scanMarkets();
  assert.deepEqual(calls.map(({ tokenId, price, shares }) => [tokenId, price, shares]), [
    ['token-up', 0.30, 10],
    ['token-up', 0.40, 10],
    ['token-up', 0.45, 20],
  ]);
  assert.equal(bot.markets['5m'].signal.candleFilter.color, 'GREEN');
});

test('a red BTC candle filters live entries to DOWN', async () => {
  const { bot, calls } = setup({
    previousColor: 'RED',
    quotes: { UP: 0.19, DOWN: 0.81 },
  });
  await bot.scanMarkets();
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.tokenId === 'token-down'));
  assert.ok(calls.some(call => call.price === 0.30 && call.shares === 10));
  assert.equal(bot.markets['5m'].signal.selectedSide, 'DOWN');
});

test('a qualifying price on the candle-opposite side waits rather than bypassing the filter', async () => {
  const { bot, calls } = setup({ previousColor: 'RED' });
  await bot.scanMarkets();
  assert.deepEqual(calls.map(({ tokenId, price, shares }) => [tokenId, price, shares]), [
    ['token-down', 0.30, 10],
  ]);
  assert.equal(bot.markets['5m'].signal.status, 'waiting_for_candle_side_trigger');
});

test('unavailable closed-candle data prevents new entries and is shown in bot state', async () => {
  const { bot, calls } = setup({ missingCandleData: true });
  await bot.scanMarkets();
  assert.equal(calls.length, 0);
  assert.equal(bot.markets['5m'].signal.status, 'waiting_for_previous_candle');
  assert.match(bot.snapshot().markets['5m'].candleFilter.reason, /Test feed has no candle history/);
});

test('matched strategy entries never submit TP or SL sells', async () => {
  const { bot, calls, exchangeOrders } = setup();
  const state = fillableMarket(bot);
  state.quotes.UP = { status: 'LIVE', bestBid: 0.99, updatedAt: 250_000, stale: false };
  await bot.fireWindowOrders(state, eligible);

  for (const order of exchangeOrders.values()) {
    if (order.side === 'BUY') order.status = 'MATCHED';
  }
  await bot.reconcileOrders();
  assert.equal(calls.filter(call => call.side === 'SELL').length, 0);

  bot.clock = () => 295_000;
  state.quotes.UP = { status: 'LIVE', bestBid: 0.01, updatedAt: 295_000, stale: false };
  await bot.reconcileOrders();
  const entry = {
    id: 'matched-stop-entry',
    kind: 'ENTRY',
    entryType: 'MIDPOINT_TRIGGER_LADDER',
    side: 'BUY',
    outcome: 'UP',
    tokenId: 'token-up',
    marketId: 'market-0',
    price: 0.40,
    shares: 10,
    matchedShares: 10,
    fillConfirmedAt: 294_000,
    slug: state.slug,
    timeframe: '5m',
    windowStart: 0,
    windowEnd: 300_000,
    status: 'MATCHED',
    exitSubmittingShares: 0,
    exits: [],
  };
  entry.sourceExitKind = 'STOP_LOSS';
  entry.sourceExitLimitPrice = 0.01;
  bot.ordersById.set(entry.id, entry);
  await bot.maybeSubmitSourceExit(entry, 295_000);
  assert.equal(calls.filter(call => call.side === 'SELL').length, 0);
});

test('a first partial entry fill cancels the unfilled remainder', async () => {
  const { bot, calls, exchangeOrders } = setup();
  const state = fillableMarket(bot);
  await bot.fireWindowOrders(state, eligible);
  const entry = [...bot.ordersById.values()].find(order => order.kind === 'ENTRY');
  const exchangeOrder = exchangeOrders.get(entry.id);
  exchangeOrder.status = 'PARTIALLY_FILLED';
  exchangeOrder.sizeMatched = 6;

  await bot.reconcileOrders();

  assert.equal(entry.matchedShares, 6);
  assert.equal(entry.status, 'CANCELED');
  assert.equal(entry.pendingFinalFillChecks, 3);
  assert.ok(calls.some(call => call.cancel === entry.id));
});

test('a first partial fill of the candle-only opening order cancels its unfilled remainder', async () => {
  const { bot, calls, exchangeOrders } = setup({
    now: 100_000,
    previousColor: 'GREEN',
    quotes: { UP: 0.52, DOWN: 0.48 },
  });
  await bot.scanTimeframe('5m', 100_000);
  const entry = [...bot.ordersById.values()].find(order => order.entryType === 'CANDLE_OPEN_ENTRY');
  const exchangeOrder = exchangeOrders.get(entry.id);
  exchangeOrder.status = 'PARTIALLY_FILLED';
  exchangeOrder.sizeMatched = 6;

  await bot.reconcileOrders();

  assert.equal(entry.matchedShares, 6);
  assert.equal(entry.status, 'CANCELED');
  assert.ok(calls.some(call => call.cancel === entry.id));
});

test('expired positions settle only after confirmed original-market resolution', async () => {
  const { bot, trader } = setup({ now: 300_000 });
  const state = fillableMarket(bot);
  const entry = {
    id: 'resolved-entry',
    kind: 'ENTRY',
    entryType: 'CANDLE_OPEN_ENTRY',
    outcome: 'UP',
    tokenId: 'token-up',
    marketId: 'market-0',
    shares: 10,
    matchedShares: 10,
    windowStart: 0,
    windowEnd: 300_000,
    timeframe: '5m',
    slug: state.slug,
    status: 'MATCHED',
    exits: [],
  };
  bot.ordersById.set(entry.id, entry);
  const requested = [];
  trader.getMarket = async id => {
    requested.push(id);
    return {
      id: 'market-0',
      closed: true,
      umaResolutionStatus: 'resolved',
      outcomes: '["Up","Down"]',
      clobTokenIds: '["token-up","token-down"]',
      outcomePrices: '["1","0"]',
    };
  };

  await bot.reconcileExpiredPositions(300_000);

  assert.deepEqual(requested, ['market-0']);
  assert.equal(entry.resolutionStatus, 'RESOLVED');
  assert.equal(entry.resolutionShares, 10);
  assert.equal(entry.resolutionPayoutPerShare, 1);
  assert.equal(entry.resolutionGrossPayout, 10);
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

test('window close cancels unfilled entries and source exit limits', async () => {
  const { bot, calls, exchangeOrders } = setup({ now: 300_000 });
  const state = fillableMarket(bot);
  const entry = {
    id: 'entry-1', clientKey: `${state.slug}:UP:0.40`, kind: 'ENTRY', side: 'BUY',
    slug: state.slug, windowEnd: 300_000, status: 'LIVE', matchedShares: 0,
    shares: 10, pendingFinalFillChecks: 0,
  };
  const exit = {
    id: 'exit-1', clientKey: 'source-exit:entry-1:TAKE_PROFIT:1', kind: 'TAKE_PROFIT', side: 'SELL',
    slug: state.slug, windowEnd: 300_000, status: 'LIVE', matchedShares: 0,
    shares: 10, pendingFinalFillChecks: 0,
  };
  state.orderIds = [entry.clientKey];
  bot.ordersById.set(entry.id, entry);
  bot.ordersById.set(exit.id, exit);
  exchangeOrders.set(entry.id, { ...entry, tokenId: 'token-up', sizeMatched: 0, price: 0.40 });
  exchangeOrders.set(exit.id, { ...exit, tokenId: 'token-up', sizeMatched: 0, price: 0.99 });
  await bot.reconcileOrders();
  assert.deepEqual(calls.filter(call => call.cancel), [
    { cancel: 'entry-1' },
    { cancel: 'exit-1' },
  ]);
  assert.equal(entry.status, 'CANCELED');
  assert.equal(exit.status, 'CANCELED');
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

test('dashboard snapshot identifies the live BTC 5m strategy only', () => {
  const { bot } = setup();
  const state = bot.snapshot();
  assert.equal(state.mode, 'REAL ORDERS');
  assert.deepEqual(state.strategy.markets, ['BTC 5m']);
  assert.equal(state.strategy.version, STRATEGY_VERSION);
  assert.match(state.strategy.windowRule, /from window start/);
  assert.match(state.strategy.trigger, /at or above \$0\.70/);
  assert.deepEqual(state.strategy.openingOrder, {
    buyPrice: 0.30,
    shares: 10,
    sideRule: 'Previous green candle: UP; previous red candle: DOWN; doji: no opening order',
  });
  assert.deepEqual(state.strategy.orders.map(order => [order.buyPrice, order.shares]), [
    [0.40, 10],
    [0.45, 20],
  ]);
  assert.deepEqual(state.strategy.exits, {
    takeProfitEnabled: false,
    stopLossEnabled: false,
    resolution: 'Hold confirmed shares until the original market is confirmed resolved; submit no strategy sell orders',
  });
  assert.match(state.strategy.rearm, /One candle-selected opening order/);
  assert.match(state.strategy.rearm, /one selected-side two-rung trigger ladder per window/);
  assert.ok(state.markets['5m']);
  assert.equal(state.markets['15m'], undefined);
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
