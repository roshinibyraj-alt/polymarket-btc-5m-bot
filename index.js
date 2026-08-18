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
<title>Copy Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:13px;font-weight:bold;-webkit-text-size-adjust:100%}

/* Header */
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #ffaa00;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:20px;color:#fff;letter-spacing:1px}.logo span{color:#00ccff}
.wallet{font-size:9px;color:#555;word-break:break-all;margin-top:2px}
.badge{padding:4px 12px;border-radius:20px;font-size:10px;font-weight:bold;background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}

/* Big/Small boxes */
.hdr-boxes{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 16px 0}
@media(max-width:500px){.hdr-boxes{grid-template-columns:1fr}}
.hb{background:#0a0a0a;border:2px solid #333;border-radius:8px;padding:10px 12px}
.hb.big{border-color:#00ff88}.hb.sm{border-color:#ff4444}
.hb .l{font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.hb.big .l{color:#00ff88}.hb.sm .l{color:#ff4444}
.hb .v{font-size:18px;font-weight:bold;color:#fff}
.hb .d{font-size:9px;color:#666;margin-top:2px}

/* Stats */
.sg{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:10px 16px 0}
@media(max-width:700px){.sg{grid-template-columns:repeat(3,1fr)}}
@media(max-width:400px){.sg{grid-template-columns:repeat(2,1fr)}}
.s{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 8px}
.sl{font-size:7px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.sv{font-size:14px;font-weight:bold;color:#fff}
.pos{color:#00ff88!important}.neg{color:#ff4444!important}

/* Equity */
.eq{margin:10px 16px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.eq-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.eq-hdr .t{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#666}
.eq-hdr .v{font-size:14px;font-weight:bold}
.eq svg{width:100%;height:60px;background:#111;border-radius:6px}

/* Sections */
.sec{margin:10px 16px 0}
.sh{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:4px}
.card{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tb{border-collapse:collapse;min-width:300px;width:100%}
.tb th{background:#111;color:#666;padding:4px 5px;text-align:left;font-size:7px;text-transform:uppercase;position:sticky;top:0;white-space:nowrap}
.tb td{padding:3px 5px;border-bottom:1px solid #1a1a1a;font-size:9px;white-space:nowrap;font-weight:bold}

/* Log panel */
.lp{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px;max-height:200px;overflow-y:auto;overflow-x:auto;font-size:9px;line-height:1.4;white-space:nowrap;-webkit-overflow-scrolling:touch}
.lp div{padding:1px 0}

.pnl-pos{color:#00ff88!important}.pnl-neg{color:#ff4444!important}
.tag-up{color:#00ccff}.tag-dn{color:#aa88ff}
.empty{padding:12px;text-align:center;color:#444;font-size:9px;font-weight:bold}

/* Window share badges */
.sh-badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:8px;font-weight:bold;margin-left:2px}
.sh-up{background:#00ccff22;color:#00ccff;border:1px solid #00ccff}
.sh-dn{background:#aa88ff22;color:#aa88ff;border:1px solid #aa88ff}
</style></head><body>

<div class="hd">
  <div><div class="logo">🪞 <span>COPY BOT</span></div><div class="wallet" id="wallet"></div></div>
  <div class="badge">DEMO</div>
</div>

<div class="hdr-boxes">
  <div class="hb big"><div class="l">🔥 BIGGEST BUY</div><div class="v" id="big-v">—</div><div class="d" id="big-d"></div></div>
  <div class="hb sm"><div class="l">💎 SMALLEST BUY</div><div class="v" id="sm-v">—</div><div class="d" id="sm-d"></div></div>
</div>

<div class="sg" id="stats"></div>

<div class="eq">
  <div class="eq-hdr"><div class="t">Equity Curve</div><div class="v" id="eq-val">—</div></div>
  <svg id="eq-svg" viewBox="0 0 700 60" preserveAspectRatio="none"></svg>
</div>

<div class="sec">
  <div class="sh">📈 Active 5m Windows</div>
  <div class="card"><div class="tw"><table class="tb">
    <tr><th>Slug</th><th>Fire</th><th>UP Shares</th><th>UP Cost</th><th>DN Shares</th><th>DN Cost</th><th>Total</th></tr>
    <tbody id="w5"></tbody>
  </table></div></div>
</div>

<div class="sec">
  <div class="sh">📈 Active 15m Windows</div>
  <div class="card"><div class="tw"><table class="tb">
    <tr><th>Slug</th><th>Fire</th><th>UP Shares</th><th>UP Cost</th><th>DN Shares</th><th>DN Cost</th><th>Total</th></tr>
    <tbody id="w15"></tbody>
  </table></div></div>
</div>

<div class="sec">
  <div class="sh">💰 Open Positions</div>
  <div class="card"><div class="tw"><table class="tb">
    <tr><th>Side</th><th>Shares</th><th>Avg Px</th><th>Cost</th><th>Buys</th><th>Master</th><th>Market</th></tr>
    <tbody id="pb"></tbody>
  </table></div></div>
</div>

<div class="sec">
  <div class="sh">📋 Live Trades</div>
  <div class="card"><div class="tw"><table class="tb">
    <tr><th>Time</th><th>Type</th><th>Fire</th><th>Side</th><th>Sh</th><th>Price</th><th>Cost</th></tr>
    <tbody id="tb"></tbody>
  </table></div></div>
</div>

<div class="sec">
  <div class="sh">📝 Logs</div>
  <div class="lp" id="lp"></div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io({pingInterval:2000,pingTimeout:5000});
var S=null;

function $(id){return document.getElementById(id)}
function ts(s){if(!s)return'—';var d=new Date((typeof s==='number'?s*1000:s));return d.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function short(s){if(!s)return'';return s.length>16?s.slice(0,16)+'…':s}
function sgn(n){return(n>0?'+$':(n<0?'-$':'$'))+Math.abs(n).toFixed(2)}
function pC(n){return n>0?'pnl-pos':n<0?'pnl-neg':''}

function svgCurve(pts,w,h,baseline){
  if(!pts||pts.length<2)return'';
  var mn=Infinity,mx=-Infinity;
  pts.forEach(function(p){if(p.equity<mn)mn=p.equity;if(p.equity>mx)mx=p.equity});
  var range=mx-mn||1;mn-=range*0.05;mx+=range*0.05;range=mx-mn;
  var last=pts[pts.length-1].equity;
  var col=last>=baseline?'#00ff88':'#ff4444';
  var d='M';
  pts.forEach(function(p,i){
    var x=(i/(pts.length-1))*w;
    var y=h-(((p.equity-mn)/range)*h);
    d+=(i?'L':'')+x.toFixed(1)+','+y.toFixed(1);
  });
  return'<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">'
    +'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="2"/>'
    +'<line x1="0" y1="'+(h-(((baseline-mn)/range)*h))+'" x2="'+w+'" y2="'+(h-(((baseline-mn)/range)*h))+'" stroke="#333" stroke-width="1" stroke-dasharray="4"/>'
    +'</svg>';
}

function render(s){try{
  S=s;
  $('wallet').textContent='Master: '+s.watchWallet.slice(0,10)+'…'+s.watchWallet.slice(-6);

  // Header boxes
  if(s.biggestBuy){var b=s.biggestBuy;$('big-v').textContent=b.shares+'sh @'+b.price.toFixed(3);$('big-d').textContent='$'+b.cost.toFixed(2)+' — '+b.side.toUpperCase()+' — '+b.type+' — '+ts(b.t);}
  if(s.smallestBuy){var sm=s.smallestBuy;$('sm-v').textContent=sm.shares+'sh @'+sm.price.toFixed(3);$('sm-d').textContent='$'+sm.cost.toFixed(2)+' — '+sm.side.toUpperCase()+' — '+sm.type+' — '+ts(sm.t);}

  // Stats
  $('stats').innerHTML=[
    sv('Bankroll','$'+s.bankroll.toFixed(2)),
    sv('Equity','$'+s.markValue.toFixed(2),pC(s.totalPnl)),
    sv('P&L',sg(s.totalPnl),pC(s.totalPnl)),
    sv('Wins / Losses',s.wins+'W / '+s.losses+'L'),
    sv('Win Rate',s.winRate!=null?s.winRate+'%':'—')
  ].join('');

  // Equity
  $('eq-val').textContent='$'+s.markValue.toFixed(2);
  $('eq-val').className='v '+pC(s.totalPnl);
  $('eq-svg').innerHTML=svgCurve(s.equityCurve,700,55,s.demoCapital);

  // Live trades
  $('tb').innerHTML=(s.trades||[]).slice(0,50).map(function(t){
    return'<tr><td>'+ts(t.t)+'</td><td>'+t.type+'</td><td>'+(t.fireOffset!=null?'+'+t.fireOffset+'s':'—')+'</td><td>'+t.side+'</td><td>'+t.shares+'</td><td>'+t.price.toFixed(3)+'</td><td>$'+t.cost.toFixed(2)+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No trades yet</td></tr>';

  // Active 5m windows with accumulated shares
  $('w5').innerHTML=(s.windows5m||[]).map(function(w){
    return'<tr><td title="'+w.slug+'">'+short(w.slug)+'</td><td>'+(w.fireOffset!=null?'+'+w.fireOffset+'s':'—')+'</td>'
      +'<td class="tag-up"><span class="sh-badge sh-up">'+w.upShares+'sh</span></td>'
      +'<td>$'+w.upCost.toFixed(2)+'</td>'
      +'<td class="tag-dn"><span class="sh-badge sh-dn">'+w.downShares+'sh</span></td>'
      +'<td>$'+w.downCost.toFixed(2)+'</td>'
      +'<td>$'+w.totalCost.toFixed(2)+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No active 5m windows</td></tr>';

  // 15m windows
  $('w15').innerHTML=(s.windows15m||[]).map(function(w){
    return'<tr><td title="'+w.slug+'">'+short(w.slug)+'</td><td>'+(w.fireOffset!=null?'+'+w.fireOffset+'s':'—')+'</td>'
      +'<td class="tag-up"><span class="sh-badge sh-up">'+w.upShares+'sh</span></td>'
      +'<td>$'+w.upCost.toFixed(2)+'</td>'
      +'<td class="tag-dn"><span class="sh-badge sh-dn">'+w.downShares+'sh</span></td>'
      +'<td>$'+w.downCost.toFixed(2)+'</td>'
      +'<td>$'+w.totalCost.toFixed(2)+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No active 15m windows</td></tr>';

  // Open positions
  $('pb').innerHTML=(s.positions||[]).map(function(p){
    return'<tr><td>'+p.outcome+'</td><td>'+p.shares+'</td><td>'+p.avgPrice.toFixed(3)+'</td><td>$'+p.cost.toFixed(2)+'</td><td>'+p.buys+'</td><td>'+(p.masterTotalShares||0)+'sh</td><td>'+short(p.title||p.slug)+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No open positions</td></tr>';
}catch(e){console.error('Render error:',e)}
}

function sv(l,v,c){return'<div class="s"><div class="sl">'+l+'</div><div class="sv '+(c||'')+'">'+v+'</div></div>'}

var lb=[];
socket.on('state',function(s){render(s)});
socket.on('log',function(line){
  lb.push(line);if(lb.length>400)lb.shift();
  var el=$('lp');
  var atBot=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=lb.slice(-150).map(function(l){
    var c=l.indexOf('WIN')>=0||l.indexOf('COPY BUY')>=0?'#00ff88':l.indexOf('LOSS')>=0||l.indexOf('⚠')>=0?'#ff4444':l.indexOf('🏁')>=0?'#ffcc00':'#999';
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
