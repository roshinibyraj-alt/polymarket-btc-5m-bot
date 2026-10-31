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

test('5m demo waits 120 seconds and uses three rungs; 15m remains unchanged',()=>{
  for(const windowMs of [300_000,900_000]){
    const timeframe=windowMs===300_000?'5m':'15m';
    const bot=new Bot({timeframe,windowMs,capital:10_000,
      priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
    const start=windowMs,prior=minuteWindow(0,100,105,106,99,windowMs/60_000);
    bot.market={id:'market',slug:'btc-updown',title:'BTC',tokens:{UP:'up',DOWN:'down'}};
    bot.orderWindowStart=start;bot.articleCandles=prior;
    bot.processCandleEntries(start,start+1_000);
    assert.equal(bot.candleEvaluation.side,'UP');
    if(timeframe==='5m'){
      assert.equal(bot.windowOrders.length,0);
      bot.processCandleEntries(start,start+cfg.DEMO_ENTRY_DELAY_MS_5M);
      assert.deepEqual(bot.windowOrders.map(o=>[o.limitPrice,o.shares]),
        [[.30,500],[.20,500],[.12,500]]);
      assert.ok(bot.windowOrders.every(o=>o.expiresAt===start+windowMs));
      assert.ok(bot.windowOrders.every(o=>o.takeProfitPrice===.80));
    }else{
      assert.deepEqual(bot.windowOrders.map(o=>[o.limitPrice,o.shares]),[[.30,500],[.20,500]]);
      assert.ok(bot.windowOrders.every(o=>o.expiresAt===start+cfg.ORDER_CUTOFF_MS*(windowMs/cfg.WINDOW_MS_5M)));
    }
    assert.equal(bot.orderCutoffMs/1000,windowMs===300_000?180:540);
  }
});

test('live mirror callback receives only the 5m rung signal and does not alter paper sizes',async()=>{
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
    if(timeframe==='5m')bot.processCandleEntries(start,start+cfg.DEMO_ENTRY_DELAY_MS_5M);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(bot.windowOrders.map(o=>o.shares),timeframe==='5m'?[500,500,500]:[500,500]);
  }
  assert.equal(captured.length,1);
  assert.equal(captured[0].tokenId,'up');
  assert.deepEqual(captured[0].orders,[{price:.30,shares:20},{price:.20,shares:20}]);
  assert.equal(captured[0].cutoffAt,300_000+180_000);
});

test('5m demo orders wait for 120 seconds, fill at a discounted ask, and remain until rollover',()=>{
  const bot=new Bot({timeframe:'5m',windowMs:300_000,capital:10_000,
    priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  const start=300_000;
  bot.market={id:'market',slug:'btc-updown',title:'BTC',tokens:{UP:'up',DOWN:'down'}};
  bot.orderWindowStart=start;bot.articleCandles=minuteWindow(0,100,105,106,99);
  bot.processCandleEntries(start,start+1_000);
  assert.equal(bot.windowOrders.length,0,'no demo entry before the delay');
  bot.processCandleEntries(start,start+120_000);
  bot.liveQuotes.UP={status:'LIVE',updatedAt:start+120_000,bestAsk:.25,bestBid:.24};
  bot.processCandleOrders(start,start+120_000);
  assert.equal(bot.windowOrders[0].status,'FILLED');
  assert.equal(bot.windowOrders[0].fillPrice,.25);
  assert.equal(bot.positions.length,1);
  assert.equal(bot.cash,9875);
  bot.liveQuotes.UP={status:'LIVE',updatedAt:start+180_000,bestAsk:.25,bestBid:.24};
  bot.processCandleOrders(start,start+180_000);
  assert.equal(bot.windowOrders[1].status,'LIVE','the former 180-second entry cutoff is removed');
  bot.processCandleOrders(start,start+300_000);
  assert.equal(bot.windowOrders[1].status,'EXPIRED','unfilled orders expire with their market window');
});

test('TP and SL require a fresh own-side best bid at $0.99 or $0.01',()=>{
  const {takeProfitHit,stopLossHit}=Bot._test,now=1_000_000;
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:.99,bestAsk:1,mid:.995},now),true);
  assert.equal(stopLossHit({status:'LIVE',updatedAt:now,bestBid:.01,bestAsk:.02,mid:.015},now),true);
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:.98,bestAsk:.99,mid:.985},now),false);
  assert.equal(takeProfitHit({status:'LIVE',updatedAt:now,bestBid:null,bestAsk:1,mid:1},now),false);
  assert.equal(stopLossHit({status:'LIVE',updatedAt:now-5001,bestBid:.01},now),false);
});

test('5m TP closes only the rung, then fills opposite-side entry without TP',async()=>{
  const bot=new Bot({timeframe:'5m',windowMs:300_000,capital:1_000,
    priceFeed:{getMinuteCandles:()=>[],snapshot:()=>({status:'live'})}});
  const start=300_000,now=start+130_000,oldGetBook=md.getBook;
  bot.market={id:'market',start,feesEnabled:false,tokens:{UP:'up',DOWN:'down'}};
  bot.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
  bot.positions=[
    {id:'up',windowStart:start,status:'OPEN',side:'UP',tokenId:'up',shares:10,totalCost:5,
      takeProfitEnabled:true,takeProfitPrice:.80},
  ];
  bot.orders=[{id:'pending',windowStart:start,status:'LIVE'}];
  md.getBook=async token=>token==='up'
    ?{bids:[{price:.81,size:10}],asks:[{price:.82,size:10}]}
    :{bids:[{price:.19,size:10}],asks:[{price:.19,size:10}]};
  try{
    await bot.refreshLiveQuotes(now);
    assert.equal(bot.positions[0].status,'SETTLED_EXIT');
    assert.equal(bot.positions[0].exitPrice,.81);
    assert.ok(Math.abs(bot.positions[0].proceeds-8.1)<1e-9);
    const opposite=bot.windowOrders[0];
    assert.equal(opposite.side,'DOWN');
    assert.equal(opposite.limitPrice,.20);
    assert.equal(opposite.shares,10);
    bot.processCandleOrders(start,now);
    const oppositePosition=bot.positions.find(p=>p.entryType==='TP_OPPOSITE');
    assert.equal(oppositePosition.avgEntry,.19,'opposite limit can fill below its rung');
    assert.equal(oppositePosition.takeProfitEnabled,false);
    assert.equal(bot.orders.find(order=>order.id==='pending').status,'LIVE',
      'TP does not cancel remaining entries');
    assert.match(bot.snapshot().strategy.exit,/opposite-side positions have no take-profit/);
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
