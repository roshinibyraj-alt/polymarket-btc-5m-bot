'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bot = require('./copy-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const PORT   = process.env.PORT || 8080;

app.use(express.json());
app.get('/healthz', (_, r) => r.sendStatus(200));
app.get('/api/status', (_, r) => { try { r.json(bot.getStatus()); } catch(e) { r.status(500).json({error:e.message}); } });
app.post('/api/pause',  (_, r) => { try { r.json(bot.pauseTrading()); }  catch(e) { r.status(500).json({error:e.message}); } });
app.post('/api/resume', (_, r) => { try { r.json(bot.resumeTrading()); } catch(e) { r.status(500).json({error:e.message}); } });

app.get('/', (_, res) => {
res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>🪞 Copy Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:12px;font-weight:bold;-webkit-text-size-adjust:100%}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #ffaa00;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:18px;color:#fff}.logo span{color:#00ccff}
.wallet{font-size:9px;color:#888;word-break:break-all}
.badge{padding:3px 10px;border-radius:20px;font-size:10px;font-weight:bold;background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}
.toolbar{display:flex;gap:6px;padding:10px 14px 0;flex-wrap:wrap}
.toolbar button{background:#00ccff;color:#001018;border:none;padding:8px 14px;border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit;font-size:11px}
.toolbar button.p{background:#ffcc00}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:10px 14px 0}
@media(max-width:600px){.sg{grid-template-columns:repeat(2,1fr)}}
.s{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 8px}
.sl{font-size:7.5px;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.sv{font-size:13px;font-weight:bold;color:#fff}
.pnl-pos{color:#00ff88!important}.pnl-neg{color:#ff4444!important}
.eq{margin:10px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.eq svg{width:100%;height:70px;background:#111;border-radius:6px}
.sec{margin:10px 14px 0}
.sh{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#888;margin-bottom:6px}
.card{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tb{border-collapse:collapse;min-width:500px;width:100%}
.tb th{background:#111;color:#888;padding:4px 5px;text-align:left;font-size:7.5px;text-transform:uppercase;position:sticky;top:0;white-space:nowrap}
.tb td{padding:3px 5px;border-bottom:1px solid #222;font-size:9px;white-space:nowrap}
.lp{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px;max-height:250px;overflow-y:auto;overflow-x:auto;font-size:9px;line-height:1.4;white-space:nowrap;-webkit-overflow-scrolling:touch}
.lp div{padding:1px 0}
.empty{padding:12px;text-align:center;color:#555;font-size:9px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
</style></head><body>
<div class="hd">
  <div><div class="logo">🪞 <span>COPY BOT</span></div><div class="wallet" id="wallet"></div></div>
  <div class="badge">DEMO</div>
</div>
<div class="toolbar">
  <button onclick="fetch('/api/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">⏸ Pause</button>
  <button class="p" onclick="fetch('/api/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">▶ Resume</button>
</div>
<div class="sg" id="stats"></div>
<div class="eq"><svg id="eq-chart" viewBox="0 0 600 70" preserveAspectRatio="none"></svg></div>
<div class="sec"><div class="sh">📊 Biggest &amp; Smallest Buys</div>
  <div class="g2">
    <div class="card"><div class="sh" style="margin-bottom:4px">🔥 Biggest Buys</div><div class="tw"><table class="tb"><thead><tr><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th><th>Slug</th></tr></thead><tbody id="big-body"></tbody></table></div></div>
    <div class="card"><div class="sh" style="margin-bottom:4px">🪙 Smallest Buys</div><div class="tw"><table class="tb"><thead><tr><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th><th>Slug</th></tr></thead><tbody id="small-body"></tbody></table></div></div>
  </div>
</div>
<div class="sec"><div class="sh">📋 Positions</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Side</th><th>Shares</th><th>Avg</th><th>Cost</th><th>Buys</th><th>Title</th></tr></thead><tbody id="pos-body"></tbody></table></div></div></div>
<div class="sec"><div class="sh">📈 Trades</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Action</th><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th><th>Master</th><th>Slug</th></tr></thead><tbody id="trade-body"></tbody></table></div></div></div>
<div class="sec"><div class="sh">📜 Logs</div><div class="lp" id="log-panel"></div></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io({transports:['websocket'],upgrade:false});
var S=null;
function $(id){return document.getElementById(id)}
function pClass(n){return n==null?'':n>0?'pnl-pos':n<0?'pnl-neg':''}
function sgn(n){if(n==null)return'—';return(n>0?'+$':(n<0?'-$':'±$'))+Math.abs(n).toFixed(2)}
function short(s){if(!s)return'';var m=s.match(/(\\d{10,})/);return m?'...'+m[1].slice(-6):s.length>18?s.slice(0,18)+'...':s}
function buildSvg(curve,W,H,start){
  if(!curve||curve.length<2)return'';
  var vals=curve.map(function(p){return p.equity});
  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals);
  if(start!=null){mn=Math.min(mn,start);mx=Math.max(mx,start)}
  var range=mx-mn||1,pad=4;
  var pts=vals.map(function(v,i){return pad+(i/(vals.length-1))*(W-pad*2)+','+(H-pad-((v-mn)/range)*(H-pad*2))}).join(' ');
  return'<polyline points="'+pts+'" fill="none" stroke="#00ccff" stroke-width="1.5"/>'+
    '<line x1="'+pad+'" y1="'+(H-pad-((start-mn)/range)*(H-pad*2))+'" x2="'+(W-pad)+'" y2="'+(H-pad-((start-mn)/range)*(H-pad*2))+'" stroke="#ffaa00" stroke-width="0.5" stroke-dasharray="4,3"/>'+
    '<circle cx="'+(W-pad)+'" cy="'+(H-pad-((vals[vals.length-1]-mn)/range)*(H-pad*2))+'" r="3" fill="#00ccff"/>';
}
function render(s){
  S=s;if(!s)return;
  $('wallet').textContent=s.watchWallet;
  $('stats').innerHTML=[
    sv('Bankroll','$'+s.bankroll.toFixed(2)),
    sv('Equity','$'+s.markValue.toFixed(2),pClass(s.totalPnl)),
    sv('P&L',sgn(s.totalPnl),pClass(s.totalPnl)),
    sv('Win Rate',s.winRate!=null?s.winRate+'%':'—'),
    sv('Wins',s.wins||0),
    sv('Losses',s.losses||0),
    sv('Realized',sgn(s.realizedPnl),pClass(s.realizedPnl)),
    sv('Uptime',fmt(s.uptime||0))
  ].join('');
  $('eq-chart').innerHTML=buildSvg(s.equityCurve,600,70,s.demoCapital);
  $('big-body').innerHTML=(s.biggestBuys||[]).map(function(t){
    return'<tr><td>'+t.side+'</td><td>'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td><td>'+short(t.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="5" class="empty">No buys yet</td></tr>';
  $('small-body').innerHTML=(s.smallestBuys||[]).map(function(t){
    return'<tr><td>'+t.side+'</td><td>'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td><td>'+short(t.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="5" class="empty">No buys yet</td></tr>';
  $('pos-body').innerHTML=(s.positions||[]).map(function(p){
    return'<tr><td>'+p.outcome+'</td><td>'+p.shares+'</td><td>'+p.avgPrice.toFixed(3)+'</td><td>$'+p.cost.toFixed(2)+'</td><td>'+p.buys+'</td><td>'+short(p.title||p.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="6" class="empty">No open positions</td></tr>';
  $('trade-body').innerHTML=(s.trades||[]).map(function(t){
    var cls=t.action==='BUY'?'pnl-pos':'pnl-neg';
    return'<tr><td>'+new Date(t.t*1000).toISOString().slice(11,19)+'</td><td class="'+cls+'">'+t.action+'</td><td>'+t.side+'</td><td>'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td><td>'+t.masterShares+'</td><td>'+short(t.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="8" class="empty">No trades yet</td></tr>';
}
function sv(label,val,cls){return'<div class="s"><div class="sl">'+label+'</div><div class="sv '+(cls||'')+'">'+val+'</div></div>'}
function fmt(s){var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h+'h '+m+'m'}
var logBuf=[];
socket.on('state',function(s){render(s)});
socket.on('trade',function(){
  if(S){render(S)}
});
socket.on('log',function(line){
  logBuf.push(line);
  if(logBuf.length>300)logBuf.shift();
  var el=$('log-panel');
  var atBot=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=logBuf.map(function(l){
    var c=l.indexOf('WIN')>=0||l.indexOf('COPY BUY')>=0?'#00ff88'
      :l.indexOf('LOSS')>=0||l.indexOf('⚠')>=0?'#ff4444'
      :l.indexOf('🏁')>=0?'#ffcc00':'#cccccc';
    return'<div style="color:'+c+'">'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  if(atBot)el.scrollTop=el.scrollHeight;
});
setInterval(function(){fetch('/api/status').then(function(r){return r.json()}).then(render).catch(function(){})},10000);
</script></body></html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

console.log('🪞 Copy Bot — DEMO MODE');
server.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard: http://0.0.0.0:' + PORT);
  bot.init(emit, slog).catch(e => { console.error('Init failed:', e.message); process.exit(1); });
});
