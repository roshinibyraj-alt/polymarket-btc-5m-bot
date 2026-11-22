'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const ClobMarketFeed = require('../clob-feed');

const sockets = [];

class FakeSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }

  send(value) {
    this.sent.push(value);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit('open');
  }

  message(value) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

test('subscribes to CLOB market updates and maintains a complete bid/ask book', (t) => {
  sockets.length = 0;
  let now = 1_800_000_000_000;
  const quotes = [];
  const feed = new ClobMarketFeed({
    assetIds: ['up-token', 'down-token'],
    WebSocketImpl: FakeSocket,
    now: () => now,
    onQuote: (assetId, quote) => quotes.push({ assetId, quote }),
    heartbeatMs: 60_000,
    connectionStaleMs: 120_000,
  });
  t.after(() => feed.stop());

  feed.start();
  const socket = sockets.at(-1);
  assert.equal(socket.url, ClobMarketFeed.MARKET_WS);
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    assets_ids: ['up-token', 'down-token'],
    type: 'market',
    custom_feature_enabled: true,
  });

  socket.message({
    event_type: 'book',
    asset_id: 'up-token',
    timestamp: String(now),
    bids: [{ price: '0.41', size: '80' }, { price: '0.40', size: '120' }],
    asks: [{ price: '0.43', size: '75' }, { price: '0.44', size: '140' }],
  });
  socket.message({
    event_type: 'book',
    asset_id: 'down-token',
    timestamp: String(now),
    bids: [{ price: '0.56', size: '70' }],
    asks: [{ price: '0.58', size: '90' }],
  });
  const first = feed.getQuote('up-token');
  assert.equal(first.bestBid, 0.41);
  assert.equal(first.bestAsk, 0.43);
  assert.equal(first.bidSize, 80);
  assert.equal(first.askSize, 75);
  assert.equal(first.source, 'POLYMARKET_CLOB_WEBSOCKET');
  assert.equal(feed.snapshot().connected, true);

  now += 250;
  socket.message({
    event_type: 'price_change',
    timestamp: String(now),
    price_changes: [
      { asset_id: 'up-token', side: 'BUY', price: '0.42', size: '30' },
      { asset_id: 'up-token', side: 'SELL', price: '0.43', size: '0' },
      { asset_id: 'down-token', side: 'BUY', price: '0.57', size: '50' },
    ],
  });

  const updated = feed.getQuote('up-token');
  assert.equal(updated.bestBid, 0.42);
  assert.equal(updated.bidSize, 30);
  assert.equal(updated.bestAsk, 0.44);
  assert.equal(updated.askLevels.length, 1);
  assert.equal(feed.getQuote('down-token').bestBid, 0.57);
  assert.ok(quotes.length >= 3);
  assert.equal(feed.snapshot().quoteAgesMs['up-token'], 0);
});

test('disconnect clears cached books and reconnect waits for a new snapshot', (t) => {
  sockets.length = 0;
  let now = 1_800_000_000_000;
  const feed = new ClobMarketFeed({
    assetIds: ['up-token'],
    WebSocketImpl: FakeSocket,
    now: () => now,
    heartbeatMs: 60_000,
    connectionStaleMs: 120_000,
  });
  t.after(() => feed.stop());

  feed.start();
  const firstSocket = sockets.at(-1);
  firstSocket.open();
  firstSocket.message({
    event_type: 'book',
    asset_id: 'up-token',
    bids: [{ price: '0.41', size: '80' }],
    asks: [{ price: '0.43', size: '75' }],
  });
  assert.equal(feed.getQuote('up-token').status, 'LIVE');

  firstSocket.close();
  assert.equal(feed.getQuote('up-token'), null);
  assert.equal(feed.snapshot().status, 'RECONNECTING');
  assert.equal(feed.snapshot().reconnectCount, 1);
});

test('dynamic subscriptions add and remove outcome IDs on the existing socket', (t) => {
  sockets.length = 0;
  const assetIds = Array.from({ length: 150 }, (_, index) => `token-${index}`);
  const feed = new ClobMarketFeed({
    assetIds: [],
    WebSocketImpl: FakeSocket,
    heartbeatMs: 60_000,
    connectionStaleMs: 120_000,
  });
  t.after(() => feed.stop());

  feed.start();
  feed.updateAssetIds(assetIds);
  const socket = sockets.at(-1);
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]).assets_ids, assetIds.slice(0, 100));
  assert.deepEqual(JSON.parse(socket.sent[1]), {
    assets_ids: assetIds.slice(100),
    operation: 'subscribe',
  });

  const next = [...assetIds.slice(1), 'new-token'];
  feed.updateAssetIds(next);
  assert.deepEqual(JSON.parse(socket.sent[2]), {
    assets_ids: ['new-token'],
    operation: 'subscribe',
  });
  assert.deepEqual(JSON.parse(socket.sent[3]), {
    assets_ids: ['token-0'],
    operation: 'unsubscribe',
  });
});

test('asset changes during connection reuse the pending socket and subscribe its latest IDs', (t) => {
  sockets.length = 0;
  const feed = new ClobMarketFeed({
    assetIds: [],
    WebSocketImpl: FakeSocket,
    heartbeatMs: 60_000,
    connectionStaleMs: 120_000,
  });
  t.after(() => feed.stop());

  feed.start();
  feed.updateAssetIds(['first-token']);
  const socket = sockets.at(-1);
  feed.updateAssetIds(['latest-token']);
  assert.equal(sockets.length, 1);
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]).assets_ids, ['latest-token']);
});
