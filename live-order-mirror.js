'use strict';

const MIN_GTD_EXPIRATION_SECONDS=180;
const POLYMARKET_GTD_BUFFER_SECONDS=60;
const LIVE_REFRESH_MS=5000;
const BOT_RUNG_PRICES=new Set(['0.3','0.30','0.2','0.20']);

class LiveOrderMirror{
  constructor({startedAt=Date.now(),clock=()=>Date.now(),tradingEnabled=true}={}){
    this.startedAt=startedAt;this.clock=clock;this.trader=null;this.status='starting';
    this.error=null;this.lastBalance=null;this.orders=[];this.seen=new Set();this.balanceTimer=null;
    this.cutoffByOrderId=new Map();this.marketCache=new Map();this.refreshing=false;
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
        this.cutoffByOrderId.set(String(response.id),Number(entry.cutoffAt));
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
      if(this.refreshing)return;
      this.refreshing=true;
      try{this.lastBalance=await this.trader.getEquitySnapshot();this.status='ready';this.error=null}
      catch(error){this.lastBalance=null;this.status='error';this.error=error.message}
      try{if(this.lastBalance)await this.cancelExpiredOrders(this.lastBalance.orders||[])}
      catch(error){this.error=`${this.error?`${this.error}; `:''}Order reconciliation: ${error.message}`}
      finally{this.refreshing=false}
    };
    void refresh();this.balanceTimer=setInterval(refresh,LIVE_REFRESH_MS);this.balanceTimer.unref?.();
  }
  async cancelExpiredOrders(orders){
    const now=this.clock();
    for(const order of orders){
      const id=String(order.id||'');
      if(!id)continue;
      let cutoffAt=this.cutoffByOrderId.get(id);
      if(!cutoffAt&&this.isCandidateBotOrder(order)){
        const marketId=order.conditionId||order.market;
        if(!marketId)continue;
        let market=this.marketCache.get(String(marketId));
        if(!market){
          market=await this.trader.getMarket(marketId);
          this.marketCache.set(String(marketId),market);
        }
        const slug=String(market?.slug||'');
        const match=slug.match(/^btc-updown-5m-(\d+)$/);
        if(!match||!this.isCandidateBotOrder(order,market))continue;
        const windowStart=Number(match[1])*1000;
        const createdAt=Date.parse(order.createdAt||'');
        if(String(order.orderType||'').toUpperCase()!=='GTD'
          ||!Number.isFinite(createdAt)||createdAt<windowStart||createdAt>=windowStart+180000)continue;
        cutoffAt=windowStart+180000;
        this.cutoffByOrderId.set(id,cutoffAt);
      }
      if(!cutoffAt||now<cutoffAt||!['LIVE','OPEN','ACTIVE'].includes(String(order.status||'LIVE').toUpperCase()))continue;
      try{
        await this.trader.cancelOrder(id);
        const local=this.orders.find(item=>String(item.orderId)===id);
        if(local){local.status='CANCELLED_AT_CUTOFF';local.cancelledAt=now}
        this.cutoffByOrderId.delete(id);
      }catch(error){
        const local=this.orders.find(item=>String(item.orderId)===id);
        if(local){local.status='CANCEL_FAILED';local.error=error.message}
        throw error;
      }
    }
  }
  isCandidateBotOrder(order,market=null){
    const price=String(Number(order.price).toFixed(2));
    const size=Number(order.originalSize??order.size??order.shares);
    if(String(order.side||'').toUpperCase()!=='BUY'||!BOT_RUNG_PRICES.has(price)||size!==20)return false;
    if(!market)return true;
    const ids=Array.isArray(market.clobTokenIds)?market.clobTokenIds:
      typeof market.clobTokenIds==='string'?(()=>{try{return JSON.parse(market.clobTokenIds)}catch{return []}})():[];
    return ids.map(String).includes(String(order.assetId||order.asset_id||''));
  }
  snapshot(){
    return this.lastBalance
      ?{...this.lastBalance,status:this.status,tradingEnabled:this.tradingEnabled,error:this.error,orders:this.lastBalance.orders||[]}
      :{status:this.status,tradingEnabled:this.tradingEnabled,error:this.error,collateral:null,positionValue:null,equity:null,positions:[],orders:[],asOf:null};
  }
  stop(){if(this.balanceTimer)clearInterval(this.balanceTimer)}
}

module.exports=LiveOrderMirror;
