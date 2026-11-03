'use strict';

const cfg=require('./config');

const ACTIVE_ORDER_STATUSES=new Set(['LIVE','OPEN','ACTIVE']);
const SHARE_EPSILON=0.0001;

function normalizedPrice(value){
  const price=Number(value);
  return Number.isFinite(price)?price.toFixed(2):null;
}

function matchedShares(order){
  const value=Number(order?.sizeMatched??order?.size_matched??0);
  return Number.isFinite(value)&&value>0?value:0;
}

class LiveOrderMirror{
  constructor({startedAt=Date.now(),clock=()=>Date.now(),tradingEnabled=true}={}){
    this.startedAt=startedAt;
    this.clock=clock;
    this.trader=null;
    this.status='starting';
    this.error=null;
    this.lastBalance=null;
    this.orders=[];
    this.orderStates=new Map();
    this.seen=new Set();
    this.balanceTimer=null;
    this.orderTimer=null;
    this.refreshing=false;
    this.polling=false;
    this.halted=false;
    this.flowTestAttempted=false;
    this.readyPromise=Promise.resolve();
    this.tradingEnabled=tradingEnabled;
  }

  setReadyPromise(promise){
    this.readyPromise=Promise.resolve(promise);
  }

  setTrader(trader){
    this.trader=trader;
    this.status='ready';
    this.error=null;
  }

  setError(message){
    this.status='error';
    this.error=String(message||'Live trading unavailable');
  }

  rememberOrder(order){
    this.orders.unshift(order);
    this.orders.length=Math.min(100,this.orders.length);
    if(order.orderId)this.orderStates.set(String(order.orderId),order);
  }

  async placeEntryOrders(entry){
    await this.readyPromise;
    if(!this.tradingEnabled)return{status:'paused'};
    if(this.halted)return{status:'halted',error:this.error};
    if(!this.trader||this.status!=='ready')return{status:this.status};
    if(entry?.windowStart<this.startedAt)return{status:'skipped_restart_window'};

    const slugMatch=String(entry?.slug||'').match(/^btc-updown-(5m|15m)-(\d+)$/);
    if(entry?.asset!=='BTC'||!slugMatch||slugMatch[1]!==entry?.timeframe
      ||!['UP','DOWN'].includes(entry?.side)||!entry?.tokenId
      ||!Array.isArray(entry?.orders)||!entry.orders.length){
      return{status:'skipped_invalid_signal'};
    }

    const cutoffAt=Number(entry.cutoffAt);
    if(!Number.isFinite(cutoffAt)||cutoffAt<=this.clock()){
      return{status:'skipped_window_ended'};
    }

    const results=[];
    for(const rung of entry.orders){
      const priceKey=normalizedPrice(rung?.price);
      const rungIndex=cfg.MARKET_CONFUSION_ENTRY_PRICES.findIndex(
        price=>normalizedPrice(price)===priceKey
      );
      if(rungIndex<0){
        results.push({status:'skipped_unrecognized_rung',price:rung?.price});
        continue;
      }

      const takeProfitPrice=Number(cfg.MARKET_CONFUSION_TAKE_PROFITS[rungIndex]);
      if(normalizedPrice(rung?.takeProfitPrice)!==normalizedPrice(takeProfitPrice)){
        results.push({status:'skipped_invalid_take_profit',price:rung?.price});
        continue;
      }

      const shares=cfg.LIVE_SHARES_PER_RUNG;
      const key=`${entry.slug}:${entry.side}:${priceKey}:${shares}`;
      if(this.seen.has(key))continue;
      this.seen.add(key);

      const tracked={
        orderId:null,kind:'ENTRY',orderSide:'BUY',asset:'BTC',
        timeframe:entry.timeframe,slug:entry.slug,side:entry.side,
        tokenId:String(entry.tokenId),price:Number(rung.price),shares,
        takeProfitPrice,filledShares:0,exitSubmittedShares:0,
        exitSubmittingShares:0,
        windowStart:Number(entry.windowStart),windowEnd:cutoffAt,
        status:'SUBMITTING',createdAt:this.clock(),
        nextSellRetryAt:0,sellRetryAttempts:0,error:null,
      };
      this.rememberOrder(tracked);

      try{
        const response=await this.trader.placeLimitOrder(
          tracked.tokenId,'BUY',tracked.price,tracked.shares
        );
        tracked.orderId=String(response.id);
        tracked.status=response.status||'LIVE';
        this.orderStates.set(tracked.orderId,tracked);
        results.push(tracked);
      }catch(error){
        tracked.status=error.submissionUncertain?'SUBMISSION_UNCERTAIN':'REJECTED';
        tracked.error=error.message;
        results.push(tracked);
        if(error.submissionUncertain){
          this.halted=true;
          this.error=`Order submission could not be confirmed: ${error.message}`;
          this.status='error';
          break;
        }
      }
    }
    return{status:'submitted',orders:results};
  }

  async placeFlowTestOrder(entry){
    await this.readyPromise;
    if(!this.tradingEnabled)return{status:'paused'};
    if(this.halted)return{status:'halted',error:this.error};
    if(!this.trader||this.status!=='ready')return{status:this.status};
    if(this.flowTestAttempted)return{status:'already_attempted'};

    const slugMatch=String(entry?.slug||'').match(/^btc-updown-5m-(\d+)$/);
    const windowStart=Number(entry?.windowStart),windowEnd=Number(entry?.windowEnd);
    if(entry?.asset!=='BTC'||entry?.timeframe!=='5m'||!slugMatch
      ||!['UP','DOWN'].includes(entry?.side)||!entry?.tokenId
      ||!Number.isFinite(windowStart)||!Number.isFinite(windowEnd)
      ||windowEnd<=windowStart){
      return{status:'skipped_invalid_signal'};
    }

    const now=this.clock();
    if(windowStart<this.startedAt)return{status:'skipped_restart_window'};
    if(now>=windowEnd)return{status:'skipped_window_ended'};

    const ask=Number(entry?.bestAsk),askSize=Number(entry?.askSize);
    const updatedAt=Number(entry?.updatedAt);
    if(entry?.stale===true||!Number.isFinite(updatedAt)||updatedAt>now
      ||now-updatedAt>5000||!Number.isFinite(ask)||ask<=0
      ||ask>cfg.LIVE_FLOW_TEST_BUY_PRICE
      ||!Number.isFinite(askSize)||askSize<cfg.LIVE_FLOW_TEST_SHARES){
      return{status:'waiting_for_fillable_quote'};
    }

    this.flowTestAttempted=true;
    const tracked={
      orderId:null,kind:'FLOW_TEST_ENTRY',orderSide:'BUY',asset:'BTC',
      timeframe:'5m',slug:entry.slug,side:entry.side,
      tokenId:String(entry.tokenId),price:cfg.LIVE_FLOW_TEST_BUY_PRICE,
      shares:cfg.LIVE_FLOW_TEST_SHARES,
      takeProfitPrice:cfg.LIVE_FLOW_TEST_TAKE_PROFIT_PRICE,
      filledShares:0,exitSubmittedShares:0,exitSubmittingShares:0,
      windowStart,windowEnd,
      status:'SUBMITTING',createdAt:now,nextSellRetryAt:0,
      sellRetryAttempts:0,error:null,testOnly:true,
    };
    this.rememberOrder(tracked);

    try{
      const response=await this.trader.placeLimitOrder(
        tracked.tokenId,'BUY',tracked.price,tracked.shares
      );
      tracked.orderId=String(response.id);
      tracked.status=response.status||'LIVE';
      this.orderStates.set(tracked.orderId,tracked);
      return{status:'submitted',order:tracked};
    }catch(error){
      tracked.status=error.submissionUncertain?'SUBMISSION_UNCERTAIN':'REJECTED';
      tracked.error=error.message;
      if(error.submissionUncertain){
        this.halted=true;
        this.error=`Test-order submission could not be confirmed: ${error.message}`;
        this.status='error';
      }
      return{status:tracked.status,order:tracked};
    }
  }

  startBalanceRefresh(){
    if(this.balanceTimer)clearInterval(this.balanceTimer);
    if(this.orderTimer)clearInterval(this.orderTimer);

    const refresh=async()=>{
      if(this.refreshing||!this.trader)return;
      this.refreshing=true;
      try{
        this.lastBalance=await this.trader.getEquitySnapshot();
        if(!this.error)this.status='ready';
      }catch(error){
        this.error=error.message;
        this.status='error';
      }finally{
        this.refreshing=false;
      }
    };

    void refresh();
    this.balanceTimer=setInterval(refresh,cfg.LIVE_BALANCE_REFRESH_MS);
    this.balanceTimer.unref?.();

    if(this.tradingEnabled){
      void this.reconcileTrackedOrders();
      this.orderTimer=setInterval(
        ()=>void this.reconcileTrackedOrders(),
        cfg.LIVE_ORDER_POLL_MS
      );
      this.orderTimer.unref?.();
    }
  }

  async reconcileTrackedOrders(){
    if(this.polling||!this.trader||!this.tradingEnabled)return;
    this.polling=true;
    try{
      const tracked=[...this.orderStates.values()].filter(
        order=>order.kind==='ENTRY'||order.kind==='FLOW_TEST_ENTRY'
      );
      await Promise.all(tracked.map(order=>this.refreshTrackedOrder(order)));
    }finally{
      this.polling=false;
    }
  }

  async refreshTrackedOrder(tracked){
    try{
      const latest=await this.trader.fetchOrder(tracked.orderId);
      tracked.status=String(latest.status||tracked.status);
      tracked.updatedAt=this.clock();

      if(tracked.kind==='ENTRY'||tracked.kind==='FLOW_TEST_ENTRY'){
        const filled=Math.min(tracked.shares,matchedShares(latest));
        tracked.filledShares=Math.max(tracked.filledShares,filled);
        if(this.clock()<tracked.windowEnd){
          await this.submitTakeProfitForConfirmedFill(tracked);
        }
      }

      if(this.clock()>=tracked.windowEnd
        &&ACTIVE_ORDER_STATUSES.has(String(tracked.status).toUpperCase())){
        await this.cancelAtWindowEnd(tracked);
      }
    }catch(error){
      tracked.lastPollError=error.message;
      tracked.lastPollAt=this.clock();
      this.error=`Order status check failed: ${error.message}`;
    }
  }

  async submitTakeProfitForConfirmedFill(entryOrder){
    const available=Number(
      (entryOrder.filledShares-entryOrder.exitSubmittedShares
        -(entryOrder.exitSubmittingShares||0)).toFixed(2)
    );
    if(available<=SHARE_EPSILON||this.clock()<entryOrder.nextSellRetryAt)return;
    entryOrder.exitSubmittingShares=Number(
      ((entryOrder.exitSubmittingShares||0)+available).toFixed(2)
    );

    const sellOrder={
      orderId:null,kind:'TAKE_PROFIT',orderSide:'SELL',asset:'BTC',
      timeframe:entryOrder.timeframe,slug:entryOrder.slug,
      side:entryOrder.side,tokenId:entryOrder.tokenId,
      price:entryOrder.takeProfitPrice,shares:available,
      parentOrderId:entryOrder.orderId,filledShares:0,
      windowStart:entryOrder.windowStart,windowEnd:entryOrder.windowEnd,
      status:'SUBMITTING',createdAt:this.clock(),error:null,
    };

    try{
      const response=await this.trader.placeLimitOrder(
        sellOrder.tokenId,'SELL',sellOrder.price,sellOrder.shares
      );
      sellOrder.orderId=String(response.id);
      sellOrder.status=response.status||'LIVE';
      entryOrder.exitSubmittingShares=Number(
        Math.max(0,entryOrder.exitSubmittingShares-available).toFixed(2)
      );
      entryOrder.exitSubmittedShares=Number(
        (entryOrder.exitSubmittedShares+available).toFixed(2)
      );
      entryOrder.nextSellRetryAt=0;
      entryOrder.sellRetryAttempts=0;
      entryOrder.lastSellError=null;
      this.rememberOrder(sellOrder);
    }catch(error){
      sellOrder.status=error.submissionUncertain?'SUBMISSION_UNCERTAIN':'REJECTED';
      sellOrder.error=error.message;
      this.rememberOrder(sellOrder);
      entryOrder.lastSellError=error.message;
      if(error.submissionUncertain){
        this.halted=true;
        this.error=`Take-profit submission could not be confirmed: ${error.message}`;
        this.status='error';
        return;
      }
      entryOrder.exitSubmittingShares=Number(
        Math.max(0,entryOrder.exitSubmittingShares-available).toFixed(2)
      );
      entryOrder.sellRetryAttempts+=1;
      const backoff=Math.min(15000,1000*2**(entryOrder.sellRetryAttempts-1));
      entryOrder.nextSellRetryAt=this.clock()+backoff;
    }
  }

  async cancelAtWindowEnd(order){
    try{
      await this.trader.cancelOrder(order.orderId);
      order.status='CANCELLED_AT_WINDOW_END';
      order.cancelledAt=this.clock();
    }catch(error){
      order.cancelError=error.message;
      this.error=`Window-end order cancellation failed: ${error.message}`;
    }
  }

  snapshot(){
    const botOrders=this.orders.map(order=>({...order}));
    return this.lastBalance
      ?{
        ...this.lastBalance,status:this.status,tradingEnabled:this.tradingEnabled,
        halted:this.halted,error:this.error,
        orders:this.lastBalance.orders||[],botOrders,
      }
      :{
        status:this.status,tradingEnabled:this.tradingEnabled,halted:this.halted,
        error:this.error,collateral:null,positionValue:null,equity:null,
        positions:[],orders:[],botOrders,asOf:null,
      };
  }

  stop(){
    if(this.balanceTimer)clearInterval(this.balanceTimer);
    if(this.orderTimer)clearInterval(this.orderTimer);
  }
}

module.exports=LiveOrderMirror;
