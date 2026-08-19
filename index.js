'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const bot     = require('./copy-bot');

const app  = express();
const srv  = http.createServer(app);
const io   = new Server(srv, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.get('/healthz', (_, r) => r.sendStatus(200));
app.get('/api/status', (_, r) => { try { r.json(bot.getStatus()); } catch(e) { r.status(500).json({ error: e.message }); } });
app.post('/api/pause',  (_, r) => { try { r.json(bot.pauseTrading());  } catch(e) { r.status(500).json({ error: e.message }); } });
app.post('/api/resume', (_, r) => { try { r.json(bot.resumeTrading()); } catch(e) { r.status(500).json({ error: e.message }); } });

const DASH = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Copy Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:13px;font-weight:bold;-webkit-text-size-adjust:100%}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #ffaa00;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:20px;color:#fff;letter-spacing:1px}.logo span{color:#00ccff}
.wallet{font-size:9px;color:#555;word-break:break-all;margin-top:2px}
.badge{padding:4px 12px;border-radius:20px;font-size:10px;font-weight:bold;background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}
.sg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px 16px 0}
@media(max-width:600px){.sg{grid-template-columns:repeat(2,1fr)}}
.s{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 8px}
.sl{font-size:7px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.sv{font-size:14px;font-weight:bold;color:#fff}
.pos{color:#00ff88!important}.neg{color:#ff4444!important}
.eq{margin:10px 16px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.eq-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.eq-hdr .t{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#666}
.eq-hdr .v{font-size:14px;font-weight:bold}
.eq svg{width:100%;height:60px;background:#111;border-radius:6px}
.sec{margin:10px 16px 0}
.sh{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:4px}
.card{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tb{border-collapse:collapse;min-width:300px;width:100%}
.tb th{background:#111;color:#666;padding:4px 5px;text-align:left;font-size:7px;text-transform:uppercase;position:sticky;top:0;white-space:nowrap}
.tb td{padding:3px 5px;border-bottom:1px solid #1a1a1a;font-size:9px;white-space:nowrap;font-weight:bold}
.lp{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px;max-height:200px;overflow-y:auto;overflow-x:auto;font-size:9px;line-height:1.4;white-space:nowrap;-webkit-overflow-scrolling:touch}
.lp div{padding:1px 0}
.pnl-pos{color:#00ff88!important}.pnl-neg{color:#ff4444!important}
.tag-up{color:#00ccff}.tag-dn{color:#aa88ff}
.empty{padding:12px;text-align:center;color:#444;font-size:9px;font-weight:bold}
.sh-badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:8px;font-weight:bold;margin-left:2px}
.sh-up{background:#00ccff22;color:#00ccff;border:1px solid #00ccff}
.sh-dn{background:#aa88ff22;color:#aa88ff;border:1px solid #aa88ff}
.win-box{border-color:#00ff88!important}.loss-box{border-color:#ff4444!important}
.big-shares{font-size:22px;font-weight:bold;font-family:'Courier New',monospace}
.win-label{color:#00ff88}.loss-label{color:#ff4444}
</style></head><body>

<div class="hd">
  <div><div class="logo">\uD83E\uDE99 <span>COPY BOT</span></div><div class="wallet" id="wallet"></div></div>
  <div class="badge">DEMO</div>
</div>

<div class="sg" id="stats"></div>

<div class="eq">
  <div class="eq-hdr"><div class="t">Equity Curve</div><div class="v" id="eq-val">\u2014</div></div>
  <svg id="eq-svg" viewBox="0 0 700 55" preserveAspectRatio="none"></svg>
</div>

<div class="sec">
  <div class="sh">\uD83C\uDFC1 5 MINUTE WINDOWS</div>
  <div class="card">
    <div class="tw"><table class="tb">
      <tr><th>Window</th><th>UP Shares</th><th>UP Cost</th><th>DN Shares</th><th>DN Cost</th><th>Total</th></tr>
    </table></div>
    <div id="w5"><div class="empty">No active 5m windows</div></div>
  </div>
</div>

<div class="sec">
  <div class="sh">\uD83C\uDFC1 15 MINUTE WINDOWS</div>
  <div class="card">
    <div class="tw"><table class="tb">
      <tr><th>Window</th><th>UP Shares</th><th>UP Cost</th><th>DN Shares</th><th>DN Cost</th><th>Total</th></tr>
    </table></div>
    <div id="w15"><div class="empty">No active 15m windows</div></div>
  </div>
</div>

<div class="sec">
  <div class="sh">\uD83D\uDCB0 OPEN POSITIONS</div>
  <div class="card">
    <div class="tw"><table class="tb">
      <tr><th>Side</th><th>Shares</th><th>Avg</th><th>Cost</th><th>Buys</th><th>Window</th></tr>
    </table></div>
    <div id="pb"><div class="empty">No open positions</div></div>
  </div>
</div>

<div class="sec">
  <div class="sh">\uD83D\uDCDD LOGS</div>
  <div class="card"><div class="lp" id="lp"></div></div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io({pingInterval:2000,pingTimeout:5000});
var lb=[];var latest={};
function $(id){return document.getElementById(id)}
function fmt2(n){return Number(n).toFixed(2)}
function sgn(n){return(n>=0?'+':'')+sgn2(n)}
function sgn2(n){return(n>=0?'$':'-$')+Math.abs(n).toFixed(2)}
function pC(n){return n>=0?'pos':'neg'}
function ts(t){if(!t)return'';var d=new Date(t);return d.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function short(s){if(!s)return'';var m=s.match(/(\d{10,})/);if(m)return'...'+m[1].slice(-6);return s.length>15?s.slice(0,15)+'...':s}
function svgCurve(pts,w,h,base){
  if(!pts||pts.length<2)return'';
  var vals=pts.map(function(p){return p.equity});
  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals);
  if(mn===mx){mn-=10;mx+=10}
  var xA=function(i,len){return(len<=1?w/2:i/(len-1)*w)};
  var yA=function(v){return h-((v-mn)/(mx-mn))*h};
  var d=pts.map(function(p,i){return(i===0?'M':'L')+xA(i,pts.length).toFixed(1)+','+yA(vals[i]).toFixed(1)}).join(' ');
  var lastY=yA(vals[vals.length-1]);
  var lastX=xA(vals.length-1,vals.length);
  var col=vals[vals.length-1]>=base?'#00ff88':'#ff4444';
  return'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.5"/><circle cx="'+lastX.toFixed(1)+'" cy="'+lastY.toFixed(1)+'" r="3" fill="'+col+'"/>';
}

function render(s){
  try{
    // Stats
    var totalPnl=s.totalPnl||0;
    var totalEquity=s.markValue||s.demoCapital;
    $('stats').innerHTML=[
      '<div class="s"><div class="sl">Capital</div><div class="sv">$'+fmt2(s.demoCapital)+'</div></div>',
      '<div class="s"><div class="sl">Bankroll</div><div class="sv">$'+fmt2(s.bankroll)+'</div></div>',
      '<div class="s"><div class="sl">Equity</div><div class="sv '+pC(totalPnl)+'">$'+fmt2(totalEquity)+'</div></div>',
      '<div class="s"><div class="sl">P&L</div><div class="sv '+pC(totalPnl)+'">'+sgn(totalPnl)+'</div></div>',
      '<div class="s"><div class="sl">Wins/Losses</div><div class="sv"><span class="pos">'+s.wins+'W</span>/<span class="neg">'+s.losses+'L</span></div></div>',
      '<div class="s"><div class="sl">Win Rate</div><div class="sv">'+(s.winRate!=null?s.winRate+'%':'\u2014')+'</div></div>',
    ].join('');

    // Wallet
    $('wallet').textContent='Master: '+s.watchWallet.slice(0,10)+'\u2026'+s.watchWallet.slice(-6);

    // Equity curve
    $('eq-val').textContent='$'+fmt2(totalEquity);
    $('eq-val').className='v '+pC(totalPnl);
    $('eq-svg').innerHTML=svgCurve(s.equityCurve,700,55,s.demoCapital);

    // 5m windows — big bold shares
    var w5=(s.windows5m||[]).map(function(w){
      return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #1a1a1a;flex-wrap:wrap">'
        + '<div style="min-width:70px;font-size:9px;color:#666">'+short(w.slug)+'</div>'
        + '<div style="flex:1;display:flex;gap:12px;align-items:center">'
        + '<div><div class="tag-up">UP</div><div class="big-shares tag-up">'+w.upShares+'<span style="font-size:11px">sh</span></div><div style="font-size:9px;color:#666">$'+fmt2(w.upCost)+'</div></div>'
        + '<div><div class="tag-dn">DN</div><div class="big-shares tag-dn">'+w.downShares+'<span style="font-size:11px">sh</span></div><div style="font-size:9px;color:#666">$'+fmt2(w.downCost)+'</div></div>'
        + '<div style="text-align:right"><div style="font-size:9px;color:#666">TOTAL</div><div class="big-shares">$'+fmt2(w.totalCost)+'</div></div>'
        + '</div></div>';
    }).join('')||'<div class="empty">No active 5m windows</div>';
    $('w5').innerHTML=w5;

    // 15m windows
    var w15=(s.windows15m||[]).map(function(w){
      return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #1a1a1a;flex-wrap:wrap">'
        + '<div style="min-width:70px;font-size:9px;color:#666">'+short(w.slug)+'</div>'
        + '<div style="flex:1;display:flex;gap:12px;align-items:center">'
        + '<div><div class="tag-up">UP</div><div class="big-shares tag-up">'+w.upShares+'<span style="font-size:11px">sh</span></div><div style="font-size:9px;color:#666">$'+fmt2(w.upCost)+'</div></div>'
        + '<div><div class="tag-dn">DN</div><div class="big-shares tag-dn">'+w.downShares+'<span style="font-size:11px">sh</span></div><div style="font-size:9px;color:#666">$'+fmt2(w.downCost)+'</div></div>'
        + '<div style="text-align:right"><div style="font-size:9px;color:#666">TOTAL</div><div class="big-shares">$'+fmt2(w.totalCost)+'</div></div>'
        + '</div></div>';
    }).join('')||'<div class="empty">No active 15m windows</div>';
    $('w15').innerHTML=w15;

    // Open positions
    $('pb').innerHTML=(s.positions||[]).map(function(p){
      return '<tr><td>'+p.outcome+'</td><td>'+p.shares+'</td><td>'+p.avgPrice.toFixed(3)+'</td><td>$'+fmt2(p.cost)+'</td><td>'+p.buys+'</td><td>'+short(p.title||p.slug)+'</td></tr>';
    }).join('')||'<tr><td colspan="6" class="empty">No open positions</td></tr>';

  }catch(err){console.error('Render error:',err)}
}

socket.on('state',function(s){latest=s;render(s)});
socket.on('log',function(line){
  lb.push(line);if(lb.length>400)lb.shift();
  var el=$('lp');if(!el)return;
  var atBot=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=lb.slice(-150).map(function(l){
    var c=l.indexOf('WIN')>=0||l.indexOf('COPY BUY')>=0?'#00ff88':l.indexOf('LOSS')>=0||l.indexOf('\u26A0')>=0?'#ff4444':l.indexOf('\uD83C\uDFC1')>=0?'#ffcc00':'#999';
    return'<div style="color:'+c+'">'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  if(atBot)el.scrollTop=el.scrollHeight;
});

setInterval(function(){
  fetch('/api/status').then(function(r){return r.json()}).then(render).catch(function(e){});
},10000);
</script></body></html>`;


app.get('/', (_, res) => { res.type('html').send(DASH); });

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

console.log('\uD83E\uDE99 Copy Bot \u2014 DEMO MODE');
srv.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard: http://0.0.0.0:' + PORT);
  bot.init(emit, slog).catch(e => { console.error('Init failed:', e.message); process.exit(1); });
});
