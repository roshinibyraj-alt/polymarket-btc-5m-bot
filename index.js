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
.hdr-box.big{border-color:#00ff88}.hdr-box.sm{border-color:#ff4444}
.hdr-box .bh{font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.hdr-box.big .bh{color:#00ff88}.hdr-box.sm .bh{color:#ff4444}
.hdr-box .bv{font-size:22px;font-weight:bold;color:#fff}
.hdr-box .bm{font-size:10px;color:#888;margin-top:4px}

.toolbar{display:flex;gap:6px;padding:10px 14px 0}
.toolbar button{background:#00ccff;color:#001018;border:none;padding:8px 14px;border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit;font-size:12px}
.toolbar button.p{background:#ffcc00}

.wr-row{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:12px 14px 0}
@media(max-width:600px){.wr-row{grid-template-columns:repeat(3,1fr)}}
.wr{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px}
.wrl{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.wrv{font-size:15px;font-weight:bold;color:#fff}

.sec{margin:12px 14px 0}
.sh{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:6px}
.card{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tb{border-collapse:collapse;min-width:350px;width:100%}
.tb th{background:#111;color:#888;padding:5px 6px;text-align:left;font-size:8px;text-transform:uppercase;position:sticky;top:0;white-space:nowrap}
.tb td{padding:4px 6px;border-bottom:1px solid #222;font-size:10px;white-space:nowrap;font-weight:bold}

.lp{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px;max-height:300px;overflow-y:auto;overflow-x:auto;font-size:10px;line-height:1.5;white-space:nowrap;-webkit-overflow-scrolling:touch}
.lp div{padding:1px 0;font-weight:bold}

.pnl-pos{color:#00ff88!important}.pnl-neg{color:#ff4444!important}
.tag-up{color:#00ccff}.tag-dn{color:#aa88ff}
.empty{padding:12px;text-align:center;color:#555;font-size:9px;font-weight:bold}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:700px){.g2{grid-template-columns:1fr}}
.win-tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:bold}
.win-yes{background:#00ff8822;color:#00ff88;border:1px solid #00ff88}
.win-no{background:#ff444422;color:#ff4444;border:1px solid #ff4444}
.win-pending{background:#333;color:#888;border:1px solid #555}
</style></head><body>

<div class="hd">
  <div><div class="logo">🪞 <span>COPY BOT</span></div><div class="wallet" id="wallet"></div></div>
  <div class="badge">DEMO</div>
</div>

<div class="hdr-boxes">
  <div class="hdr-box big"><div class="bh">🔥 BIGGEST BUY</div><div class="bv" id="big-val">—</div><div class="bm" id="big-info"></div></div>
  <div class="hdr-box sm"><div class="bh">🪙 SMALLEST BUY</div><div class="bv" id="sm-val">—</div><div class="bm" id="sm-info"></div></div>
</div>

<div class="toolbar">
  <button onclick="fetch('/api/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">⏸ Pause</button>
  <button class="p" onclick="fetch('/api/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">▶ Resume</button>
</div>

<div class="wr-row" id="summary"></div>

<div class="sec"><div class="sh">⚡ Live Trades</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Type</th><th>Fire</th><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th><th>Master</th><th>Master$</th></tr></thead><tbody id="trade-body"></tbody></table></div></div></div>

<div class="sec"><div class="g2">
  <div><div class="sh" style="color:#00ccff">📊 5-Minute Windows</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Slug</th><th>Fire</th><th>UP sh</th><th>UP$</th><th>DN sh</th><th>DN$</th><th>Cost</th><th>P&L</th><th>Result</th></tr></thead><tbody id="w5-body"></tbody></table></div></div></div>
  <div><div class="sh" style="color:#aa88ff">📊 15-Minute Windows</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Slug</th><th>Fire</th><th>UP sh</th><th>UP$</th><th>DN sh</th><th>DN$</th><th>Cost</th><th>P&L</th><th>Result</th></tr></thead><tbody id="w15-body"></tbody></table></div></div></div>
</div></div>

<div class="sec"><div class="sh">📋 Master Wallet Activity</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Side</th><th>Size</th><th>Avg</th><th>P&L</th><th>Current</th><th>Title</th></tr></thead><tbody id="master-body"></tbody></table></div></div></div>

<div class="sec"><div class="sh">📋 Open Positions</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Opened</th><th>Side</th><th>Shares</th><th>Avg</th><th>Cost</th><th>Buys</th><th>Master</th><th>Title</th></tr></thead><tbody id="pos-body"></tbody></table></div></div></div>

<div class="sec"><div class="sh">📜 Logs</div><div class="lp" id="log-panel"></div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io({transports:['websocket'],upgrade:false});
var S=null;
function $(id){return document.getElementById(id)}
function pC(n){return n==null?'':n>0?'pnl-pos':n<0?'pnl-neg':''}
function sg(n){if(n==null)return'—';return(n>0?'+$':(n<0?'-$':'±$'))+Math.abs(n).toFixed(2)}
function ts(epoch){return epoch?new Date(epoch*1000).toISOString().slice(11,19):'—'}
function short(s){if(!s)return'';var m=s.match(/(\\d{10,})/);return m?'...'+m[1].slice(-6):s.length>16?s.slice(0,16)+'...':s}
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
function wTag(w){
  if(w.resolved===undefined||w.resolved===null)return'<span class="win-tag win-pending">PENDING</span>';
  return w.won?'<span class="win-tag win-yes">✅ WIN</span>':'<span class="win-tag win-no">❌ LOSS</span>';
}

function render(s){
  S=s;if(!s)return;
  $('wallet').textContent=s.watchWallet;

  if(s.biggestBuy){var b=s.biggestBuy;$('big-val').textContent=b.shares+'sh @'+b.price.toFixed(3);$('big-info').textContent='$'+b.cost.toFixed(2)+' — '+b.side.toUpperCase()+' — '+b.type+' — '+ts(b.t);}
  if(s.smallestBuy){var sm=s.smallestBuy;$('sm-val').textContent=sm.shares+'sh @'+sm.price.toFixed(3);$('sm-info').textContent='$'+sm.cost.toFixed(2)+' — '+sm.side.toUpperCase()+' — '+sm.type+' — '+ts(sm.t);}

  $('summary').innerHTML=[
    wr('Bankroll','$'+s.bankroll.toFixed(2)),
    wr('Equity','$'+s.markValue.toFixed(2),pC(s.totalPnl)),
    wr('P&L',sg(s.totalPnl),pC(s.totalPnl)),
    wr('Wins / Losses',s.wins+'W / '+s.losses+'L'),
    wr('Win Rate',s.winRate!=null?s.winRate+'%':'—')
  ].join('');

  $('trade-body').innerHTML=(s.trades||[]).map(function(t){
    return'<tr><td>'+ts(t.t)+'</td><td style="color:#00ff88">'+t.type+'</td><td>'+(t.fireOffset!=null?'+'+Math.floor(t.fireOffset/60)+':'+String(Math.round(t.fireOffset%60)).padStart(2,'0'):'—')+'</td><td>'+t.side+'</td><td>'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td><td>'+t.masterShares+'sh</td><td>$'+(t.masterShares*t.masterPrice).toFixed(2)+'</td></tr>';
  }).join('')||'<tr><td colspan="9" class="empty">No trades yet</td></tr>';

  function wRow(w){
    var fo=w.fireOffset!=null?'+'+Math.floor(w.fireOffset/60)+':'+String(Math.round(w.fireOffset%60)).padStart(2,'0'):'—';
    return'<tr><td title="'+w.slug+'">'+short(w.slug)+'</td><td>'+fo+'</td><td class="tag-up">'+w.upShares+'</td><td>$'+w.upCost.toFixed(2)+'</td><td class="tag-dn">'+w.downShares+'</td><td>$'+w.downCost.toFixed(2)+'</td><td>$'+w.totalCost.toFixed(2)+'</td><td class="'+pC(w.pnl)+'">'+sg(w.pnl)+'</td><td>'+wTag(w)+'</td></tr>';
  }
  var w5=(s.windows5m||[]).map(wRow).join('');
  var w15=(s.windows15m||[]).map(wRow).join('');
  $('w5-body').innerHTML=w5||'<tr><td colspan="9" class="empty">No 5m windows yet</td></tr>';
  $('w15-body').innerHTML=w15||'<tr><td colspan="9" class="empty">No 15m windows yet</td></tr>';

  $('master-body').innerHTML=(s.masterTrades||[]).map(function(t){
    return'<tr><td>'+t.outcome+'</td><td>'+t.size+'sh</td><td>'+(t.avgPrice?t.avgPrice.toFixed(3):'—')+'</td><td class="'+pC(t.cashPnl)+'">'+sg(t.cashPnl)+'</td><td>'+(t.curPrice?t.curPrice.toFixed(3):'—')+'</td><td>'+short(t.title)+'</td></tr>';
  }).join('')||'<tr><td colspan="6" class="empty">No master positions</td></tr>';

  $('pos-body').innerHTML=(s.positions||[]).map(function(p){
    var ot=p.openedAt?Math.floor(new Date(p.openedAt).getTime()/1000):null;
    return'<tr><td>'+ts(ot)+'</td><td>'+p.outcome+'</td><td>'+p.shares+'</td><td>'+p.avgPrice.toFixed(3)+'</td><td>$'+p.cost.toFixed(2)+'</td><td>'+p.buys+'</td><td>'+(p.masterTotalShares||0)+'sh</td><td>'+short(p.title||p.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="8" class="empty">No open positions</td></tr>';
}

function wr(label,val,cls){return'<div class="wr"><div class="wrl">'+label+'</div><div class="wrv '+(cls||'')+'">'+val+'</div></div>'}

var logBuf=[];
socket.on('state',function(s){render(s)});
socket.on('trade',function(){if(S)render(S)});
socket.on('log',function(line){
  logBuf.push(line);if(logBuf.length>400)logBuf.shift();
  var el=$('log-panel');
  var wasBot=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=logBuf.slice(-200).map(function(l){
    var c=l.indexOf('WIN')>=0||l.indexOf('COPY BUY')>=0?'#00ff88':l.indexOf('LOSS')>=0||l.indexOf('⚠')>=0?'#ff4444':l.indexOf('🏁')>=0?'#ffcc00':'#cccccc';
    return'<div style="color:'+c+'">'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  if(wasBot)el.scrollTop=el.scrollHeight;
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
