'use strict';

class PolymarketTrader{
  constructor(privateKey,{sdk=null,actions=null,privateKeyAdapter=null,fetcher=globalThis.fetch}={}){
    if(!privateKey)throw new Error('PRIVATE_KEY is required when LIVE_TRADING=true');
    this.privateKey=privateKey.startsWith('0x')?privateKey:`0x${privateKey}`;
    this.sdk=sdk;this.actions=actions;this.privateKeyAdapter=privateKeyAdapter;this.fetcher=fetcher;
    this.client=null;this.depositWallet=null;
  }
  async authenticate(){
    this.sdk=this.sdk||await import('@polymarket/client');
    this.actions=this.actions||await import('@polymarket/client/actions');
    const adapter=this.privateKeyAdapter||(await import('@polymarket/client/viem')).privateKey;
    this.client=await this.sdk.createSecureClient({signer:adapter(this.privateKey)});
    this.depositWallet=this.client.account?.wallet||null;
    if(!this.depositWallet)throw new Error('Polymarket SDK did not resolve the account wallet');
  }
  async placeGtdOrder(tokenId,side,price,size,expiration){
    if(!this.client)throw new Error('Polymarket authentication is not ready');
    const response=await this.client.placeLimitOrder({
      assetId:String(tokenId),side:side==='BUY'?this.sdk.OrderSide.BUY:this.sdk.OrderSide.SELL,
      price:String(price),size:String(size),expiration:Number(expiration),postOnly:true
    });
    if(!response?.ok)throw new Error(response?.message||response?.error||'GTD order rejected');
    if(!response.orderId)throw new Error('GTD response did not include an order ID');
    return{id:response.orderId,status:response.status||'LIVE'};
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
  async getEquitySnapshot(){
    if(!this.client)throw new Error('Polymarket authentication is not ready');
    const wallet=this.depositWallet||this.address;
    const [balance,positions,orders]=await Promise.all([
      this.actions.fetchBalanceAllowance(this.client,{assetType:this.sdk.AssetType.COLLATERAL}),
      this.fetcher(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(wallet)}&sizeThreshold=0.01&limit=500&offset=0`,
        {signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw new Error(`Positions API ${r.status}`);return r.json()}),
      this.listOpenOrders()
    ]);
    const collateral=Number(balance?.balance)/1e6;
    if(!Number.isFinite(collateral))throw new Error('Collateral balance unavailable');
    const normalizedPositions=(Array.isArray(positions)?positions:[]).map(p=>({
      market:String(p.title||p.question||p.market||'Unknown market'),
      slug:p.slug||null,outcome:String(p.outcome||'Unknown'),
      shares:Number(p.size)||0,avgEntry:Number(p.avgPrice)||0,
      markPrice:Number(p.curPrice)||0,value:Number(p.currentValue)||0,
      pnl:Number(p.cashPnl)||0,assetId:p.asset||p.assetId||null
    }));
    const positionValue=normalizedPositions.reduce((sum,p)=>sum+(p.value||p.shares*p.markPrice),0);
    return{status:'ready',collateral,positionValue,equity:collateral+positionValue,
      positionCount:normalizedPositions.length,positions:normalizedPositions,orders,asOf:new Date().toISOString()};
  }
}
module.exports=PolymarketTrader;
