'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const PolymarketTrader=require('../polymarket-trader');

function setup(response={ok:true,orderId:'mock-order',status:'live'},{positions=null,activity=null,placeError=null}={}){
  const calls=[];
  const client={
    account:{wallet:'0xdepositwallet'},
    placeLimitOrder:async input=>{calls.push(input);if(placeError)throw placeError;return response},
    fetchOrder:async input=>{calls.push(input);return{id:input.orderId,status:'LIVE',sizeMatched:'2'}},
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
    if(url.includes('/v2/activity')){
      return{ok:true,json:async()=>({data:activity||[
        {token_id:'asset-1',timestamp:100},{token_id:'asset-2',timestamp:300},{token_id:'asset-3',timestamp:200}
      ],pagination:{next_cursor:null,has_more:false}})};
    }
    if(url.includes('/v2/positions'))return{ok:true,json:async()=>{
      const query=new URL(url).searchParams;
      const offset=query.has('cursor')?500:0;
      const rows=positions||[
      {token_id:'asset-1',title:'Older position',slug:'btc-updown-5m-0',outcome:'Yes',current_size:10,avg_price:.2,current_price:.4,current_value:4,unrealized_pnl:2},
      {token_id:'asset-2',title:'Newest position',slug:'btc-updown-5m-300',outcome:'No',current_size:5,avg_price:.25,current_price:.2,current_value:1,unrealized_pnl:-.25},
      {token_id:'asset-3',title:'Second newest position',slug:'btc-updown-5m-300',outcome:'Yes',current_size:4,avg_price:.4,current_price:.5,current_value:2,unrealized_pnl:.4}
      ];
      const data=rows.slice(offset,offset+500);
      const hasMore=offset+data.length<rows.length;
      return{data,pagination:{next_cursor:hasMore?'next-page':null,has_more:hasMore}};
    }};
    throw new Error(`Unexpected API request: ${url}`);
  };
  return{trader:new PolymarketTrader('test-key',{sdk,actions,privateKeyAdapter:key=>({key}),fetcher}),calls};
}

test('places a non-expiring GTC limit order without an expiration field',async()=>{
  const {trader,calls}=setup();
  await trader.authenticate();
  const result=await trader.placeLimitOrder('token-1','BUY',.3,5);
  assert.deepEqual(result,{id:'mock-order',status:'live'});
  assert.deepEqual(calls[0],{signer:{key:'0xtest-key'}});
  assert.deepEqual(calls[1],{assetId:'token-1',side:'BUY',price:'0.3',size:'5',postOnly:false});
});

test('fetches the exchange order by ID to reconcile confirmed fills',async()=>{
  const {trader,calls}=setup();
  await trader.authenticate();
  assert.deepEqual(await trader.fetchOrder('live-order'),{
    id:'live-order',status:'LIVE',sizeMatched:'2'
  });
  assert.deepEqual(calls.at(-1),{orderId:'live-order'});
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
  assert.equal(snapshot.positions[0].assetId,'asset-2');
  assert.equal(snapshot.positions[0].avgEntry,.25);
  assert.equal(snapshot.positions[0].markPrice,.2);
  assert.equal(snapshot.positions[0].pnl,-.25);
  assert.deepEqual(snapshot.orders,[
    {id:'open-1',assetId:'asset-2',side:'BUY',status:'LIVE',sizeMatched:'2',
      currentPosition:{market:'Newest position',outcome:'No',shares:5,value:1}},
    {id:'open-2',assetId:'unheld-token',side:'BUY',status:'LIVE',sizeMatched:'0',currentPosition:null}
  ]);
  assert.equal(Object.hasOwn(snapshot,'wallet'),false);
  assert.ok(calls.some(value=>value?.assetType==='COLLATERAL'));
  assert.ok(calls.some(value=>typeof value==='string'&&value.includes('/v2/positions?')&&value.includes('filter_type=TOKENS')));
  assert.ok(calls.some(value=>typeof value==='string'&&value.includes('/v2/activity?')&&value.includes('type=TRADE')));
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
    token_id:`old-${i}`,title:`Older position ${i}`,slug:'btc-updown-5m-300',
    outcome:'Yes',current_size:1,current_price:.1,current_value:.1
  }));
  positions.push({
    token_id:'current-token',title:'Current BTC window',slug:'btc-updown-5m-600',outcome:'Up',
    current_size:20,avg_price:.3,current_price:.45,current_value:9,unrealized_pnl:3
  });
  const {trader,calls}=setup(undefined,{positions,activity:[{token_id:'current-token',timestamp:500}]});
  await trader.authenticate();
  const snapshot=await trader.getEquitySnapshot({windowSlug:'btc-updown-5m-600'});
  assert.equal(snapshot.positionCount,501);
  assert.ok(Math.abs(snapshot.positionValue-59)<1e-8);
  assert.ok(Math.abs(snapshot.equity-184)<1e-8);
  assert.equal(snapshot.positions[0].market,'Current BTC window');
  assert.equal(snapshot.positions[0].shares,20);
  assert.ok(calls.some(value=>typeof value==='string'&&value.includes('/v2/positions?')&&value.includes('cursor=next-page')));
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
  await assert.rejects(
    ()=>trader.placeLimitOrder('token-1','SELL',.75,5),
    error=>error.message==='rejected'&&error.submissionUncertain===false
  );
});

test('a balance-settlement rejection is definite and can be retried safely',async()=>{
  const {trader}=setup(undefined,{
    placeError:new Error('not enough balance / allowance: the balance is not enough -> balance: 0'),
  });
  await trader.authenticate();
  await assert.rejects(
    ()=>trader.placeLimitOrder('token-1','SELL',.75,5),
    error=>error.submissionUncertain===false
  );
});

test('a minimum-size rejection is definite and does not halt future orders',async()=>{
  const {trader}=setup(undefined,{
    placeError:new Error('order is invalid. Size (4.99) lower than the minimum: 5'),
  });
  await trader.authenticate();
  await assert.rejects(
    ()=>trader.placeLimitOrder('token-1','SELL',.75,4.99),
    error=>error.submissionUncertain===false&&error.minimumOrderSize===true
  );
});

test('a transport failure keeps the order submission uncertain',async()=>{
  const {trader}=setup(undefined,{placeError:new Error('connection reset')});
  await trader.authenticate();
  await assert.rejects(
    ()=>trader.placeLimitOrder('token-1','SELL',.75,5),
    error=>error.submissionUncertain===true
  );
});
