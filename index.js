'use strict';

const express = require('express');
const { SportsBucketEngine } = require('./engine');

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

const app = express();
const port = Number(process.env.PORT || 3000);

const engine = new SportsBucketEngine({
  name: 'SportsBuckets',
  onLog: line => console.log(`[BUCKET] ${line}`),
});

app.disable('x-powered-by');
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(engine.buildState()));

const dashboard = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sports Bucket Bot</title>
<style>
*{box-sizing:border-box}
:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400;--blue:#38d6ff}
html,body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}
.wrap{max-width:1200px;margin:auto}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px}
.logo{width:38px;height:38px;border-radius:50%;background:#1f6feb;display:grid;place-items:center;font-size:20px}
h1{font-size:18px;margin:0;text-transform:uppercase;letter-spacing:.4px}
.sub{font-size:10px;color:var(--muted);margin-top:2px}
.status{display:flex;flex-wrap:wrap;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap}
.live{color:var(--up);border-color:#084b31}.warn{color:var(--amber);border-color:#5a4300}.bad{color:var(--down);border-color:#5c1622}.blue{color:var(--blue);border-color:#0d3a4a}
.pricebar{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px}
.bigcard{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}
.market-title{font-size:11px;color:var(--muted);text-transform:uppercase}
.live-price{font-size:34px;line-height:1;margin:2px 0}
.quote{font-size:12px}
.buckets{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:8px}
.bucket{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}
.bucket.buyp{border-color:#0d5c32}.bucket.HED{padding:0}
.bucket-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.bucket-name{font-size:15px;text-transform:uppercase}
.bucket-state{font-size:10px;padding:3px 6px;border-radius:4px;border:1px solid var(--line)}
.bucket-state.FLAT{color:var(--muted)}.bucket-state.BUY_PLACED{color:var(--amber);border-color:#5a4300}.bucket-state.HELD{color:var(--blue);border-color:#0d3a4a}
.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.box,.panel{background:#000;border:1px solid var(--line);padding:8px;border-radius:6px}
.label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.value{font-size:16px;margin-top:2px}.value.positive{color:var(--up)}.value.negative{color:var(--down)}
.chart{width:100%;height:100px;display:block;background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:8px}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;text-transform:uppercase}
.list{max-height:200px;overflow:auto;margin-top:6px}
.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:6px 0;font-size:11px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:9px;font-weight:700}
.logsPanel{height:180px;overflow:auto;font-family:"Courier New",monospace;font-size:9px;line-height:1.45;color:#e4e4e4;background:#010407;border-radius:6px;padding:6px;white-space:pre-wrap}
.log-buy{color:var(--up)}.log-sell{color:var(--down)}
.empty{color:var(--muted);padding:8px;border:1px dashed #333;text-align:center;border-radius:6px}
@media(max-width:820px){.pricebar{grid-template-columns:1fr}.buckets{grid-template-columns:1fr}.panels{grid-template-columns:1fr}}
@media(max-width:560px){body{padding:6px;font-size:13px}h1{font-size:15px}.live-price{font-size:28px}}
</style>
</head>
<body>
<div class="wrap">
<div class="topbar">
 <div class="brand"><div class="logo">🎱</div><div><h1>Sports Bucket Bot</h1><div class="sub" id="strategy">LOADING…</div></div></div>
 <div class="status">
  <span class="pill" id="uiLink">UI…</span>
  <span class="pill" id="connLink">CONN…</span>
  <span class="pill" id="mktLink">MARKET…</span>
 </div>
</div>
<div class="pricebar">
 <div class="bigcard"><div class="market-title" id="markettitle">—</div><div class="live-price" id="livePrice">—</div><div class="quote" id="quote">—</div></div>
 <div class="bigcard"><div class="market-title">Equity</div><div class="live-price" id="equity">—</div><div class="quote" id="totPnl">—</div></div>
 <div class="bigcard"><div class="market-title">Realized PnL</div><div class="live-price" id="realPnl">—</div><div class="quote" id="roundTrips">—</div></div>
</div>
<svg class="chart" id="chart"></svg>
<div class="buckets" id="buckets"></div>
<div class="panels">
 <div class="panel"><div class="section-head"><span>TRADE FEED</span><span id="tradeCount">0</span></div><div class="list" id="trades"><div class="empty">WAITING FOR TRADE</div></div></div>
 <div class="panel"><div class="section-head"><span>LOGS</span></div><div class="logsPanel" id="logs">—</div></div>
</div>
</div>
<script>
const $=id=>document.getElementById(id);
const cash=v=>(v>=0?'+':'')+'$'+v.toFixed(2);
const price=v=>v==null?'—':v.toFixed(3);
const shares=v=>Math.round(v).toLocaleString();
const cls=v=>v>=0?'positive':'negative';
const caches={};
function drawChart(curve,total){
 const svg=$('chart');if(!svg)return;
 if(!curve||curve.length<2){svg.innerHTML='';return}
 const values=curve.map(p=>p.equity),low=Math.min(...values),high=Math.max(...values),range=(high-low)||1;
 const color=total>=0?'#00ff85':'#ff4a68';
 const points=curve.map((p,i)=>[(i/(curve.length-1))*1000,95-(p.equity-low)/range*90]);
 const sig='chart:'+curve.length+':'+values.at(-1)+':'+total;if(caches[sig])return;caches[sig]=1;
 svg.innerHTML='<path d="M'+points.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L')+'" fill="none" stroke="'+color+'" stroke-width="3"/>';
}
function renderBuckets(list){
 const host=$('buckets');
 const key='bk:'+list.map(b=>b.id+':'+b.state+':'+(b.order?(b.order.side+b.order.price):'')+':'+b.entryPrice+':'+b.shares+':'+b.bankroll).join('|');
 if(caches[key])return;caches[key]=1;
 host.innerHTML=list.map(b=>{
  const order=b.order?('<div class="dim">ORDER '+b.order.side+' @ '+price(b.order.price)+'</div>'):'';
  const held=b.state==='HELD'?('<div class="dim">ENTRY '+price(b.entryPrice)+' @ '+shares(b.shares)+' SH · SELL @ '+price((b.entryPrice||0)+0.02)+'</div>'):'';
  return '<div class="bucket"><div class="bucket-head"><span class="bucket-name">BUCKET '+b.id+'</span><span class="bucket-state '+b.state+'">'+b.state+'</span></div><div class="metrics"><div class="box"><div class="label">Capital</div><div class="value">'+cash(b.bankroll)+'</div></div><div class="box"><div class="label">Round Trips</div><div class="value">'+b.roundTrips+'</div></div></div><div class="box" style="margin-top:6px"><div class="label">Order</div>'+order+(held||'<div class="dim">FLAT · next BUY @ '+(anchor0==null?'—':price(anchor0-0.02-b.depth))+'</div>')+'</div></div>';
 }).join('');
}
let anchor0=null;
function renderTrades(rows){
 $('tradeCount').textContent=rows.length;
 const sig='tr:'+rows.map(t=>t.timestamp+t.action+t.bucket+t.price).join('|');
 if(caches[sig])return;caches[sig]=1;
 $('trades').innerHTML=!rows.length?'<div class="empty">WAITING FOR TRADE</div>':rows.map(t=>'<article class="trade-item"><div><span class="'+(t.action==='BUY'?'buy':'sell')+'">'+t.action+' B'+t.bucket+' '+shares(t.shares)+' SH</span><div class="dim">@'+price(t.price)+(t.reason?' · '+t.reason:'')+'</div></div><div class="'+cls(t.pnl||t.cost||0)+'">'+(t.action==='BUY'?cash(t.cost):cash(t.pnl))+ '</div></article>').join('');
}
function renderLogs(input){
 const sig='lg:'+(input||[]).length;if(caches[sig])return;caches[sig]=1;
 const box=$('logs');if(!box)return;
 box.innerHTML=(input||[]).slice(-240).map(line=>'<div class="'+(line.includes('BUY')?'log-buy':line.includes('SELL')?'log-sell':line.includes('FAIL')?'log-sell':'')+'">'+line+'</div>').join('');
 box.scrollTop=box.scrollHeight;
}
async function refresh(){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),850);
 try{
  const response=await fetch('/api/status',{cache:'no-store',signal:controller.signal});
  const d=await response.json();
  anchor0=d.anchor;
  $('uiLink').textContent='UI LIVE';$('uiLink').className='pill live';
  $('connLink').textContent=d.connected?'CLOB LIVE':'CLOB WAIT';$('connLink').className='pill '+(d.connected?'live':'warn');
  $('mktLink').textContent=d.marketReady?'MARKET LIVE':'MARKET WAIT';$('mktLink').className='pill '+(d.marketReady?'live':'warn');
  $('strategy').textContent=d.strategy||'';
  const tt=d.market?d.market.title:'—';
  $('markettitle').textContent=(tt?tt.toUpperCase():'—')+' · '+((d.market&&d.market.outcome)||'—');
  $('livePrice').textContent=price(d.token?d.token.mid:null);
  $('quote').innerHTML='BID <b>'+price(d.token?d.token.bid:null)+'</b> / ASK <b>'+price(d.token?d.token.ask:null)+'</b> · SPREAD '+(d.token&&d.token.spread!=null?d.token.spread.toFixed(3):'—');
  $('equity').textContent=cash(d.markValue);
  $('totPnl').innerHTML='TOTAL PnL '+cash(d.totalPnl)+' · DRAWDOWN '+cash(-(d.drawdown||0));
  $('realPnl').textContent=cash(d.realizedPnl);
  $('roundTrips').textContent=d.roundTrips+' ROUND TRIPS';
  drawChart(d.equityCurve,d.totalPnl);
  renderBuckets(d.buckets||[]);
  renderTrades(d.trades||[]);
  renderLogs(d.logs||[]);
 }catch(error){$('uiLink').textContent='UI RETRY';$('uiLink').className='pill warn';$('connLink').textContent='CLOB RETRY';$('connLink').className='pill warn';}
 finally{clearTimeout(timer);setTimeout(refresh,150)}
}
refresh();
</script></body></html>`;

app.get('/', (_, res) => res.type('html').send(dashboard));

app.listen(port, '0.0.0.0', () => {
  console.log(`Sports Bucket Bot listening on :${port}`);
  engine.init();
});
