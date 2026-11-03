'use strict';

async function main() {
  const Bot = require('./multi-bot');
  const startServer = require('./server');
  const enabled=process.env.LIVE_TRADING==='true';
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
        console.log(`[live] Account connection ready; BTC 5m/15m limit-order mirror ${enabled?'enabled':'paused'}.`);
      }catch(error){
        liveMirror.setError(error.message);
        console.error('[live] Real trading unavailable; demo remains running:',error.message);
      }
    })());
  }
  const bot = new Bot({
    onLiveEntryOrders:enabled&&liveMirror?(entry=>liveMirror.placeEntryOrders(entry)):null,
    liveTradingEnabled:enabled,
  });
  bot.start();
  startServer(bot, process.env.PORT || 3000,liveMirror);

  console.log(`MODE: ${enabled?'PAPER + LIVE BTC LIMIT ORDERS':'PAPER ONLY'}`);
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
