'use strict';
const { CheapHunterEngine, config } = require('./engine');

const engine = new CheapHunterEngine({
  name: 'CheapHunter',
  onTick: (state) => { /* dashboard pushes via SSE */ },
  onLog: (line) => console.log(line),
});

const dashboard = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>30 Seconds Waiter — BTC 5m</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e17;color:#e1e4e8;padding:12px;max-width:600px;margin:0 auto}
  .topbar{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #21262d;margin-bottom:12px}
  .btc{font-size:28px}
  h1{font-size:20px;color:#fff}
  .sub{font-size:11px;color:#8b949e;margin-top:2px}
  .card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px;margin-bottom:10px}
  .card h3{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
  .prices{display:flex;gap:12px;margin-bottom:10px}
  .price-box{flex:1;text-align:center;padding:8px;border-radius:6px}
  .price-box.up{background:#0d2818;border:1px solid #238636}
  .price-box.dn{background:#2d1117;border:1px solid #da3633}
  .side-label{font-size:11px;color:#8b949e;text-transform:uppercase}
  .side-price{font-size:28px;font-weight:700;line-height:1.2}
  .side-price.up{color:#3fb950}
  .side-price.dn{color:#f85149}
  .stat-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px}
  .stat-row .label{color:#8b949e}
  .stat-row .value{color:#fff;font-weight:600}
  .stat-row .value.green{color:#3fb950}
  .stat-row .value.red{color:#f85149}
  .pos-card{border:2px solid #f0883e;background:#1c1206;padding:12px;border-radius:8px;margin-bottom:10px}
  .pos-card h3{color:#f0883e}
  .equity-chart{height:100px;margin-top:8px}
  .equity-chart canvas{width:100%;height:100%}
  .window-bar{height:4px;background:#21262d;border-radius:2px;margin-top:6px;overflow:hidden}
  .window-bar .fill{height:100%;background:#f0883e;transition:width 1s linear;border-radius:2px}
  .tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}
  .tag.wait{background:#1c2333;color:#58a6ff}
  .tag.trade{background:#0d2818;color:#3fb950}
  .tag.done{background:#21262d;color:#8b949e}
</style>
</head><body>
<div class="topbar">
  <div class="btc">₿</div>
  <div><h1>30 Seconds Waiter</h1><div class="sub" id="strategy">Loading...</div></div>
</div>

<div class="prices">
  <div class="price-box up"><div class="side-label">BTC UP</div><div class="side-price up" id="upPrice">--</div></div>
  <div class="price-box dn"><div class="side-label">BTC DOWN</div><div class="side-price dn" id="dnPrice">--</div></div>
</div>

<div class="pos-card" id="posCard" style="display:none">
  <h3>📍 Open Position</h3>
  <div class="stat-row"><span class="label">Side</span><span class="value" id="posSide">--</span></div>
  <div class="stat-row"><span class="label">Shares</span><span class="value" id="posShares">--</span></div>
  <div class="stat-row"><span class="label">Entry</span><span class="value" id="posEntry">--</span></div>
  <div class="stat-row"><span class="label">Cost</span><span class="value" id="posCost">--</span></div>
  <div class="stat-row"><span class="label">Unrealized P&L</span><span class="value" id="posPnl">--</span></div>
  <div class="stat-row"><span class="label">TP Target</span><span class="value" id="posTp">0.50 (limit sell)</span></div>
</div>

<div class="card">
  <h3>Account</h3>
  <div class="stat-row"><span class="label">Capital</span><span class="value" id="bankroll">--</span></div>
  <div class="stat-row"><span class="label">Realized P&L</span><span class="value" id="realized">--</span></div>
  <div class="stat-row"><span class="label">Fees Paid</span><span class="value" id="fees">--</span></div>
  <div class="stat-row"><span class="label">Win / Loss</span><span class="value" id="wl">--</span></div>
  <div class="stat-row"><span class="label">Peak</span><span class="value" id="peak">--</span></div>
  <div class="stat-row"><span class="label">Max Drawdown</span><span class="value" id="drawdown">--</span></div>
</div>

<div class="card">
  <h3>Window</h3>
  <div class="stat-row"><span class="label">Window</span><span class="value" id="window">--</span></div>
  <div class="stat-row"><span class="label">Status</span><span class="value" id="status">--</span></div>
  <div class="window-bar"><div class="fill" id="windowBar" style="width:0%"></div></div>
</div>

<div class="card">
  <h3>Equity Curve</h3>
  <div class="equity-chart"><canvas id="eqChart"></canvas></div>
</div>

<script>
let es;
function connect() {
  es = new EventSource('/events');
  es.onmessage = (e) => {
    try { update(JSON.parse(e.data)); } catch(err) {}
  };
  es.onerror = () => { setTimeout(connect, 3000); es.close(); };
}

function update(s) {
  const $ = id => document.getElementById(id);
  $('strategy').textContent = \`Wait \${s.config?.waitSeconds||30}s · Buy underdog ≤ \${s.config?.cheapThreshold||0.20} · TP @ \${s.config?.tpPrice||0.50} · \${s.config?.basePct||10}% base · No SL · No martingale\`;
  $('upPrice').textContent = s.upAsk != null ? s.upAsk.toFixed(3) : '--';
  $('dnPrice').textContent = s.dnAsk != null ? s.dnAsk.toFixed(3) : '--';

  if (s.position) {
    $('posCard').style.display = 'block';
    $('posSide').textContent = s.position.side;
    $('posSide').className = 'value ' + (s.position.side==='UP'?'green':'red');
    $('posShares').textContent = s.position.shares;
    $('posEntry').textContent = s.position.entryPrice.toFixed(3);
    $('posCost').textContent = '$' + s.position.cost.toFixed(2);
    const pnl = s.position.unrealized;
    $('posPnl').textContent = (pnl>=0?'+':'') + '$' + Math.abs(pnl).toFixed(2);
    $('posPnl').className = 'value ' + (pnl>=0?'green':'red');
  } else {
    $('posCard').style.display = 'none';
  }

  $('bankroll').textContent = '$' + s.bankroll.toFixed(2);
  const rpnl = s.realizedPnl;
  $('realized').textContent = (rpnl>=0?'+':'') + '$' + Math.abs(rpnl).toFixed(2);
  $('realized').className = 'value ' + (rpnl>=0?'green':'red');
  $('fees').textContent = '$' + s.totalFeesPaid.toFixed(2);
  $('wl').textContent = s.wins + ' / ' + s.losses;
  $('peak').textContent = '$' + s.peakEquity.toFixed(2);
  $('drawdown').textContent = (s.maxDrawdown*100).toFixed(1) + '%';

  $('window').textContent = s.currentWindow || '--';
  const elapsed = s.windowElapsed || 0;
  const dur = s.windowDuration || 300;
  $('windowBar').style.width = Math.min(100, (elapsed/dur*100)).toFixed(1) + '%';
  if (s.position) $('status').innerHTML = '<span class="tag trade">IN POSITION — TP limit @ 0.50</span>';
  else if (elapsed < 30) $('status').innerHTML = '<span class="tag wait">WAITING ' + (30-elapsed) + 's</span>';
  else $('status').innerHTML = '<span class="tag done">SCANNING</span>';

  drawChart(s.equityCurve || []);
}

function drawChart(data) {
  const canvas = document.getElementById('eqChart');
  if (!canvas || !data.length) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);
  const vals = data.map(d => d.equity);
  const mn = Math.min(...vals) * 0.99;
  const mx = Math.max(...vals) * 1.01;
  const range = mx - mn || 1;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - mn) / range) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = vals[vals.length-1] >= vals[0] ? '#3fb950' : '#f85149';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

connect();
</script>
</body></html>`;

const http = require('http');
const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(':\n\n');
    const id = setInterval(() => {
      try { res.write(`data: ${JSON.stringify(engine.buildState())}\n\n`); } catch(e) {}
    }, 1000);
    req.on('close', () => clearInterval(id));
    return;
  }
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(engine.buildState()));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(dashboard);
}).listen(PORT, () => {
  console.log(`CheapHunter listening on :${PORT}`);
  engine.start().catch(e => console.error('ENGINE ERROR:', e));
});
