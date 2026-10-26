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

test('5m and 15m strategies place the same two 500-share resting limits',()=>{
  for(const windowMs of [300_000,900_000]){
    const bot=new Bot({timeframe:windowMs===300_000?'5m':'15m',windowMs,capital:10_000,
      priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
    const start=windowMs,prior=minuteWindow(0,100,105,106,99,windowMs/60_000);
    bot.market={id:'market',slug:'btc-updown',title:'BTC',tokens:{UP:'up',DOWN:'down'}};
    bot.orderWindowStart=start;bot.articleCandles=prior;
    bot.processCandleEntries(start,start+1_000);
    assert.equal(bot.candleEvaluation.side,'UP');
    assert.deepEqual(bot.windowOrders.map(o=>[o.limitPrice,o.shares]),[[.30,500],[.20,500]]);
    const expectedCutoff=cfg.ORDER_CUTOFF_MS*(windowMs/cfg.WINDOW_MS_5M);
    assert.ok(bot.windowOrders.every(o=>o.expiresAt===start+expectedCutoff));
    assert.equal(bot.orderCutoffMs/1000,windowMs===300_000?180:540);
  }
});

test('paper orders fill on fresh ask touches and expire at 180 seconds',()=>{
  const bot=new Bot({timeframe:'5m',windowMs:300_000,capital:10_000,
    priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  const start=300_000;
  bot.market={id:'market',slug:'btc-updown',title:'BTC',tokens:{UP:'up',DOWN:'down'}};
  bot.orderWindowStart=start;bot.articleCandles=minuteWindow(0,100,105,106,99);
  bot.processCandleEntries(start,start+1_000);
  bot.liveQuotes.UP={status:'LIVE',updatedAt:start+1_000,bestAsk:.25,bestBid:.24};
  bot.processCandleOrders(start,start+1_000);
  assert.equal(bot.windowOrders[0].status,'FILLED');
  assert.equal(bot.positions.length,1);
  assert.equal(bot.cash,9850);
  bot.liveQuotes.UP={status:'LIVE',updatedAt:start+180_000,bestAsk:.25,bestBid:.24};
  bot.processCandleOrders(start,start+180_000);
  assert.equal(bot.windowOrders[1].status,'EXPIRED');
});

test('TP and SL require a fresh own-side best bid at $0.99 or $0.01',()=>{
  const {takeProfitHit,stopLossHit}=Bot._test,now=1_000_000;
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:.99,bestAsk:1,mid:.995},now),true);
  assert.equal(stopLossHit({status:'LIVE',updatedAt:now,bestBid:.01,bestAsk:.02,mid:.015},now),true);
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:.98,bestAsk:.99,mid:.985},now),false);
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:null,bestAsk:1,mid:1},now),false);
  assert.equal(stopLossHit({status:'LIVE',updatedAt:now-5001,bestBid:.01},now),false);
});

test('TP completes the full window, closes both sides at their own bids, and cancels entries',async()=>{
  const bot=new Bot({timeframe:'5m',windowMs:300_000,capital:1_000,
    priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  const start=300_000,now=start+10_000,oldGetBook=md.getBook;
  bot.market={id:'market',start,feesEnabled:false,tokens:{UP:'up',DOWN:'down'}};
  bot.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
  bot.positions=[
    {id:'up',windowStart:start,status:'OPEN',side:'UP',tokenId:'up',shares:10,totalCost:5},
    {id:'down',windowStart:start,status:'OPEN',side:'DOWN',tokenId:'down',shares:10,totalCost:5},
  ];
  bot.orders=[{id:'pending',windowStart:start,status:'LIVE'}];
  md.getBook=async token=>({bids:[{price:token==='up'?.99:.2,size:10}],asks:[]});
  try{
    await bot.refreshLiveQuotes(now);
    assert.equal(bot.positions[0].status,'SETTLED_EXIT');
    assert.equal(bot.positions[0].exitPrice,.99);
    assert.equal(bot.positions[0].proceeds,9.9);
    assert.equal(bot.positions[1].exitPrice,.2);
    assert.equal(bot.positions[1].proceeds,2);
    assert.equal(bot.orders[0].status,'EXPIRED_WINDOW_COMPLETE');
    assert.equal(bot.snapshot().account.openPositions,0);
    bot.processTimedEntries(start,now+10_000);
    assert.equal(bot.orders.length,1,'completed window must not add another entry');
    assert.match(bot.snapshot().strategy.exit,/No official results are used/);
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
