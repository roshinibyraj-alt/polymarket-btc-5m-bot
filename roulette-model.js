'use strict';
    const {Worker}=require('node:worker_threads');const path=require('node:path');const pending=new Map();
    const HORIZONS=[4,8,12,16,20],LOOKBACK=20;
    async function predict(windowStart,timeframe='15m'){
      if(!['5m','15m'].includes(timeframe))return{ready:false,status:'error',reason:'Unsupported model timeframe'};
      const key=timeframe+':'+windowStart;if(pending.has(key))return pending.get(key);
      const task=(async()=>{try{
        const response=await fetch('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval='+timeframe+'&limit=1000',{headers:{'User-Agent':'paper-model/1.0'},signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('BTC candle feed returned HTTP '+response.status);
        const raw=await response.json(),now=Date.now(),bars=raw.filter(r=>Number(r[6])<now).map(r=>({time:Number(r[0]),close:Number(r[4])}));
        if(bars.length<300)throw new Error('Need at least 300 completed '+timeframe+' candles');
        const returns=bars.map((bar,i)=>i===0?null:Math.abs((bar.close-bars[i-1].close)/bars[i-1].close));
        const targets=bars.map((_,i)=>{if(i<LOOKBACK)return null;let total=0;for(let j=i-LOOKBACK+1;j<=i;j++)total+=returns[j];return total/LOOKBACK});
        const labels=bars.map((bar,i)=>i+1<bars.length&&targets[i]!=null&&((bars[i+1].close-bar.close)/bar.close)>targets[i]?1:0),rows=[];
        for(let i=Math.max(...HORIZONS);i<bars.length;i++){const x=[];for(const h of HORIZONS){let mean=0,trend=0;for(let j=i-h+1;j<=i;j++)mean+=bars[j].close;for(let j=i-h;j<i;j++)trend+=labels[j];x.push(bars[i].close/(mean/h),trend)}rows.push({time:bars[i].time,x,y:labels[i],targetReturn:targets[i]})}
        if(rows.length<301)throw new Error('Not enough samples after feature warmup');
        const latest=rows[rows.length-1],labeled=rows.slice(0,-1),validation=labeled.slice(-200),preValidation=labeled.slice(0,-200);
        const calibrationCount=Math.min(100,Math.floor(preValidation.length*.2)),calibration=preValidation.slice(-calibrationCount),train=preValidation.slice(0,-calibrationCount);
        if(train.length<50||calibration.length<25)throw new Error('Not enough model training and calibration examples');
        const result=await new Promise((resolve,reject)=>{const worker=new Worker(path.join(__dirname,'roulette-forest-worker.js'));worker.once('message',v=>{worker.terminate();resolve(v)});worker.once('error',reject);worker.postMessage({train,calibration,test:validation,latest:latest.x})});
        return{...result,ready:true,status:'ready',modelVersion:'roulette-rf-'+timeframe+'-adaptive20-calibrated-v3',signal:result.probabilityStrongUp>=result.threshold?'UP':null,targetReturn:latest.targetReturn,targetReturnPercent:latest.targetReturn*100,targetLookbackCandles:LOOKBACK,timeframe,trainingRows:train.length,calibrationRows:calibration.length,validationRows:validation.length,latestCandleAt:latest.time};
      }catch(error){return{ready:false,status:'error',reason:error.message||'Model inference failed'}}})();pending.set(key,task);if(pending.size>16)pending.delete(pending.keys().next().value);return task;
    }
    module.exports={predict};
    