'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const LiveOrderFlowTest=require('../live-order-flow-test');

function makeBot(start,upQuote,downQuote){
  return{
    bots:{
      'BTC-5m':{
        market:{slug:`btc-updown-5m-${start/1000}`,start,end:start+300_000,
          tokens:{UP:'token-up',DOWN:'token-down'}},
        liveQuotes:{UP:upQuote,DOWN:downQuote},
      },
    },
  };
}
function quote(bestAsk,askSize,updatedAt,{status='LIVE',stale=false}={}){
  return{bestAsk,askSize,updatedAt,status,stale};
}

test('waits for a fresh five-minute window then submits one $0.70 test order',async()=>{
  let now=1_000_100;
  const calls=[];
  const liveMirror={
    status:'ready',trader:{},readyPromise:Promise.resolve(),
    placeFlowTestOrder:async entry=>{calls.push(entry);return{status:'submitted',order:{orderId:'test-1'}}},
  };
  const bot=makeBot(1_000_000,quote(.65,50,now),quote(.68,50,now));
  const flowTest=new LiveOrderFlowTest({bot,liveMirror,clock:()=>now,log:()=>{}});

  await flowTest.check();
  assert.equal(calls.length,0,'must not use a market window already open when the test was armed');

  now=1_300_000;
  bot.bots['BTC-5m'].market={slug:'btc-updown-5m-1300',start:1_300_000,end:1_600_000,
    tokens:{UP:'token-up',DOWN:'token-down'}};
  bot.bots['BTC-5m'].liveQuotes={UP:quote(.70,5,now),DOWN:quote(.69,20,now)};
  await flowTest.check();
  assert.equal(calls.length,1);
  assert.equal(calls[0].side,'UP');
  assert.equal(calls[0].bestAsk,.70);
  assert.equal(flowTest.finished,true);
  await flowTest.check();
  assert.equal(calls.length,1);
});

test('does not submit when the best ask exceeds $0.70 or depth is below five',async()=>{
  let now=1_000_000;
  const calls=[];
  const liveMirror={
    status:'ready',trader:{},readyPromise:Promise.resolve(),
    placeFlowTestOrder:async entry=>{calls.push(entry);return{status:'submitted'}},
  };
  const bot=makeBot(1_000_000,quote(.71,50,now),quote(.69,4,now));
  const flowTest=new LiveOrderFlowTest({bot,liveMirror,clock:()=>now,log:()=>{}});
  await flowTest.check();
  assert.equal(calls.length,0);
});

test('stops without submitting when the selected five-minute window ends',async()=>{
  let now=1_000_000;
  const calls=[];
  const liveMirror={
    status:'ready',trader:{},readyPromise:Promise.resolve(),
    placeFlowTestOrder:async entry=>{calls.push(entry);return{status:'submitted'}},
  };
  const bot=makeBot(1_000_000,quote(.71,50,now),quote(.72,50,now));
  const flowTest=new LiveOrderFlowTest({bot,liveMirror,clock:()=>now,log:()=>{}});
  await flowTest.check();
  now=1_300_000;
  bot.bots['BTC-5m'].market={slug:'btc-updown-5m-1300',start:1_300_000,end:1_600_000,
    tokens:{UP:'token-up',DOWN:'token-down'}};
  await flowTest.check();
  assert.equal(calls.length,0);
  assert.equal(flowTest.finished,true);
});
