'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
