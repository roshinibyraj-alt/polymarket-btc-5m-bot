'use strict';

const express = require('express');
const { BtcBreakoutEngine } = require('./engine');

const app = express();
const engine = new BtcBreakoutEngine({
  onLog: line => console.log(line),
});
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.get('/healthz', (_, request) => request.json({ ok: true }));
app.get('/api/status', (_, request) => request.json(engine.buildState()));

const dashboard = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BTC 5-Minute Breakout</title>
<style>
*{box-sizing:border-box}
:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400}
html,body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}
.wrap{max-width:1180px;margin:auto}
.topbar,.grid{display:grid;gap:8px}
.topbar{grid-template-columns:1fr auto;align-items:center;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:38px;height:38px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:22px}
h1{font-size:19px;margin:0;line-height:1.1;text-transform:uppercase}
.sub{font-size:10px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap}
.live{color:var(--up);border-color:#084b31}.warn{color:var(--amber);border-color:#5a4300}.bad{color:var(--down);border-color:#5c1622}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.box,.panel{background:var(--panel);border:1px solid var(--line);padding:9px}
.label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.value{font-size:18px;margin-top:2px}.value.positive{color:var(--up)}.value.negative{color:var(--down)}
.main{display:grid;grid-template-columns:minmax(280px,1fr) minmax(260px,.75fr);gap:8px;margin-top:8px}
.clock{font-size:42px;line-height:1}.clock small{font-size:12px;color:var(--muted)}
.prices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.side{border:1px solid var(--line);padding:9px;background:#000}
.side-name{font-size:12px}.side-price{font-size:34px;line-height:1;margin:3px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:13px}.quote-row span:last-child{color:#ddd}
.position-name{font-size:20px}.pnl{font-size:32px;margin:2px 0}.small-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:8px}
.mini .value{font-size:14px}.wide{margin-top:8px}.empty{color:var(--muted);padding:10px;border:1px dashed #333;text-align:center}
.chart{width:100%;height:110px;display:block}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#fff;text-transform:uppercase}
.list{max-height:220px;overflow:auto;margin-top:6px}
.result,.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:7px 0;font-size:12px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:10px;font-weight:700}
#logsPanel{height:180px;overflow:auto;font-family:"Courier New",monospace;font-size:10px;line-height:1.45;color:#e4e4e4;margin-top:6px;white-space:pre-wrap}
.log-buy{color:var(--up)}.log-loss{color:var(--down)}
@media(max-width:720px){
 body{padding:6px;font-size:13px}
 h1{font-size:16px}.topbar{grid-template-columns:1fr}.status{justify-content:flex-start}
 .metrics{grid-template-columns:repeat(2,1fr)}.main{grid-template-columns:1fr}
 .side-price{font-size:30px}.pnl{font-size:27px}.clock{font-size:35px}
 .list,#logsPanel{max-height:170px}
}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
 <div class="brand"><div class="btc">₿</div><div><h1>BTC 5-Minute Breakout</h1><div class="sub">ENTRY @0.60 · WAIT 60s · FLIP UNLIMITED · TARGET $50 · FINAL-2S WINNER &gt;0.90</div></div></div>
 <div class="status"><span id="uiLink" class="pill warn">UI LINK</span><span id="clobLink" class="pill warn">CLOB WAIT</span><span id="marketLink" class="pill warn">MARKET WAIT</span><span id="rate" class="pill">0/S</span></div>
</header>
<section class="metrics">
 <div class="box"><div class="label">Equity / Total PNL</div><div id="equity" class="value">—</div><div id="totalPnl" class="dim">—</div></div>
 <div class="box"><div class="label">Realized / Floating</div><div id="realized" class="value">—</div><div id="floating" class="dim">—</div></div>
 <div class="box"><div class="label">Win / Loss / Rate</div><div id="record" class="value">—</div><div id="streak" class="dim">—</div></div>
 <div class="box"><div class="label">Flips / Sunk</div><div id="flipCount" class="value">—</div><div id="sunkCost" class="dim">—</div></div>
 <div class="box" style="border-color:#084b31"><div class="label" style="color:var(--up)">▲ ACCUMULATED UP</div><div id="accumUp" class="value" style="color:var(--up)">0 SH</div><div id="accumUpCost" class="dim">—</div></div>
 <div class="box" style="border-color:#5c1622"><div class="label" style="color:var(--down)">▼ ACCUMULATED DOWN</div><div id="accumDown" class="value" style="color:var(--down)">0 SH</div><div id="accumDownCost" class="dim">—</div></div>
</section>
<main class="main">
 <section class="panel">
  <div class="section-head"><span id="slug">WAITING FOR BTC WINDOW</span><span id="source">GAMMA DISCOVERY + CLOB BOOKS</span></div>
  <div id="clock" class="clock">--:--<small>T+0S</small></div>
  <div class="prices"><div class="side up"><div class="side-name">UP</div><div id="upPrice" class="side-price">—</div><div id="upQuote" class="quote-row"></div><div id="upFinal" class="dim"></div></div><div class="side down"><div class="side-name">DOWN</div><div id="downPrice" class="side-price">—</div><div id="downQuote" class="quote-row"></div><div id="downFinal" class="dim"></div></div></div>
 </section>
 <aside class="panel">
  <div class="section-head"><span>Live Position</span><span id="positionStatus">FLAT</span></div>
  <div id="positionPanel"><div class="empty">NO OPEN POSITION</div></div>
  <div class="box wide"><div class="label">Global equity curve</div><svg id="chart" class="chart" preserveAspectRatio="none" viewBox="0 0 500 100"></svg></div>
 </aside>
</main>
<section class="grid metrics wide"><div class="panel"><div class="section-head"><span>Window Results</span><span id="resultCount">0</span></div><div id="results" class="list"><div class="empty">NO COMPLETED WINDOWS</div></div></div><div class="panel"><div class="section-head"><span>Execution Feed</span><span id="tradeCount">0</span></div><div id="trades" class="list"><div class="empty">WAITING FOR TRADE</div></div></div></section>
<section class="panel wide"><div class="section-head"><span>Server Log</span><span>LIVE</span></div><div id="logsPanel"></div></section>
</div>
<script>
const $=id=>document.getElementById(id),caches={};let rateSample=null;
const cls=v=>v==null?'':v>0?'positive':v<0?'negative':'';
const cash=v=>v==null?'—':'$'+Number(v).toFixed(2);
const shares=v=>v==null?'—':Number(v).toLocaleString();
const price=v=>v==null?'—':Number(v).toFixed(3);
function quote(token){return token?'BID '+price(token.bid)+' ASK '+price(token.ask)+' MID '+price(token.mid):''}
function render(s){
 $('uiLink').textContent='UI LIVE';$('uiLink').className='pill live';
 $('clobLink').textContent=s.connected?'CLOB LIVE':'CLOB STALE';$('clobLink').className='pill '+(s.connected?'live':'warn');
 $('marketLink').textContent=s.marketReady?'BTC READY':'DISCOVERY';$('marketLink').className='pill '+(s.marketReady?'live':'warn');
 const nowMs=Date.now();if(!rateSample||nowMs-rateSample.at>=1000){const rate=rateSample?Math.max(0,(s.pollCount-rateSample.count)/((nowMs-rateSample.at)/1000)):0;$('rate').textContent=rate.toFixed(1)+'/S';rateSample={at:nowMs,count:s.pollCount}}
 const pnlClass=cls(s.totalPnl),floatClass=cls(s.unrealizedPnl);
 $('equity').textContent=cash(s.markValue);$('equity').className='value '+pnlClass;
 $('totalPnl').textContent=(s.totalPnl>=0?'+':'')+cash(s.totalPnl)+' TOTAL';
 $('realized').textContent=cash(s.realizedPnl);$('realized').className='value '+cls(s.realizedPnl);
 $('floating').textContent=(s.unrealizedPnl>=0?'+':'')+cash(s.unrealizedPnl)+' FLOATING';
 $('record').textContent=s.wins+'W / '+s.losses+'L';$('streak').textContent=(s.winRate==null?'—':s.winRate+'%')+' WIN RATE';
 $('flipCount').textContent=s.windowFlipCount+' FLIPS';$('flipCount').className='value';
 $('sunkCost').textContent='SUNK '+cash(s.windowSunkCost)+' · '+(s.monitoringActive?'MONITORING':'WAITING');
 $('accumUp').textContent=s.accumUpShares+' SH';$('accumUp').className='value';
 $('accumDown').textContent=s.accumDownShares+' SH';$('accumDown').className='value';
 const m=s.market;if(m){
  $('slug').textContent=m.slug.toUpperCase();$('source').textContent=m.settled?('WINNER '+(m.winner||'UNKNOWN')):'CLOB TOP OF BOOK';
  $('clock').innerHTML=String(Math.floor(m.remaining/60)).padStart(2,'0')+':'+String(m.remaining%60).padStart(2,'0')+'<small>T+'+m.elapsed+'S</small>';
  $('upPrice').textContent=price(m.up.mid);$('downPrice').textContent=price(m.down.mid);
  $('upQuote').innerHTML='<span>'+price(m.up.bid)+' / '+price(m.up.ask)+'</span><span>'+(m.up.spread==null?'NO BOOK':m.up.spread.toFixed(3))+'</span>';
  $('downQuote').innerHTML='<span>'+price(m.down.bid)+' / '+price(m.down.ask)+'</span><span>'+(m.down.spread==null?'NO BOOK':m.down.spread.toFixed(3))+'</span>';
  $('upFinal').textContent=m.finalUpMax==null?'':'FINAL MAX '+price(m.finalUpMax);
  $('downFinal').textContent=m.finalDownMax==null?'':'FINAL MAX '+price(m.finalDownMax);
 }
 const p=s.position;$('positionStatus').textContent=p?p.outcome+' · '+shares(p.shares)+' SH':'FLAT';
 if(!p){$('positionPanel').innerHTML='<div class="empty">NO OPEN POSITION</div>'}else{
  $('positionPanel').innerHTML='<div class="position-name">'+p.outcome+' · '+shares(p.shares)+' SH</div><div class="pnl '+cls(p.pnl)+'">'+(p.pnl>=0?'+':'')+cash(p.pnl)+'</div><div class="dim">ENTRY '+price(p.entryPrice)+' · COST '+cash(p.cost)+' · MARK '+price(p.tokenMid??p.signal?.mid)+'</div><div class="dim">T+'+(p.signal?.elapsed||0)+'S · '+p.signal?.triggerSource+' TRIGGER '+price(p.signal?.triggerPrice)+'</div>';
 }
 drawChart(s.equityCurve,s.totalPnl);renderResults(s.results);renderTrades(s.trades);renderLogs(s.logs);
}
function drawChart(curve,total){if(!curve||curve.length<2){if(caches.chart!=='empty'){caches.chart='empty';$('chart').innerHTML=''}return}const values=curve.map(point=>point.equity),low=Math.min(...values),high=Math.max(...values),range=(high-low)||1,color=total>=0?'#00ff85':'#ff4a68',points=curve.map((point,index)=>[(index/(curve.length-1))*500,95-(point.equity-low)/range*90]);const signature='chart:'+curve.length+':'+values.at(-1)+':'+total;if(caches.chart===signature)return;caches.chart=signature;$('chart').innerHTML='<path d="M'+points.map(point=>point[0].toFixed(1)+','+point[1].toFixed(1)).join(' L')+'" fill="none" stroke="'+color+'" stroke-width="3"/>'}
function renderResults(rows){$('resultCount').textContent=rows.length+' SETTLED';const signature=rows.map(row=>row.windowStart+':'+row.result+':'+row.realizedPnl).join('|');if(caches.results===signature)return;caches.results=signature;$('results').innerHTML=!rows.length?'<div class="empty">NO COMPLETED WINDOWS</div>':rows.map(row=>'<article class="result"><div><div>'+(row.result||'PENDING')+' · WINNER '+(row.winner||'—')+'</div><div class="dim">'+new Date(row.windowStart*1000).toLocaleTimeString()+' · '+row.resolutionSource+'</div></div><div class="'+cls(row.realizedPnl)+'">'+cash(row.realizedPnl)+'</div></article>').join('')}
function renderTrades(rows){$('tradeCount').textContent=rows.length;const signature='trades:'+rows.map(trade=>trade.timestamp+trade.action+trade.price).join('|');if(caches.trades===signature)return;caches.trades=signature;$('trades').innerHTML=!rows.length?'<div class="empty">WAITING FOR TRADE</div>':rows.slice(0,40).map(trade=>'<article class="trade-item"><div><span class="'+(trade.action==='BUY'?'buy':'sell')+'">'+trade.action+' '+trade.outcome+' '+shares(trade.shares)+' SH</span><div class="dim">@'+price(trade.price)+' · '+trade.reason+'</div></div><div class="'+cls(trade.pnl)+'">'+(trade.action==='BUY'?cash(trade.cost):(trade.pnl>=0?'+':'')+cash(trade.pnl))+'</div></article>').join('')}
function renderLogs(input){const signature=input.join('\u0000');if(caches.logs===signature)return;caches.logs=signature;const logs=input.slice(-240);$('logsPanel').innerHTML=logs.map(line=>'<div class="'+(line.includes('BUY')?'log-buy':line.includes('STOP')||line.includes('FAIL')?'log-loss':'')+'">'+line+'</div>').join('');$('logsPanel').scrollTop=$('logsPanel').scrollHeight}
async function refresh(){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),850);try{const response=await fetch('/api/status',{cache:'no-store',signal:controller.signal});render(await response.json())}catch(error){$('uiLink').textContent='UI RETRY';$('uiLink').className='pill warn'}finally{clearTimeout(timer);setTimeout(refresh,100)}}
refresh();
</script></body></html>`;

app.get('/', (_, request) => request.type('html').send(dashboard));

app.listen(port, '0.0.0.0', () => {
  console.log(`BTC breakout dashboard listening on :${port}`);
  engine.init();
});
