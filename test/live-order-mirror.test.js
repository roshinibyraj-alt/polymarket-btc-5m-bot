'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const LiveOrderMirror=require('../live-order-mirror');

const entry={
  asset:'BTC',timeframe:'5m',windowStart:1_000_000,cutoffAt:1_300_000,
  slug:'btc-updown-5m-1000',tokenId:'token-up',side:'UP',
  orders:[{price:.25,shares:500,takeProfitPrice:.75},{price:.15,shares:500,takeProfitPrice:.85}],
};

test('mirrors the existing BTC rungs as five-share limit buys',async()=>{
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({placeGtdOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}}});
  const result=await mirror.placeEntryOrders(entry);
  assert.equal(calls.length,2);
  assert.deepEqual(calls,[
    ['token-up','BUY',.25,5,1360],['token-up','BUY',.15,5,1360]
  ]);
  assert.equal(result.orders.length,2);
  assert.equal((await mirror.placeEntryOrders(entry)).orders.length,0);
});

test('accepts the existing BTC 15-minute ladder without adding another strategy gate',async()=>{
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_500_000});
  mirror.setTrader({placeGtdOrder:async(...args)=>{calls.push(args);return{id:'15m-order',status:'LIVE'}}});
  const result=await mirror.placeEntryOrders({
    ...entry,timeframe:'15m',windowStart:900_000,cutoffAt:1_800_000,
    slug:'btc-updown-15m-900',
    orders:[{price:.15,shares:500,takeProfitPrice:.85}],
  });
  assert.equal(result.orders.length,1);
  assert.deepEqual(calls[0],['token-up','BUY',.15,5,1860]);
});

test('skips an already-open window after restart',async()=>{
  let count=0;
  const mirror=new LiveOrderMirror({startedAt:1_000_100,clock:()=>1_000_000});
  mirror.setTrader({placeGtdOrder:async()=>{count++;return{id:'unexpected'}}});
  assert.equal((await mirror.placeEntryOrders(entry)).status,'skipped_restart_window');
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

test('creates TP limit sells only for confirmed fills without duplicate quantities',async()=>{
  const calls=[];
  let matched='2';
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeGtdOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}},
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:id==='order-1'?matched:'0'}),
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});

  await mirror.reconcileTrackedOrders();
  await mirror.reconcileTrackedOrders();
  assert.equal(calls.length,2,'the same confirmed fill must not create a duplicate sell');
  assert.deepEqual(calls[1],['token-up','SELL',.75,2,1360]);

  matched='3';
  await mirror.reconcileTrackedOrders();
  assert.equal(calls.length,3);
  assert.deepEqual(calls[2],['token-up','SELL',.75,1,1360]);
  const buy=mirror.orderStates.get('order-1');
  assert.equal(buy.filledShares,3);
  assert.equal(buy.exitSubmittedShares,3);
});

test('does not place a TP sell before Polymarket confirms a fill',async()=>{
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeGtdOrder:async(...args)=>{calls.push(args);return{id:'entry-order',status:'LIVE'}},
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:'0'}),
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  await mirror.reconcileTrackedOrders();
  assert.equal(calls.length,1);
  assert.equal(calls[0][1],'BUY');
});

test('halts new submissions after an order submission with unknown outcome',async()=>{
  let calls=0;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeGtdOrder:async()=>{
      calls++;
      const error=new Error('connection lost');
      error.submissionUncertain=true;
      throw error;
    },
  });
  const result=await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  assert.equal(result.orders[0].status,'SUBMISSION_UNCERTAIN');
  assert.equal(mirror.halted,true);
  assert.equal((await mirror.placeEntryOrders(entry)).status,'halted');
  assert.equal(calls,1);
});
