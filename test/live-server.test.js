'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startLiveServer = require('../live-server');

function mockBot(status = 'ready') {
  return {
    snapshot: () => ({
      ok: status === 'ready',
      mode: 'REAL ORDERS',
      status,
      tradingEnabled: true,
      startedAt: 1,
      now: 2,
      strategy: { markets: ['BTC 5m'] },
      account: { status, accountReady: status === 'ready', collateral: 20, equity: 20, error: null },
      markets: {},
      orders: [],
      events: [],
      error: null,
    }),
  };
}

test('live server exposes the bot state and health status', async t => {
  const server = startLiveServer(mockBot(), 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const stateResponse = await fetch(`${base}/api/state`);
  assert.equal(stateResponse.status, 200);
  assert.equal((await stateResponse.json()).mode, 'REAL ORDERS');
  assert.match(stateResponse.headers.get('cache-control'), /no-store/);

  const healthResponse = await fetch(`${base}/api/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);
});

test('legacy live server serves the current pressure dashboard without implying active real trading', async t => {
  const server = startLiveServer(mockBot('error'), 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/api/healthz`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).accountReady, false);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Five Minute \| BTC Paper Monitor/);
  assert.match(html, /Real-order modules/);
  assert.match(html, /Uncalibrated/);
  assert.doesNotMatch(html, /15m/i);
  assert.match(html, /Paper only/i);
  assert.match(html, /sampleCount/);
  assert.match(html, /expected net edge/i);
});
