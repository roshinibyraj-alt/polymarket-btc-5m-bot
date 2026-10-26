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
function payout(m,side){
  const outcomes=Array.isArray(m.outcomes)?m.outcomes:parse(m.outcomes);
  const prices=Array.isArray(m.outcomePrices)?m.outcomePrices:parse(m.outcomePrices);
  const idx=outcomes.findIndex(x=>String(typeof x==='string'?x:x.name||x.label).toUpperCase()===side);
  const status=String(m.status||'').toUpperCase();
  if(!(m.closed===true||m.resolved===true||['CLOSED','RESOLVED','SETTLED'].includes(status))||idx<0)return null;
  const p=Number(prices[idx]??(typeof outcomes[idx]==='object'?outcomes[idx].payout:NaN));
  return p>=.99?1:p<=.01?0:null;
}
function parse(x){if(typeof x==='string'){try{return JSON.parse(x)}catch(_){}}return []}
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
function clobWinner(up,down){
  if(!Number.isFinite(up)||!Number.isFinite(down))return null;
  return up>=.98?'UP':down>=.98?'DOWN':up>=down?'UP':'DOWN';
}
function clobQuotePrices(q){
  return [q?.mid,q?.bestBid,q?.bestAsk].filter(x=>x!=null&&x!=='').map(Number)
    .filter(x=>Number.isFinite(x)&&x>=0&&x<=1);
}
function clobQuoteValue(q){const prices=clobQuotePrices(q);return prices.length?Math.max(...prices):null}
function clobQuoteFloor(q){const prices=clobQuotePrices(q);return prices.length?Math.min(...prices):null}
function takeProfitHit(q,now=Date.now()){return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&clobQuotePrices(q).some(price=>price>=.99)}
function stopLossHit(q,now=Date.now()){return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&clobQuotePrices(q).some(price=>price<=.01)}
function clobQuoteWinner(up,down){
  const upPrices=clobQuotePrices(up),downPrices=clobQuotePrices(down);
  const upHigh=upPrices.some(x=>x>=.98),downHigh=downPrices.some(x=>x>=.98);
  if(upHigh!==downHigh)return upHigh?'UP':'DOWN';
  const upLow=upPrices.some(x=>x<=.02),downLow=downPrices.some(x=>x<=.02);
  if(upLow!==downLow)return upLow?'DOWN':'UP';
  const u=clobQuoteValue(up),d=clobQuoteValue(down);
  if(u==null||d==null)return null;
  return u>=d?'UP':'DOWN';
}
class WickBot{
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS_5M,capital=cfg.DEMO_CAPITAL_5M,
    strategyMode='candle-pattern',priceFeed=chainlinkFeed}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.strategyMode=strategyMode;this.priceFeed=priceFeed;
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';
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
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
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
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&(p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT'))p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      for(const p of this.positions){
        if((p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT')
          &&now>=p.windowStart+this.windowMs
          &&now-(p.lastSettlementAttempt||0)>=1000) await this.trySettle(p);
      }
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
    this.windowOrders=[];
    this.log('CANDLE_PATTERN_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe});
  }
  updateCandleContext(){
    try{this.articleCandles=this.priceFeed.getMinuteCandles()}
    catch(error){this.candleEvaluation={side:null,reason:error.message}}
  }
  processCandleEntries(start,now){
    if(this.orderWindowStart!==start||this.candleOrdersPlaced)return;
    const windows=candleStrategy.aggregateCompleteCandles(this.articleCandles,this.windowMs)
      .filter(c=>c.end<=start);
    const signal=candleStrategy.signalForPrevious(windows);
    this.candleEvaluation={...signal,ready:!!signal.previous};
    if(!signal.side)return;
    if(!windows.length||windows.at(-1).end!==start){
      this.candleEvaluation={side:null,reason:'Previous market candle is incomplete or unavailable'};return;
    }
    if(now>=start+cfg.ORDER_CUTOFF_MS){this.candleEvaluation={...signal,reason:'180-second entry cutoff has passed'};return}
    this.candleOrdersPlaced=true;
    const tokenId=this.market.tokens[signal.side];
    this.windowOrders=[];
    for(const level of cfg.RESTING_LIMITS){
      const price=level.price;
      const order={id:`${this.timeframe}-${start}-${price}`,timeframe:this.timeframe,windowStart:start,
        side:signal.side,tokenId,limitPrice:price,shares:level.shares,status:'LIVE',
        createdAt:now,expiresAt:start+cfg.ORDER_CUTOFF_MS,pattern:signal.pattern};
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
        ||!Number.isFinite(ask)||ask>order.limitPrice)continue;
      const cost=order.shares*order.limitPrice;
      if(cost>this.cash){order.status='REJECTED_INSUFFICIENT_CASH';continue}
      order.status='FILLED';order.filledAt=now;order.fillPrice=order.limitPrice;
      const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,
        windowStart:start,marketId:this.market.id,slug:this.market.slug,title:this.market.title,
        side:order.side,tokenId:order.tokenId,entryKey:order.id,
        entryLabel:`${order.pattern} · ${order.side} · $${order.limitPrice.toFixed(2)}`,
        entryType:'CANDLE_PATTERN_LIMIT',orderType:'GTC_LIMIT',fillModel:'PAPER_ASK_TOUCH',
        shares:order.shares,initialShares:order.shares,avgEntry:order.limitPrice,
        cost,totalCost:cost,fees:0,status:'OPEN',submittedAt:order.createdAt,
        openedAt:now,filledAt:now,markBid:this.liveQuotes[order.side]?.bestBid??null};
      this.cash-=cost;this.positions.unshift(position);
      this.log('PAPER_LIMIT_FILLED',{id:order.id,side:order.side,price:order.limitPrice,shares:order.shares});
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
    if(this.strategyMode!=='article-15m'||this.articleEntryFilled||this.windowFiredEntries>0)return;
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
        // Candle strategy holds filled shares to official market resolution.
      }
    }
    const due=open.filter(p=>p.windowStart!==this.market.start&&p.tokenId&&now-(p.lastMarkAttempt||0)>=5000);
    await Promise.all(due.map(async p=>{
      p.lastMarkAttempt=now;
      try{const q=quoteFromBook(await md.getBook(p.tokenId),now);p.markBid=q.bestBid;p.markUpdatedAt=now;p.markStatus=q.bestBid!=null?'LIVE':'MISSING'}
      catch(_){p.markStatus=p.markBid!=null?'STALE':'MISSING'}
    }));
  }
  processArticleExit(position,quote,now){
    const bid=Number(quote?.bestBid);
    if(!Number.isFinite(bid)||bid<=0)return;
    if(bid>=.85){this.finalizeArticleExit(position,bid,'ARTICLE_TAKE_PROFIT_0_85');return}
    if(bid>=.60&&bid<=.70){
      position.stallStartedAt??=now;
      if(now-position.stallStartedAt>=180_000)this.finalizeArticleExit(position,bid,'ARTICLE_STALLED_3_MINUTES');
    }else position.stallStartedAt=null;
  }
  finalizeArticleExit(position,bid,reason){
    if(position.status!=='OPEN')return;
    const exitFee=feeFor(this.market,bid,position.shares);
    const proceeds=Math.max(0,bid*position.shares-exitFee);
    position.exitPrice=bid;position.exitFees=exitFee;position.proceeds=proceeds;
    position.realizedPnl=proceeds-position.totalCost;position.status='SETTLED_EXIT';
    position.settledAt=Date.now();position.settlementBasis=reason;
    this.cash+=proceeds;
    this.log('PAPER_ARTICLE_15M_EXIT',{id:position.id,side:position.side,bid,shares:position.shares,
      exitFee,proceeds,pnl:position.realizedPnl,reason});
  }
  async trySettle(p){
    if(Date.now()<p.windowStart+(p.windowMs||this.windowMs))return;if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))return;p.lastSettlementAttempt=Date.now();
    try{let market;try{market=await md.getMarket(p.marketId)}catch(_){market=await md.getBtcMarket(p.windowStart,p.windowMs||this.windowMs)}const result=payout(market,p.side);
      if(result==null){p.status='PENDING_CLOB_RESULT';p.settlementError='Waiting for Polymarket official resolution';if(!p.lastPendingLog||Date.now()-p.lastPendingLog>30000){p.lastPendingLog=Date.now();this.log('PAPER_OFFICIAL_RESULT_PENDING',{id:p.id,marketId:p.marketId})}return}
      this.finalizePosition(p,result===1,result===1?'OFFICIAL_RESOLUTION_WIN':'OFFICIAL_RESOLUTION_LOSS',null);
    }catch(e){p.status='PENDING_CLOB_RESULT';p.settlementError=e.message;if(!p.lastPendingLog||Date.now()-p.lastPendingLog>30000){p.lastPendingLog=Date.now();this.log('PAPER_OFFICIAL_RESULT_PENDING',{id:p.id,marketId:p.marketId,error:e.message})}}
  }
  finalizePosition(p,won,reason,triggerQuote){if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))return;p.payout=won?1:0;p.proceeds=won?p.shares:0;p.realizedPnl=p.proceeds-p.totalCost;p.status=won?'SETTLED_WIN':'SETTLED_LOSS';p.settledAt=Date.now();p.settlementBasis=reason;p.tpTriggerQuote=reason==='TP_HIT_0_99'?triggerQuote:null;p.stopTriggerQuote=reason.startsWith('STOP_LOSS_HIT_')?triggerQuote:null;p.winningSide=won?p.side:null;this.cash+=p.proceeds;const event=reason==='TP_HIT_0_99'?'PAPER_TP_HIT':reason.startsWith('STOP_LOSS_HIT_')?'PAPER_STOP_LOSS':won?'PAPER_OFFICIAL_WIN':'PAPER_OFFICIAL_LOSS';this.log(event,{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,shares:p.shares,proceeds:p.proceeds,triggerQuote,tpTarget:.99,stopLoss:p.stopLossThreshold??.01,reason})}
  snapshot(){
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
     const takerFees=this.positions.reduce((s,p)=>s+(p.fees||0)+(p.exitFees||0),0);
     const estimatedMakerRebate=this.positions.reduce((s,p)=>s+(p.estimatedMakerRebate||0),0);
    const wins=this.positions.filter(p=>p.status==='SETTLED_WIN'
      ||(p.status==='SETTLED_EXIT'&&Number(p.realizedPnl)>0)).length;
    const losses=this.positions.filter(p=>p.status==='SETTLED_LOSS'
      ||(p.status==='SETTLED_EXIT'&&Number(p.realizedPnl)<=0)).length;
    const exits=this.positions.filter(p=>p.status==='SETTLED_EXIT').length;
    const settledTrades=wins+losses,totalTrades=this.positions.filter(p=>p.status!=='CANCELLED_UNFILLED').length;
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
        orders:{type:'Resting paper limit buys',levels:[{price:.30,shares:500},{price:.20,shares:500}],
          cutoffSeconds:180},exit:'Hold filled shares to official market resolution',execution:'PAPER ONLY',
        signalState:this.candleEvaluation,priceFeed:this.priceFeed?.snapshot?.()||null};
     return {now,mode:'DEMO ONLY',status:this.status,error:this.error,strategy,
        account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,
         totalTrades,settledTrades,wins,losses,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
         openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT').length,
          maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,exits,
          wins,losses,equityCurve},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
          scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
            source:'Polymarket Gamma/CLOB + Polymarket RTDS Chainlink BTC/USD',
           marketResolution:'Official Gamma result at window close; retry until resolved'},
       positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
      start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,
        note:'Paper-only previous-candle strategy with two resting limit orders; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,feeFor,payout,quoteFromBook,clobWinner,clobQuoteWinner,clobQuoteValue,clobQuoteFloor,takeProfitHit,stopLossHit};
