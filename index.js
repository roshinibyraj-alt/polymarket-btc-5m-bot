'use strict';

const express = require('express');
const { BtcBreakoutEngine } = require('./engine');

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

const app = express();
const port = Number(process.env.PORT || 3000);

const START_BANKROLL = Number(process.env.START_BANKROLL || 5000);

const martingale = new BtcBreakoutEngine({
  name: 'MARTINGALE',
  shareLadder: [20, 40, 80, 160],
  maxFlips: 3,
  bankroll: START_BANKROLL,
  onLog: line => console.log(`[MART] ${line}`),
});

const anti = new BtcBreakoutEngine({
  name: 'ANTI',
  shareLadder: [160, 80, 40, 20],
  maxFlips: 3,
  bankroll: START_BANKROLL,
  onLog: line => console.log(`[ANTI] ${line}`),
});

app.disable('x-powered-by');
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json({
  martingale: martingale.buildState(),
  anti: anti.buildState(),
}));

const dashboard = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flipper X — Marty vs Anti</title>
<style>
*{box-sizing:border-box}
:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400;--blue:#38d6ff}
html,body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}
.wrap{max-width:1400px;margin:auto}
.topbar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:38px;height:38px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:22px}
h1{font-size:19px;margin:0;line-height:1.1;text-transform:uppercase}
.sub{font-size:10px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap}
.live{color:var(--up);border-color:#084b31}.warn{color:var(--amber);border-color:#5a4300}.bad{color:var(--down);border-color:#5c1622}.blue{color:var(--blue);border-color:#0d3a4a}
.engines{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}
.engine{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}
.engine.mart{border-color:#0d5c32}.engine.anti{border-color:#7a2f42}
.engine-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.engine-name{font-size:16px;text-transform:uppercase;letter-spacing:.5px}
.engine-name.mart{color:var(--up)}.engine-name.anti{color:var(--down)}
.engine-strategy{font-size:9px;color:var(--muted);margin-top:2px}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0}
.box,.panel{background:#000;border:1px solid var(--line);padding:8px;border-radius:6px}
.label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.value{font-size:17px;margin-top:2px}.value.positive{color:var(--up)}.value.negative{color:var(--down)}
.main{display:grid;grid-template-columns:minmax(280px,420px) minmax(240px,.8fr);gap:8px;margin-top:8px}
.clock{font-size:34px;line-height:1}.clock small{font-size:11px;color:var(--muted)}
.prices{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}
.side{border:1px solid var(--line);padding:8px;background:#000;border-radius:6px}
.side-name{font-size:11px}.side-price{font-size:28px;line-height:1;margin:3px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:12px}.quote-row span:last-child{color:#ddd}
.position-name{font-size:18px}.pnl{font-size:28px;margin:2px 0}
.empty{color:var(--muted);padding:8px;border:1px dashed #333;text-align:center;border-radius:6px}
.chart{width:100%;height:100px;display:block}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#fff;text-transform:uppercase}
.list{max-height:200px;overflow:auto;margin-top:6px}
.result,.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:6px 0;font-size:11px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:9px;font-weight:700}
.logsPanel{height:150px;overflow:auto;font-family:"Courier New",monospace;font-size:9px;line-height:1.45;color:#e4e4e4;margin-top:6px;white-space:pre-wrap;background:#010407;border-radius:6px;padding:6px}
.log-buy{color:var(--up)}.log-loss{color:var(--down)}
@media(max-width:900px){
 .engines{grid-template-columns:1fr}
 .metrics{grid-template-columns:repeat(2,1fr)}.main{grid-template-columns:1fr}
}
@media(max-width:560px){
 body{padding:6px;font-size:13px}
 h1{font-size:15px}.topbar{grid-template-columns:1fr}.status{justify-content:flex-start}
 .side-price{font-size:26px}.pnl{font-size:24px}.clock{font-size:30px}
}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
 <div class="brand"><div class="btc">₿</div><div><h1>Flipper X</h1><div class="sub">MARTINGALE 20→40→80→160 · ANTI 160→80→40→20 · GTC@0.99 SWEEP · ENTRY 0.60 · 3 FLIPS</div></div></div>
 <div class="status"><span id="uiLink" class="pill warn">UI LINK</span><span id="martLink" class="pill warn">MART CLOB WAIT</span><span id="antiLink" class="pill warn">ANTI CLOB WAIT</span></div>
</header>
<div class="engines">
<section class="engine mart" id="eng-mart">
 <div class="engine-head"><div><div class="engine-name mart">MARTINGALE</div><div class="engine-strategy" id="mart-strategy">—</div></div><div class="pill" id="mart-accum">—</div></div>
 <div class="metrics">
  <div class="box"><div class="label">Equity / Total PNL</div><div id="mart-equity" class="value">—</div><div id="mart-totalPnl" class="dim">—</div></div>
  <div class="box"><div class="label">Realized / Floating</div><div id="mart-realized" class="value">—</div><div id="mart-floating" class="dim">—</div></div>
  <div class="box"><div class="label">Win / Loss / Rate</div><div id="mart-record" class="value">—</div><div id="mart-streak" class="dim">—</div></div>
  <div class="box"><div class="label">Flips / Sunk</div><div id="mart-flips" class="value">—</div><div id="mart-sunk" class="dim">—</div></div>
  <div class="box"><div class="label">Drawdown / Peak</div><div id="mart-drawdown" class="value">—</div><div id="mart-peak" class="dim">—</div></div>
 </div>
 <div class="main">
  <div class="panel"><div class="section-head"><span id="mart-slug">MARKET</span><span id="mart-source">SOURCE</span></div><div id="mart-clock" class="clock">—</div>
  <div class="prices">
   <div class="side up"><div class="side-name">▲ UP</div><div class="side-price" id="mart-upPrice">—</div><div class="quote-row" id="mart-upQuote"></div><div id="mart-upFinal" class="dim"></div></div>
   <div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price" id="mart-downPrice">—</div><div class="quote-row" id="mart-downQuote"></div><div id="mart-downFinal" class="dim"></div></div>
  </div></div>
  <div class="panel"><div class="section-head"><span>POSITION</span><span id="mart-positionStatus">—</span></div><div id="mart-positionPanel" class="empty">NO OPEN POSITION</div>
  <div class="section-head" style="margin-top:8px"><span>EQUITY</span></div><svg id="mart-chart" class="chart" viewBox="0 0 500 100" preserveAspectRatio="none"></svg></div>
 </div>
 <div class="panel" style="margin-top:8px"><div class="section-head"><span>TRADES</span><span id="mart-tradeCount">0</span></div><div id="mart-trades" class="list"></div></div>
 <div class="panel" style="margin-top:8px"><div class="section-head"><span>LOGS</span></div><div id="mart-logs" class="logsPanel"></div></div>
 <div class="panel" style="margin-top:8px"><div class="section-head"><span>SETTLED</span><span id="mart-resultCount">0</span></div><div id="mart-results" class="list"></div></div>
</section>
<section class="engine anti" id="eng-anti">
 <div class="engine-head"><div><div class="engine-name anti">ANTI-MARTINGALE</div><div class="engine-strategy" id="anti-strategy">—</div></div><div class="pill" id="anti-accum">—</div></div>
 <div class="metrics">
  <div class="box"><div class="label">Equity / Total PNL</div><div id="anti-equity" class="value">—</div><div id="anti-totalPnl" class="dim">—</div></div>
  <div class="box"><div class="label">Realized / Floating</div><div id="anti-realized" class="value">—</div><div id="anti-floating" class="dim">—</div></div>
  <div class="box"><div class="label">Win / Loss / Rate</div><div id="anti-record" class="value">—</div><div id="anti-streak" class="dim">—</div></div>
  <div class="box"><div class="label">Flips / Sunk</div><div id="anti-flips" class="value">—</div><div id="anti-sunk" class="dim">—</div></div>
  <div class="box"><div class="label">Drawdown / Peak</div><div id="anti-drawdown" class="value">—</div><div id="anti-peak" class="dim">—</div></div>
 </div>
 <div class="main">
  <div class="panel"><div class="section-head"><span id="anti-slug">MARKET</span><span id="anti-source">SOURCE</span></div><div id="anti-clock" class="clock">—</div>
  <div class="prices">
   <div class="side up"><div class="side-name">▲ UP</div><div class="side-price" id="anti-upPrice">—</div><div class="quote-row" id="anti-upQuote"></div><div id="anti-upFinal" class="dim"></div></div>
   <div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price" id="anti-downPrice">—</div><div class="quote-row" id="anti-downQuote"></div><div id="anti-downFinal" class="dim"></div></div>
  </div></div>
  <div class="panel"><div class="section-head"><span>POSITION</span><span id="anti-positionStatus">—</span></div><div id="anti-positionPanel" class="empty">NO OPEN POSITION</div>
  <div class="section-head" style="margin-top:8px"><span>EQUITY</span></div><svg id="anti-chart" class="chart" viewBox="0 0 500 100" preserveAspectRatio="none"></svg></div>
 </div>
 <div class="panel" style="margin-top:8px"><div class="section-head"><span>TRADES</span><span id="anti-tradeCount">0</span></div><div id="anti-trades" class="list"></div></div>
 <div class="panel" style="margin-top:8px"><div class="section-head"><span>LOGS</span></div><div id="anti-logs" class="logsPanel"></div></div>
 <div class="panel" style="margin-top:8px"><div class="section-head"><span>SETTLED</span><span id="anti-resultCount">0</span></div><div id="anti-results" class="list"></div></div>
</section>
</div>
<script>
const $=id=>document.getElementById(id);
const cash=n=>'$'+Math.round(Number(n||0)).toLocaleString();
const price=n=>n!=null?Number(n).toFixed(3):'—';
const shares=n=>Number(n||0).toLocaleString();
const cls=n=>n>=0?'positive':'negative';
const caches={};
function renderEngine(p,s){
 $((p+'-strategy')).textContent=s.strategy||'';
 const floating=s.unrealizedPnl||0;
 $((p+'-equity')).textContent=cash(s.markValue);$((p+'-totalPnl')).textContent=(s.totalPnl>=0?'+':'')+cash(s.totalPnl)+' TOTAL';
 $((p+'-realized')).textContent=cash(s.realizedPnl);$((p+'-floating')).textContent=(floating>=0?'+':'')+cash(floating)+' FLOAT';
 $((p+'-record')).textContent=(s.wins||0)+' / '+(s.losses||0);$((p+'-streak')).textContent=s.winRate!=null?s.winRate+'% RATE':'';
 $((p+'-flips')).textContent=(s.windowFlipCount||0)+' / '+(s.maxFlips||0);$((p+'-sunk')).textContent=cash(s.windowSunkCost)+' SUNK';
 $((p+'-drawdown')).textContent=(s.drawdown>0?'-$':'+$')+Math.abs(s.drawdown).toFixed(2);
 $((p+'-drawdown')).className='value '+(s.drawdown>0?'negative':'');
 $((p+'-peak')).textContent='PEAK '+cash(s.peakEquity);
 $((p+'-accum')).textContent='▲'+shares(s.accumUpShares)+' ▼'+shares(s.accumDownShares);
 const m=s.market;
 if(m){
  $((p+'-slug')).textContent=m.windowStart?'WINDOW '+new Date(m.windowEnd*1000).toLocaleTimeString()+' CLOSE':'-';
  $((p+'-source')).textContent=m.settled?('WINNER '+(m.winner||'UNKNOWN')):'CLOB TOP OF BOOK';
  $((p+'-clock')).innerHTML=String(Math.floor(m.remaining/60)).padStart(2,'0')+':'+String(Math.floor(m.remaining%60)).padStart(2,'0')+'<small>T+'+m.elapsed+'S</small>';
  $((p+'-upPrice')).textContent=price(m.up.mid);$((p+'-downPrice')).textContent=price(m.down.mid);
  $((p+'-upQuote')).innerHTML='<span>'+price(m.up.bid)+' / '+price(m.up.ask)+'</span><span>'+(m.up.spread==null?'NO BOOK':m.up.spread.toFixed(3))+'</span>';
  $((p+'-downQuote')).innerHTML='<span>'+price(m.down.bid)+' / '+price(m.down.ask)+'</span><span>'+(m.down.spread==null?'NO BOOK':m.down.spread.toFixed(3))+'</span>';
  $((p+'-upFinal')).textContent=m.finalUpMax==null?'':'FINAL '+price(m.finalUpMax);
  $((p+'-downFinal')).textContent=m.finalDownMax==null?'':'FINAL '+price(m.finalDownMax);
 }
 const pos=s.position;
 $((p+'-positionStatus')).textContent=pos?pos.outcome+' · '+shares(pos.shares)+' SH':'FLAT';
 if(!pos){$((p+'-positionPanel')).innerHTML='<div class="empty">NO OPEN POSITION</div>'}
 else{$((p+'-positionPanel')).innerHTML='<div class="position-name">'+pos.outcome+' · '+shares(pos.shares)+' SH</div><div class="pnl '+cls(pos.pnl)+'">'+(pos.pnl>=0?'+':'')+cash(pos.pnl)+'</div><div class="dim">ENTRY '+price(pos.entryPrice)+' · COST '+cash(pos.cost)+' · MARK '+price(pos.tokenMid??pos.signal?.mid)+'</div><div class="dim">LADDER STEP '+(s.windowFlipCount||0)+' · '+pos.signal?.triggerSource+' @ '+price(pos.signal?.triggerPrice)+'</div>';}
 drawChart((p+'-chart'),s.equityCurve,s.totalPnl);
 renderResults((p+'-results'),(p+'-resultCount'),s.results);
 renderTrades((p+'-trades'),(p+'-tradeCount'),s.trades);
 renderLogs((p+'-logs'),s.logs);
}
function drawChart(id,curve,total){
 const svg=$(id);if(!svg)return;
 if(!curve||curve.length<2){svg.innerHTML='';return}
 const values=curve.map(pt=>pt.equity),low=Math.min(...values),high=Math.max(...values),range=(high-low)||1;
 const color=total>=0?'#00ff85':'#ff4a68';
 const points=curve.map((pt,index)=>[(index/(curve.length-1))*500,95-(pt.equity-low)/range*90]);
 const sig='chart:'+id+':'+curve.length+':'+values.at(-1)+':'+total;if(caches[sig]===true)return;caches[sig]=true;
 svg.innerHTML='<path d="M'+points.map(pt=>pt[0].toFixed(1)+','+pt[1].toFixed(1)).join(' L')+'" fill="none" stroke="'+color+'" stroke-width="3"/>';
}
function renderResults(id,cid,rows){$(cid).textContent=(rows||[]).length+' SETTLED';const sig='res:'+id+':'+(rows||[]).map(r=>r.windowStart+':'+r.result+':'+r.realizedPnl).join('|');if(caches[sig]===true)return;caches[sig]=true;$(id).innerHTML=!rows||!rows.length?'<div class="empty">NO COMPLETED WINDOWS</div>':rows.map(row=>'<article class="result"><div><div>'+(row.result||'PENDING')+' · WINNER '+(row.winner||'—')+'</div><div class="dim">'+new Date(row.windowStart*1000).toLocaleTimeString()+' · '+row.resolutionSource+'</div></div><div class="'+cls(row.realizedPnl)+'">'+cash(row.realizedPnl)+'</div></article>').join('')}
function renderTrades(id,cid,rows){$(cid).textContent=(rows||[]).length;const sig='tr:'+id+':'+(rows||[]).map(t=>t.timestamp+t.action+t.price).join('|');if(caches[sig]===true)return;caches[sig]=true;$(id).innerHTML=!rows||!rows.length?'<div class="empty">WAITING FOR TRADE</div>':rows.slice(0,40).map(trade=>'<article class="trade-item"><div><span class="'+(trade.action==='BUY'?'buy':'sell')+'">'+trade.action+' '+trade.outcome+' '+shares(trade.shares)+' SH</span><div class="dim">@'+price(trade.price)+' · '+trade.reason+'</div></div><div class="'+cls(trade.pnl||0)+'">'+(trade.action==='BUY'?cash(trade.cost):(trade.pnl>=0?'+':'')+cash(trade.pnl))+'</div></article>').join('')}
function renderLogs(id,input){const sig='lg:'+id+':'+(input||[]).length;if(caches[sig]===true)return;caches[sig]=true;const box=$(id);if(!box)return;const logs=(input||[]).slice(-240);box.innerHTML=logs.map(line=>'<div class="'+(line.includes('BUY')?'log-buy':line.includes('STOP')||line.includes('FAIL')||line.includes('SKIP')?'log-loss':'')+'">'+line+'</div>').join('');box.scrollTop=box.scrollHeight}
async function refresh(){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),850);
 try{
  const response=await fetch('/api/status',{cache:'no-store',signal:controller.signal});
  const d=await response.json();
  if(d.martingale){renderEngine('mart',d.martingale);$('martLink').textContent='MART LIVE';$('martLink').className='pill live'}
  else{$('martLink').textContent='MART WAIT';$('martLink').className='pill warn'}
  if(d.anti){renderEngine('anti',d.anti);$('antiLink').textContent='ANTI LIVE';$('antiLink').className='pill live'}
  else{$('antiLink').textContent='ANTI WAIT';$('antiLink').className='pill warn'}
  $('uiLink').textContent='UI LIVE';$('uiLink').className='pill live';
 }catch(error){$('uiLink').textContent='UI RETRY';$('uiLink').className='pill warn'}
 finally{clearTimeout(timer);setTimeout(refresh,150)}
}
refresh();
</script></body></html>`;

app.get('/', (_, res) => res.type('html').send(dashboard));

app.listen(port, '0.0.0.0', () => {
  console.log(`Flipper X dashboard listening on :${port}`);
  martingale.init();
  anti.init();
});
