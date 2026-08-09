'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./copy-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/status', (_, res) => {
  try { res.json(bot.getStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/pause', (_, res) => {
  try { res.json(bot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/resume', (_, res) => {
  try { res.json(bot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(bot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪞 Polymarket Copy-Trading Bot</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --gold: #b8860b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#f0f4f8,#e4ecf5); border-bottom: 2px solid #0099cc44; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 20px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
  .logo span { color: var(--cyan); }
  .wallet-tag { font-size: 10px; color: var(--muted); word-break: break-all; }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #ff475722; color: var(--red); border: 1px solid var(--red); }
  .wallet-warn { display: none; margin: 10px 20px 0; padding: 10px 14px; background: #e8304a18; color: var(--red); border: 1px solid var(--red); border-radius: 8px; font-size: 11px; }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--cyan); color: #001018; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .toolbar-status { padding: 6px 20px 0; font-size: 10px; color: var(--muted); min-height: 14px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 20px; font-weight: bold; color: #12202e; }
  .stat-sub { font-size: 9px; color: var(--muted); margin-top: 3px; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .equity-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin: 0 20px 14px; }
  .equity-hdr { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .equity-hdr .title { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .equity-hdr .val { font-size: 13px; }
  .equity-svg { width: 100%; height: 90px; display: block; }
  .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
  @media (max-width: 800px) { .bottom-grid { grid-template-columns: 1fr; } }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .logs-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px; max-height: 320px; overflow-y: auto; font-size: 10px; }
  .logs-wrap div { padding: 1px 0; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 10px; }
  .reason-tag { padding: 2px 7px; border-radius: 8px; font-size: 9px; }
  .reason-OPEN { background: #00a85422; color: var(--green); }
  .reason-ADD { background: #0099cc22; color: var(--cyan); }
  .reason-REDUCE { background: #e6a80022; color: var(--yellow); }
  .reason-CLOSE { background: #e8304a22; color: var(--red); }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">🪞 <span>COPY</span>-TRADING BOT</div>
      <div class="wallet-tag" id="wallet-tag">watching —</div>
    </div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>
  <div id="wallet-warn" class="wallet-warn">⚠️ <span id="wallet-warn-text">Perps auth is not configured — the bot cannot read the master wallet yet.</span></div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">Pause</button>
    <button id="resume-btn" class="resume">Resume</button>
  </div>
  <div id="toolbar-status" class="toolbar-status"></div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Mark Value</div><div class="stat-val" id="mark-value">$0.00</div></div>
    <div class="stat"><div class="stat-label">Total P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Realized</div><div class="stat-val" id="realized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val" id="bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val" id="win-rate">—</div><div class="stat-sub" id="win-loss-sub">0W / 0L</div></div>
    <div class="stat"><div class="stat-label">Mirroring</div><div class="stat-val" id="trading-flag">ON</div></div>
    <div class="stat"><div class="stat-label">Master Positions</div><div class="stat-val" id="master-count">—</div></div>
    <div class="stat"><div class="stat-label">Last Poll</div><div class="stat-val" id="last-poll" style="font-size:13px">—</div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">0s</div></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr"><div class="title">Paper Equity Curve</div><div class="val" id="equity-val">$0.00</div></div>
    <div id="equity-chart"><svg class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none"></svg></div>
  </div>

  <div class="section"><div class="section-hdr">Perps Positions — Master vs Mirrored</div></div>
  <div class="section" style="padding-top:0"><div class="tbl-wrap" id="positions-wrap"><div class="empty">No open positions</div></div></div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr" style="padding:0 0 8px">Master Portfolio (perps)</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>uPnL</th><th>Lev</th></tr></thead>
          <tbody id="master-body"><tr><td colspan="6" class="empty">No perps positions</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr" style="padding:0 0 8px">Mirrored Trades (paper)</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Action</th><th>Symbol</th><th>Dir</th><th>Price</th><th>Size</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="7" class="empty">No mirrored trades yet</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr" style="padding:0 0 8px">Logs</div>
    <div class="logs-wrap" id="logs"></div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const statusEl = document.getElementById('toolbar-status');
  const sgn = v => (v >= 0 ? '+$' : '-$') + Math.abs(v || 0).toFixed(2);
  const pClass = v => (v >= 0 ? 'pnl-pos' : 'pnl-neg');
  const fmt = s => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60); return (h?h+'h ':'')+(m?m+'m ':'')+sec+'s'; };

  function buildEquitySvg(curve, w, h, capitalLine) {
    if (!curve || curve.length < 2) return '';
    const vals = curve.map(p => p.equity);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (capitalLine != null) { min = Math.min(min, capitalLine); max = Math.max(max, capitalLine); }
    const pad = (max - min) * 0.1 || 1;
    min -= pad; max += pad;
    const pts = curve.map((p, i) => {
      const x = (i / (curve.length - 1)) * w;
      const y = h - ((p.equity - min) / (max - min)) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = vals[vals.length - 1], first = vals[0];
    const color = last >= first ? '#00a854' : '#e8304a';
    let extra = '';
    if (capitalLine != null) {
      const y = h - ((capitalLine - min) / (max - min)) * h;
      extra = '<line x1="0" y1="'+y.toFixed(1)+'" x2="'+w+'" y2="'+y.toFixed(1)+'" stroke="#7a8fa8" stroke-width="1" stroke-dasharray="3,3" />';
    }
    return extra + '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="2" />';
  }

  document.getElementById('pause-btn').addEventListener('click', async () => {
    try { const r = await fetch('/api/pause', { method: 'POST' }); const d = await r.json(); statusEl.textContent = d.ok ? '⏸️ Paused' : '❌ ' + (d.error||'failed'); } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });
  document.getElementById('resume-btn').addEventListener('click', async () => {
    try { const r = await fetch('/api/resume', { method: 'POST' }); const d = await r.json(); statusEl.textContent = d.ok ? '▶️ Resumed' : '❌ ' + (d.error||'failed'); } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });

  socket.on('state', s => {
    document.getElementById('wallet-tag').textContent = 'watching ' + (s.watchWallet || '—');
    const warnEl = document.getElementById('wallet-warn');
    const warnText = document.getElementById('wallet-warn-text');
    if (s.resolveError) { warnText.textContent = s.resolveError; warnEl.style.display = 'block'; }
    else if (s.lastPollError) { warnText.textContent = 'Last poll failed: ' + s.lastPollError; warnEl.style.display = 'block'; }
    else if (s.lastPollAt && s.masterPositionsCount === 0) { warnText.textContent = 'Master perps portfolio returned 0 open positions — the bot has nothing to mirror.'; warnEl.style.display = 'block'; }
    else { warnEl.style.display = 'none'; }
    document.getElementById('master-count').textContent = (s.masterPositionsCount ?? 0);
    document.getElementById('master-count').className = 'stat-val ' + ((s.masterPositionsCount ?? 0) > 0 ? 'pnl-pos' : '');
    const modeBadge = document.getElementById('mode-badge');
    modeBadge.className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    modeBadge.textContent = s.dryRun ? 'DEMO' : '🔴 LIVE';

    document.getElementById('mark-value').textContent = '$'+(s.markValue||0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl); pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    const relEl = document.getElementById('realized-pnl');
    relEl.textContent = sgn(s.realizedPnl); relEl.className = 'stat-val ' + pClass(s.realizedPnl);
    document.getElementById('bankroll').textContent = '$'+(s.bankroll||0).toFixed(2);
    document.getElementById('win-rate').textContent = (s.winRate!==null && s.winRate!==undefined) ? s.winRate+'%' : '—';
    document.getElementById('win-loss-sub').textContent = (s.wins||0)+'W / '+(s.losses||0)+'L';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    const tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ON' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');
    document.getElementById('last-poll').textContent = s.lastPollError ? '⚠️ error' : (s.lastPollAt ? new Date(s.lastPollAt).toISOString().slice(11,19)+'Z' : '—');

    const eqVal = document.getElementById('equity-val');
    eqVal.textContent = '$'+(s.markValue||0).toFixed(2);
    eqVal.className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = '<svg class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none">'+buildEquitySvg(s.equityCurve, 600, 90, s.demoCapital)+'</svg>';

    const posWrap = document.getElementById('positions-wrap');
    const masterByKey = {};
    (s.masterPositions||[]).forEach(m => masterByKey[m.key] = m);
    const botByKey = {};
    (s.positions||[]).forEach(p => botByKey[p.key] = p);
    const allKeys = Array.from(new Set([...Object.keys(masterByKey), ...Object.keys(botByKey)]));
    if (allKeys.length > 0) {
      posWrap.innerHTML = '<table class="tbl"><thead><tr><th>Symbol</th><th>Side</th><th>Master Size</th><th>Bot Size</th><th>Bot Avg Entry</th></tr></thead><tbody>' +
        allKeys.map(k => {
          const m = masterByKey[k], b = botByKey[k];
          const symbol = (m && m.symbol) || (b && b.symbol) || k;
          const side = (m && m.side) || (b && b.side) || '—';
          const sideColor = side === 'LONG' ? '#00a854' : (side === 'SHORT' ? '#e8304a' : '');
          return '<tr><td>'+symbol+'</td><td style="color:'+sideColor+'">'+side+'</td><td>'+(m ? m.size : 0)+'</td><td>'+(b ? b.size : 0)+'</td><td>'+(b ? b.avgPrice.toFixed(2) : '—')+'</td></tr>';
        }).join('') +
        '</tbody></table>';
    } else {
      posWrap.innerHTML = '<div class="empty">No open positions</div>';
    }

    const mb = document.getElementById('master-body');
    if (s.masterPositions && s.masterPositions.length > 0) {
      mb.innerHTML = s.masterPositions.map(m => {
        const color = m.side === 'LONG' ? '#00a854' : '#e8304a';
        return '<tr><td>'+m.symbol+'</td><td style="color:'+color+'">'+m.side+'</td><td>'+m.size+'</td><td>'+(m.entryPrice||0).toFixed(2)+'</td><td class="'+pClass(m.unrealizedPnl)+'">'+sgn(m.unrealizedPnl)+'</td><td>'+m.leverage+'x</td></tr>';
      }).join('');
    } else {
      mb.innerHTML = '<tr><td colspan="6" class="empty">No perps positions</td></tr>';
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? pClass(t.profit) : '';
        const reason = t.reason || t.side;
        return '<tr><td>'+t.time+'</td>'+
          '<td><span class="reason-tag reason-'+reason+'">'+reason+'</span></td>'+
          '<td>'+t.symbol+'</td>'+
          '<td>'+(t.dir||'—')+'</td>'+
          '<td>'+(t.price||0).toFixed(3)+'</td>'+
          '<td>'+(t.size||0)+'</td>'+
          '<td class="'+pnlCls+'">'+pnlStr+'</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No mirrored trades yet</td></tr>';
    }

    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('💥') ? '#e8304a'
                  : l.includes('💰')||l.includes('✅') ? '#00a854'
                  : l.includes('🚀')||l.includes('👀') ? '#b8860b'
                  : l.includes('⏭️')||l.includes('⚠️') ? '#cc7a00'
                  : '#2f3f57';
        return '<div style="color:'+col+'">'+l+'</div>';
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }
  });
</script>
</body>
</html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

console.log('🪞 Polymarket Copy-Trading Bot — DEMO MODE — position mirroring');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
