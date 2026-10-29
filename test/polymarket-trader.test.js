'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const PolymarketTrader=require('../polymarket-trader');

function setup(response={ok:true,orderId:'mock-order',status:'live'},{positions=null,activity=null}={}){
  const calls=[];
  const client={
    account:{wallet:'0xdepositwallet'},
    placeLimitOrder:async input=>{calls.push(input);return response},
     listOpenOrders:async function*(){yield{items:[
       {id:'open-1',assetId:'asset-2',side:'BUY',status:'LIVE',sizeMatched:'2'},
       {id:'open-2',assetId:'unheld-token',side:'BUY',status:'LIVE',sizeMatched:'0'}
     ],hasMore:false}},
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
      return{ok:true,json:async()=>activity||[
        {asset:'asset-1',timestamp:100},{asset:'asset-2',timestamp:300},{asset:'asset-3',timestamp:200}
      ]};
    }
    if(url.includes('/positions'))return{ok:true,json:async()=>{
      const offset=Number(new URL(url).searchParams.get('offset'))||0;
      return(positions||[
      {asset:'asset-1',title:'Older position',slug:'btc-updown-5m-0',outcome:'Yes',size:10,curPrice:.4,currentValue:4},
      {asset:'asset-2',title:'Newest position',slug:'btc-updown-5m-300',outcome:'No',size:5,curPrice:.2,currentValue:1},
      {asset:'asset-3',title:'Second newest position',slug:'btc-updown-5m-300',outcome:'Yes',size:4,curPrice:.5,currentValue:2}
      ]).slice(offset,offset+500);
    }};
    throw new Error(`Unexpected API request: ${url}`);
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

test('reports full equity and shows only positions for the active window',async()=>{
  const {trader,calls}=setup();
  await trader.authenticate();
  const snapshot=await trader.getEquitySnapshot({windowSlug:'btc-updown-5m-300'});
  assert.equal(snapshot.collateral,125);
  assert.equal(snapshot.positionValue,7);
  assert.equal(snapshot.equity,132);
  assert.equal(snapshot.positionCount,3);
  assert.deepEqual(snapshot.positions.map(p=>p.market),['Newest position','Second newest position']);
  assert.equal(snapshot.positions[0].lastTradeAt,new Date(300_000).toISOString());
  assert.equal(snapshot.positions[1].lastTradeAt,new Date(200_000).toISOString());
  assert.equal(snapshot.positions.some(p=>p.market==='Older position'),false);
  assert.deepEqual(snapshot.orders,[
    {id:'open-1',assetId:'asset-2',side:'BUY',status:'LIVE',sizeMatched:'2',
      currentPosition:{market:'Newest position',outcome:'No',shares:5,value:1}},
    {id:'open-2',assetId:'unheld-token',side:'BUY',status:'LIVE',sizeMatched:'0',currentPosition:null}
  ]);
  assert.equal(Object.hasOwn(snapshot,'wallet'),false);
  assert.ok(calls.some(value=>value?.assetType==='COLLATERAL'));
});

test('shows no real positions when the active window has no holdings',async()=>{
  const {trader}=setup();
  await trader.authenticate();
  const snapshot=await trader.getEquitySnapshot({windowSlug:'btc-updown-5m-600'});
  assert.equal(snapshot.positionValue,7);
  assert.equal(snapshot.equity,132);
  assert.deepEqual(snapshot.positions,[]);
});

test('paginates position results so a recent fill beyond the first 500 is visible',async()=>{
  const positions=Array.from({length:500},(_,i)=>({
    asset:`old-${i}`,title:`Older position ${i}`,slug:'btc-updown-5m-300',
    outcome:'Yes',size:1,curPrice:.1,currentValue:.1
  }));
  positions.push({
    asset:'current-token',title:'Current BTC window',slug:'btc-updown-5m-600',outcome:'Up',
    size:20,avgPrice:.3,curPrice:.45,currentValue:9,cashPnl:3
  });
  const {trader,calls}=setup(undefined,{positions,activity:[{asset:'current-token',timestamp:500}]});
  await trader.authenticate();
  const snapshot=await trader.getEquitySnapshot({windowSlug:'btc-updown-5m-600'});
  assert.equal(snapshot.positionCount,501);
  assert.ok(Math.abs(snapshot.positionValue-59)<1e-8);
  assert.ok(Math.abs(snapshot.equity-184)<1e-8);
  assert.equal(snapshot.positions[0].market,'Current BTC window');
  assert.equal(snapshot.positions[0].shares,20);
  assert.ok(calls.some(value=>typeof value==='string'&&value.includes('limit=500&offset=500')));
});

test('lists all open-order pages and confirms cancellation by order ID',async()=>{
  const {trader,calls}=setup();
  await trader.authenticate();
  assert.deepEqual(await trader.listOpenOrders(),[
    {id:'open-1',assetId:'asset-2',side:'BUY',status:'LIVE',sizeMatched:'2'},
    {id:'open-2',assetId:'unheld-token',side:'BUY',status:'LIVE',sizeMatched:'0'}
  ]);
  await trader.cancelOrder('open-1');
  assert.deepEqual(calls.at(-1),{orderId:'open-1'});
});

test('rejects unsuccessful order responses',async()=>{
  const {trader}=setup({ok:false,message:'rejected'});
  await trader.authenticate();
  await assert.rejects(()=>trader.placeGtdOrder('token-1','BUY',.3,20,1234567890),/rejected/);
});
