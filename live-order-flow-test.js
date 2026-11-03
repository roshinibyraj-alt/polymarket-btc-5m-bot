'use strict';

const cfg=require('./config');

const SIDES=['UP','DOWN'];

class LiveOrderFlowTest{
  constructor({bot,liveMirror,clock=()=>Date.now(),log=message=>console.log(message)}={}){
    this.bot=bot;
    this.liveMirror=liveMirror;
    this.clock=clock;
    this.log=log;
    this.armedAt=clock();
    this.targetWindowStart=null;
    this.targetSlug=null;
    this.timer=null;
    this.checking=false;
    this.finished=false;
  }

  start(){
    if(this.timer||this.finished)return;
    this.timer=setInterval(()=>void this.check(),cfg.LIVE_FLOW_TEST_POLL_MS);
    this.timer.unref?.();
    void this.check();
  }

  async check(){
    if(this.checking||this.finished)return;
    this.checking=true;
    try{
      await this.liveMirror?.readyPromise;
      if(!this.liveMirror?.trader||this.liveMirror.status!=='ready')return;

      const scanner=this.bot?.bots?.['BTC-5m'];
      const market=scanner?.market;
      const start=Number(market?.start),end=Number(market?.end);
      if(!market||!Number.isFinite(start)||!Number.isFinite(end))return;
      if(this.targetWindowStart===null){
        if(start<this.armedAt)return;
        this.targetWindowStart=start;
        this.targetSlug=market.slug;
        this.log(`[live-test] Armed for ${this.targetSlug}; waiting for a fillable $0.70 UP/DOWN ask.`);
      }

      if(start!==this.targetWindowStart||market.slug!==this.targetSlug){
        this.finish('window_changed_without_order');
        return;
      }
      if(this.clock()>=end){
        this.finish('window_ended_without_order');
        return;
      }

      for(const side of SIDES){
        const quote=scanner.liveQuotes?.[side];
        const ask=Number(quote?.bestAsk),askSize=Number(quote?.askSize);
        const updatedAt=Number(quote?.updatedAt),now=this.clock();
        const fresh=quote?.status==='LIVE'&&quote?.stale!==true
          &&Number.isFinite(updatedAt)&&updatedAt<=now&&now-updatedAt<=5000;
        if(!fresh||!Number.isFinite(ask)||ask<=0
          ||ask>cfg.LIVE_FLOW_TEST_BUY_PRICE
          ||!Number.isFinite(askSize)||askSize<cfg.LIVE_FLOW_TEST_SHARES){
          continue;
        }

        const result=await this.liveMirror.placeFlowTestOrder({
          asset:'BTC',timeframe:'5m',slug:market.slug,side,
          tokenId:market.tokens?.[side],windowStart:start,windowEnd:end,
          bestAsk:ask,askSize,updatedAt,stale:quote.stale,
        });
        if(result.status==='waiting_for_fillable_quote')continue;
        this.log(`[live-test] One-shot order attempt: ${JSON.stringify({
          status:result.status,side,limitPrice:cfg.LIVE_FLOW_TEST_BUY_PRICE,
          shares:cfg.LIVE_FLOW_TEST_SHARES,orderId:result.order?.orderId||null,
          window:market.slug,
        })}`);
        this.finish(result.status);
        return;
      }
    }catch(error){
      this.log(`[live-test] Check failed: ${error.message}`);
    }finally{
      this.checking=false;
    }
  }

  finish(reason){
    this.finished=true;
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
    this.log(`[live-test] Stopped: ${reason}.`);
  }

  stop(){
    this.finish('stopped');
  }
}

module.exports=LiveOrderFlowTest;
