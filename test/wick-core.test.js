'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const strategy=require('../candle-strategy');
const cfg=require('../config');
const Bot=require('../wick-bot');
const md=require('../wick-market-data');

test('green/red closed candles choose UP/DOWN',()=>{
  assert.equal(strategy.signalForPrevious([{color:'GREEN'}]).side,'UP');
  assert.equal(strategy.signalForPrevious([{color:'RED'}]).side,'DOWN');
});

test('doji signals follow two consecutive opposite-color candles only',()=>{
  assert.equal(strategy.signalForPrevious([{color:'RED'},{color:'RED'},{color:'DOJI'}]).side,'UP');
  assert.equal(strategy.signalForPrevious([{color:'GREEN'},{color:'GREEN'},{color:'DOJI'}]).side,'DOWN');
  assert.equal(strategy.signalForPrevious([{color:'RED'},{color:'DOJI'}]).side,null);
});

test('doji is a candle body no larger than ten percent of the full range',()=>{
  assert.equal(strategy.candleColor(100,100.1,102,98),'DOJI');
  assert.equal(strategy.candleColor(100,101,102,98),'GREEN');
  assert.equal(strategy.candleColor(100,99,102,98),'RED');
});

function minuteWindow(start,open,close,high,low,count=5){
  return Array.from({length:count},(_,i)=>({t:start+i*60_000,o:open,c:i===count-1?close:open,
    h:high,l:low,v:1}));
}

test('15m candle fallback keeps its existing resting paper limits',()=>{
  const bot=new Bot({timeframe:'15m',windowMs:900_000,capital:10_000,
    priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  const start=900_000;
  bot.market={id:'market',slug:'btc-updown',title:'BTC',tokens:{UP:'up',DOWN:'down'}};
  bot.orderWindowStart=start;bot.articleCandles=minuteWindow(0,100,105,106,99,15);
  bot.processCandleEntries(start,start+1_000);
  assert.deepEqual(bot.windowOrders.map(o=>[o.limitPrice,o.shares]),[[.30,500],[.20,500]]);
  assert.ok(bot.windowOrders.every(o=>o.expiresAt===start+540_000));
});

test('market-confusion entries never call the live-order mirror',async()=>{
  const captured=[];
  for(const timeframe of ['5m','15m']){
    const windowMs=timeframe==='5m'?300_000:900_000;
    const bot=new Bot({timeframe,windowMs,capital:10_000,
      priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})},
      onLiveEntryOrders:entry=>{captured.push(entry)}});
    const start=windowMs;
    bot.market={id:'market',slug:'btc-updown',title:'BTC',tokens:{UP:'up',DOWN:'down'}};
    bot.orderWindowStart=start;bot.articleCandles=minuteWindow(0,100,105,106,99,windowMs/60_000);
    bot.processCandleEntries(start,start+1_000);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(bot.windowOrders.map(o=>o.shares),timeframe==='5m'?[]:[500,500]);
  }
  assert.equal(captured.length,0);
});

test('market confusion places the requested two-sided ladder only in the final 60 seconds',()=>{
  for(const asset of ['BTC','ETH'])for(const timeframe of ['5m','15m']){
    const windowMs=timeframe==='5m'?300_000:900_000;
    const bot=new Bot({asset,timeframe,windowMs,strategyMode:'market-confusion',
      priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
    const start=windowMs,now=start+windowMs-60_000;
    bot.market={id:'market',start,feesEnabled:false,tokens:{UP:'up',DOWN:'down'}};
    bot.orderWindowStart=start;
    bot.liveQuotes={UP:{status:'LIVE',updatedAt:now,mid:.52},DOWN:{status:'LIVE',updatedAt:now,mid:.48}};
    bot.processMarketConfusionEntries(start,start+200_000);
    assert.equal(bot.windowOrders.length,0);
    bot.processMarketConfusionEntries(start,now-1);
    assert.equal(bot.windowOrders.length,0,'do not start before the 60-second window');
    bot.processMarketConfusionEntries(start,now);
    assert.equal(bot.windowOrders.length,12,`${asset} ${timeframe}`);
    assert.ok(bot.windowOrders.every(o=>o.asset===asset&&o.timeframe===timeframe));
    assert.deepEqual(bot.windowOrders.map(o=>[o.side,o.limitPrice,o.shares,o.takeProfitPrice]),[
      ...[.30,.25,.20,.15,.10,.05].map((price,i)=>['UP',price,500,[.70,.75,.80,.85,.90,.95][i]]),
      ...[.30,.25,.20,.15,.10,.05].map((price,i)=>['DOWN',price,500,[.70,.75,.80,.85,.90,.95][i]]),
    ]);
  }
});

test('multi-bot registers confusion strategy for BTC and ETH on both intervals',()=>{
  const MultiBot=require('../multi-bot');
  const combined=new MultiBot().snapshot();
  assert.deepEqual(Object.keys(combined.timeframes),['BTC-5m','BTC-15m','ETH-5m','ETH-15m']);
  assert.equal(combined.strategy.execution,'PAPER ONLY');
  assert.equal(combined.account.capital,cfg.DEMO_CAPITAL_5M+cfg.DEMO_CAPITAL_15M);
  for(const state of Object.values(combined.timeframes)){
    assert.equal(state.strategy.orders.type,'Two-sided paper limit buys');
    assert.equal(state.strategy.orders.cutoffSeconds,60);
    assert.equal(state.strategy.signalState.reason,'Waiting for final 60 seconds');
  }
});

test('market discovery uses the correct BTC or ETH slug and maps outcomes',async()=>{
  const original=global.fetch,urls=[];
  global.fetch=async url=>{
    urls.push(String(url));
    return{ok:true,json:async()=>[{id:'condition',question:'Asset up or down',outcomes:'["Up","Down"]',clobTokenIds:'["up-token","down-token"]'}]};
  };
  try{
    for(const asset of ['BTC','ETH']){
      const market=await md.getMarketForAsset(300_000,300_000,asset);
      assert.equal(market.tokens.UP,'up-token');
      assert.equal(market.tokens.DOWN,'down-token');
      assert.match(market.slug,new RegExp(`^${asset.toLowerCase()}-updown-5m-`));
    }
    assert.ok(urls.some(url=>url.includes('slug=btc-updown-5m-')));
    assert.ok(urls.some(url=>url.includes('slug=eth-updown-5m-')));
  }finally{global.fetch=original}
});

test('TP and SL require a fresh own-side best bid at $0.99 or $0.01',()=>{
  const {takeProfitHit,stopLossHit}=Bot._test,now=1_000_000;
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:.99,bestAsk:1,mid:.995},now),true);
  assert.equal(stopLossHit({status:'LIVE',updatedAt:now,bestBid:.01,bestAsk:.02,mid:.015},now),true);
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:.98,bestAsk:.99,mid:.985},now),false);
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:null,bestAsk:1,mid:1},now),false);
  assert.equal(stopLossHit({status:'LIVE',updatedAt:now-5001,bestBid:.01},now),false);
});

test('market-confusion TP does not rearm its rung',async()=>{
  const bot=new Bot({timeframe:'5m',windowMs:300_000,capital:1_000,
    priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  const start=300_000,now=start+130_000,oldGetBook=md.getBook;
  bot.market={id:'market',start,feesEnabled:false,tokens:{UP:'up',DOWN:'down'}};
  bot.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
  bot.positions=[
    {id:'up',windowStart:start,status:'OPEN',side:'UP',tokenId:'up',shares:10,totalCost:5,
      entryType:'MARKET_CONFUSION',rungPrice:.30,takeProfitEnabled:true,takeProfitPrice:.70},
  ];
  bot.orders=[{id:'pending',windowStart:start,status:'LIVE'}];
  md.getBook=async token=>token==='up'
    ?{bids:[{price:.71,size:10}],asks:[{price:.72,size:10}]}
    :{bids:[{price:.19,size:10}],asks:[{price:.19,size:10}]};
  try{
    await bot.refreshLiveQuotes(now);
    assert.equal(bot.positions[0].status,'SETTLED_EXIT');
    assert.equal(bot.positions[0].exitPrice,.71);
    assert.ok(Math.abs(bot.positions[0].proceeds-7.1)<1e-9);
    assert.equal(bot.windowOrders.length,0,'a TP does not create a replacement entry');
    assert.equal(bot.orders.find(order=>order.id==='pending').status,'LIVE',
      'TP does not cancel remaining entries');
    assert.match(bot.snapshot().strategy.exit,/No replacement buy/);
  }finally{md.getBook=oldGetBook}
});

test('window rollover clears prior shares at $0 when no bid exists and expires old orders',async()=>{
  const bot=new Bot({timeframe:'5m',windowMs:300_000,capital:1_000,
    priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  const start=300_000,now=600_000,oldGetBook=md.getBook;
  bot.market={id:'old-market',start,feesEnabled:false,tokens:{UP:'up',DOWN:'down'}};
  bot.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
  bot.positions=[{id:'old',windowStart:start,status:'OPEN',side:'DOWN',tokenId:'down',shares:50,totalCost:12.5}];
  bot.orders=[{id:'old-order',windowStart:start,status:'LIVE'}];
  md.getBook=async()=>({bids:[],asks:[]});
  try{
    await bot.closePreviousWindows(start+300_000,now);
    assert.equal(bot.positions[0].status,'SETTLED_EXIT');
    assert.equal(bot.positions[0].exitPrice,0);
    assert.equal(bot.positions[0].proceeds,0);
    assert.equal(bot.positions[0].realizedPnl,-12.5);
    assert.equal(bot.orders[0].status,'EXPIRED_WINDOW_ROLLOVER');
    assert.equal(bot.snapshot().account.openPositions,0);
  }finally{md.getBook=oldGetBook}
});

test('dashboard account snapshot reports visible win, loss, and break-even metrics',()=>{
  const bot=new Bot({capital:1_000,priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  bot.positions=[
    {id:'win',status:'SETTLED_EXIT',realizedPnl:12},
    {id:'loss',status:'SETTLED_EXIT',realizedPnl:-8},
    {id:'flat',status:'SETTLED_EXIT',realizedPnl:0},
    {id:'open',status:'OPEN',realizedPnl:0},
  ];
  const {account}=bot.snapshot();
  assert.equal(account.totalTrades,4);
  assert.equal(account.settledTrades,3);
  assert.equal(account.wins,1);
  assert.equal(account.losses,1);
  assert.equal(account.breakEvenExits,1);
  assert.ok(Math.abs(account.winRate-100/3)<1e-10);
});
