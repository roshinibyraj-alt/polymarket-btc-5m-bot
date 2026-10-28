'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const LiveOrderMirror=require('../live-order-mirror');

const entry={windowStart:1_000_000,cutoffAt:1_180_000,slug:'btc-updown-5m',
  tokenId:'token-up',side:'UP',orders:[{price:.30,shares:20},{price:.20,shares:20}]};

test('submits two 20-share GTD entry orders and prevents duplicate mirror calls',async()=>{
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({placeGtdOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}}});
  const result=await mirror.placeEntryOrders(entry);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(x=>[x[0],x[1],x[2],x[3],x[4]]),[
    ['token-up','BUY',.30,20,1240],['token-up','BUY',.20,20,1240]
  ]);
  assert.equal(result.orders.length,2);
  assert.equal((await mirror.placeEntryOrders(entry)).orders.length,0);
});

test('skips the already-open market after restart and orders too near the expiry boundary',async()=>{
  let count=0;
  const mirror=new LiveOrderMirror({startedAt:1_000_100,clock:()=>1_000_000});
  mirror.setTrader({placeGtdOrder:async()=>{count++;return{id:'unexpected'}}});
  assert.equal((await mirror.placeEntryOrders(entry)).status,'skipped_restart_window');
  const late={...entry,windowStart:1_000_100,cutoffAt:1_060_000};
  const result=await mirror.placeEntryOrders(late);
  assert.ok(result.orders.every(order=>order.status==='skipped_expiry_too_soon'));
  assert.equal(count,0);
});

test('paused mirror does not submit real orders',async()=>{
  let count=0;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000,tradingEnabled:false});
  mirror.setTrader({placeGtdOrder:async()=>{count++;return{id:'unexpected'}}});
  assert.equal((await mirror.placeEntryOrders(entry)).status,'paused');
  assert.equal(count,0);
  assert.equal(mirror.snapshot().tradingEnabled,false);
});
