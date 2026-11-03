'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {setImmediate:turn}=require('node:timers/promises');
const LiveOrderMirror=require('../live-order-mirror');

const entry={asset:'BTC',timeframe:'5m',windowStart:1_000_000,cutoffAt:1_300_000,
  slug:'btc-updown-5m-1000',tokenId:'token',side:'UP',
  orders:[{price:.25,shares:500,takeProfitPrice:.75},{price:.15,shares:500,takeProfitPrice:.85}]};
const account=orders=>({orders:orders||[],positions:[],collateral:20,equity:20,asOf:new Date().toISOString()});
function setup(overrides={}){
  let now=1_000_000;
  const calls=[];
  const mirror=new LiveOrderMirror({startedAt:900_000,clock:()=>now});
  const trader={
    getEquitySnapshot:async()=>account(),
    fetchOrder:async()=>({id:'order-1',status:'LIVE',sizeMatched:'0'}),
    placeLimitOrder:async(...args)=>{calls.push(args);return{id:'order-'+calls.length,status:'LIVE'}},
    ...overrides,
  };
  mirror.setTrader(trader);
  return{mirror,trader,calls,advance:ms=>{now+=ms}};
}

test('account timeout blocks entries, successful full reconciliation clears the stale error',async()=>{
  let failed=true;
  const {mirror,calls}=setup({getEquitySnapshot:async()=>{
    if(failed)throw new Error('Request timed out: GET /data/orders');
    return account();
  }});
  assert.equal(await mirror.refreshAccountSnapshot(),false);
  assert.equal((await mirror.placeEntryOrders(entry)).status,'error');
  assert.equal(calls.length,0);
  assert.equal(mirror.snapshot().recovery.accountFailures,1);
  failed=false;
  assert.equal(await mirror.refreshAccountSnapshot(),true);
  assert.equal(mirror.snapshot().error,null);
  assert.equal((await mirror.placeEntryOrders(entry)).orders.length,2);
  assert.deepEqual(calls,[['token','BUY',.25,10],['token','BUY',.15,10]]);
  assert.deepEqual(mirror.snapshot().recovery.entryDecisions.map(d=>d.status),['submitted','error']);
});

test('new entries stay blocked while initial account reconciliation is in flight',async()=>{
  let resolve;
  const pending=new Promise(r=>{resolve=r});
  const {mirror,calls}=setup({getEquitySnapshot:()=>pending});
  const refresh=mirror.refreshAccountSnapshot();
  assert.equal((await mirror.placeEntryOrders(entry)).status,'reconciling');
  assert.equal(calls.length,0);
  resolve(account());
  assert.equal(await refresh,true);
  assert.equal(mirror.status,'ready');
});

test('a recovered account read cannot reopen entries before tracked order reads succeed',async()=>{
  const {mirror,trader,calls}=setup();
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  let resolve;
  trader.fetchOrder=()=>new Promise(r=>{resolve=r});
  trader.getEquitySnapshot=async()=>account([{id:'order-1'}]);
  const refresh=mirror.refreshAccountSnapshot();
  await turn();
  assert.equal((await mirror.placeEntryOrders({...entry,side:'DOWN'})).status,'reconciling');
  assert.equal(calls.length,1);
  resolve({id:'order-1',status:'LIVE',sizeMatched:'0'});
  assert.equal(await refresh,true);
});

test('tracked read failures gate entries and recover only when the failed read succeeds',async()=>{
  const {mirror,trader,calls}=setup();
  await mirror.placeEntryOrders({...entry,orders:[entry.orders[0]]});
  trader.getEquitySnapshot=async()=>account([{id:'order-1'}]);
  trader.fetchOrder=async()=>{throw new Error('order read timed out')};
  assert.equal(await mirror.refreshAccountSnapshot(),false);
  assert.equal(mirror.status,'error');
  assert.equal((await mirror.placeEntryOrders({...entry,side:'DOWN'})).status,'error');
  assert.equal(calls.length,1);
  trader.fetchOrder=async()=>({id:'order-1',status:'LIVE',sizeMatched:'0'});
  assert.equal(await mirror.refreshAccountSnapshot(),true);
  assert.equal(mirror.error,null);
});

test('successful account reads never clear an uncertain-submission halt or retry that order',async()=>{
  const {mirror,calls}=setup({placeLimitOrder:async(...args)=>{
    calls.push(args);
    const error=new Error('transport outcome unknown');
    error.submissionUncertain=true;
    throw error;
  }});
  await mirror.placeEntryOrders(entry);
  assert.equal(mirror.halted,true);
  await mirror.refreshAccountSnapshot();
  assert.equal(mirror.status,'error');
  assert.match(mirror.error,/could not be confirmed/);
  assert.equal((await mirror.placeEntryOrders(entry)).status,'halted');
  assert.equal(calls.length,2,'both intentional rung submissions may be in flight concurrently');
});

test('unknown outstanding exchange orders block new entries without cancelling or replacing them',async()=>{
  const {mirror,trader,calls}=setup({getEquitySnapshot:async()=>account([{id:'prior-process-order'}])});
  assert.equal(await mirror.refreshAccountSnapshot(),false);
  assert.equal(mirror.snapshot().recovery.untrackedOpenOrders,1);
  assert.equal((await mirror.placeEntryOrders(entry)).status,'error');
  assert.equal(calls.length,0);
  trader.getEquitySnapshot=async()=>account();
  assert.equal(await mirror.refreshAccountSnapshot(),true);
});

test('incomplete snapshots and stale account data cannot enable entries',async()=>{
  const {mirror,trader,calls,advance}=setup({getEquitySnapshot:async()=>({orders:[]})});
  assert.equal(await mirror.refreshAccountSnapshot(),false);
  trader.getEquitySnapshot=async()=>account();
  assert.equal(await mirror.refreshAccountSnapshot(),true);
  advance(120001);
  assert.equal((await mirror.placeEntryOrders(entry)).status,'error');
  assert.equal(calls.length,0);
  assert.match(mirror.error,/stale/);
  assert.equal(await mirror.refreshAccountSnapshot(),true);
});

test('timeout reads retry with bounded backoff; a successful refresh returns to normal timing',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let attempts=0;
  const {mirror}=setup({getEquitySnapshot:async()=>{
    if(++attempts<=2)throw new Error('request timed out');
    return account();
  }});
  t.after(()=>mirror.stop());
  mirror.startBalanceRefresh();
  await turn();
  assert.equal(attempts,1);
  t.mock.timers.tick(999);await turn();assert.equal(attempts,1);
  t.mock.timers.tick(1);await turn();assert.equal(attempts,2);
  t.mock.timers.tick(1999);await turn();assert.equal(attempts,2);
  t.mock.timers.tick(1);await turn();assert.equal(attempts,3);
  assert.equal(mirror.status,'ready');
  t.mock.timers.tick(59999);await turn();assert.equal(attempts,3);
  t.mock.timers.tick(1);await turn();assert.equal(attempts,4);
  mirror.stop();
  t.mock.timers.tick(30000);await turn();assert.equal(attempts,4);
});

test('account refresh honors a positions Retry-After before retrying',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let attempts=0;
  const {mirror,advance}=setup({getEquitySnapshot:async()=>{
    attempts++;
    const error=new Error('Positions API 429');
    error.retryAfterMs=120_000;
    throw error;
  }});
  t.after(()=>mirror.stop());
  mirror.startBalanceRefresh();
  await turn();
  assert.equal(attempts,1);
  advance(119_999);
  t.mock.timers.tick(119_999);await turn();
  assert.equal(attempts,1);
  advance(1);
  t.mock.timers.tick(1);await turn();
  assert.equal(attempts,2);
  mirror.stop();
});

test('definite per-rung rejections remain visible instead of implying accepted orders',async()=>{
  const {mirror}=setup({placeLimitOrder:async()=>{
    const error=new Error('insufficient balance');
    error.submissionUncertain=false;
    throw error;
  }});
  await mirror.placeEntryOrders(entry);
  const decision=mirror.snapshot().recovery.entryDecisions[0];
  assert.equal(decision.submittedOrders,0);
  assert.equal(decision.rejectedOrders,2);
  assert.equal(decision.orderErrors[0].error,'insufficient balance');
  assert.equal(mirror.halted,false);
});
