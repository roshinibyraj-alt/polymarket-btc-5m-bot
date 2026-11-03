'use strict';

async function main() {
  const Bot = require('./multi-bot');
  const startServer = require('./server');
  const enabled=process.env.LIVE_TRADING==='true';
  const flowTestEnabled=enabled&&process.env.LIVE_ORDER_FLOW_TEST==='true';
  if(enabled&&!process.env.PRIVATE_KEY){
    throw new Error('LIVE_TRADING=true requires the PRIVATE_KEY secret; refusing to start without a signer');
  }
  let liveMirror=null;
  if(process.env.PRIVATE_KEY){
    const LiveOrderMirror=require('./live-order-mirror');
    const PolymarketTrader=require('./polymarket-trader');
    liveMirror=new LiveOrderMirror({startedAt:Date.now(),tradingEnabled:enabled});
    liveMirror.setReadyPromise((async()=>{
      try{
        const trader=new PolymarketTrader(process.env.PRIVATE_KEY);
        await trader.authenticate();
        liveMirror.setTrader(trader);
        liveMirror.startBalanceRefresh();
        const liveDescription=flowTestEnabled
          ?'single BTC 5m order-flow test enabled; strategy live entries paused'
          :`BTC 5m/15m limit-order mirror ${enabled?'enabled':'paused'}`;
        console.log(`[live] Account connection ready; ${liveDescription}.`);
      }catch(error){
        liveMirror.setError(error.message);
        console.error('[live] Real trading unavailable; demo remains running:',error.message);
      }
    })());
  }
  const bot = new Bot({
    onLiveMarketState:enabled&&liveMirror&&!flowTestEnabled
      ?(marketState=>liveMirror.scanMarketState(marketState)):null,
    liveTradingEnabled:enabled,
  });
  bot.start();
  startServer(bot, process.env.PORT || 3000,liveMirror);

  console.log(`MODE: ${flowTestEnabled
    ?'PAPER + LIVE ORDER-FLOW TEST (STRATEGY LIVE ENTRIES PAUSED)'
    :enabled?'PAPER + LIVE BTC LIMIT ORDERS':'PAPER ONLY'}`);
  if(flowTestEnabled&&liveMirror){
    const LiveOrderFlowTest=require('./live-order-flow-test');
    const flowTest=new LiveOrderFlowTest({bot,liveMirror});
    flowTest.start();
    console.log('[live-test] One BTC 5m buy/sell flow test is enabled; strategy live entries are paused.');
  }
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
