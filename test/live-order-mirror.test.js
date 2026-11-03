'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const LiveOrderMirror=require('../live-order-mirror');

const entry={
  asset:'BTC',timeframe:'5m',windowStart:1_000_000,cutoffAt:1_300_000,
  slug:'btc-updown-5m-1000',tokenId:'token-up',side:'UP',
  orders:[{price:.25,shares:500,takeProfitPrice:.75},{price:.15,shares:500,takeProfitPrice:.85}],
};

test('mirrors BTC rungs as ten-share non-expiring limit buys',async()=>{
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({placeLimitOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}}});
  const result=await mirror.placeEntryOrders(entry);
  assert.equal(calls.length,2);
  assert.deepEqual(calls,[
    ['token-up','BUY',.25,10],['token-up','BUY',.15,10]
  ]);
  assert.equal(result.orders.length,2);
  assert.equal((await mirror.placeEntryOrders(entry)).orders.length,0);
});

test('standalone live scanner posts both sides once without a demo-order callback',async()=>{
  const calls=[];
  const now=1_250_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}},
  });
  const snapshot={
    asset:'BTC',timeframe:'5m',now,windowStart:1_000_000,windowEnd:1_300_000,
    market:{slug:'btc-updown-5m-1000',tokens:{UP:'token-up',DOWN:'token-down'}},
    quotes:{
      UP:{status:'LIVE',updatedAt:now,mid:.52},
      DOWN:{status:'LIVE',updatedAt:now,mid:.48},
    },
  };

  const result=await mirror.scanMarketState(snapshot);
  assert.equal(result.status,'triggered');
  assert.equal(calls.length,4);
  assert.deepEqual(calls.slice().sort((a,b)=>`${a[0]}${a[2]}`.localeCompare(`${b[0]}${b[2]}`)),[
    ['token-down','BUY',.15,10],['token-down','BUY',.25,10],
    ['token-up','BUY',.15,10],['token-up','BUY',.25,10],
  ]);
  await mirror.scanMarketState(snapshot);
  assert.equal(calls.length,4,'the signal must not duplicate orders on subsequent scans');
  assert.equal(mirror.snapshot().recovery.liveSignals[0].sides.UP.status,'submitted');
});

test('live scanner retries a qualifying signal after initial account reconciliation',async()=>{
  const calls=[];
  const now=1_250_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.accountMonitoring=true;
  mirror.accountReady=false;
  mirror.lastReconciledAt=null;
  mirror.updateHealth();
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}},
  });
  const snapshot={
    asset:'BTC',timeframe:'5m',now,windowStart:1_000_000,windowEnd:1_300_000,
    market:{slug:'btc-updown-5m-1000',tokens:{UP:'token-up',DOWN:'token-down'}},
    quotes:{UP:{status:'LIVE',updatedAt:now,mid:.52},DOWN:{status:'LIVE',updatedAt:now,mid:.48}},
  };

  await mirror.scanMarketState(snapshot);
  assert.equal(calls.length,0);
  mirror.accountReady=true;
  mirror.lastReconciledAt=now;
  mirror.updateHealth();
  await mirror.scanMarketState(snapshot);
  assert.equal(calls.length,4);
});

test('accepts the existing BTC 15-minute ladder without adding another strategy gate',async()=>{
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_500_000});
  mirror.setTrader({placeLimitOrder:async(...args)=>{calls.push(args);return{id:'15m-order',status:'LIVE'}}});
  const result=await mirror.placeEntryOrders({
    ...entry,timeframe:'15m',windowStart:900_000,cutoffAt:1_800_000,
    slug:'btc-updown-15m-900',
    orders:[{price:.15,shares:500,takeProfitPrice:.85}],
  });
  assert.equal(result.orders.length,1);
  assert.deepEqual(calls[0],['token-up','BUY',.15,10]);
});

test('skips an already-open window after restart',async()=>{
  let count=0;
  const mirror=new LiveOrderMirror({startedAt:1_000_100,clock:()=>1_000_000});
  mirror.setTrader({placeLimitOrder:async()=>{count++;return{id:'unexpected'}}});
  assert.equal((await mirror.placeEntryOrders(entry)).status,'skipped_restart_window');
  assert.equal(count,0);
});

test('paused mirror does not submit real orders',async()=>{
  let count=0;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000,tradingEnabled:false});
  mirror.setTrader({placeLimitOrder:async()=>{count++;return{id:'unexpected'}}});
  assert.equal((await mirror.placeEntryOrders(entry)).status,'paused');
  assert.equal(count,0);
  assert.equal(mirror.snapshot().tradingEnabled,false);
});

test('creates TP limit sells only for confirmed fills without duplicate quantities',async()=>{
  const calls=[];
  let matched='5';
  let now=1_000_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}},
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:id==='order-1'?matched:'0'}),
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});

  await mirror.reconcileTrackedOrders();
  await mirror.reconcileTrackedOrders();
  assert.equal(calls.length,2,'the same confirmed fill must not create a duplicate sell');
  assert.deepEqual(calls[1],['token-up','SELL',.75,5]);

  matched='10';
  await mirror.reconcileTrackedOrders();
  assert.equal(calls.length,3);
  assert.deepEqual(calls[2],['token-up','SELL',.75,5]);
  const buy=mirror.orderStates.get('order-1');
  assert.equal(buy.filledShares,10);
  assert.equal(buy.exitSubmittedShares,10);
});

test('holds a confirmed subminimum fill without halting and sells once five shares accumulate',async()=>{
  const calls=[];
  let matched='4.990932';
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}},
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:matched}),
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  await mirror.reconcileTrackedOrders();
  const buy=mirror.orderStates.get('order-1');
  assert.equal(calls.length,1);
  assert.equal(buy.exitBlockedShares,4.99);
  assert.match(buy.exitBlockedReason,/at least 5 shares/);
  assert.equal(mirror.halted,false);

  matched='5';
  await mirror.reconcileTrackedOrders();
  assert.deepEqual(calls[1],['token-up','SELL',.75,5]);
  assert.equal(buy.exitSubmittedShares,5);
  assert.equal(buy.exitBlockedShares,0);
});

test('terminal entry orders stop being polled after their final confirmed fill',async()=>{
  let reads=0;
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:`order-${calls.length}`,status:'LIVE'}},
    fetchOrder:async id=>{reads++;return{id,status:'MATCHED',sizeMatched:'5'}},
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  await mirror.reconcileTrackedOrders();
  assert.equal(calls.length,2,'a confirmed fill at the five-share minimum should place its take-profit');
  assert.equal(reads,1);
  await mirror.reconcileTrackedOrders();
  assert.equal(reads,1,'terminal matches should not create ongoing API polling');
});

test('retries a definite sell rejection after settlement without halting',async()=>{
  let now=1_000_000;
  let sells=0;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeLimitOrder:async(token,side)=>{
      if(side==='SELL'&&++sells===1){
        const error=new Error('not enough balance / allowance');
        error.submissionUncertain=false;
        throw error;
      }
      return{id:side==='BUY'?'buy':'sell',status:'LIVE'};
    },
    fetchOrder:async()=>({status:'MATCHED',sizeMatched:'5'}),
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  await mirror.reconcileTrackedOrders();
  await mirror.reconcileTrackedOrders();
  assert.equal(sells,1);
  assert.equal(mirror.halted,false);
  now+=1000;
  await mirror.reconcileTrackedOrders();
  await mirror.reconcileTrackedOrders();
  assert.equal(sells,2);
  assert.equal(mirror.orderStates.get('buy').exitSubmittedShares,5);
});

test('does not resend a sell whose submission outcome is unknown',async()=>{
  let sells=0;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeLimitOrder:async(token,side)=>{
      if(side==='SELL'){
        sells++;
        const error=new Error('connection reset');
        error.submissionUncertain=true;
        throw error;
      }
      return{id:'buy',status:'LIVE'};
    },
    fetchOrder:async()=>({status:'MATCHED',sizeMatched:'5'}),
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  await mirror.reconcileTrackedOrders();
  await mirror.reconcileTrackedOrders();
  assert.equal(sells,1);
  assert.equal(mirror.halted,true);
});

test('flow test submits exactly one five-share limit buy at $0.70',async()=>{
  const calls=[];
  const now=1_000_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({placeLimitOrder:async(...args)=>{calls.push(args);return{id:'test-buy',status:'LIVE'}}});
  const testOrder={
    asset:'BTC',timeframe:'5m',slug:'btc-updown-5m-1000',
    side:'DOWN',tokenId:'token-down',windowStart:1_000_000,windowEnd:1_300_000,
    bestAsk:.70,askSize:5,updatedAt:now,stale:false,
  };
  const result=await mirror.placeFlowTestOrder(testOrder);
  assert.equal(result.status,'submitted');
  assert.deepEqual(calls,[['token-down','BUY',.70,5]]);
  assert.equal(result.order.kind,'FLOW_TEST_ENTRY');
  assert.equal(result.order.takeProfitPrice,.75);
  assert.equal((await mirror.placeFlowTestOrder(testOrder)).status,'already_attempted');
  assert.equal(calls.length,1);
});

test('flow test waits for a fresh ask at or below $0.70 with five shares visible',async()=>{
  const calls=[];
  const now=1_000_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({placeLimitOrder:async(...args)=>{calls.push(args);return{id:'test-buy'}}});
  const testOrder={
    asset:'BTC',timeframe:'5m',slug:'btc-updown-5m-1000',
    side:'UP',tokenId:'token-up',windowStart:1_000_000,windowEnd:1_300_000,
    bestAsk:.70,askSize:4,updatedAt:now,stale:false,
  };
  assert.equal((await mirror.placeFlowTestOrder(testOrder)).status,'waiting_for_fillable_quote');
  assert.equal(calls.length,0);
  assert.equal((await mirror.placeFlowTestOrder({...testOrder,askSize:5,updatedAt:now-6000})).status,'waiting_for_fillable_quote');
  assert.equal(calls.length,0);
});

test('flow test submits the $0.75 limit sell only after a confirmed fill',async()=>{
  const calls=[];
  let matched='0';
  const now=1_000_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:`test-order-${calls.length}`,status:'LIVE'}},
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:matched}),
  });
  await mirror.placeFlowTestOrder({
    asset:'BTC',timeframe:'5m',slug:'btc-updown-5m-1000',
    side:'UP',tokenId:'token-up',windowStart:1_000_000,windowEnd:1_300_000,
    bestAsk:.70,askSize:5,updatedAt:now,stale:false,
  });
  await mirror.reconcileTrackedOrders();
  assert.deepEqual(calls,[['token-up','BUY',.70,5]]);

  matched='5';
  await mirror.reconcileTrackedOrders();
  assert.deepEqual(calls,[
    ['token-up','BUY',.70,5],
    ['token-up','SELL',.75,5],
  ]);
});

test('reserves shares while a take-profit sell is being submitted',async()=>{
  const calls=[];
  let releaseSell;
  const sellResponse=new Promise(resolve=>{releaseSell=resolve});
  const now=1_000_000;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{
      calls.push(args);
      if(args[1]==='SELL')return sellResponse;
      return{id:'test-buy',status:'LIVE'};
    },
  });
  await mirror.placeFlowTestOrder({
    asset:'BTC',timeframe:'5m',slug:'btc-updown-5m-1000',
    side:'UP',tokenId:'token-up',windowStart:1_000_000,windowEnd:1_300_000,
    bestAsk:.70,askSize:5,updatedAt:now,stale:false,
  });
  const entryOrder=mirror.orderStates.get('test-buy');
  entryOrder.filledShares=5;
  const first=mirror.submitTakeProfitForConfirmedFill(entryOrder);
  const second=mirror.submitTakeProfitForConfirmedFill(entryOrder);
  await second;
  assert.deepEqual(calls,[
    ['token-up','BUY',.70,5],
    ['token-up','SELL',.75,5],
  ]);
  releaseSell({id:'test-sell',status:'LIVE'});
  await first;
  assert.equal(entryOrder.exitSubmittedShares,5);
  assert.equal(entryOrder.exitSubmittingShares,0);
});

test('cancels an unfilled test entry at the five-minute window end',async()=>{
  let now=1_000_000;
  const cancelled=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeLimitOrder:async()=>({id:'test-buy',status:'LIVE'}),
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:'0'}),
    cancelOrder:async id=>{cancelled.push(id)},
  });
  await mirror.placeFlowTestOrder({
    asset:'BTC',timeframe:'5m',slug:'btc-updown-5m-1000',
    side:'UP',tokenId:'token-up',windowStart:1_000_000,windowEnd:1_300_000,
    bestAsk:.70,askSize:5,updatedAt:now,stale:false,
  });
  now=1_300_000;
  await mirror.reconcileTrackedOrders();
  assert.deepEqual(cancelled,['test-buy']);
});

test('does not place a TP sell before Polymarket confirms a fill',async()=>{
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:'entry-order',status:'LIVE'}},
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:'0'}),
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  await mirror.reconcileTrackedOrders();
  assert.equal(calls.length,1);
  assert.equal(calls[0][1],'BUY');
});

test('cancels an unfilled non-expiring entry at the market window end',async()=>{
  let now=1_000_000;
  const cancelled=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  mirror.setTrader({
    placeLimitOrder:async()=>({id:'entry-order',status:'LIVE'}),
    fetchOrder:async id=>({id,status:'LIVE',sizeMatched:'0'}),
    cancelOrder:async id=>{cancelled.push(id)},
  });
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  now=entry.cutoffAt;
  await mirror.reconcileTrackedOrders();
  assert.deepEqual(cancelled,['entry-order']);
  assert.equal(mirror.orderStates.get('entry-order').status,'CANCELLED_AT_WINDOW_END');
});

test('halts new submissions after an order submission with unknown outcome',async()=>{
  let calls=0;
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>1_000_000});
  mirror.setTrader({
    placeLimitOrder:async()=>{
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
