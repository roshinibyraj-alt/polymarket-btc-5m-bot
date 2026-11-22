'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startApplication = require('../index');

const STRATEGY_VERSION = 'test-non-sports-mid-limit-v2';

function makeBot(steps) {
  return {
    status: 'starting',
    persistenceStrategyVersion: STRATEGY_VERSION,
    restoredState: null,
    snapshot() {
      return {
        mode: 'DEMO ONLY',
        status: this.status,
        now: Date.now(),
        positions: this.restoredState?.positions || [],
        account: {
          capital: this.restoredState?.capital || 10_000,
          cash: this.restoredState?.cash ?? 10_000,
          settledTrades: this.restoredState?.totalSettledTrades || 0,
        },
      };
    },
    serializePersistentState() {
      steps.push('serialize');
      return {
        schemaVersion: 1,
        paperStrategyVersion: STRATEGY_VERSION,
        paperHistoryResetVersion: null,
        capital: 10_000,
        cash: 10_000,
        positions: [],
        trades: [],
        events: [],
        pendingOrders: [],
        enteredTokenIds: [],
        stoppedMarketIds: [],
        totalEntries: 0,
        totalSettledTrades: 0,
      };
    },
    restorePersistentState(state) {
      steps.push('restore');
      this.restoredState = structuredClone(state);
    },
    attachPersistenceStore() {
      steps.push('attach');
    },
    markDirty() {
      steps.push('dirty');
    },
    async persistState() {
      steps.push('persist');
      await this.store.save(this.restoredState);
    },
    start() {
      steps.push('start');
    },
    stop() {},
  };
}

function makeStore(steps, initialState = null) {
  const savedStates = [];
  const store = {
    async load() {
      steps.push('load');
      return savedStates.at(-1) || structuredClone(initialState);
    },
    async save(state) {
      steps.push('save');
      savedStates.push(structuredClone(state));
    },
  };
  return { store, savedStates };
}

async function waitForListening(server) {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

test('new strategy starts with a clean paper ledger and persists the reset marker before listening', async (t) => {
  const steps = [];
  const { store, savedStates } = makeStore(steps);
  const bot = makeBot(steps);
  bot.store = store;
  const app = startApplication({
    env: { PAPER_HISTORY_RESET_VERSION: 'near-market-clean-start-v1' },
    port: 0,
    bot,
    paperStateStore: store,
    historyImporter: async () => {
      throw new Error('The replaced BTC dashboard must not be imported');
    },
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  await waitForListening(app.server);

  assert.deepEqual(steps, ['load', 'serialize', 'restore', 'attach', 'persist', 'save', 'start']);
  assert.deepEqual(bot.restoredState.positions, []);
  assert.equal(bot.restoredState.cash, 10_000);
  assert.equal(
    bot.restoredState.paperHistoryResetVersion,
    `near-market-clean-start-v1|${STRATEGY_VERSION}`,
  );
  assert.equal(savedStates.length, 1);
  assert.equal(app.server.listening, true);
});

test('an older volume strategy ledger is reset instead of carrying BTC history forward', async (t) => {
  const steps = [];
  const oldState = {
    schemaVersion: 1,
    strategyVersion: 'old-volume-strategy',
    capital: 10_000,
    cash: 7_500,
    positions: [{ id: 'old-btc-position' }],
  };
  const { store, savedStates } = makeStore(steps, oldState);
  const bot = makeBot(steps);
  bot.store = store;
  const app = startApplication({
    env: { PAPER_HISTORY_RESET_VERSION: 'near-market-clean-start-v1' },
    port: 0,
    bot,
    paperStateStore: store,
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  await waitForListening(app.server);

  assert.deepEqual(bot.restoredState.positions, []);
  assert.equal(bot.restoredState.cash, 10_000);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].paperStrategyVersion, STRATEGY_VERSION);
  assert.ok(steps.includes('serialize'));
});

test('midpoint-limit strategy upgrade preserves the ledger for market-sweep migration', async (t) => {
  const steps = [];
  const previousVersion = 'non-sports-non-crypto-mid-limit-requote-v4';
  const currentVersion = 'non-sports-non-crypto-market-sweep-v5';
  const oldState = {
    schemaVersion: 1,
    paperStrategyVersion: previousVersion,
    paperHistoryResetVersion: `near-market-clean-start-v1|${previousVersion}`,
    capital: 10_000,
    cash: 9_740,
    positions: [{ id: 'preserved-position', remainingShares: 10, status: 'OPEN' }],
    pendingOrders: [{ id: 'old-limit', tokenId: 'old-token' }],
    trades: [{ id: 'filled-entry', kind: 'BUY_ENTRY' }],
    orderEvents: [{ id: 'old-limit', kind: 'BUY_LIMIT_PLACED' }],
    events: [],
    enteredTokenIds: ['already-entered'],
    stoppedMarketIds: [],
    totalEntries: 1,
    totalSettledTrades: 0,
  };
  const { store, savedStates } = makeStore(steps, oldState);
  const bot = makeBot(steps);
  bot.persistenceStrategyVersion = currentVersion;
  bot.store = store;
  const app = startApplication({
    env: { PAPER_HISTORY_RESET_VERSION: 'near-market-clean-start-v1' },
    port: 0,
    bot,
    paperStateStore: store,
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  await waitForListening(app.server);

  assert.equal(bot.restoredState.cash, 9_740);
  assert.equal(bot.restoredState.positions[0].id, 'preserved-position');
  assert.equal(bot.restoredState.trades[0].id, 'filled-entry');
  assert.equal(bot.paperHistoryResetVersion, `near-market-clean-start-v1|${currentVersion}`);
  assert.ok(!steps.includes('serialize'), 'migration does not start a fresh paper ledger');
  assert.equal(savedStates.length, 1);
});

test('matching strategy and reset markers preserve the new paper history on restart', async (t) => {
  const marker = `near-market-clean-start-v1|${STRATEGY_VERSION}`;
  const steps = [];
  const persisted = {
    schemaVersion: 1,
    paperStrategyVersion: STRATEGY_VERSION,
    paperHistoryResetVersion: marker,
    capital: 10_000,
    cash: 9_750,
    positions: [{ id: 'new-non-sports-position', remainingShares: 10, status: 'OPEN' }],
    trades: [],
    events: [],
    enteredTokenIds: ['non-sports-token'],
    stoppedMarketIds: [],
    totalEntries: 1,
    totalSettledTrades: 0,
  };
  const { store } = makeStore(steps, persisted);
  const bot = makeBot(steps);
  bot.store = store;
  const app = startApplication({
    env: { PAPER_HISTORY_RESET_VERSION: 'near-market-clean-start-v1' },
    port: 0,
    bot,
    paperStateStore: store,
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  await waitForListening(app.server);

  assert.deepEqual(bot.restoredState.positions, persisted.positions);
  assert.equal(bot.restoredState.cash, 9_750);
  assert.equal(bot.restoredState.enteredTokenIds[0], 'non-sports-token');
  assert.ok(!steps.includes('serialize'));
});
