'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint returns the current strategy with no cache', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-5m-combined-orderflow-accumulation' } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state?ts=123`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('dashboard state route serves the same live strategy snapshot', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-5m-combined-orderflow-accumulation' } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/strategy/state`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('health endpoint reports the demo service without secrets', async t => {
  const server = startServer({ snapshot: () => ({ mode: 'DEMO ONLY', status: 'scanning', now: 123 }) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: 'DEMO', status: 'scanning', now: 123 });
});

test('health endpoint reports strategy errors as unhealthy', async t => {
  const server = startServer({ snapshot: () => ({ status: 'ERROR', now: 123 }) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/healthz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, mode: 'DEMO', status: 'ERROR', now: 123 });
});

test('dashboard serves the BTC 5-minute color-follow-through strategy', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /BTC Candle Bot/);
  assert.match(html, /Current BTC market/);
  assert.match(html, /Five one-minute candles/);
  assert.match(html, /Minute 1 compares with the prior window’s last candle/);
  assert.match(html, /Two green candles in a row buy 200 DOWN shares; two red candles in a row buy 200 UP shares/);
  assert.match(html, /no \$0\.50 entry-price cap/);
  assert.match(html, /sell the previously held side/);
  assert.match(html, /At a \$0\.99 midpoint, take profit/);
  assert.match(html, /There is no stop-loss/);
  assert.match(html, /official resolution/);
  assert.match(html, /PAPER ONLY/);
  assert.match(html, /@media \(max-width: 360px\)/);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
