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
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:13px;font-weight:bold;-webkit-text-size-adjust:100%}

.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #ffaa00;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:20px;color:#fff;letter-spacing:1px}.logo span{color:#00ccff}
.wallet{font-size:10px;color:#888;word-break:break-all;margin-top:2px}
.badge{padding:4px 14px;border-radius:20px;font-size:11px;font-weight:bold;background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}

.hdr-boxes{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px 14px 0}
@media(max-width:500px){.hdr-boxes{grid-template-columns:1fr}}
.hdr-box{background:#0a0a0a;border:2px solid #333;border-radius:10px;padding:12px 14px}
.hdr-box.big{border-color:#00ff88}.hdr-box.small{border-color:#ff4444}
.hdr-box .bh{font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.hdr-box.big .bh{color:#00ff88}.hdr-box.small .bh{color:#ff4444}
.hdr-box .bv{font-size:22px;font-weight:bold;color:#fff;margin-bottom:4px}
.hdr-box .bm{font-size:10px;color:#888}

.toolbar{display:flex;gap:6px;padding:10px 14px 0;flex-wrap:wrap}
.toolbar button{background:#00ccff;color:#001018;border:none;padding:8px 14px;border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit;font-size:12px}
.toolbar button.p{background:#ffcc00}

.w-results{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:12px 14px 0}
@media(max-width:600px){.w-results{grid-template-columns:repeat(3,1fr)}}
.wr{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px}
.wrl{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.wrv{font-size:16px;font-weight:bold;color:#fff}

.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:12px 14px 0}
@media(max-width:600px){.sg{grid-template-columns:repeat(2,1fr)}}
.s{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 8px}
.sl{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.sv{font-size:14px;font-weight:bold;color:#fff}
.pnl-pos{color:#00ff88!important}.pnl-neg{color:#ff4444!important}

.eq{margin:10px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.eq svg{width:100%;height:70px;background:#111;border-radius:6px}

.sec{margin:10px 14px 0}
.sh{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:6px}
.card{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}

.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tb{border-collapse:collapse;min-width:400px;width:100%}
.tb th{background:#111;color:#888;padding:5px 6px;text-align:left;font-size:8px;text-transform:uppercase;position:sticky;top:0;white-space:nowrap}
.tb td{padding:4px 6px;border-bottom:1px solid #222;font-size:10px;white-space:nowrap;font-weight:bold}

.lp{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px;max-height:300px;overflow-y:auto;overflow-x:auto;font-size:10px;line-height:1.5;white-space:nowrap;-webkit-overflow-scrolling:touch}
.lp div{padding:1px 0;font-weight:bold}

.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
.empty{padding:12px;text-align:center;color:#555;font-size:9px;font-weight:bold}
</style></head><body>

<div class="hd">
  <div><div class="logo">🪞 <span>COPY BOT</span></div><div class="wallet" id="wallet"></div></div>
  <div class="badge">DEMO</div>
</div>

<div class="hdr-boxes">
  <div class="hdr-box big">
    <div class="bh">🔥 BIGGEST BUY EVER</div>
    <div class="bv" id="big-val">—</div>
    <div class="bm" id="big-detail"></div>
  </div>
  <div class="hdr-box small">
    <div class="bh">🪙 SMALLEST BUY EVER</div>
    <div class="bv" id="sm-val">—</div>
    <div class="bm" id="sm-detail"></div>
  </div>
</div>

<div class="toolbar">
  <button onclick="fetch('/api/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">⏸ Pause</button>
  <button class="p" onclick="fetch('/api/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">▶ Resume</button>
</div>

<div class="w-results" id="w-results"></div>
<div class="sg" id="stats"></div>
<div class="eq"><svg id="eq-chart" viewBox="0 0 600 70" preserveAspectRatio="none"></svg></div>

<div class="sec"><div class="sh">📊 Biggest &amp; Smallest Buys</div>
  <div class="g2">
    <div class="card"><div class="sh" style="margin-bottom:4px;color:#00ff88">🔥 TOP 10 BIGGEST</div><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th></tr></thead><tbody id="big-body"></tbody></table></div></div>
    <div class="card"><div class="sh" style="margin-bottom:4px;color:#ff4444">🪙 TOP 10 SMALLEST</div><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th></tr></thead><tbody id="sm-body"></tbody></table></div></div>
  </div>
</div>

<div class="sec"><div class="sh">📋 Open Positions</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Side</th><th>Shares</th><th>Avg</th><th>Cost</th><th>Buys</th><th>Title</th></tr></thead><tbody id="pos-body"></tbody></table></div></div></div>

<div class="sec"><div class="sh">📋 Window Results</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Side</th><th>Shares</th><th>Cost</th><th>Payout</th><th>P&L</th><th>Result</th></tr></thead><tbody id="res-body"></tbody></table></div></div></div>

<div class="sec"><div class="sh">⚡ Live Trades</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Action</th><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th><th>Master</th></tr></thead><tbody id="trade-body"></tbody></table></div></div></div>

<div class="sec"><div class="sh">📜 Logs</div><div class="lp" id="log-panel"></div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io({transports:['websocket'],upgrade:false});
var S=null;
function $(id){return document.getElementById(id)}
function pC(n){return n==null?'':n>0?'pnl-pos':n<0?'pnl-neg':''}
function sg(n){if(n==null)return'—';return(n>0?'+$':(n<0?'-$':'±$'))+Math.abs(n).toFixed(2)}
function ts(epoch){return epoch?new Date(epoch*1000).toISOString().slice(11,19):'—'}
function short(s){if(!s)return'';var m=s.match(/(\\d{10,})/);return m?'...'+m[1].slice(-6):s.length>18?s.slice(0,18)+'...':s}
function fmtSec(s){var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h+'h '+m+'m'}
function bSvg(curve,W,H,start){
  if(!curve||curve.length<2)return'';
  var vals=curve.map(function(p){return p.equity});
  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals);
  if(start!=null){mn=Math.min(mn,start);mx=Math.max(mx,start)}
  var r=mx-mn||1,pd=4;
  var pts=vals.map(function(v,i){return pd+(i/(vals.length-1))*(W-pd*2)+','+(pd+((mx-v)/r)*(H-pd*2))}).join(' ');
  return'<polyline points="'+pts+'" fill="none" stroke="#00ccff" stroke-width="1.5"/>'+
    '<circle cx="'+(W-pd)+'" cy="'+(pd+((mx-vals[vals.length-1])/r)*(H-pd*2))+'" r="3" fill="#00ccff"/>';
}

function render(s){
  S=s;if(!s)return;
  $('wallet').textContent=s.watchWallet;

  // biggest/smallest header boxes
  if(s.biggestBuy){
    var b=s.biggestBuy;
    $('big-val').textContent=b.shares+'sh @'+b.price.toFixed(3);
    $('big-detail').textContent='$'+b.cost.toFixed(2)+' — '+b.side.toUpperCase()+' — '+ts(b.t);
  }
  if(s.smallestBuy){
    var sm=s.smallestBuy;
    $('sm-val').textContent=sm.shares+'sh @'+sm.price.toFixed(3);
    $('sm-detail').textContent='$'+sm.cost.toFixed(2)+' — '+sm.side.toUpperCase()+' — '+ts(sm.t);
  }

  // window results row
  $('w-results').innerHTML=[
    wr('Total Windows',s.totalWindows||0),
    wr('Total Cost','$'+(s.totalWindowsCost||0).toFixed(2)),
    wr('Won ('+((s.wins||0))+'x)','$'+(s.totalWonCost||0).toFixed(2),'pnl-pos'),
    wr('Lost ('+((s.losses||0))+'x)','$'+(s.totalLostCost||0).toFixed(2),'pnl-neg'),
    wr('Net P&L',sg(s.totalPnl),pC(s.totalPnl))
  ].join('');

  // stats
  $('stats').innerHTML=[
    sv('Bankroll','$'+s.bankroll.toFixed(2)),
    sv('Equity','$'+s.markValue.toFixed(2),pC(s.totalPnl)),
    sv('Realized P&L',sg(s.realizedPnl),pC(s.realizedPnl)),
    sv('Win Rate',s.winRate!=null?s.winRate+'%':'—'),
    sv('Uptime',fmtSec(s.uptime||0))
  ].join('');

  $('eq-chart').innerHTML=bSvg(s.equityCurve,600,70,s.demoCapital);

  // biggest buys table
  $('big-body').innerHTML=(s.biggestBuys||[]).map(function(t){
    return'<tr><td>'+ts(t.t)+'</td><td>'+t.side+'</td><td style="color:#00ff88">'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td></tr>';
  }).join('')||'<tr><td colspan="5" class="empty">No buys</td></tr>';

  // smallest buys table
  $('sm-body').innerHTML=(s.smallestBuys||[]).map(function(t){
    return'<tr><td>'+ts(t.t)+'</td><td>'+t.side+'</td><td style="color:#ff4444">'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td></tr>';
  }).join('')||'<tr><td colspan="5" class="empty">No buys</td></tr>';

  // positions
  $('pos-body').innerHTML=(s.positions||[]).map(function(p){
    return'<tr><td>'+ts(Math.floor(new Date(p.openedAt).getTime()/1000))+'</td><td>'+p.outcome+'</td><td>'+p.shares+'</td><td>'+p.avgPrice.toFixed(3)+'</td><td>$'+p.cost.toFixed(2)+'</td><td>'+p.buys+'</td><td>'+short(p.title||p.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No open positions</td></tr>';

  // window results table
  $('res-body').innerHTML=(s.windowHistory||[]).map(function(w){
    var cls=w.won?'pnl-pos':'pnl-neg';
    var tag=w.won?'✅ WIN':'❌ LOSS';
    return'<tr><td>'+ts(Math.floor(new Date(w.settledAt).getTime()/1000))+'</td><td class="'+cls+'">'+w.side+'</td><td>'+w.shares+'</td><td>$'+w.cost.toFixed(2)+'</td><td>$'+w.payout.toFixed(2)+'</td><td class="'+cls+'">'+sg(w.pnl)+'</td><td class="'+cls+'">'+tag+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No resolved windows</td></tr>';

  // trades
  $('trade-body').innerHTML=(s.trades||[]).map(function(t){
    return'<tr><td>'+ts(t.t)+'</td><td style="color:#00ff88">'+t.action+'</td><td>'+t.side+'</td><td>'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td><td>'+t.masterShares+'sh</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No trades yet</td></tr>';
}

function wr(label,val,cls){return'<div class="wr"><div class="wrl">'+label+'</div><div class="wrv '+(cls||'')+'">'+val+'</div></div>'}
function sv(label,val,cls){return'<div class="s"><div class="sl">'+label+'</div><div class="sv '+(cls||'')+'">'+val+'</div></div>'}

var logBuf=[];
socket.on('state',function(s){render(s)});
socket.on('trade',function(){if(S)render(S)});
socket.on('log',function(line){
  logBuf.push(line);
  if(logBuf.length>400)logBuf.shift();
  var el=$('log-panel');
  var atBot=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  var wasAtBottom=atBot;
  el.innerHTML=logBuf.slice(-200).map(function(l){
    var c=l.indexOf('WIN')>=0||l.indexOf('COPY BUY')>=0?'#00ff88'
      :l.indexOf('LOSS')>=0||l.indexOf('⚠')>=0?'#ff4444'
      :l.indexOf('🏁')>=0?'#ffcc00':'#cccccc';
    return'<div style="color:'+c+'">'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  if(wasAtBottom)el.scrollTop=el.scrollHeight;
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
