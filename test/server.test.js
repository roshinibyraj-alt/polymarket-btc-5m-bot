'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint accepts the dashboard cache-buster query string', async (t) => {
  const expected = { mode: 'DEMO', account: { capital: 1000 } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/state?ts=123');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('dashboard serves the near-resolution strategy and live market controls', async (t) => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Near-resolution markets/);
  assert.match(html, /Non-sports, non-crypto markets/);
  assert.match(html, /Markets ending soon/);
  assert.match(html, /id="positions"/);
  assert.match(html, /id="pending-orders"/);
  assert.match(html, /id="unrealized"/);
  assert.match(html, /id="markets"/);
  assert.match(html, /id="trades"/);
  assert.match(html, /0\.80/);
  assert.match(html, /0\.90/);
  assert.match(html, /0\.99/);
  assert.match(html, /0\.60/);
  assert.match(html, /resting limit/);
  assert.match(html, /Demo only/);
  assert.doesNotMatch(html, /BTCUSDT|Binance model|Volume and rebate tracker/);
});

test('unknown dashboard paths still return 404', async (t) => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/not-a-route');
  assert.equal(response.status, 404);
});

test('health endpoint returns demo service status without exposing secrets', async (t) => {
  const server = startServer({ snapshot: () => ({ mode: 'DEMO ONLY', status: 'scanning', now: 123 }) }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok:true,mode:'DEMO',status:'scanning',liveStatus:'disabled',now:123
  });
});

test('health endpoint reports an unhealthy state when paper history cannot be restored', async (t) => {
  const server = startServer({
    snapshot: () => ({ mode: 'DEMO ONLY', status: 'history_restore_failed', now: 123 }),
  }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/healthz`);

  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test('health endpoint reports live mode only when the live order adapter is ready',async t=>{
  const server=startServer(
    {snapshot:()=>({status:'scanning',now:123})},
    0,
    {snapshot:()=>({status:'ready',tradingEnabled:true,halted:false})}
  );
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/healthz`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{
    ok:true,mode:'LIVE',status:'scanning',liveStatus:'ready',now:123
  });
});

test('live balance endpoint returns only the read-only balance snapshot',async(t)=>{
  const snapshot={status:'ready',collateral:125,positionValue:40,equity:165,positionCount:2,asOf:'2026-10-29T00:00:00Z'};
  const server=startServer({snapshot:()=>({})},0,{snapshot:()=>snapshot});
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/live-balance`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),snapshot);
});
