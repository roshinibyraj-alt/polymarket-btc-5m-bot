'use strict';

async function main() {
  const Bot = require('./multi-bot');
  const startServer = require('./server');
  const enabled=process.env.LIVE_TRADING==='true';
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
        console.log(`[live] Read-only balance ready; entry mirror ${enabled?'enabled':'paused'}. No bot-side TP/SL or claims.`);
      }catch(error){
        liveMirror.setError(error.message);
        console.error('[live] Real trading unavailable; demo remains running:',error.message);
      }
    })());
  }
  const bot = new Bot({onLiveEntryOrders:enabled&&liveMirror?(entry=>liveMirror.placeEntryOrders(entry)):null});
  bot.start();
  startServer(bot, process.env.PORT || 3000,liveMirror);

  console.log(`MODE: DEMO${enabled?' + LIVE 5m entry mirror':' ONLY'} -- demo order management remains unchanged.`);
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
