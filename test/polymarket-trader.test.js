'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const PolymarketTrader=require('../polymarket-trader');

function setup(response={ok:true,orderId:'mock-order',status:'live'}){
  const calls=[];
  const client={
    account:{wallet:'0xdepositwallet'},
    placeLimitOrder:async input=>{calls.push(input);return response},
    listOpenOrders:async function*(){yield{items:[{id:'open-1',side:'BUY',status:'LIVE'}],hasMore:false}},
    cancelOrder:async input=>{calls.push(input);return{canceled:[input.orderId],notCanceled:{}}}
  };
  const sdk={createSecureClient:async options=>{calls.push(options);return client},
    OrderSide:{BUY:'BUY',SELL:'SELL'},AssetType:{COLLATERAL:'COLLATERAL'}};
  const actions={fetchBalanceAllowance:async(_client,params)=>{
    calls.push(params);return{balance:'125000000',allowance:'125000000'}
  }};
  const fetcher=async url=>{
    calls.push(url);
    if(url.includes('/activity')){
      return{ok:true,json:async()=>[
        {asset:'asset-1',timestamp:100},{asset:'asset-2',timestamp:300},{asset:'asset-3',timestamp:200}
      ]};
    }
    return{ok:true,json:async()=>[
      {asset:'asset-1',title:'Older position',outcome:'Yes',size:10,curPrice:.4,currentValue:4},
      {asset:'asset-2',title:'Newest position',outcome:'No',size:5,curPrice:.2,currentValue:1},
      {asset:'asset-3',title:'Second newest position',outcome:'Yes',size:4,curPrice:.5,currentValue:2}
    ]};
  };
  return{trader:new PolymarketTrader('test-key',{sdk,actions,privateKeyAdapter:key=>({key}),fetcher}),calls};
}

test('authenticates with the unified SDK and places a post-only GTD order',async()=>{
  const {trader,calls}=setup();
  await trader.authenticate();
  const result=await trader.placeGtdOrder('token-1','BUY',.3,20,1234567890);
  assert.deepEqual(result,{id:'mock-order',status:'live'});
  assert.deepEqual(calls[0],{signer:{key:'0xtest-key'}});
  assert.deepEqual(calls[1],{assetId:'token-1',side:'BUY',price:'0.3',size:'20',expiration:1234567890,postOnly:true});
});

test('reports full equity but shows only the two most recently traded positions',async()=>{
  const {trader,calls}=setup();
  await trader.authenticate();
  const snapshot=await trader.getEquitySnapshot();
  assert.equal(snapshot.collateral,125);
  assert.equal(snapshot.positionValue,7);
  assert.equal(snapshot.equity,132);
  assert.equal(snapshot.positionCount,3);
  assert.deepEqual(snapshot.positions.map(p=>p.market),['Newest position','Second newest position']);
  assert.equal(snapshot.positions[0].lastTradeAt,new Date(300_000).toISOString());
  assert.equal(snapshot.positions[1].lastTradeAt,new Date(200_000).toISOString());
  assert.equal(snapshot.positions.some(p=>p.market==='Older position'),false);
  assert.deepEqual(snapshot.orders,[{id:'open-1',side:'BUY',status:'LIVE'}]);
  assert.equal(Object.hasOwn(snapshot,'wallet'),false);
  assert.ok(calls.some(value=>value?.assetType==='COLLATERAL'));
});

test('lists all open-order pages and confirms cancellation by order ID',async()=>{
  const {trader,calls}=setup();
  await trader.authenticate();
  assert.deepEqual(await trader.listOpenOrders(),[{id:'open-1',side:'BUY',status:'LIVE'}]);
  await trader.cancelOrder('open-1');
  assert.deepEqual(calls.at(-1),{orderId:'open-1'});
});

test('rejects unsuccessful order responses',async()=>{
  const {trader}=setup({ok:false,message:'rejected'});
  await trader.authenticate();
  await assert.rejects(()=>trader.placeGtdOrder('token-1','BUY',.3,20,1234567890),/rejected/);
});
