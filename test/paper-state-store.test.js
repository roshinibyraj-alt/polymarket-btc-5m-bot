'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PaperStateStore, paperStateFilePath } = require('../paper-state-store');

test('paper state store atomically saves and restores a full portfolio document', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new PaperStateStore(path.join(directory, 'portfolio.json'));
  const state = {
    schemaVersion: 1,
    capital: 10_000,
    cash: 9_450,
    positions: [{ id: 'position-1', side: 'UP', shares: 100 }],
  };

  assert.equal(await store.load(), null);
  await store.save(state);

  assert.deepEqual(await store.load(), state);
  assert.deepEqual(await fs.readdir(directory), ['portfolio.json']);
});

test('paper state store rejects corrupt or unsupported data without treating it as empty', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-state-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'portfolio.json');
  await fs.writeFile(filePath, JSON.stringify({ version: 99, state: {} }));
  const store = new PaperStateStore(filePath);

  await assert.rejects(store.load(), /unsupported or invalid format/);
});

test('paper state file uses the existing Railway bot volume directory', () => {
  assert.equal(
    paperStateFilePath({ RAILWAY_PROJECT_ID: 'project-1' }),
    '/data/pressure-paper-state.json',
  );
  assert.equal(
    paperStateFilePath({ BOT_STATE_DIR: '/mounted/state' }),
    '/mounted/state/pressure-paper-state.json',
  );
});
