'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');
const {feed:chainlinkFeed}=require('./chainlink-feed');
const candleStrategy=require('./candle-strategy');

function levels(xs){return (xs||[]).map(x=>({price:Number(x.price),size:Number(x.size)}))
  .filter(x=>Number.isFinite(x.price)&&x.size>0).sort((a,b)=>a.price-b.price)}
function usdPrice(x){return '$'+Number(x).toFixed(2)}
function quoteFromBook(book,updatedAt){
  const bids=levels(book.bids),asks=levels(book.asks);
  const bid=bids.sort((a,b)=>b.price-a.price)[0]||null;
  const ask=asks[0]||null;
  const bestBid=bid?.price??null,bestAsk=ask?.price??null;
  return {status:bid||ask?'LIVE':'MISSING',bestBid,bidSize:bid?.size??0,
    bestAsk,askSize:ask?.size??0,mid:bestBid!=null&&bestAsk!=null?(bestBid+bestAsk)/2:null,
    updatedAt,stale:false,error:null};
}
function simulateAtBestAsk(asks,qty,maxPrice,minPrice=cfg.MIN_ENTRY_ASK){
  const best=levels(asks).find(x=>x.price>=minPrice&&x.price<maxPrice);
  if(!best)return null;
  return {shares:qty,cost:qty*best.price,avg:best.price,visibleDepth:best.size,
    simulatedShares:Math.max(0,qty-best.size)};
}
function feeFor(m,avg,qty){
  if(m?.feesEnabled===false)return 0;
  const rate=Number(m?.feeSchedule?.rate??m?.takerFeeRate??cfg.CRYPTO_TAKER_FEE_RATE);
  const exp=Number(m?.feeSchedule?.exponent??1);
  return Number.isFinite(rate)&&Number.isFinite(exp)&&avg>0&&avg<1&&qty>0
    ? rate*Math.pow(avg*(1-avg),exp)*qty : 0;
}
function makerRebateFor(m,price,qty){
  if(m?.feesEnabled===false)return {feeEquivalent:0,estimate:0};
  const rate=Number(m?.feeSchedule?.rate??m?.takerFeeRate??cfg.CRYPTO_TAKER_FEE_RATE);
  const exponent=Number(m?.feeSchedule?.exponent??1);
  const feeEquivalent=Number.isFinite(rate)&&Number.isFinite(exponent)&&price>0&&price<1&&qty>0
    ?rate*Math.pow(price*(1-price),exponent)*qty:0;
  return {feeEquivalent,estimate:feeEquivalent*cfg.CRYPTO_MAKER_REBATE_RATE};
}
function takeProfitHit(q,now=Date.now()){
  const bid=Number(q?.bestBid);
  return q?.status==='LIVE'&&Number.isFinite(q.updatedAt)&&now>=q.updatedAt
    &&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=.99;
}
function stopLossHit(q,now=Date.now()){
  const bid=Number(q?.bestBid);
  return q?.status==='LIVE'&&Number.isFinite(q.updatedAt)&&now>=q.updatedAt
    &&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid<=.01;
}
function freshBidAtLeast(q,price,now=Date.now()){
  const bid=Number(q?.bestBid);
  return q?.status==='LIVE'&&Number.isFinite(q.updatedAt)&&now>=q.updatedAt
    &&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=price;
}
class WickBot{
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS_5M,capital=cfg.DEMO_CAPITAL_5M,
    strategyMode='candle-pattern',priceFeed=chainlinkFeed,onLiveEntryOrders=null}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.orderCutoffMs=cfg.ORDER_CUTOFF_MS*(windowMs/cfg.WINDOW_MS_5M);
    this.strategyMode=strategyMode;this.priceFeed=priceFeed;
    this.onLiveEntryOrders=onLiveEntryOrders;
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';
    this.completedWindows=new Map();
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.windowFiredEntries=0;
    this.lastFiredEntryShares=0;
    this.initialEntrySide=null;
    this.initialEntryAt=null;
    this.martingaleAttempted=false;
    this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    this.closeQuotes=null;
    this.articleReferencePrice=null;this.articleTicks=[];this.articleCandles=[];
    this.articleEvaluation={ready:false,reason:'Waiting for market data'};
    this.articleEntryFilled=false;
    this.candleEvaluation={side:null,reason:'Waiting for closed-candle history'};
    this.candleOrdersPlaced=false;
    this.liveCandleSignalSent=false;
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
      await this.closePreviousWindows(start,now);
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
        this.closeQuotes=null;
      }
      if(!this.market||this.market.start!==start||now-this.lastMarketAt>cfg.MARKET_REFRESH_MS){
        this.market=await md.getBtcMarket(start,this.windowMs);this.lastMarketAt=now;
        if(!this.market){
          this.status='waiting_for_market';this.lastScanAt=now;
          if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{status:this.status,windowStart:start})}
          return;
        }
      }
      await this.refreshLiveQuotes(now);
      if(this.orderWindowStart!==start)this.openStrategyWindow(start,now);
      this.updateCandleContext(start);
      this.processCandleEntries(start,now);
      this.processCandleOrders(start,now);
      this.lastScanAt=now;this.error=null;
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      this.status=hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  openStrategyWindow(start,now){
    this.orderWindowStart=start;
    this.lastEntryCheckpoint=0;
    this.windowFiredEntries=0;
    this.lastFiredEntryShares=0;
    this.initialEntrySide=null;
    this.initialEntryAt=null;
    this.martingaleAttempted=false;
    this.articleReferencePrice=null;this.articleTicks=[];this.articleCandles=[];
    this.articleEvaluation={ready:false,reason:'Waiting for BTC price history'};
    this.articleEntryFilled=false;
    this.candleEvaluation={side:null,reason:'Waiting for closed-candle history'};
    this.candleOrdersPlaced=false;
    this.liveCandleSignalSent=false;
    this.windowOrders=[];
    this.log('CANDLE_PATTERN_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe});
  }
  updateCandleContext(){
    try{this.articleCandles=this.priceFeed.getMinuteCandles()}
    catch(error){this.candleEvaluation={side:null,reason:error.message}}
  }
  processCandleEntries(start,now){
    if(this.completedWindows.has(start)||this.orderWindowStart!==start||this.candleOrdersPlaced)return;
    const windows=candleStrategy.aggregateCompleteCandles(this.articleCandles,this.windowMs)
      .filter(c=>c.end<=start);
    const signal=candleStrategy.signalForPrevious(windows);
    this.candleEvaluation={...signal,ready:!!signal.previous};
    if(!signal.side)return;
    if(!windows.length||windows.at(-1).end!==start){
      this.candleEvaluation={side:null,reason:'Previous market candle is incomplete or unavailable'};return;
    }
    const isFiveMinute=this.timeframe==='5m'&&this.windowMs===cfg.WINDOW_MS_5M;
    if(isFiveMinute&&!this.liveCandleSignalSent&&typeof this.onLiveEntryOrders==='function'){
      this.liveCandleSignalSent=true;
      const tokenId=this.market.tokens[signal.side];
      const liveEntry={windowStart:start,cutoffAt:start+this.orderCutoffMs,slug:this.market.slug,
        tokenId,side:signal.side,
        orders:cfg.RESTING_LIMITS.map(({price})=>({price,shares:cfg.LIVE_SHARES_PER_RUNG}))};
      Promise.resolve().then(()=>this.onLiveEntryOrders(liveEntry))
        .catch(error=>this.log('LIVE_ENTRY_MIRROR_ERROR',{note:error.message,slug:this.market?.slug||null}));
    }
    if(isFiveMinute&&now<start+cfg.DEMO_ENTRY_DELAY_MS_5M){
      this.candleEvaluation={...signal,reason:'Waiting for 120-second demo entry delay'};
      return;
    }
    if(!isFiveMinute&&now>=start+this.orderCutoffMs){
      this.candleEvaluation={...signal,reason:`${this.orderCutoffMs/1000}-second entry cutoff has passed`};return;
    }
    this.candleOrdersPlaced=true;
    const tokenId=this.market.tokens[signal.side];
    this.windowOrders=[];
    const levels=isFiveMinute?cfg.DEMO_RESTING_LIMITS_5M:cfg.RESTING_LIMITS;
    const expiresAt=isFiveMinute?start+this.windowMs:start+this.orderCutoffMs;
    for(const level of levels){
      const price=level.price;
      const order={id:`${this.timeframe}-${start}-${price}`,timeframe:this.timeframe,windowStart:start,
        side:signal.side,tokenId,limitPrice:price,shares:level.shares,status:'LIVE',
        createdAt:now,expiresAt,pattern:signal.pattern,entryType:'CANDLE_PATTERN_LIMIT',
        takeProfitPrice:isFiveMinute?cfg.DEMO_TAKE_PROFIT_PRICE_5M:null};
      this.windowOrders.push(order);this.orders.unshift(order);
    }
    this.log('CANDLE_SIGNAL_LIMITS_PLACED',{side:signal.side,pattern:signal.pattern,
      previousCandle:signal.previous,orders:this.windowOrders.map(o=>({price:o.limitPrice,shares:o.shares}))});
  }
  processCandleOrders(start,now){
    for(const order of this.windowOrders){
      if(order.status!=='LIVE')continue;
      if(now>=order.expiresAt){order.status='EXPIRED';order.closedAt=now;continue}
      const quote=this.liveQuotes[order.side];
      const ask=Number(quote?.bestAsk);
      if(quote?.status!=='LIVE'||!Number.isFinite(quote.updatedAt)||now-quote.updatedAt>5000
       ||!Number.isFinite(ask)||ask<=0||ask>order.limitPrice)continue;
      const fillPrice=ask;
      const cost=order.shares*fillPrice;
      if(cost>this.cash){order.status='REJECTED_INSUFFICIENT_CASH';continue}
      order.status='FILLED';order.filledAt=now;order.fillPrice=fillPrice;
      const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,
        windowStart:start,marketId:this.market.id,slug:this.market.slug,title:this.market.title,
        side:order.side,tokenId:order.tokenId,entryKey:order.id,
        entryLabel:`${order.pattern||'TP opposite'} · ${order.side} · $${fillPrice.toFixed(2)}`,
        entryType:order.entryType||'CANDLE_PATTERN_LIMIT',orderType:'GTC_LIMIT',fillModel:'PAPER_ASK_TOUCH',
        shares:order.shares,initialShares:order.shares,avgEntry:fillPrice,
        cost,totalCost:cost,fees:0,status:'OPEN',submittedAt:order.createdAt,
        openedAt:now,filledAt:now,markBid:this.liveQuotes[order.side]?.bestBid??null,
        takeProfitEnabled:order.takeProfitPrice!=null,
        takeProfitPrice:order.takeProfitPrice??null};
      this.cash-=cost;this.positions.unshift(position);
      this.log('PAPER_LIMIT_FILLED',{id:order.id,side:order.side,limitPrice:order.limitPrice,
        fillPrice,shares:order.shares,entryType:position.entryType});
    }
  }
  updateArticlePriceContext(start){
    try{
      const candles=this.priceFeed.getMinuteCandles();
      const ticks=this.priceFeed.getTicks();
      this.articleCandles=candles;
      this.articleTicks=ticks;
      const openingMinute=candles.find(x=>x.t===start);
      if(openingMinute&&this.articleReferencePrice==null)this.articleReferencePrice=openingMinute.o;
    }catch(error){
      this.articleEvaluation={ready:false,reason:error.message};
    }
  }
  processArticleEntries(start,now){
    if(this.completedWindows.has(start)||this.strategyMode!=='article-15m'||this.articleEntryFilled||this.windowFiredEntries>0)return;
    const evaluation=article15m.evaluateArticleEntry({
      now,windowStart:start,windowMs:this.windowMs,referencePrice:this.articleReferencePrice,
      ticks:this.articleTicks,candles:this.articleCandles,quotes:this.liveQuotes,
      capital:this.capital,cash:this.cash,
      feePerShare:(side,ask)=>feeFor(this.market,ask,1),
    });
    this.articleEvaluation=evaluation;
    if(!evaluation.ready)return;
    this.attemptArticleEntry(start,now,evaluation.candidate);
  }
  attemptArticleEntry(start,now,candidate){
    const {side,ask,shares}=candidate;
    const quote=this.liveQuotes[side];
    const id=`${this.timeframe}-${start}-article-${side.toLowerCase()}-${now}`;
    const order={id,timeframe:this.timeframe,windowStart:start,side,secondsIntoWindow:Math.floor((now-start)/1000),
      ask,shares,orderType:'MARKET',status:'SKIPPED',createdAt:now,entryType:'ARTICLE_15M',
      fairProbability:candidate.fairProbability,edge:candidate.edge,spread:candidate.spread,
      stakeUsd:candidate.stakeUsd,kellyFraction:candidate.kellyFraction,probabilityProxy:'BTC log-return volatility'};
    this.windowOrders.unshift(order);this.orders.unshift(order);
    if(this.orders.length>1000)this.orders.length=1000;
    if(!quote||quote.status!=='LIVE'||now-(quote.updatedAt||0)>5000){
      order.status='SKIPPED_STALE_QUOTE';order.reason='Fresh CLOB ask required';return false;
    }
    const fee=feeFor(this.market,ask,shares),cost=ask*shares,totalCost=cost+fee;
    if(totalCost>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';order.reason='Insufficient paper cash for the Kelly-sized entry and fee';return false;
    }
    const position={id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:start,
      marketId:this.market.id,slug:this.market.slug,title:this.market.title,side,
      tokenId:this.market.tokens[side],entryKey:id,
      entryLabel:`Article-inspired ${side} · ${usdPrice(ask)} · ¼ Kelly proxy`,
      entryType:'CLOB_ARTICLE_15M',orderType:'MARKET',fillModel:'PAPER_AT_BEST_ASK',
      shares,initialShares:shares,avgEntry:ask,cost,totalCost,fees:fee,
      makerFeeEquivalent:0,estimatedMakerRebate:0,status:'OPEN',
      submittedAt:now,openedAt:now,filledAt:now,visibleAskSize:quote.askSize,
      simulatedShares:Math.max(0,shares-(quote.askSize||0)),
      fairProbability:candidate.fairProbability,probabilityProxy:'BTC log-return volatility',
      edge:candidate.edge,stakeUsd:candidate.stakeUsd,kellyFraction:candidate.kellyFraction,
      btcAtEntry:candidate.spot,btcWindowOpen:candidate.referencePrice,
      stallStartedAt:null};
    order.status='FILLED';order.filledAt=now;order.positionId=id;order.fillPrice=ask;order.fee=fee;
    this.cash-=totalCost;this.positions.unshift(position);this.windowFiredEntries++;
    this.lastFiredEntryShares=shares;this.articleEntryFilled=true;
    this.log('PAPER_ARTICLE_15M_ENTRY_FILLED',{id,side,ask,shares,fee,totalCost,
      fairProbability:candidate.fairProbability,edge:candidate.edge,spread:candidate.spread,
      stakeUsd:candidate.stakeUsd,kellyFraction:candidate.kellyFraction,
      newsFilter:'NOT_IMPLEMENTED'});
    return true;
  }
  processTimedEntries(start,now){
    const elapsedMs=now-start,cutoffMs=cfg.MAX_ENTRY_SECONDS*1000;
    if(this.completedWindows.has(start))return;
    if(elapsedMs>=cutoffMs||this.windowFiredEntries>=cfg.MAX_SUCCESSFUL_ENTRIES_PER_WINDOW)return;

    if(this.windowFiredEntries===0){
      if(elapsedMs<cfg.INITIAL_ENTRY_DELAY_MS)return;
      const secondsIntoWindow=Math.floor(elapsedMs/1000);
      const candidates=['UP','DOWN'].map(side=>{
        const quote=this.liveQuotes[side],ask=Number(quote?.bestAsk);
        const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
          &&now-quote.updatedAt<=5000&&Number.isFinite(ask);
        return {side,ask,fresh};
      }).filter(q=>q.fresh&&q.ask>cfg.ENTRY_PRICE_THRESHOLD&&q.ask<=cfg.INITIAL_ENTRY_MAX_PRICE)
        .sort((a,b)=>a.ask-b.ask||a.side.localeCompare(b.side));
      if(candidates.length){
        this.attemptEntry(start,now,candidates[0].side,cfg.BASE_ENTRY_SHARES,'INITIAL',secondsIntoWindow);
      }
      return;
    }

    if(this.windowFiredEntries!==1||this.martingaleAttempted||!this.initialEntrySide)return;
    const oppositeSide=this.initialEntrySide==='UP'?'DOWN':'UP';
    const quote=this.liveQuotes[oppositeSide],ask=Number(quote?.bestAsk);
    const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
      &&now-quote.updatedAt<=5000&&Number.isFinite(ask);
    if(!fresh||ask<cfg.ENTRY_PRICE_THRESHOLD)return;
    this.martingaleAttempted=true;
    this.attemptEntry(start,now,oppositeSide,cfg.BASE_ENTRY_SHARES*cfg.ENTRY_SIZE_MULTIPLIER,
      'MARTINGALE',Math.floor(elapsedMs/1000));
  }
  attemptEntry(start,now,side,shares,entryType,secondsIntoWindow){
    const quote=this.liveQuotes[side],ask=Number(quote?.bestAsk);
    const id=`${this.timeframe}-${start}-${entryType.toLowerCase()}-${side.toLowerCase()}-${now}`;
    const order={id,timeframe:this.timeframe,windowStart:start,side,secondsIntoWindow,
      ask:Number.isFinite(ask)?ask:null,shares,orderType:'MARKET',status:'SKIPPED',createdAt:now,entryType};
    this.windowOrders.unshift(order);this.orders.unshift(order);
    if(this.orders.length>1000)this.orders.length=1000;
    const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
      &&now-quote.updatedAt<=5000&&Number.isFinite(ask);
    if(!fresh){
      order.status='SKIPPED_STALE_QUOTE';
      order.reason='A fresh executable ask for this side is required.';
      return false;
    }
    const fee=feeFor(this.market,ask,shares),cost=ask*shares,totalCost=cost+fee;
    if(totalCost>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.reason='Insufficient paper cash for this entry and its fee.';
      this.log('PAPER_ENTRY_REJECTED',{id,side,ask,shares,fee,reason:order.reason,entryType});
      return false;
    }
    const position={id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:start,
      marketId:this.market.id,slug:this.market.slug,title:this.market.title,side,
      tokenId:this.market.tokens[side],entryKey:id,
      entryLabel:`${entryType==='INITIAL'?'Initial':'Martingale'} buy ${usdPrice(ask)} · ${shares} shares`,
      entryType:`CLOB_${entryType}`,orderType:'MARKET',fillModel:'PAPER_AT_BEST_ASK',
      shares,initialShares:shares,avgEntry:ask,cost,totalCost,fees:fee,
      makerFeeEquivalent:0,estimatedMakerRebate:0,status:'OPEN',
      submittedAt:now,openedAt:now,filledAt:now,visibleAskSize:quote.askSize,
      simulatedShares:Math.max(0,shares-(quote.askSize||0))};
    order.status='FILLED';order.filledAt=now;order.positionId=id;order.fillPrice=ask;order.fee=fee;
    this.cash-=totalCost;this.positions.unshift(position);
    this.windowFiredEntries++;this.lastFiredEntryShares=shares;
    if(entryType==='INITIAL'){this.initialEntrySide=side;this.initialEntryAt=now}
    this.log('PAPER_TIMED_ENTRY_FILLED',{id,side,entryType,secondsIntoWindow,
      ask,shares,sizeMultiplier:entryType==='MARTINGALE'?cfg.ENTRY_SIZE_MULTIPLIER:null,
      fee,totalCost,visibleAskSize:quote.askSize});
    return true;
  }
  async refreshLiveQuotes(now){
    if(!this.market)return;
    const sides=['UP','DOWN'];
    const results=await Promise.allSettled(sides.map(side=>md.getBook(this.market.tokens[side])));
    sides.forEach((side,i)=>{
      const result=results[i];
      if(result.status==='fulfilled')this.liveQuotes[side]=quoteFromBook(result.value,now);
      else{
        const previous=this.liveQuotes[side]||{};
        const stale=previous.updatedAt?now-previous.updatedAt>10000:true;
        this.liveQuotes[side]={...previous,status:previous.updatedAt?(stale?'STALE':'LIVE'):'ERROR',stale,
          attemptedAt:now,error:result.reason?.message||'Order book unavailable'};
      }
    });
    const open=this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT');
    for(const p of open){
      if(p.windowStart===this.market.start){
        const q=this.liveQuotes[p.side];
        p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';
      }
    }
    const due=open.filter(p=>p.windowStart!==this.market.start&&p.tokenId&&now-(p.lastMarkAttempt||0)>=5000);
    await Promise.all(due.map(async p=>{
      p.lastMarkAttempt=now;
      try{const q=quoteFromBook(await md.getBook(p.tokenId),now);p.markBid=q.bestBid;p.markUpdatedAt=now;p.markStatus=q.bestBid!=null?'LIVE':'MISSING'}
      catch(_){p.markStatus=p.markBid!=null?'STALE':'MISSING'}
    }));
    const currentWindowOpen=open.filter(p=>p.windowStart===this.market.start);
    if(this.timeframe==='5m'){
      for(const position of currentWindowOpen){
        if(position.status!=='OPEN'||!position.takeProfitEnabled)continue;
        const quote=this.liveQuotes[position.side];
        if(freshBidAtLeast(quote,position.takeProfitPrice??cfg.DEMO_TAKE_PROFIT_PRICE_5M,now)){
          this.finalizeExit(position,Number(quote.bestBid),'TP_HIT_0_80');
          this.placeOppositeDemoOrder(position,now);
        }
      }
    }
    const stopLossPosition=currentWindowOpen.find(p=>p.status==='OPEN'&&stopLossHit(this.liveQuotes[p.side],now));
    const legacyTakeProfitPosition=this.timeframe==='5m'?null:
      currentWindowOpen.find(p=>takeProfitHit(this.liveQuotes[p.side],now));
    const trigger=legacyTakeProfitPosition||stopLossPosition;
    if(trigger){
      const reason=legacyTakeProfitPosition?'TP_HIT_0_99':'STOP_LOSS_HIT_0_01';
      await this.completeWindow(trigger.windowStart,trigger,reason,now);
    }
  }
  placeOppositeDemoOrder(position,now){
    if(position.oppositeOrderCreatedAt)return null;
    position.oppositeOrderCreatedAt=now;
    const side=position.side==='UP'?'DOWN':'UP';
    const id=`${position.id}-opposite-0.20`;
    const order={id,timeframe:this.timeframe,windowStart:position.windowStart,
      side,tokenId:this.market?.tokens?.[side]||null,
      limitPrice:cfg.DEMO_OPPOSITE_ENTRY_PRICE_5M,shares:position.shares,
      status:'LIVE',createdAt:now,expiresAt:position.windowStart+this.windowMs,
      pattern:'TP opposite-side entry',entryType:'TP_OPPOSITE',
      takeProfitPrice:null};
    this.windowOrders.push(order);this.orders.unshift(order);
    this.log('PAPER_TP_OPPOSITE_ORDER_PLACED',{triggerPositionId:position.id,
      side,price:order.limitPrice,shares:order.shares});
    return order;
  }
  cancelWindowOrders(windowStart,now,reason){
    for(const order of this.orders){
      if(order.windowStart===windowStart&&['LIVE','PENDING'].includes(order.status)){
        order.status=reason==='WINDOW_ROLLOVER'?'EXPIRED_WINDOW_ROLLOVER':'EXPIRED_WINDOW_COMPLETE';
        order.closedAt=now;
      }
    }
  }
  async completeWindow(windowStart,triggerPosition,triggerReason,now=Date.now()){
    if(this.completedWindows.has(windowStart))return;
    this.completedWindows.set(windowStart,now);
    if(this.completedWindows.size>100)this.completedWindows.delete(this.completedWindows.keys().next().value);
    this.cancelWindowOrders(windowStart,now,triggerReason);
    const positions=this.positions.filter(p=>p.windowStart===windowStart
      &&['OPEN','PENDING_CLOB_RESULT'].includes(p.status));
    for(const p of positions){
      let quote=null;
      const current=this.market?.start===windowStart?this.liveQuotes[p.side]:null;
      if(current?.status==='LIVE'&&current.bestBid!=null&&Number.isFinite(current.updatedAt)
        &&now>=current.updatedAt&&now-current.updatedAt<=5000)quote=current;
      if(!quote&&p.tokenId){
        try{quote=quoteFromBook(await md.getBook(p.tokenId),now)}
        catch(_){quote=null}
      }
      const bid=Number(quote?.bestBid);
      const hasBid=quote?.bestBid!=null&&Number.isFinite(bid)&&bid>=0&&bid<=1;
      const reason=p===triggerPosition?triggerReason:
        triggerReason==='WINDOW_ROLLOVER'
          ?(hasBid?'WINDOW_ROLLOVER_BID':'WINDOW_ROLLOVER_NO_BID')
          :(hasBid?'WINDOW_COMPLETE_BID':'WINDOW_COMPLETE_NO_BID');
      this.finalizeExit(p,hasBid?bid:0,reason);
    }
    this.log(triggerReason==='WINDOW_ROLLOVER'?'PAPER_WINDOW_ROLLED_OVER':'PAPER_WINDOW_COMPLETED',
      {windowStart,reason:triggerReason,closedPositions:positions.length});
  }
  async closePreviousWindows(currentStart,now){
    const oldWindows=new Set(this.positions
      .filter(p=>p.windowStart<currentStart&&['OPEN','PENDING_CLOB_RESULT'].includes(p.status))
      .map(p=>p.windowStart));
    for(const order of this.orders)if(order.windowStart<currentStart&&['LIVE','PENDING'].includes(order.status))oldWindows.add(order.windowStart);
    for(const windowStart of oldWindows)await this.completeWindow(windowStart,null,'WINDOW_ROLLOVER',now);
  }
  finalizeExit(p,bid,reason){
    if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))return;
    const exitFee=feeFor(this.market,bid,p.shares),grossProceeds=bid*p.shares;
    const proceeds=Math.max(0,grossProceeds-exitFee);
    p.exitPrice=bid;p.proceeds=proceeds;p.exitFees=exitFee;
    p.realizedPnl=proceeds-p.totalCost;p.status='SETTLED_EXIT';
    p.settledAt=Date.now();p.settlementBasis=reason;p.exitReason=reason;
    this.cash+=proceeds;
    this.log('PAPER_PRICE_EXIT',{id:p.id,side:p.side,shares:p.shares,exitPrice:bid,
      grossProceeds,proceeds,exitFee,realizedPnl:p.realizedPnl,reason});
  }
  snapshot(){
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
     const takerFees=this.positions.reduce((s,p)=>s+(p.fees||0)+(p.exitFees||0),0);
     const estimatedMakerRebate=this.positions.reduce((s,p)=>s+(p.estimatedMakerRebate||0),0);
     const profitableExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&Number(p.realizedPnl)>0).length;
     const losingExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&Number(p.realizedPnl)<0).length;
     const breakEvenExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&Number(p.realizedPnl)===0).length;
     const wins=this.positions.filter(p=>p.status==='SETTLED_WIN').length+profitableExits;
     const losses=this.positions.filter(p=>p.status==='SETTLED_LOSS').length+losingExits;
    const exits=this.positions.filter(p=>p.status==='SETTLED_EXIT').length;
     const settledTrades=wins+losses+breakEvenExits,totalTrades=this.positions.filter(p=>p.status!=='CANCELLED_UNFILLED').length;
    const history=this.positions.filter(p=>p.status==='SETTLED_WIN'||p.status==='SETTLED_LOSS'||p.status==='SETTLED_EXIT')
      .sort((a,b)=>(a.settledAt||0)-(b.settledAt||0));
    const equityCurve=[{ts:this.startedAt,equity:this.capital}];
    let curveEquity=this.capital,peak=this.capital,maxDrawdown=0,maxConsecutiveLosses=0,lossStreak=0;
    for(const p of history){
      curveEquity+=Number(p.realizedPnl)||0;
      equityCurve.push({ts:p.settledAt||p.openedAt,equity:curveEquity});
      peak=Math.max(peak,curveEquity);maxDrawdown=Math.max(maxDrawdown,peak-curveEquity);
      if((Number(p.realizedPnl)||0)<0){lossStreak++;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,lossStreak)}
      else lossStreak=0;
    }
    let unrealizedPnl=0,unpricedOpenPositions=0,markedValue=0;
    for(const p of this.positions){
      if(p.status!=='OPEN'&&p.status!=='PENDING_CLOB_RESULT'){
        p.markValue=0;p.unrealizedPnl=0;p.markStatus='CLOSED';continue;
      }
      const mark=p.markBid==null?null:p.markBid*p.shares;p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';const freshMark=mark!=null&&p.markAgeMs<=15000;p.markValue=freshMark?mark:null;p.unrealizedPnl=freshMark?mark-p.totalCost:null;if(!freshMark)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
    }
      const strategy={timeframe:this.timeframe,market:`Polymarket BTC ${this.timeframe} UP/DOWN`,
        signal:'Previous green → UP; previous red → DOWN; doji after 2+ red → UP; doji after 2+ green → DOWN',
        dojiDefinition:'Body ≤10% of candle high-low range',
        orders:{type:'Resting paper limit buys',
          levels:this.timeframe==='5m'?cfg.DEMO_RESTING_LIMITS_5M:cfg.RESTING_LIMITS,
          entryDelaySeconds:this.timeframe==='5m'?cfg.DEMO_ENTRY_DELAY_MS_5M/1000:0,
          cutoffSeconds:this.timeframe==='5m'?null:this.orderCutoffMs/1000},
        exit:this.timeframe==='5m'
          ?'Each filled signal-side rung exits at a fresh own-side bid >= $0.80 and places an opposite-side $0.20 paper limit for the same shares; opposite-side positions have no take-profit. A fresh own-side bid <= $0.01 completes the window and closes remaining positions. Unresolved shares close at rollover. No official outcomes are used.'
          :'A fresh own-side best bid >= $0.99 or <= $0.01 completes the whole window. All remaining positions close at their own bids (or $0 if no bid); pending entries are cancelled. Unresolved shares close at the next window start. No official outcomes are used.',
        execution:'PAPER ONLY',
        signalState:this.candleEvaluation,priceFeed:this.priceFeed?.snapshot?.()||null};
     return {now,mode:'DEMO ONLY',status:this.status,error:this.error,strategy,
        account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,
          totalTrades,settledTrades,wins,losses,breakEvenExits,profitableExits,losingExits,
          winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
         openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT').length,
          maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,exits,
          wins,losses,equityCurve},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
          scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
            source:'Polymarket market discovery and CLOB quotes + Polymarket RTDS Chainlink BTC/USD',
           marketResolution:'No official results are used; fresh own-side $0.99/$0.01 bids complete the window, and remaining shares close at their own bids or $0 on rollover'},
       positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
      start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,
        note:'Paper-only previous-candle strategy with two resting limit orders; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,feeFor,quoteFromBook,takeProfitHit,stopLossHit,freshBidAtLeast};
