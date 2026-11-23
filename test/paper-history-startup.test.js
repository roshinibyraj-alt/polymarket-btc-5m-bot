'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { brotliCompressSync } = require('node:zlib');
const startApplication = require('../index');

test('startup imports and saves existing history before listening or starting the bot', async (t) => {
  const steps = [];
  const snapshot = { mode: 'DEMO ONLY', positions: [], account: { capital: 10000, cash: 10000 } };
  const store = {
    async load() {
      steps.push('load');
      return null;
    },
    async save(state) {
      steps.push('save');
      assert.equal(state.source, 'seeded');
    },
  };
  const bot = {
    status: 'starting',
    snapshot() {
      return { mode: 'DEMO ONLY', status: this.status, now: Date.now() };
    },
    restoreFromSnapshot(value) {
      steps.push('restore');
      assert.equal(value, snapshot);
    },
    attachPersistenceStore() {
      steps.push('attach');
    },
    async persistState() {
      steps.push('persist');
      await store.save({ source: 'seeded' });
    },
    start() {
      steps.push('start');
    },
    stop() {},
  };
  const app = startApplication({
    port: 0,
    bot,
    paperStateStore: store,
    historyImporter: async () => {
      steps.push('import');
      return snapshot;
    },
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  if (!app.server.listening) await new Promise((resolve) => app.server.once('listening', resolve));

  assert.deepEqual(steps, ['load', 'import', 'restore', 'attach', 'persist', 'save', 'start']);
  assert.equal(app.server.listening, true);
});

test('startup restores a compressed migration seed without calling the old dashboard', async (t) => {
  const steps = [];
  const snapshot = {
    mode: 'DEMO ONLY',
    positions: [{ id: 'position-1' }],
    account: { capital: 10000, cash: 10025, equityCurve: [], settledTrades: 1 },
    events: [],
    resolutions: [],
  };
  const store = {
    async load() {
      steps.push('load');
      return null;
    },
    async save() {
      steps.push('save');
    },
  };
  const bot = {
    status: 'starting',
    snapshot() {
      return {
        mode: 'DEMO ONLY',
        status: this.status,
        now: Date.now(),
        positions: snapshot.positions,
        account: { ...snapshot.account },
      };
    },
    restoreFromSnapshot(value) {
      steps.push('restore');
      assert.deepEqual(value, snapshot);
    },
    attachPersistenceStore() {
      steps.push('attach');
    },
    async persistState() {
      steps.push('persist');
      await store.save();
    },
    start() {
      steps.push('start');
    },
    stop() {},
  };
  const app = startApplication({
    env: {
      PAPER_HISTORY_SEED_BR_B64: brotliCompressSync(Buffer.from(JSON.stringify(snapshot))).toString('base64'),
    },
    port: 0,
    bot,
    paperStateStore: store,
    historyImporter: async () => {
      throw new Error('The old dashboard should not be contacted when a seed exists');
    },
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  if (!app.server.listening) await new Promise((resolve) => app.server.once('listening', resolve));

  assert.deepEqual(steps, ['load', 'restore', 'attach', 'persist', 'save', 'start']);
  assert.equal(app.server.listening, true);
});

test('authorized paper history reset replaces the old ledger once and persists its marker', async (t) => {
  const steps = [];
  const oldState = {
    schemaVersion: 1,
    capital: 10000,
    cash: 8500,
    positions: [{ id: 'old-position', status: 'SETTLED_LOSS' }],
    orders: [{ id: 'old-order' }],
    events: [{ event: 'OLD_EVENT' }],
    resolutions: [{ slug: 'old-market' }],
  };
  const freshState = {
    schemaVersion: 1,
    capital: 10000,
    cash: 10000,
    positions: [],
    orders: [],
    events: [],
    resolutions: [],
  };
  const savedStates = [];
  const store = {
    async load() {
      steps.push('load');
      return savedStates.at(-1) || oldState;
    },
    async save(state) {
      steps.push('save');
      savedStates.push(structuredClone(state));
    },
  };
  const bot = {
    status: 'starting',
    restoredState: null,
    snapshot() {
      return {
        mode: 'DEMO ONLY',
        status: this.status,
        now: Date.now(),
        positions: this.restoredState?.positions || [],
        account: { capital: 10000, cash: this.restoredState?.cash ?? 10000, settledTrades: 0 },
      };
    },
    serializePersistentState() {
      steps.push('serialize');
      return structuredClone(freshState);
    },
    restorePersistentState(state) {
      steps.push('restore');
      this.restoredState = structuredClone(state);
    },
    attachPersistenceStore() {
      steps.push('attach');
    },
    async persistState() {
      steps.push('persist');
      await store.save(this.restoredState);
    },
    start() {
      steps.push('start');
    },
    stop() {},
  };
  const app = startApplication({
    env: { PAPER_HISTORY_RESET_VERSION: 'test-reset-v1' },
    port: 0,
    bot,
    paperStateStore: store,
    historyImporter: async () => {
      throw new Error('A reset must not import old dashboard history');
    },
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  if (!app.server.listening) await new Promise((resolve) => app.server.once('listening', resolve));

  assert.deepEqual(bot.restoredState.positions, []);
  assert.deepEqual(bot.restoredState.orders, []);
  assert.deepEqual(bot.restoredState.events, []);
  assert.deepEqual(bot.restoredState.resolutions, []);
  assert.equal(bot.restoredState.cash, 10000);
  assert.equal(bot.restoredState.paperHistoryResetVersion, 'test-reset-v1');
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].paperHistoryResetVersion, 'test-reset-v1');
  assert.ok(steps.includes('start'));
});

test('a completed reset marker preserves new history on later startup', async (t) => {
  const marker = 'test-reset-v1';
  const persisted = {
    schemaVersion: 1,
    paperHistoryResetVersion: marker,
    capital: 10000,
    cash: 9750,
    positions: [{ id: 'new-position', status: 'OPEN' }],
    orders: [{ id: 'new-order' }],
    events: [],
    resolutions: [],
  };
  const steps = [];
  const store = {
    async load() {
      steps.push('load');
      return structuredClone(persisted);
    },
    async save(state) {
      steps.push('save');
      assert.equal(state.positions[0].id, 'new-position');
    },
  };
  const bot = {
    status: 'starting',
    restoredState: null,
    snapshot() {
      return {
        mode: 'DEMO ONLY',
        status: this.status,
        now: Date.now(),
        positions: this.restoredState?.positions || [],
        account: { capital: 10000, cash: this.restoredState?.cash ?? 10000, settledTrades: 0 },
      };
    },
    restorePersistentState(state) {
      steps.push('restore');
      this.restoredState = structuredClone(state);
    },
    attachPersistenceStore() {
      steps.push('attach');
    },
    async persistState() {
      steps.push('persist');
      await store.save(this.restoredState);
    },
    start() {
      steps.push('start');
    },
    stop() {},
  };
  const app = startApplication({
    env: { PAPER_HISTORY_RESET_VERSION: marker },
    port: 0,
    bot,
    paperStateStore: store,
    historyImporter: async () => {
      throw new Error('A marked ledger must not import or reset history');
    },
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  await app.ready;
  if (!app.server.listening) await new Promise((resolve) => app.server.once('listening', resolve));

  assert.deepEqual(bot.restoredState.positions, [{ id: 'new-position', status: 'OPEN' }]);
  assert.equal(bot.restoredState.cash, 9750);
  assert.equal(bot.restoredState.paperHistoryResetVersion, marker);
  assert.ok(!steps.includes('serialize'));
});
