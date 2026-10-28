'use strict';

const MIN_GTD_EXPIRATION_SECONDS=180;
const POLYMARKET_GTD_BUFFER_SECONDS=60;

class LiveOrderMirror{
  constructor({startedAt=Date.now(),clock=()=>Date.now(),tradingEnabled=true}={}){
    this.startedAt=startedAt;this.clock=clock;this.trader=null;this.status='starting';
    this.error=null;this.lastBalance=null;this.orders=[];this.seen=new Set();this.balanceTimer=null;
    this.readyPromise=Promise.resolve();this.tradingEnabled=tradingEnabled;
  }
  setReadyPromise(promise){this.readyPromise=Promise.resolve(promise)}
  setTrader(trader){this.trader=trader;this.status='ready';this.error=null}
  setError(message){this.status='error';this.error=String(message||'Live trading unavailable')}
  async placeEntryOrders(entry){
    await this.readyPromise;
    if(!this.tradingEnabled)return {status:'paused'};
    if(!this.trader||this.status!=='ready')return {status:this.status};
    if(entry?.windowStart<this.startedAt)return {status:'skipped_restart_window'};
    if(!entry?.slug||!entry?.tokenId||!Array.isArray(entry.orders))return {status:'skipped_invalid_signal'};
    const results=[];
    for(const rung of entry.orders){
      const key=`${entry.slug}:${entry.side}:${rung.price}:${rung.shares}`;
      if(this.seen.has(key))continue;
      this.seen.add(key);
      const expiration=Math.floor(Number(entry.cutoffAt)/1000)+POLYMARKET_GTD_BUFFER_SECONDS;
      const now=Math.floor(this.clock()/1000);
      if(!Number.isFinite(expiration)||expiration-now<MIN_GTD_EXPIRATION_SECONDS){
        results.push({status:'skipped_expiry_too_soon',price:rung.price});
        this.orders.unshift({slug:entry.slug,side:entry.side,price:rung.price,shares:rung.shares,status:'SKIPPED_EXPIRY_TOO_SOON',at:this.clock()});
        continue;
      }
      try{
        const response=await this.trader.placeGtdOrder(entry.tokenId,'BUY',rung.price,rung.shares,expiration);
        const item={slug:entry.slug,side:entry.side,price:rung.price,shares:rung.shares,
          orderId:response.id,status:response.status||'LIVE',expiresAt:Number(entry.cutoffAt),at:this.clock()};
        this.orders.unshift(item);results.push(item);
      }catch(error){
        const item={slug:entry.slug,side:entry.side,price:rung.price,shares:rung.shares,status:'REJECTED',error:error.message,at:this.clock()};
        this.orders.unshift(item);results.push(item);
      }
      this.orders.length=Math.min(50,this.orders.length);
    }
    return {status:'submitted',orders:results};
  }
  startBalanceRefresh(){
    if(this.balanceTimer)clearInterval(this.balanceTimer);
    const refresh=async()=>{
      try{this.lastBalance=await this.trader.getEquitySnapshot();this.status='ready';this.error=null}
      catch(error){this.lastBalance=null;this.status='error';this.error=error.message}
    };
    void refresh();this.balanceTimer=setInterval(refresh,15000);this.balanceTimer.unref?.();
  }
  snapshot(){
    return this.lastBalance
      ?{...this.lastBalance,status:this.status,tradingEnabled:this.tradingEnabled,error:this.error,orders:this.orders.slice(0,10)}
      :{status:this.status,tradingEnabled:this.tradingEnabled,error:this.error,collateral:null,positionValue:null,equity:null,asOf:null,orders:this.orders.slice(0,10)};
  }
  stop(){if(this.balanceTimer)clearInterval(this.balanceTimer)}
}

module.exports=LiveOrderMirror;
