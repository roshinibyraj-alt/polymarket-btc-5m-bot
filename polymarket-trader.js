'use strict';

if(!globalThis.crypto?.subtle){
  const {webcrypto}=require('node:crypto');
  Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
}
const {privateKeyToAccount}=require('viem/accounts');
const {createWalletClient,http}=require('viem');
const {polygon}=require('viem/chains');
const {ClobClient,AssetType,Side,OrderType}=require('@polymarket/clob-client-v2');
const {RelayClient}=require('@polymarket/builder-relayer-client');
const CLOB='https://clob.polymarket.com';

class PolymarketTrader{
  constructor(privateKey){
    if(!privateKey)throw new Error('PRIVATE_KEY is required when LIVE_TRADING=true');
    const account=privateKeyToAccount(privateKey.startsWith('0x')?privateKey:`0x${privateKey}`);
    this.address=account.address;this.wallet=createWalletClient({account,chain:polygon,transport:http()});
    this.clob=null;this.depositWallet=null;this.options=new Map();
  }
  async authenticate(){
    try{this.depositWallet=await new RelayClient('https://relayer-v2.polymarket.com',137,this.wallet).deriveDepositWalletAddress()}catch{}
    const temp=new ClobClient({host:CLOB,chain:137,signer:this.wallet});
    const creds=await temp.createOrDeriveApiKey();
    this.clob=new ClobClient({host:CLOB,chain:137,signer:this.wallet,creds,
      ...(this.depositWallet?{signatureType:3,funderAddress:this.depositWallet}:{})});
  }
  async marketOptions(tokenId){
    if(this.options.has(tokenId))return this.options.get(tokenId);
    const [tickSize,negRisk]=await Promise.all([this.clob.getTickSize(tokenId),this.clob.getNegRisk(tokenId)]);
    const options={tickSize:tickSize||'0.01',negRisk:!!negRisk};this.options.set(tokenId,options);return options;
  }
  async placeGtdOrder(tokenId,side,price,size,expiration){
    if(!this.clob)throw new Error('CLOB authentication is not ready');
    const options=await this.marketOptions(tokenId);
    const response=await this.clob.createAndPostOrder(
      {tokenID:tokenId,price:Number(price),side:side==='BUY'?Side.BUY:Side.SELL,size:Number(size),expiration:String(expiration)},
      options,OrderType.GTD,true);
    if(response?.success===false)throw new Error(response.errorMsg||response.error||'GTD order rejected');
    const id=response?.orderID||response?.id;if(!id)throw new Error('GTD response did not include an order ID');
    return{id,status:response.status||'LIVE'};
  }
  async getEquitySnapshot(){
    if(!this.clob)throw new Error('CLOB authentication is not ready');
    const wallet=this.depositWallet||this.address;
    const [balance,positions]=await Promise.all([
      this.clob.getBalanceAllowance({asset_type:AssetType.COLLATERAL}),
      fetch(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(wallet)}&sizeThreshold=0.01&limit=500&offset=0`,
        {signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw new Error(`Positions API ${r.status}`);return r.json()})
    ]);
    const collateral=Number(balance?.balance)/1e6;
    if(!Number.isFinite(collateral))throw new Error('Collateral balance unavailable');
    const positionValue=(Array.isArray(positions)?positions:[]).reduce((sum,p)=>{
      const value=Number(p.currentValue);
      if(Number.isFinite(value))return sum+value;
      const size=Number(p.size),price=Number(p.curPrice);
      return sum+(Number.isFinite(size)&&Number.isFinite(price)?size*price:0);
    },0);
    return{status:'ready',collateral,positionValue,equity:collateral+positionValue,
      positionCount:Array.isArray(positions)?positions.length:0,asOf:new Date().toISOString()};
  }
}
module.exports=PolymarketTrader;
