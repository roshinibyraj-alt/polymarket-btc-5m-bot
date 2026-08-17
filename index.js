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
<title>Copy Bot Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:13px;font-weight:bold;-webkit-text-size-adjust:100%}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #ffaa00;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:22px;color:#fff;letter-spacing:1px}.logo span{color:#00ccff}
.wallet{font-size:10px;color:#666;word-break:break-all;margin-top:3px}
.badge{padding:4px 14px;border-radius:20px;font-size:11px;font-weight:bold;background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}

/* header buy boxes */
.hdr-boxes{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px 16px 0}
@media(max-width:500px){.hdr-boxes{grid-template-columns:1fr}}
.hb{background:#0a0a0a;border:2px solid #333;border-radius:10px;padding:14px 16px}
.hb.big{border-color:#00ff88}.hb.sm{border-color:#ff4444}
.hb .l{font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.hb.big .l{color:#00ff88}.hb.sm .l{color:#ff4444}
.hb .v{font-size:24px;font-weight:bold;color:#fff}
.hb .d{font-size:10px;color:#888;margin-top:4px}

.toolbar{display:flex;gap:6px;padding:10px 16px 0}
.toolbar button{background:#00ccff;color:#001018;border:none;padding:8px 16px;border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit;font-size:12px}
.toolbar button.p{background:#ffcc00}

/* stats */
.sg{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:12px 16px 0}
@media(max-width:700px){.sg{grid-template-columns:repeat(3,1fr)}}
.s{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:8px 10px}
.sl{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.sv{font-size:15px;font-weight:bold;color:#fff}
.pos{color:#00ff88!important}.neg{color:#ff4444!important}

/* equity chart */
.eq{margin:12px 16px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:12px 14px}
.eq-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.eq-hdr .t{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#888}
.eq-hdr .v{font-size:16px;font-weight:bold}
.eq svg{width:100%;height:80px;background:#111;border-radius:6px}

/* sections */
.sec{margin:12px 16px 0}
.sh{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:6px}
.card{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tb{border-collapse:collapse;min-width:350px;width:100%}
.tb th{background:#111;color:#888;padding:5px 6px;text-align:left;font-size:8px;text-transform:uppercase;position:sticky;top:0;white-space:nowrap}
.tb td{padding:4px 6px;border-bottom:1px solid #222;font-size:10px;white-space:nowrap;font-weight:bold}

.lp{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px;max-height:250px;overflow-y:auto;overflow-x:auto;font-size:10px;line-height:1.5;white-space:nowrap;-webkit-overflow-scrolling:touch}
.lp div{padding:1px 0;font-weight:bold}

.pnl-pos{color:#00ff88!important}.pnl-neg{color:#ff4444!important}
.tag-up{color:#00ccff}.tag-dn{color:#aa88ff}
.empty{padding:14px;text-align:center;color:#555;font-size:10px;font-weight:bold}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:700px){.g2{grid-template-columns:1fr}}
.wtag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:bold}
.won{background:#00ff8822;color:#00ff88;border:1px solid #00ff88}
.lost{background:#ff444422;color:#ff4444;border:1px solid #ff4444}
.pending{background:#333;color:#888;border:1px solid #555}
</style></head><body>

<div class="hd">
  <div><div class="logo">🪞 <span>COPY BOT</span></div><div class="wallet" id="wallet"></div></div>
  <div class="badge">DEMO</div>
</div>

<div class="hdr-boxes">
  <div class="hb big"><div class="l">🔥 BIGGEST BUY</div><div class="v" id="big-v">—</div><div class="d" id="big-d"></div></div>
  <div class="hb sm"><div class="l">🪙 SMALLEST BUY</div><div class="v" id="sm-v">—</div><div class="d" id="sm-d"></div></div>
</div>

<div class="toolbar">
  <button onclick="fetch('/api/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">⏸ Pause</button>
  <button class="p" onclick="fetch('/api/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})">▶ Resume</button>
</div>

<div class="sg" id="stats"></div>

<div class="eq">
  <div class="eq-hdr"><div class="t">📈 Equity Curve</div><div class="v" id="eq-val"></div></div>
  <svg id="eq-svg" viewBox="0 0 700 80" preserveAspectRatio="none"></svg>
</div>

<div class="sec"><div class="sh">⚡ Live Trades</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Time</th><th>Type</th><th>Fire</th><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th><th>Master</th><th>Master$</th></tr></thead><tbody id="tb"></tbody></table></div></div></div>

<div class="sec"><div class="g2">
  <div><div class="sh" style="color:#00ccff">📊 5-Minute Windows</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Slug</th><th>Fire</th><th>UP sh</th><th>UP$</th><th>DN sh</th><th>DN$</th><th>Cost</th><th>P&L</th><th>Result</th></tr></thead><tbody id="w5"></tbody></table></div></div></div>
  <div><div class="sh" style="color:#aa88ff">📊 15-Minute Windows</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Slug</th><th>Fire</th><th>UP sh</th><th>UP$</th><th>DN sh</th><th>DN$</th><th>Cost</th><th>P&L</th><th>Result</th></tr></thead><tbody id="w15"></tbody></table></div></div></div>
</div></div>

<div class="sec"><div class="sh">📋 Master Wallet Positions</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Side</th><th>Size</th><th>Avg</th><th>P&L</th><th>Current</th><th>Title</th></tr></thead><tbody id="mb"></tbody></table></div></div></div>

<div class="sec"><div class="sh">📋 Open Positions</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Opened</th><th>Side</th><th>Shares</th><th>Avg</th><th>Cost</th><th>Buys</th><th>Master</th><th>Title</th></tr></thead><tbody id="pb"></tbody></table></div></div></div>

<div class="sec"><div class="sh">🏁 Resolution Results</div><div class="card"><div class="tw"><table class="tb"><thead><tr><th>Settled</th><th>Type</th><th>Side</th><th>Shares</th><th>Cost</th><th>Payout</th><th>P&L</th><th>Result</th><th>Title</th></tr></thead><tbody id="rb"></tbody></table></div></div></div>

<div class="sec"><div class="sh">📜 Logs</div><div class="lp" id="lp"></div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io({transports:['websocket'],upgrade:false});
var S=null;
function $(id){return document.getElementById(id)}
function pC(n){return n==null?'':n>0?'pnl-pos':n<0?'pnl-neg':''}
function sg(n){if(n==null)return'—';return(n>0?'+$':(n<0?'-$':'±$'))+Math.abs(n).toFixed(2)}
function ts(e){return e?new Date(e*1000).toISOString().slice(11,19):'—'}
function short(s){if(!s)return'';var m=s.match(/(\\d{10,})/);return m?'...'+m[1].slice(-6):s.length>16?s.slice(0,16)+'...':s}
function fmtS(s){var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h+'h '+m+'m'}
function fireTag(o){return o!=null?'+'+Math.floor(o/60)+':'+String(Math.round(o%60)).padStart(2,'0'):'—'}
function svgCurve(curve,W,H,start){
  if(!curve||curve.length<2)return'';
  var v=curve.map(function(p){return p.equity});
  var mn=Math.min.apply(null,v),mx=Math.max.apply(null,v);
  if(start!=null){mn=Math.min(mn,start);mx=Math.max(mx,start)}
  var r=mx-mn||1,pd=4;
  var pts=v.map(function(val,i){return pd+(i/(v.length-1))*(W-pd*2)+','+(pd+((mx-val)/r)*(H-pd*2))}).join(' ');
  var lastY=pd+((mx-v[v.length-1])/r)*(H-pd*2);
  var startY=pd+((mx-start)/r)*(H-pd*2);
  return'<line x1="'+pd+'" y1="'+startY+'" x2="'+(W-pd)+'" y2="'+startY+'" stroke="#ffaa0055" stroke-width="0.5" stroke-dasharray="4,3"/>'+
    '<polyline points="'+pts+'" fill="none" stroke="#00ccff" stroke-width="1.5"/>'+
    '<circle cx="'+(W-pd)+'" cy="'+lastY+'" r="3" fill="#00ccff"/>'+
    '<text x="'+(W-pd-2)+'" y="'+lastY-6+'" fill="#00ccff" font-size="8" text-anchor="end">$'+v[v.length-1].toFixed(0)+'</text>';
}
function wRes(w){
  if(w.resolved===undefined||w.resolved===null)return'<span class="wtag pending">PENDING</span>';
  return w.won?'<span class="wtag won">✅ WIN</span>':'<span class="wtag lost">❌ LOSS</span>';
}

function render(s){
  S=s;if(!s)return;
  $('wallet').textContent=s.watchWallet;

  // header boxes
  if(s.biggestBuy){var b=s.biggestBuy;$('big-v').textContent=b.shares+'sh @'+b.price.toFixed(3);$('big-d').textContent='$'+b.cost.toFixed(2)+' — '+b.side.toUpperCase()+' — '+b.type+' — '+ts(b.t);}
  if(s.smallestBuy){var sm=s.smallestBuy;$('sm-v').textContent=sm.shares+'sh @'+sm.price.toFixed(3);$('sm-d').textContent='$'+sm.cost.toFixed(2)+' — '+sm.side.toUpperCase()+' — '+sm.type+' — '+ts(sm.t);}

  // stats
  $('stats').innerHTML=[
    sv('Bankroll','$'+s.bankroll.toFixed(2)),
    sv('Equity','$'+s.markValue.toFixed(2),pC(s.totalPnl)),
    sv('P&L',sg(s.totalPnl),pC(s.totalPnl)),
    sv('Wins / Losses',s.wins+'W / '+s.losses+'L'),
    sv('Win Rate',s.winRate!=null?s.winRate+'%':'—')
  ].join('');

  // equity curve
  $('eq-val').textContent='$'+s.markValue.toFixed(2);
  $('eq-val').className='v '+pC(s.totalPnl);
  $('eq-svg').innerHTML=svgCurve(s.equityCurve,700,80,s.demoCapital);

  // live trades
  $('tb').innerHTML=(s.trades||[]).map(function(t){
    return'<tr><td>'+ts(t.t)+'</td><td>'+t.type+'</td><td>'+fireTag(t.fireOffset)+'</td><td>'+t.side+'</td><td>'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td><td>'+t.masterShares+'sh</td><td>$'+(t.masterShares*t.masterPrice).toFixed(2)+'</td></tr>';
  }).join('')||'<tr><td colspan="9" class="empty">No trades yet</td></tr>';

  // windows
  function wRow(w){
    return'<tr><td title="'+w.slug+'">'+short(w.slug)+'</td><td>'+fireTag(w.fireOffset)+'</td><td class="tag-up">'+w.upShares+'</td><td>$'+w.upCost.toFixed(2)+'</td><td class="tag-dn">'+w.downShares+'</td><td>$'+w.downCost.toFixed(2)+'</td><td>$'+w.totalCost.toFixed(2)+'</td><td class="'+pC(w.pnl)+'">'+sg(w.pnl)+'</td><td>'+wRes(w)+'</td></tr>';
  }
  $('w5').innerHTML=(s.windows5m||[]).map(wRow).join('')||'<tr><td colspan="9" class="empty">No 5m windows yet</td></tr>';
  $('w15').innerHTML=(s.windows15m||[]).map(wRow).join('')||'<tr><td colspan="9" class="empty">No 15m windows yet</td></tr>';

  // master
  $('mb').innerHTML=(s.masterTrades||[]).map(function(t){
    return'<tr><td>'+t.outcome+'</td><td>'+t.size+'sh</td><td>'+(t.avgPrice?t.avgPrice.toFixed(3):'—')+'</td><td class="'+pC(t.cashPnl)+'">'+sg(t.cashPnl)+'</td><td>'+(t.curPrice?t.curPrice.toFixed(3):'—')+'</td><td>'+short(t.title)+'</td></tr>';
  }).join('')||'<tr><td colspan="6" class="empty">No master positions</td></tr>';

  // open positions
  $('pb').innerHTML=(s.positions||[]).map(function(p){
    var ot=p.openedAt?Math.floor(new Date(p.openedAt).getTime()/1000):null;
    return'<tr><td>'+ts(ot)+'</td><td>'+p.outcome+'</td><td>'+p.shares+'</td><td>'+p.avgPrice.toFixed(3)+'</td><td>$'+p.cost.toFixed(2)+'</td><td>'+p.buys+'</td><td>'+(p.masterTotalShares||0)+'sh</td><td>'+short(p.title||p.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="8" class="empty">No open positions</td></tr>';

  // resolution results — show settled windows from both 5m and 15m
  var resolved=[];
  (s.windows5m||[]).forEach(function(w){if(w.resolved)resolved.push(w)});
  (s.windows15m||[]).forEach(function(w){if(w.resolved)resolved.push(w)});
  resolved.sort(function(a,b){return (b.settledAt||'').localeCompare(a.settledAt||'')});
  $('rb').innerHTML=resolved.map(function(w){
    var st=w.settledAt?Math.floor(new Date(w.settledAt).getTime()/1000):null;
    return'<tr><td>'+ts(st)+'</td><td>'+w.type+'</td><td class="'+(w.won?'pnl-pos':'pnl-neg')+'">'+w.winner+'</td><td>UP '+w.upShares+' / DN '+w.downShares+'</td><td>$'+w.totalCost.toFixed(2)+'</td><td>$'+w.payout.toFixed(2)+'</td><td class="'+pC(w.pnl)+'">'+sg(w.pnl)+'</td><td>'+wRes(w)+'</td><td>'+short(w.title)+'</td></tr>';
  }).join('')||'<tr><td colspan="9" class="empty">No resolutions yet</td></tr>';
}

function sv(l,v,c){return'<div class="s"><div class="sl">'+l+'</div><div class="sv '+(c||'')+'">'+v+'</div></div>'}

var lb=[];
socket.on('state',function(s){render(s)});
socket.on('trade',function(){if(S)render(S)});
socket.on('log',function(line){
  lb.push(line);if(lb.length>400)lb.shift();
  var el=$('lp');
  var atBot=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=lb.slice(-200).map(function(l){
    var c=l.indexOf('WIN')>=0||l.indexOf('COPY BUY')>=0?'#00ff88':l.indexOf('LOSS')>=0||l.indexOf('⚠')>=0?'#ff4444':l.indexOf('🏁')>=0?'#ffcc00':'#cccccc';
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
