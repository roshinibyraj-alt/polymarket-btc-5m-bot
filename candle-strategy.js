'use strict';

function candleColor(open, close, high, low) {
  const range = Number(high) - Number(low);
  const body = Math.abs(Number(close) - Number(open));
  if (range > 0 && body / range <= 0.1) return 'DOJI';
  return Number(close) > Number(open) ? 'GREEN' : Number(close) < Number(open) ? 'RED' : 'DOJI';
}

function aggregateCompleteCandles(minuteCandles, windowMs) {
  const count = windowMs / 60_000, groups = new Map();
  for (const row of minuteCandles || []) {
    const start = Math.floor(Number(row.t) / windowMs) * windowMs;
    const rows = groups.get(start) || [];
    rows.push(row); groups.set(start, rows);
  }
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([start, rows]) => {
    rows.sort((a,b)=>a.t-b.t);
    if (rows.length !== count || rows.some((r,i)=>r.t !== start + i*60_000)) return [];
    const open=Number(rows[0].o),close=Number(rows.at(-1).c);
    const high=Math.max(...rows.map(r=>Number(r.h))),low=Math.min(...rows.map(r=>Number(r.l)));
    return [{start,end:start+windowMs,open,close,high,low,color:candleColor(open,close,high,low)}];
  });
}

function signalForPrevious(candles) {
  if (!candles.length) return {side:null,reason:'Waiting for a complete previous candle'};
  const last=candles.at(-1);
  if(last.color==='GREEN') return {side:'UP',pattern:'PREVIOUS_GREEN',previous:last};
  if(last.color==='RED') return {side:'DOWN',pattern:'PREVIOUS_RED',previous:last};
  let red=0,green=0;
  for(let i=candles.length-2;i>=0;i--){
    if(candles[i].color==='RED'&&!green)red++;
    else if(candles[i].color==='GREEN'&&!red)green++;
    else break;
  }
  if(red>=2)return {side:'UP',pattern:'DOJI_AFTER_RED_RUN',previous:last};
  if(green>=2)return {side:'DOWN',pattern:'DOJI_AFTER_GREEN_RUN',previous:last};
  return {side:null,pattern:'DOJI_NO_RUN',previous:last,reason:'Doji needs two consecutive prior candles of one color'};
}

module.exports={candleColor,aggregateCompleteCandles,signalForPrevious};
