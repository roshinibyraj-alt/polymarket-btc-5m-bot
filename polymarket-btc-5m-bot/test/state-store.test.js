'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStateStore } = require('../state-store');

test('JSON order ledger survives reload with private file permissions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btc-live-ledger-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStateStore(directory);
  const document = {
    version: 1,
    updatedAt: 123,
    entryKeys: ['btc-updown-5m-0:UP:0.25'],
    orders: [{ id: 'order-1', side: 'BUY', status: 'LIVE', shares: 10 }],
  };
  await store.save(document);
  assert.deepEqual(await store.load(), document);
  const stat = await fs.stat(path.join(directory, 'live-order-ledger.json'));
  assert.equal(stat.mode & 0o077, 0);
});

test('JSON order ledger rejects invalid documents rather than silently resetting', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btc-live-ledger-bad-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStateStore(directory);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'live-order-ledger.json'), '{"version":99,"orders":[]}', 'utf8');
  await assert.rejects(store.load(), /unsupported or invalid format/);
});
