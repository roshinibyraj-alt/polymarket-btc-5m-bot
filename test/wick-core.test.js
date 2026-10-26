'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const strategy=require('../candle-strategy');
const cfg=require('../config');
const Bot=require('../wick-bot');

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
