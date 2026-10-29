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

test('cancels known live entries at the demo cutoff',async()=>{
  const cancelled=[];
  let now=1_000_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeGtdOrder:async(_token,_side,price)=>({id:`order-${price}`,status:'LIVE'}),
    getEquitySnapshot:async()=>({orders:[]}),
    cancelOrder:async id=>cancelled.push(id)
  });
  await mirror.placeEntryOrders(entry);
  now=1_180_001;
  await mirror.cancelExpiredOrders([
    {id:'order-0.3',status:'LIVE'},
    {id:'order-0.2',status:'LIVE'}
  ]);
  assert.deepEqual(cancelled,['order-0.3','order-0.2']);
  assert.ok(mirror.orders.every(order=>order.status==='CANCELLED_AT_CUTOFF'));
});

test('after restart discovers only matching BTC 5m bot orders and cancels after cutoff',async()=>{
  const cancelled=[],lookups=[];
  const mirror=new LiveOrderMirror({startedAt:2_000_000,clock:()=>2_180_001});
  mirror.setTrader({
    getMarket:async id=>{lookups.push(id);return id==='btc-condition'
      ?{slug:'btc-updown-5m-2000',clobTokenIds:['btc-token']}
      :{slug:'eth-updown-5m-2000',clobTokenIds:['btc-token']}},
    cancelOrder:async id=>cancelled.push(id)
  });
  await mirror.cancelExpiredOrders([
    {id:'bot-order',conditionId:'btc-condition',assetId:'btc-token',side:'BUY',price:'0.30',originalSize:'20',orderType:'GTD',createdAt:new Date(2_000_030).toISOString(),status:'LIVE'},
    {id:'manual-other-token',conditionId:'btc-condition',assetId:'other-token',side:'BUY',price:'0.30',originalSize:'20',orderType:'GTD',createdAt:new Date(2_000_030).toISOString(),status:'LIVE'},
    {id:'other-market',conditionId:'other-condition',assetId:'btc-token',side:'BUY',price:'0.20',originalSize:'20',orderType:'GTD',createdAt:new Date(2_000_030).toISOString(),status:'LIVE'}
  ]);
  assert.deepEqual(cancelled,['bot-order']);
  assert.deepEqual(lookups,['btc-condition','other-condition']);
});
