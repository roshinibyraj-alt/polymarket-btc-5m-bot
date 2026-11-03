'use strict';

const cfg=require('./config');
const confusionStrategy=require('./market-confusion-strategy');

const ACTIVE_ORDER_STATUSES=new Set(['LIVE','OPEN','ACTIVE','PARTIALLY_FILLED']);
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
    this.accountMonitoring=false;
    this.accountReady=false;
    this.accountError=null;
    this.orderError=null;
    this.fatalError=null;
    this.accountFailures=0;
    this.lastAccountSuccessAt=null;
    this.lastReconciledAt=null;
    this.nextAccountRefreshAt=null;
    this.reconcilePromise=null;
    this.untrackedOpenOrders=0;
    this.entryDecisions=[];
    this.liveSignals=new Map();
    this.stopped=false;
  }

  setReadyPromise(promise){
    this.readyPromise=Promise.resolve(promise);
  }

  setTrader(trader){
    this.trader=trader;
    if(!this.halted)this.fatalError=null;
    this.updateHealth();
  }

  setError(message){
    this.fatalError=String(message||'Live trading unavailable');
    this.updateHealth();
  }

  updateHealth(){
    const stale=this.accountMonitoring&&this.lastAccountSuccessAt!==null
      &&this.clock()-this.lastAccountSuccessAt>Math.max(30000,cfg.LIVE_BALANCE_REFRESH_MS*2);
    const error=this.fatalError||this.accountError||this.orderError
      ||(this.untrackedOpenOrders?'Outstanding account orders are not tracked by this process; reconciliation required':null)
      ||(stale?'Account snapshot is stale; waiting for successful reconciliation':null);
    this.error=error;
    this.status=this.halted||error?'error'
      :this.accountMonitoring&&(!this.accountReady||this.lastReconciledAt===null)?'reconciling'
      :this.trader?'ready':'starting';
  }

  async placeEntryOrders(entry){
    try{
      const result=await this.submitEntryOrders(entry);
      this.recordEntryDecision({at:this.clock(),slug:entry?.slug||null,
        timeframe:entry?.timeframe||null,side:entry?.side||null,status:result.status,
        error:result.error||null,submittedOrders:(result.orders||[]).filter(order=>order.orderId).length,
        rejectedOrders:(result.orders||[]).filter(order=>order.status==='REJECTED').length,
        orderErrors:(result.orders||[]).filter(order=>order.error)
          .map(order=>({status:order.status,error:order.error}))});
      return result;
    }catch(error){
      this.recordEntryDecision({at:this.clock(),slug:entry?.slug||null,
        side:entry?.side||null,status:'error',error:error.message});
      throw error;
    }
  }

  rememberOrder(order){
    this.orders.unshift(order);
    this.orders.length=Math.min(100,this.orders.length);
    if(order.orderId)this.orderStates.set(String(order.orderId),order);
  }

  recordEntryDecision(decision){
    const previous=this.entryDecisions.find(item=>item.slug===decision.slug
      &&item.side===decision.side&&item.status===decision.status&&item.error===decision.error);
    if(previous){
      previous.at=decision.at;
      previous.submittedOrders=decision.submittedOrders??previous.submittedOrders;
      previous.rejectedOrders=decision.rejectedOrders??previous.rejectedOrders;
      previous.orderErrors=decision.orderErrors??previous.orderErrors;
      return;
    }
    this.entryDecisions.unshift(decision);
    this.entryDecisions.length=Math.min(50,this.entryDecisions.length);
  }

  async scanMarketState(snapshot){
    const now=Number(snapshot?.now??this.clock());
    const asset=snapshot?.asset;
    const timeframe=snapshot?.timeframe;
    const market=snapshot?.market;
    const windowStart=Number(snapshot?.windowStart);
    const cutoffAt=Number(snapshot?.windowEnd);
    const slug=String(market?.slug||'');
    const windowMs=timeframe==='5m'?cfg.WINDOW_MS_5M:timeframe==='15m'?cfg.WINDOW_MS_15M:null;
    if(!this.tradingEnabled)return{status:'paused'};
    if(asset!=='BTC'||!windowMs||!/^btc-updown-(5m|15m)-\d+$/.test(slug)
      ||!slug.startsWith(`btc-updown-${timeframe}-`)
      ||!Number.isFinite(windowStart)||!Number.isFinite(cutoffAt)
      ||cutoffAt!==windowStart+windowMs
      ||!market?.tokens?.UP||!market?.tokens?.DOWN){
      return{status:'skipped_invalid_signal'};
    }
    if(now>=cutoffAt)return{status:'skipped_window_ended'};

    for(const [key,signal] of this.liveSignals){
      if(now>signal.cutoffAt+cfg.WINDOW_MS_15M)this.liveSignals.delete(key);
    }

    let signal=this.liveSignals.get(slug);
    if(!signal){
      if(cutoffAt-now>cfg.MARKET_CONFUSION_WINDOW_MS)return{status:'watching'};
      const evaluation=confusionStrategy.isMarketConfused(
        snapshot.quotes?.UP,snapshot.quotes?.DOWN,now
      );
      if(!evaluation.eligible)return{status:'watching',reason:evaluation.reason};
      signal={
        slug,timeframe,windowStart,cutoffAt,triggeredAt:now,
        upMid:evaluation.upMid,downMid:evaluation.downMid,
        sides:{UP:{inFlight:false,done:false},DOWN:{inFlight:false,done:false}},
      };
      this.liveSignals.set(slug,signal);
      while(this.liveSignals.size>100){
        this.liveSignals.delete(this.liveSignals.keys().next().value);
      }
      console.log('[live] '+JSON.stringify({event:'LIVE_SIGNAL_TRIGGERED',slug,timeframe,
        windowStart,upMid:evaluation.upMid,downMid:evaluation.downMid,at:now}));
    }

    const results=await Promise.all(['UP','DOWN'].map(async side=>{
      const sideState=signal.sides[side];
      if(sideState.done||sideState.inFlight)return{side,status:sideState.done?'submitted':'in_flight'};
      sideState.inFlight=true;
      try{
        const entry={
          asset:'BTC',timeframe,windowStart,cutoffAt,slug,side,
          tokenId:market.tokens[side],
          orders:cfg.MARKET_CONFUSION_ENTRY_PRICES.map((price,index)=>({
            price,shares:cfg.MARKET_CONFUSION_SHARES,
            takeProfitPrice:cfg.MARKET_CONFUSION_TAKE_PROFITS[index],
          })),
        };
        const result=await this.placeEntryOrders(entry);
        sideState.lastStatus=result.status;
        sideState.lastError=result.error||null;
        if(['submitted','rejected','already_submitted','halted','paused',
          'skipped_restart_window','skipped_invalid_signal','skipped_window_ended'].includes(result.status)){
          sideState.done=true;
        }
        return{side,...result};
      }catch(error){
        sideState.lastStatus='error';
        sideState.lastError=error.message;
        return{side,status:'error',error:error.message};
      }finally{
        sideState.inFlight=false;
      }
    }));
    return{status:'triggered',slug,triggeredAt:signal.triggeredAt,results};
  }

  async submitEntryOrders(entry){
    await this.readyPromise;
    this.updateHealth();
    if(!this.tradingEnabled)return{status:'paused'};
    if(this.halted)return{status:'halted',error:this.error};
    if(!this.trader||this.status!=='ready')return{status:this.status,error:this.error};
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
    const pending=[];
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
      pending.push(tracked);
    }
    const posted=await Promise.all(pending.map(async tracked=>{
      try{
        const response=await this.trader.placeLimitOrder(
          tracked.tokenId,'BUY',tracked.price,tracked.shares
        );
        tracked.orderId=String(response.id);
        tracked.status=response.status||'LIVE';
        this.orderStates.set(tracked.orderId,tracked);
        return tracked;
      }catch(error){
        tracked.status=error.submissionUncertain?'SUBMISSION_UNCERTAIN':'REJECTED';
        tracked.error=error.message;
        if(error.submissionUncertain){
          this.halted=true;
          this.setError(`Order submission could not be confirmed: ${error.message}`);
        }
        return tracked;
      }
    }));
    results.push(...posted);
    const status=this.halted?'halted'
      :results.some(order=>order.orderId)?'submitted'
        :results.length?'rejected':'already_submitted';
    return{status,orders:results,error:this.halted?this.error:null};
  }

  async placeFlowTestOrder(entry){
    await this.readyPromise;
    this.updateHealth();
    if(!this.tradingEnabled)return{status:'paused'};
    if(this.halted)return{status:'halted',error:this.error};
    if(!this.trader||this.status!=='ready')return{status:this.status,error:this.error};
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
        this.setError(`Test-order submission could not be confirmed: ${error.message}`);
      }
      return{status:tracked.status,order:tracked};
    }
  }

  startBalanceRefresh(){
    if(this.balanceTimer)clearTimeout(this.balanceTimer);
    if(this.orderTimer)clearInterval(this.orderTimer);
    this.stopped=false;
    this.accountMonitoring=true;
    this.accountReady=false;
    this.updateHealth();
    const refresh=async()=>{
      await this.refreshAccountSnapshot();
      if(this.stopped)return;
      const delay=this.accountFailures
        ?Math.min(cfg.LIVE_BALANCE_REFRESH_MS,1000*2**Math.min(4,this.accountFailures-1))
        :cfg.LIVE_BALANCE_REFRESH_MS;
      this.nextAccountRefreshAt=this.clock()+delay;
      this.balanceTimer=setTimeout(refresh,delay);
      this.balanceTimer.unref?.();
    };
    void refresh();

    if(this.tradingEnabled){
      void this.reconcileTrackedOrders();
      this.orderTimer=setInterval(
        ()=>void this.reconcileTrackedOrders(),
        cfg.LIVE_ORDER_POLL_MS
      );
      this.orderTimer.unref?.();
    }
  }

  async refreshAccountSnapshot(){
    if(this.refreshing||!this.trader)return false;
    this.refreshing=true;
    this.accountMonitoring=true;
    this.updateHealth();
    try{
      const snapshot=await this.trader.getEquitySnapshot();
      if(!Array.isArray(snapshot?.orders)||!Array.isArray(snapshot?.positions)){
        throw new Error('Account reconciliation returned an incomplete snapshot');
      }
      this.lastBalance=snapshot;
      this.untrackedOpenOrders=snapshot.orders.filter(order=>
        !this.orderStates.has(String(order.id||order.orderId||''))).length;
      const reconciliation=await this.reconcileTrackedOrders();
      this.accountError=null;
      this.accountReady=reconciliation.ok;
      this.lastAccountSuccessAt=this.clock();
      this.accountFailures=0;
      this.updateHealth();
      return this.status==='ready';
    }catch(error){
      this.accountReady=false;
      this.accountFailures++;
      this.accountError=error.message;
      this.updateHealth();
      return false;
    }finally{
      this.refreshing=false;
    }
  }

  async reconcileTrackedOrders(){
    if(this.reconcilePromise)return this.reconcilePromise;
    if(!this.trader)return{ok:false};
    if(!this.tradingEnabled){
      this.lastReconciledAt=this.clock();
      return{ok:true};
    }
    this.polling=true;
    this.reconcilePromise=(async()=>{
      try{
      const tracked=[...this.orderStates.values()].filter(order=>{
        if(order.kind!=='ENTRY'&&order.kind!=='FLOW_TEST_ENTRY')return false;
        const status=String(order.status).toUpperCase();
        const active=ACTIVE_ORDER_STATUSES.has(status);
        const hasUnsubmittedFill=order.filledShares
          -(order.exitSubmittedShares||0)-(order.exitSubmittingShares||0)>SHARE_EPSILON;
        const terminalMinimumBlock=Number.isFinite(order.minSellBlockedAtFilledShares)
          &&['MATCHED','FILLED','CANCELLED','CANCELED','EXPIRED'].includes(status);
        return active||(hasUnsubmittedFill&&!terminalMinimumBlock);
      });
      const results=await Promise.all(tracked.map(order=>this.refreshTrackedOrder(order)));
      const failed=results.some(ok=>!ok);
      this.orderError=failed?'Order reconciliation failed; waiting for successful order-status reads':null;
      if(!failed)this.lastReconciledAt=this.clock();
      this.updateHealth();
      return{ok:!failed&&!this.halted};
      }catch(error){
        this.orderError=`Order reconciliation failed: ${error.message}`;
        this.updateHealth();
        return{ok:false};
      }finally{
        this.polling=false;
      }
    })();
    try{return await this.reconcilePromise;}finally{this.reconcilePromise=null;}
  }

  async refreshTrackedOrder(tracked){
    try{
      const latest=await this.trader.fetchOrder(tracked.orderId);
      tracked.status=String(latest.status||tracked.status);
      tracked.updatedAt=this.clock();
      tracked.lastPollError=null;

      if(tracked.kind==='ENTRY'||tracked.kind==='FLOW_TEST_ENTRY'){
        const filled=Math.min(tracked.shares,matchedShares(latest));
        tracked.filledShares=Math.max(tracked.filledShares,filled);
        if(this.clock()<tracked.windowEnd){
          await this.submitTakeProfitForConfirmedFill(tracked);
        }
      }

      if(this.clock()>=tracked.windowEnd
        &&ACTIVE_ORDER_STATUSES.has(String(tracked.status).toUpperCase())){
        if(!await this.cancelAtWindowEnd(tracked))return false;
      }
      return !this.halted;
    }catch(error){
      tracked.lastPollError=error.message;
      tracked.lastPollAt=this.clock();
      return false;
    }
  }

  async submitTakeProfitForConfirmedFill(entryOrder){
    const available=Number(
      (entryOrder.filledShares-entryOrder.exitSubmittedShares
        -(entryOrder.exitSubmittingShares||0)).toFixed(2)
    );
    if(Number.isFinite(entryOrder.minSellBlockedAtFilledShares)){
      if(entryOrder.filledShares<=entryOrder.minSellBlockedAtFilledShares+SHARE_EPSILON)return;
      entryOrder.minSellBlockedAtFilledShares=null;
      entryOrder.exitBlockedShares=0;
      entryOrder.exitBlockedReason=null;
    }
    if(available<=SHARE_EPSILON||this.clock()<entryOrder.nextSellRetryAt)return;
    if(available<cfg.LIVE_MIN_ORDER_SHARES){
      entryOrder.minSellBlockedAtFilledShares=entryOrder.filledShares;
      entryOrder.exitBlockedShares=available;
      entryOrder.exitBlockedAt=this.clock();
      entryOrder.exitBlockedReason=`Polymarket requires at least ${cfg.LIVE_MIN_ORDER_SHARES} shares per sell; ${available} confirmed shares are below that minimum.`;
      return;
    }
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
        this.setError(`Take-profit submission could not be confirmed: ${error.message}`);
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
      order.cancelError=null;
      return true;
    }catch(error){
      order.cancelError=error.message;
      return false;
    }
  }

  snapshot(){
    this.updateHealth();
    const botOrders=this.orders.map(order=>({...order}));
    const recovery={accountReady:this.accountReady,accountFailures:this.accountFailures,
      lastAccountSuccessAt:this.lastAccountSuccessAt,lastReconciledAt:this.lastReconciledAt,
      nextAccountRefreshAt:this.nextAccountRefreshAt,untrackedOpenOrders:this.untrackedOpenOrders,
      entryDecisions:this.entryDecisions.map(decision=>({...decision})),
      liveSignals:[...this.liveSignals.values()].slice(-10).map(signal=>({
        slug:signal.slug,timeframe:signal.timeframe,triggeredAt:signal.triggeredAt,
        upMid:signal.upMid,downMid:signal.downMid,
        sides:Object.fromEntries(Object.entries(signal.sides).map(([side,state])=>[side,{
          status:state.lastStatus||(state.done?'submitted':state.inFlight?'submitting':'pending'),
          error:state.lastError||null,
        }])),
      }))};
    return this.lastBalance
      ?{
        ...this.lastBalance,status:this.status,tradingEnabled:this.tradingEnabled,
        halted:this.halted,error:this.error,
        orders:this.lastBalance.orders||[],botOrders,recovery,
      }
      :{
        status:this.status,tradingEnabled:this.tradingEnabled,halted:this.halted,
        error:this.error,collateral:null,positionValue:null,equity:null,
        positions:[],orders:[],botOrders,asOf:null,recovery,
      };
  }

  stop(){
    this.stopped=true;
    if(this.balanceTimer)clearTimeout(this.balanceTimer);
    if(this.orderTimer)clearInterval(this.orderTimer);
  }
}

module.exports=LiveOrderMirror;
