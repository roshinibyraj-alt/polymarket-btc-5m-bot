'use strict';

const cfg=require('./config');

function retryAfterMilliseconds(response,now){
  const value=response?.headers?.get?.('retry-after');
  if(value===null||value===undefined||value==='')return 0;
  const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds*1000);
  const date=Date.parse(value);
  return Number.isFinite(date)?Math.max(0,date-now):0;
}

class PolymarketTrader{
  constructor(privateKey,{sdk=null,actions=null,privateKeyAdapter=null,
    fetcher=globalThis.fetch,clock=()=>Date.now()}={}){
    if(!privateKey)throw new Error('PRIVATE_KEY is required when LIVE_TRADING=true');
    this.privateKey=privateKey.startsWith('0x')?privateKey:`0x${privateKey}`;
    this.sdk=sdk;this.actions=actions;this.privateKeyAdapter=privateKeyAdapter;this.fetcher=fetcher;
    this.clock=clock;
    this.client=null;this.depositWallet=null;this.activityCache=null;this.activityCacheAt=0;
    this.positionsNextAllowedAt=0;this.positionsRequest=null;
  }
  async authenticate(){
    this.sdk=this.sdk||await import('@polymarket/client');
    this.actions=this.actions||await import('@polymarket/client/actions');
    const adapter=this.privateKeyAdapter||(await import('@polymarket/client/viem')).privateKey;
    this.client=await this.sdk.createSecureClient({signer:adapter(this.privateKey)});
    this.depositWallet=this.client.account?.wallet||null;
    if(!this.depositWallet)throw new Error('Polymarket SDK did not resolve the account wallet');
  }
  async placeLimitOrder(tokenId,side,price,size){
    if(!this.client)throw new Error('Polymarket authentication is not ready');
    let response;
    try{
      response=await this.client.placeLimitOrder({
        assetId:String(tokenId),side:side==='BUY'?this.sdk.OrderSide.BUY:this.sdk.OrderSide.SELL,
        price:String(price),size:String(size),postOnly:false
      });
    }catch(error){
      const message=String(error?.message||error);
      const explicitRejection=/not enough balance|balance is not enough|insufficient (?:balance|allowance)|(?:invalid|below|lower than|less than).{0,60}(?:minimum|min(?:imum)? size|size)|(?:minimum|min(?:imum)? size|size).{0,60}(?:below|lower than|less than|invalid)/i.test(message);
      error.submissionUncertain=!explicitRejection;
      if(/(?:size|order).{0,60}(?:minimum|min(?:imum)? size)|(?:minimum|min(?:imum)? size).{0,60}(?:size|order)/i.test(message)){
        error.minimumOrderSize=true;
      }
      throw error;
    }
    if(!response?.ok){
      const error=new Error(response?.message||response?.error||'Limit order rejected');
      error.submissionUncertain=false;
      throw error;
    }
    if(!response.orderId){
      const error=new Error('Limit order response did not include an order ID');
      error.submissionUncertain=true;
      throw error;
    }
    return{id:response.orderId,status:response.status||'LIVE'};
  }
  async fetchOrder(orderId){
    if(!this.client)throw new Error('Polymarket authentication is not ready');
    const order=await this.client.fetchOrder({orderId:String(orderId)});
    if(!order?.id)throw new Error(`Polymarket did not return order ${orderId}`);
    return order;
  }
  async listOpenOrders(){
    if(!this.client)throw new Error('Polymarket authentication is not ready');
    const orders=[];
    for await(const page of this.client.listOpenOrders()){
      if(Array.isArray(page?.items))orders.push(...page.items);
    }
    return orders;
  }
  async cancelOrder(orderId){
    if(!this.client)throw new Error('Polymarket authentication is not ready');
    const result=await this.client.cancelOrder({orderId:String(orderId)});
    const canceled=Array.isArray(result?.canceled)?result.canceled.map(String):[];
    if(!canceled.includes(String(orderId))){
      const reason=result?.notCanceled?.[orderId]||result?.not_canceled?.[orderId];
      throw new Error(reason||`Polymarket did not confirm cancellation for ${orderId}`);
    }
    return result;
  }
  async getMarket(conditionId){
    const response=await this.fetcher(`https://gamma-api.polymarket.com/markets/${encodeURIComponent(conditionId)}`,
      {signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`Market API ${response.status}`);
    return response.json();
  }
  async getRecentActivity(wallet){
    if(this.activityCache&&Date.now()-this.activityCacheAt<15000)return this.activityCache;
    const url=new URL('https://data-api.polymarket.com/v2/activity');
    url.searchParams.set('user',wallet);
    url.searchParams.set('limit','500');
    url.searchParams.set('type','TRADE');
    url.searchParams.set('sort_by','TIMESTAMP');
    url.searchParams.set('sort_direction','DESC');
    const response=await this.fetcher(url.toString(),{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`Activity API ${response.status}`);
    const payload=await response.json();
    if(!Array.isArray(payload?.data))throw new Error('Activity API returned an invalid response');
    this.activityCache=payload.data;
    this.activityCacheAt=Date.now();
    return this.activityCache;
  }
  async getAllPositions(wallet){
    if(this.positionsRequest)return this.positionsRequest;
    const now=Number(this.clock());
    const waitMs=Math.max(0,this.positionsNextAllowedAt-now);
    if(waitMs>0){
      const error=new Error('Positions API rate-limit cooldown active; request withheld');
      error.statusCode=429;
      error.retryAfterMs=waitMs;
      error.rateLimited=true;
      throw error;
    }
    this.positionsNextAllowedAt=now+cfg.LIVE_POSITIONS_MIN_INTERVAL_MS;
    const request=this.fetchAllPositions(wallet);
    this.positionsRequest=request;
    try{return await request;}
    finally{if(this.positionsRequest===request)this.positionsRequest=null;}
  }

  async fetchAllPositions(wallet){
    const pageSize=500,maxPages=20,all=[];
    let cursor=null;
    for(let page=0;page<maxPages;page++){
      const url=new URL('https://data-api.polymarket.com/v2/positions');
      url.searchParams.set('user',wallet);
      url.searchParams.set('status','OPEN');
      url.searchParams.set('filter_type','TOKENS');
      url.searchParams.set('filter_amount','0.01');
      url.searchParams.set('sort_by','TIMESTAMP');
      url.searchParams.set('sort_direction','DESC');
      url.searchParams.set('limit',String(pageSize));
      if(cursor)url.searchParams.set('cursor',cursor);
      const response=await this.fetcher(url.toString(),{signal:AbortSignal.timeout(10000)});
      if(!response.ok){
        if(response.status===429){
          const retryAfterMs=Math.max(cfg.LIVE_POSITIONS_MIN_INTERVAL_MS,
            retryAfterMilliseconds(response,Number(this.clock())));
          this.positionsNextAllowedAt=Math.max(this.positionsNextAllowedAt,
            Number(this.clock())+retryAfterMs);
          const error=new Error(`Positions API 429; retrying after ${Math.ceil(retryAfterMs/1000)}s`);
          error.statusCode=429;
          error.retryAfterMs=retryAfterMs;
          error.rateLimited=true;
          throw error;
        }
        throw new Error(`Positions API ${response.status}`);
      }
      const payload=await response.json();
      if(!Array.isArray(payload?.data)||!payload.pagination)throw new Error('Positions API returned an invalid response');
      all.push(...payload.data);
      const nextCursor=payload.pagination.next_cursor;
      if(nextCursor===null||nextCursor===undefined||nextCursor==='')return all;
      if(typeof nextCursor!=='string'||nextCursor===cursor)throw new Error('Positions API returned an invalid pagination cursor');
      cursor=nextCursor;
    }
    throw new Error(`Positions API exceeded the ${maxPages*pageSize}-row safety limit; account equity would be incomplete`);
  }
  async getEquitySnapshot({windowSlug=`btc-updown-5m-${Math.floor(Date.now()/300000)*300}`}={}){
    if(!this.client)throw new Error('Polymarket authentication is not ready');
    const wallet=this.depositWallet||this.address;
    const [balance,positions,orders,activity]=await Promise.all([
      this.actions.fetchBalanceAllowance(this.client,{assetType:this.sdk.AssetType.COLLATERAL}),
      this.getAllPositions(wallet),
      this.listOpenOrders(),
      this.getRecentActivity(wallet)
    ]);
    const collateral=Number(balance?.balance)/1e6;
    if(!Number.isFinite(collateral))throw new Error('Collateral balance unavailable');
    const recentTradeByAsset=new Map();
    for(const trade of Array.isArray(activity)?activity:[]){
      const asset=String(trade.token_id||'');
      const timestamp=Number(trade.timestamp);
      if(asset&&!recentTradeByAsset.has(asset)&&Number.isFinite(timestamp)){
        recentTradeByAsset.set(asset,new Date(timestamp*1000).toISOString());
      }
    }
    const normalizedPositions=(Array.isArray(positions)?positions:[]).map(p=>({
      market:String(p.title||p.question||p.market||'Unknown market'),
      slug:p.slug||null,outcome:String(p.outcome||'Unknown'),
      shares:Number(p.current_size)||0,avgEntry:Number(p.avg_price)||0,
      markPrice:Number(p.current_price)||0,value:Number(p.current_value)||0,
      pnl:Number(p.unrealized_pnl)||0,assetId:p.token_id||null,
      lastTradeAt:recentTradeByAsset.get(String(p.token_id||''))||null
    }));
    const positionByAsset=new Map(normalizedPositions.map(position=>[String(position.assetId||''),position]));
    const ordersWithPositions=(Array.isArray(orders)?orders:[]).map(order=>{
      const assetId=order.assetId||order.asset_id||order.tokenId||order.token_id;
      const position=assetId?positionByAsset.get(String(assetId)):null;
      return{
        ...order,
        currentPosition:position?{
          market:position.market,outcome:position.outcome,
          shares:position.shares,value:position.value
        }:null
      };
    });
    const positionValue=normalizedPositions.reduce((sum,p)=>sum+(p.value||p.shares*p.markPrice),0);
    const currentWindowPositions=normalizedPositions
      .filter(position=>position.slug===windowSlug)
      .sort((a,b)=>(Date.parse(b.lastTradeAt||'')||0)-(Date.parse(a.lastTradeAt||'')||0));
    return{status:'ready',collateral,positionValue,equity:collateral+positionValue,
      positionCount:normalizedPositions.length,positions:currentWindowPositions,orders:ordersWithPositions,asOf:new Date().toISOString()};
  }
}
module.exports=PolymarketTrader;
