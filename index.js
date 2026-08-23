'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bot = require('./copy-bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.get('/healthz', (_, response) => response.sendStatus(200));
app.get('/api/status', (_, response) => {
  try { response.json(bot.getStatus()); }
  catch (error) { response.status(500).json({ error: error.message }); }
});

const dashboard = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Polymarket Copy Trading</title>
<style>
:root{--bg:#04060a;--panel:#0a0f18;--panel2:#070b11;--line:#1d2836;--text:#fff;--dim:#7c8b9e;--blue:#22d3ee;--green:#16ff9d;--red:#ff4a68;--gold:#ffd166;--purple:#a78bfa}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:700;line-height:1.3;padding-bottom:24px}
.shell{width:min(1500px,100%);margin:auto;padding:14px}
.topbar,.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.topbar{padding:12px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(135deg,#071120,#04060a)}
.brand{display:flex;align-items:center;gap:10px}.brand-icon{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:#0e1a29;color:var(--blue);border:1px solid #20364b}
h1{font-size:19px;letter-spacing:.3px}.sub{font-size:10px;color:var(--dim);word-break:break-all;margin-top:2px}
.status{display:flex;gap:6px;flex-wrap:wrap}.pill{padding:5px 9px;border-radius:999px;font-size:9px;text-transform:uppercase;background:#111a25;border:1px solid var(--line)}.live{color:var(--green);border-color:#12483a;background:#051b17}
.kpis{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin-top:10px}
.metric,.record,.window-card,.position,.result-row{min-width:0}
.metric{padding:10px;border-radius:13px;background:var(--panel);border:1px solid var(--line)}.label{font-size:8px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px}.value{font-size:17px;margin-top:3px;overflow-wrap:anywhere}.small{font-size:9px;color:var(--dim);margin-top:2px}
.layout-main{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:10px;margin-top:10px}
.panel{padding:11px;border:1px solid var(--line);border-radius:15px;background:var(--panel)}
.panel-title{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}.panel-title strong{color:#fff;font-size:13px;text-transform:none}
.chart-box{height:180px;margin-top:8px}.chart-box svg{width:100%;height:100%;overflow:visible}
.records-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}
.records-window{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.record{padding:10px;border-radius:12px;background:var(--panel2);border:1px solid var(--line)}.record-value{font-size:19px;margin-top:2px}.record-meta{font-size:8px;color:var(--dim);margin-top:3px;word-break:break-all}
.windows-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
.window-card{padding:10px;border-radius:12px;background:var(--panel2);border:1px solid var(--line)}.win-top{display:flex;justify-content:space-between;gap:6px;align-items:flex-start}.slug{font-size:10px;overflow-wrap:anywhere}.timer{text-align:right;font-size:16px;color:var(--blue)}.timer span{display:block;font-size:8px;color:var(--dim)}
.side-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.side{padding:8px;border-radius:10px;background:#08111b;border:1px solid #182534;text-align:center}.side-name{font-size:8px;letter-spacing:.8px;text-transform:uppercase}.up-name{color:var(--blue)}.down-name{color:var(--purple)}.side-shares{font-size:23px;margin-top:2px}.side-cost{font-size:9px;color:var(--dim)}
.total-line{display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-top:8px;padding-top:7px;border-top:1px solid var(--line)}
.positions,.results,.feed,.logs{margin-top:8px;display:grid;gap:6px}
.position{padding:9px;border-radius:11px;background:var(--panel2);border:1px solid var(--line)}.pos-top{display:flex;justify-content:space-between;gap:8px}.asset{font-size:10px;color:var(--gold)}.outcome{font-size:15px}.pos-shares{font-size:21px;color:var(--blue)}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-top:7px}.cell{padding:5px;border-radius:7px;background:#070d14;border:1px solid #16202c;text-align:center}.cell b{display:block;font-size:11px;margin-top:2px}
.result-row,.feed-item{padding:8px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px;align-items:center}.time{font-size:9px;color:var(--dim)}.name{font-size:10px;overflow-wrap:anywhere}.money{text-align:right;font-size:13px}.detail{grid-column:1/-1;font-size:9px;color:var(--dim)}
.feed-item{grid-template-columns:52px auto auto minmax(58px,1fr) auto}.side-tag{padding:3px 6px;border-radius:6px;font-size:8px}.buy-up{color:var(--blue);background:#12293a}.buy-down{color:var(--purple);background:#241d3d}.shares{font-size:14px}.price{font-size:10px;color:var(--dim);text-align:right}
.logs{max-height:220px;overflow:auto;background:#020508;border:1px solid #14202d;border-radius:11px;padding:8px;font-family:"SFMono-Regular",Consolas,monospace;font-size:9px;font-weight:500;-webkit-overflow-scrolling:touch}.log-line{white-space:pre-wrap;word-break:break-word;color:#9babbc;padding:1px 0}.log-win{color:var(--green)!important}.log-loss{color:var(--red)!important}.log-info{color:var(--blue)!important}
.empty{padding:14px;text-align:center;color:#455567;font-size:11px}
.green{color:var(--green)!important}.red{color:var(--red)!important}.gold{color:var(--gold)!important}
@media(max-width:1050px){.kpis{grid-template-columns:repeat(4,minmax(0,1fr))}.layout-main,.windows-grid{grid-template-columns:1fr}.records-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.records-window{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){body{padding-bottom:90px}.feed-item{display:flex;flex-wrap:wrap;align-items:center}.feed-item .time{width:100%;margin-bottom:3px}.feed-item .side-tag{margin-right:6px}.feed-item .shares{margin-left:auto}.feed-item .price{width:100%;text-align:left;margin-top:2px}.shell{padding:9px}.topbar{padding:10px}h1{font-size:16px}.brand-icon{width:31px;height:31px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.value{font-size:16px}.chart-box{height:145px}.record-value{font-size:18px}.side-shares{font-size:22px}.pos-shares{font-size:20px}.metrics{grid-template-columns:repeat(3,1fr)}}
</style>
</head>
<body><div class="shell">
<header class="topbar"><div class="brand"><div class="brand-icon">◎</div><div><h1>Copy Trading Control Room</h1><div class="sub" id="wallet">Connecting…</div></div></div><div class="status"><span class="pill" id="connection">CONNECTING</span><span class="pill live" id="mode">DEMO COPY · 100%</span><span class="pill" id="uptime">00:00</span></div></header>
<section class="kpis" id="kpis"></section>
<section class="layout-main">
<div class="panel"><div class="panel-title"><span>Global equity curve</span><strong id="equityValue">—</strong></div><div class="chart-box"><svg id="equityChart" preserveAspectRatio="none"></svg></div></div>
<div class="panel"><div class="panel-title"><span>Single-buy records</span></div><div class="records-grid" style="margin-top:8px"><div class="record"><div class="label">🔥 Largest Buy</div><div class="record-value gold" id="largestBuy">—</div><div class="record-meta" id="largestBuyMeta">Waiting for fills</div></div><div class="record"><div class="label">🧊 Smallest Buy</div><div class="record-value" id="smallestBuy">—</div><div class="record-meta" id="smallestBuyMeta">Waiting for fills</div></div><div class="record"><div class="label">Master Exposure</div><div class="record-value" id="masterExposure">—</div><div class="record-meta" id="masterMeta">Live wallet positions</div></div></div></div>
</section>
<section class="panel" style="margin-top:10px"><div class="panel-title"><span>Highest / lowest capital deployed per window</span><strong>PERSISTENT RECORDS</strong></div><div class="records-window" style="margin-top:8px" id="capitalRecords"></div></section>
<section class="panel" style="margin-top:10px"><div class="panel-title"><span>Active windows</span><strong id="activeCount">0 OPEN</strong></div><div class="windows-grid" id="windowsGrid"></div></section>
<section class="layout-main">
<div class="panel"><div class="panel-title"><span>Open positions & floating P&L</span><strong id="positionCount">0</strong></div><div class="positions" id="positionsGrid"></div></div>
<div class="panel"><div class="panel-title"><span>Resolved windows</span><strong>RECENT</strong></div><div class="results" id="resultsGrid"></div></div>
</section>
<section class="panel" style="margin-top:10px"><div class="panel-title"><span>Real-time copy feed</span><strong id="tradeCount">0 FILLS</strong></div><div class="feed" id="feedGrid"></div></section>
<section class="panel" style="margin-top:10px"><div class="panel-title"><span>Server activity</span></div><div class="logs" id="logPanel"></div></section>
</div>
<script src="/socket.io/socket.io.js"></script><script>
let state=null,logs=[],connected=false;
const $=id=>document.getElementById(id);
const socket=io({transports:['websocket','polling']});
socket.on('connect',()=>{connected=true;$('connection').textContent='LIVE SOCKET';$('connection').className='pill live'});
socket.on('disconnect',()=>{connected=false;$('connection').textContent='RECONNECTING';$('connection').className='pill'});
socket.on('state',render);
socket.on('log',line=>{logs.push(line);if(logs.length>250)logs.shift();renderLogs()});
setInterval(()=>{if(!connected)fetch('/api/status').then(r=>r.json()).then(render).catch(()=>{})},2000);
function money(value){if(value==null||!isFinite(value))return '—';const n=Number(value),sign=n>0?'+':n<0?'-':'$';return sign+'$'+Math.abs(n).toFixed(2)}
function amount(value){return '$'+Number(value||0).toFixed(2)}
function number(value){return Number(value||0).toLocaleString(undefined,{maximumFractionDigits:2})}
function shortText(text){text=String(text||'—');const match=text.match(/(\d{8,})/);return match?'…'+match[0].slice(-6):(text.length>26?text.slice(0,24)+'…':text)}
function toneClass(value){return Number(value)>0?'green':Number(value)<0?'red':''}
function assetName(item){const text=((item.slug||'')+' '+(item.title||'')).toLowerCase();if(text.includes('btc')||text.includes('bitcoin'))return'BTC';if(text.includes('eth')||text.includes('ethereum'))return'ETH';if(text.includes('sol'))return'SOL';if(text.includes('xrp'))return'XRP';if(text.includes('bnb'))return'BNB';if(text.includes('doge'))return'DOGE';return'MARKET'}
function clock(seconds){seconds=Math.max(0,Math.floor(seconds));return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')}
function uptime(sec){return clock(sec)}
function windowTiming(slug,type){const match=String(slug||'').match(/(\d{10})\D*$/),duration=type==='5m'?300:type==='15m'?900:type==='1h'?3600:0;if(!duration)return null;const start=match?Number(match[1])*1000:null;if(!start)return null;const elapsed=Math.floor((Date.now()-start)/1000),remaining=Math.max(0,duration-elapsed);return{start,elapsed,remaining,duration}}
function render(data){
 state=data;if(!logs.length&&data.logs)logs=data.logs.slice();
 $('wallet').textContent='Master · '+data.watchWallet;
 $('mode').textContent='DEMO COPY · '+data.config.copyPct+' · '+amount(data.demoCapital);
 $('uptime').textContent=uptime(data.uptime||0);
 const openPnl=(data.positions||[]).reduce((sum,p)=>sum+p.shares*((p.curPrice||p.avgPrice)-p.avgPrice),0);
 const kpis=[['Equity',amount(data.markValue),'','Current marked value'],['Total P&L',money(data.totalPnl),toneClass(data.totalPnl),'Since launch'],['Realized P&L',money(data.realizedPnl),toneClass(data.realizedPnl),'Settled result'],['Open P&L',money(openPnl),toneClass(openPnl),'Unrealized marks'],['Bankroll',amount(data.bankroll),'','Cash available'],['Win Rate',(data.winRate==null?'—':data.winRate+'%'),'',(data.wins||0)+'W / '+(data.losses||0)+'L'],['Deployed',amount((data.positions||[]).reduce((sum,p)=>sum+p.cost,0)),'','Open cost basis']];
 $('kpis').innerHTML=kpis.map(k=>'<article class="metric"><div class="label">'+k[0]+'</div><div class="value '+k[2]+'">'+k[1]+'</div><div class="small">'+k[3]+'</div></article>').join('');
 $('equityValue').textContent=amount(data.markValue);renderChart(data.equityCurve||[],data.demoCapital);
 $('largestBuy').textContent=data.biggestBuy?number(data.biggestBuy.shares)+' sh':'—';
 $('largestBuyMeta').textContent=data.biggestBuy?amount(data.biggestBuy.cost)+' · '+assetName(data.biggestBuy)+' · '+shortText(data.biggestBuy.slug):'Waiting for fills';
 $('smallestBuy').textContent=data.smallestBuy?number(data.smallestBuy.shares)+' sh':'—';
 $('smallestBuyMeta').textContent=data.smallestBuy?amount(data.smallestBuy.cost)+' · '+assetName(data.smallestBuy)+' · '+shortText(data.smallestBuy.slug):'Waiting for fills';
 renderMaster(data.masterTrades||[]);renderRecords(data.windowCapitalStats||{});renderWindows([...(data.windows5m||[]),...(data.windows15m||[])]);renderPositions(data.positions||[]);renderResults(data.resolvedWindows||[]);renderFeed(data.trades||[]);renderLogs();
}
function renderChart(curve,baseline){const svg=$('equityChart');if(!curve.length){svg.innerHTML='';return}
 const values=[...curve.map(point=>point.equity),baseline],low=Math.min(...values),high=Math.max(...values),range=(high-low)||1,width=700,height=170,pad=12;
 const points=curve.map((point,index)=>[index/Math.max(1,curve.length-1)*width,height-pad-(point.equity-low)/range*(height-pad*2)]);
 const path='M'+points.map(point=>point[0].toFixed(1)+','+point[1].toFixed(1)).join(' L');
 const baselineY=height-pad-(baseline-low)/range*(height-pad*2),last=points[points.length-1]||[0,baselineY],color=state.totalPnl>=0?'#16ff9d':'#ff4a68';
 svg.innerHTML='<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="'+color+'" stop-opacity=".35"/><stop offset="1" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs><line x1="0" x2="'+width+'" y1="'+baselineY+'" y2="'+baselineY+'" stroke="#334155" stroke-dasharray="4 4"/><path d="'+path+' L'+last[0]+','+(height-pad)+' L0,'+(height-pad)+' Z" fill="url(#fill)" stroke="none"/><path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5" stroke-linejoin="round"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>';
}
function renderRecords(records){const rows=[];['5m','15m'].forEach(type=>{const bucket=records[type]||{},highest=bucket.highest,lowest=bucket.lowest;rows.push(['🚀 '+type.toUpperCase()+' HIGH',highest?amount(highest.totalCost):'—',highest?number(highest.upShares)+'↑ / '+number(highest.downShares)+'↓ · '+shortText(highest.slug):'No deployment yet']);rows.push(['🌙 '+type.toUpperCase()+' LOW',lowest?amount(lowest.totalCost):'—',lowest?number(lowest.upShares)+'↑ / '+number(lowest.downShares)+'↓ · '+shortText(lowest.slug):'No deployment yet'])});$('capitalRecords').innerHTML=rows.map(row=>'<article class="record"><div class="label">'+row[0]+'</div><div class="record-value">'+row[1]+'</div><div class="record-meta">'+row[2]+'</div></article>').join('')}
function renderWindows(windows){$('activeCount').textContent=windows.length+' OPEN';if(!windows.length){$('windowsGrid').innerHTML='<div class="empty" style="grid-column:1/-1">No active copied windows</div>';return}
 $('windowsGrid').innerHTML=windows.map(window=>{const timing=windowTiming(window.slug,window.type);return '<article class="window-card"><div class="win-top"><div><div class="label">'+(window.type||'?').toUpperCase()+' WINDOW</div><div class="slug">'+shortText(window.slug)+'</div></div><div class="timer">'+clock(timing?timing.remaining:0)+'<span>'+(timing?('T+'+timing.elapsed+'s'):'NO TIMING')+'</span></div></div><div class="side-grid"><div class="side"><div class="side-name up-name">UP SHARES</div><div class="side-shares">'+number(window.upShares)+'</div><div class="side-cost">'+amount(window.upCost)+' · '+window.upBuys+' buys</div></div><div class="side"><div class="side-name down-name">DOWN SHARES</div><div class="side-shares">'+number(window.downShares)+'</div><div class="side-cost">'+amount(window.downCost)+' · '+window.downBuys+' buys</div></div><div class="side"><div class="side-name">TOTAL COST</div><div class="side-shares">'+amount(window.totalCost)+'</div><div class="side-cost">master '+number(window.totalMasterShares)+' sh</div></div></div><div class="total-line"><span>'+assetName(window)+' · '+window.totalBuys+' fills</span><span>First T+'+(window.fireOffset==null?'—':window.fireOffset)+'s</span></div></article>'}).join('')}
function renderPositions(positions){$('positionCount').textContent=positions.length+' OPEN';if(!positions.length){$('positionsGrid').innerHTML='<div class="empty">No open copied positions</div>';return}
 $('positionsGrid').innerHTML=positions.map(p=>{const current=p.curPrice||p.avgPrice,value=p.shares*current,unrealized=value-p.cost;return '<article class="position"><div class="pos-top"><div><div class="asset">'+assetName(p)+' · '+shortText(p.slug)+'</div><div class="outcome">'+p.outcome.toUpperCase()+' @ '+Number(p.avgPrice).toFixed(3)+'</div></div><div class="money '+toneClass(unrealized)+'">'+money(unrealized)+'<div class="small">now '+Number(current).toFixed(3)+'</div></div></div><div class="pos-shares">'+number(p.shares)+' SHARES</div><div class="metrics"><div class="cell">COST<b>'+amount(p.cost)+'</b></div><div class="cell">VALUE<b>'+amount(value)+'</b></div><div class="cell">BUYS<b>'+p.buys+'</b></div><div class="cell">MASTER<b>'+number(p.masterTotalShares)+'</b></div><div class="cell">MARK<b>'+Number(current).toFixed(3)+'</b></div></div></article>'}).join('')}
function renderResults(results){if(!results.length){$('resultsGrid').innerHTML='<div class="empty">No settled windows yet</div>';return}
 $('resultsGrid').innerHTML=results.map(result=>'<article class="result-row"><div class="time">'+new Date(result.settledAt||Date.now()).toLocaleTimeString()+'</div><div class="name">'+shortText(result.slug)+'<div class="small">'+assetName(result)+(result.winners&&result.winners.length?' · WINNER '+result.winners.join('/').toUpperCase():' · NO WINNER')+'</div></div><div class="money '+toneClass(result.pnl)+'">'+money(result.pnl)+'<div class="small">'+amount(result.payout)+' / '+amount(result.cost)+'</div></div></article>').join('')}
function renderFeed(trades){$('tradeCount').textContent=trades.length+' FILLS';if(!trades.length){$('feedGrid').innerHTML='<div class="empty">Monitoring master wallet…</div>';return}
 $('feedGrid').innerHTML=trades.slice(0,50).map(trade=>'<article class="feed-item"><span class="time">'+new Date((trade.timestamp||trade.t)*1000).toLocaleTimeString()+'</span><span class="side-tag '+(String(trade.side||trade.outcome).includes('up')?'buy-up':'buy-down')+'">'+String(trade.side||trade.outcome||'?').toUpperCase()+'</span><span>'+assetName(trade)+'</span><span class="shares green">'+number(trade.size||trade.shares)+' SH</span><span class="price">@ '+Number(trade.price).toFixed(3)+'<br>T+'+(trade.fireOffset==null?'—':trade.fireOffset)+'s</span></article>').join('')}
function renderMaster(master){const shares=master.reduce((sum,p)=>sum+Math.abs(p.size||0),0);$('masterExposure').textContent=number(shares)+' SH';$('masterMeta').textContent=master.length+' tracked markets'}
function renderLogs(){const panel=$('logPanel'),nearBottom=panel.scrollHeight-panel.scrollTop-panel.clientHeight<50;panel.innerHTML=logs.slice(-180).map(line=>{let cls='';if(line.includes('WIN')||line.includes('COPY BUY'))cls='log-win';else if(line.includes('LOSS')||line.includes('⚠️'))cls='log-loss';else if(line.includes('🚀')||line.includes('👀'))cls='log-info';return'<div class="log-line '+cls+'">'+escapeHtml(line)+'</div>'}).join('');if(nearBottom)panel.scrollTop=panel.scrollHeight}
function escapeHtml(value){return String(value||'').replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]))}
</script></body></html>`;

app.get('/', (_, request) => request.type('html').send(dashboard));

const emit = (event, data) => io.emit(event, data);
const serverLog = line => {
  console.log(line);
  io.emit('log', line);
};

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Copy trading dashboard listening on :${PORT}`);
  bot.init(emit, serverLog).catch(error => console.error(`Init failure: ${error.message}`));
});
