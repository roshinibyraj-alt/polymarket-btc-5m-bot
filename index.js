'use strict';

/**
 * index.js — Express + socket.io dashboard for the binary copy-trading
 * bot. Serves the single-page dashboard (public-facing HTML below),
 * a JSON status API, and starts the copy-bot loop.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bot = require('./copy-bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/status', (_, res) => {
  try { res.json(bot.getStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/learn', (_, res) => {
  const s = bot.getStatus();
  res.json({ ok: true, learning: s.learning, learningError: s.learningError, watchWallet: s.watchWallet });
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
<title>🪞 Polymarket Binary Copy-Trading Bot</title>
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
  .toolbar-status { padding: 12px 20px 0; font-size: 11px; color: var(--muted); }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 16px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .stat-val { font-size: 19px; margin-top: 4px; }
  .stat-sub { font-size: 10px; color: var(--muted); margin-top: 2px; }
  .pnl-pos { color: var(--green); }
  .pnl-neg { color: var(--red); }
  .equity-wrap { margin: 0 20px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
  .equity-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .equity-hdr .title { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .equity-hdr .val { font-size: 18px; }
  .equity-svg { width: 100%; height: 90px; background: var(--bg3); border-radius: 8px; }
  .section { margin: 18px 20px 0; }
  .section-hdr { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 8px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .logs-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px; max-height: 320px; overflow-y: auto; font-size: 10px; }
  .logs-wrap div { padding: 1px 0; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 10px; }
  .behaviors { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .bh { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 10px; }
  .bh b { display: block; font-size: 11px; }
  .bh .conf { color: var(--cyan); }
  .bh-pos { border-color: var(--green); color: var(--green); }
  .bh-neg { border-color: var(--red); color: var(--red); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 10px; }
  .kv .k { color: var(--muted); }
  .strat-read { background: #e8f4fb; border: 1px solid var(--cyan); border-left: 4px solid var(--cyan); border-radius: 8px; padding: 10px 12px; font-size: 10px; line-height: 1.6; white-space: pre-line; margin-bottom: 12px; }
  .fire-tbl { width: 100%; border-collapse: collapse; margin-top: 10px; }
  .fire-tbl th { background: var(--bg3); color: var(--muted); padding: 5px 7px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; }
  .fire-tbl td { padding: 5px 7px; border-bottom: 1px solid var(--border); font-size: 10px; vertical-align: top; }
  .firebar-row { display: flex; align-items: flex-end; gap: 1px; height: 22px; margin-top: 3px; min-width: 120px; }
  .firebar { background: linear-gradient(180deg, var(--cyan), #00607f); border-radius: 1px; min-width: 1px; }
  .firebar-tip { color: var(--muted); font-size: 9px; margin-top: 2px; }
  .side-up { color: var(--green); }
  .side-down { color: var(--red); }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">🪞 <span>COPY</span>-TRADING BOT — BINARY EVENTS</div>
      <div class="wallet-tag" id="wallet-tag">watching —</div>
    </div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>
  <div id="wallet-warn" class="wallet-warn">⚠️ <span id="wallet-warn-text">No wallet configured yet.</span></div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">Pause</button>
    <button id="resume-btn" class="resume">Resume</button>
    <button id="learn-btn">🧠 Refresh Learning</button>
  </div>
  <div id="toolbar-status" class="toolbar-status"></div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Master Realized P&amp;L</div><div class="stat-val" id="m-realized">—</div><div class="stat-sub" id="m-realized-sub">—</div></div>
    <div class="stat"><div class="stat-label">Master Windows</div><div class="stat-val" id="m-windows">—</div><div class="stat-sub" id="m-windows-sub">—</div></div>
    <div class="stat"><div class="stat-label">Master Win Rate</div><div class="stat-val" id="m-winrate">—</div><div class="stat-sub" id="m-winrate-sub">—</div></div>
    <div class="stat"><div class="stat-label">Master Net P&amp;L</div><div class="stat-val" id="m-net">—</div><div class="stat-sub" id="m-net-sub">open —</div></div>
    <div class="stat"><div class="stat-label">Mirror Bankroll</div><div class="stat-val" id="bankroll">—</div><div class="stat-sub">demo $—</div></div>
    <div class="stat"><div class="stat-label">Mirror P&amp;L</div><div class="stat-val" id="mirror-pnl">—</div><div class="stat-sub" id="mirror-pnl-sub">equity —</div></div>
    <div class="stat"><div class="stat-label">Mirror Win Rate</div><div class="stat-val" id="mirror-winrate">—</div><div class="stat-sub" id="mirror-winloss">0W / 0L</div></div>
    <div class="stat"><div class="stat-label">Open (master / mirror)</div><div class="stat-val" id="open-count">—</div></div>
    <div class="stat"><div class="stat-label">Mirroring</div><div class="stat-val" id="trading-flag">ON</div></div>
    <div class="stat"><div class="stat-label">Last Poll</div><div class="stat-val" id="last-poll" style="font-size:13px">—</div><div class="stat-sub" id="uptime">uptime —</div></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr"><div class="title">Paper Mirror Equity Curve</div><div class="val" id="equity-val">—</div></div>
    <div id="equity-chart"><svg class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none"></svg></div>
  </div>

  <div class="section"><div class="section-hdr">🧠 Learning — Master Strategy Fingerprint</div></div>
  <div class="section" style="padding-top:0"><div class="card" id="learn-panel"><div class="empty">Learning model not ready yet — it needs a full activity fetch (~1 min on first boot).</div></div></div>

  <div class="section grid2" style="margin-top:18px">
    <div>
      <div class="section-hdr" style="padding:0 0 8px">Master vs Mirrored (binary positions)</div>
      <div class="tbl-wrap" id="positions-wrap"><div class="empty">No positions</div></div>
    </div>
    <div>
      <div class="section-hdr" style="padding:0 0 8px">Resolved Mirrored Windows</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Window</th><th>Side</th><th>Sh</th><th>Avg</th><th>P&amp;L</th></tr></thead>
          <tbody id="resolved-body"><tr><td colspan="5" class="empty">No resolved windows yet</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr" style="padding:0 0 8px">Mirrored Trades (paper)</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Time</th><th>Fire into window</th><th>Action</th><th>Window</th><th>Side</th><th>Price</th><th>Shares</th><th>Cost</th></tr></thead>
        <tbody id="trade-body"><tr><td colspan="8" class="empty">No mirrored trades yet</td></tr></tbody>
      </table>
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
  const short = slug => (slug || '').replace(/^btc-updown-/, '').replace(/-(\d+)$/, '');

  function buildEquitySvg(curve, w, h, capitalLine) {
    if (!curve || curve.length < 2) return '';
    const vals = curve.map(p => p.equity);
    const min = Math.min(...vals, capitalLine != null ? capitalLine : Infinity);
    const max = Math.max(...vals, capitalLine != null ? capitalLine : -Infinity);
    const range = (max - min) || 1;
    const pts = curve.map((p, i) => {
      const x = (i / (curve.length - 1)) * w;
      const y = h - ((p.equity - min) / range) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = vals[vals.length - 1], first = vals[0];
    const color = last >= first ? '#00a854' : '#e8304a';
    let extra = '';
    if (capitalLine != null) {
      const y = h - ((capitalLine - min) / range) * h;
      extra = '<line x1="0" y1="'+y.toFixed(1)+'" x2="'+w+'" y2="'+y.toFixed(1)+'" stroke="#7a8fa8" stroke-width="1" stroke-dasharray="3,3" />';
    }
    return extra + '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="2" />';
  }

  function renderLearning(s) {
    const el = document.getElementById('learn-panel');
    const l = s.learning;
    if (!l) {
      el.innerHTML = s.learningError ? '<div class="empty">Learning refresh failed: ' + s.learningError + '</div>' : '<div class="empty">Learning model not ready yet.</div>';
      return;
    }
    const o = l.overview, mix = l.mix, st = l.stakes, tm = l.timing;
    const behaviors = (l.behaviors || []).map(b => {
      const cls = b.name === 'PROFITABLE' ? 'bh-pos' : (b.name === 'LOSING' ? 'bh-neg' : '');
      return '<div class="bh ' + cls + '"><b>' + b.name + '</b><span class="conf">conf ' + Math.round(b.confidence * 100) + '%</span><div style="color:var(--muted);font-weight:normal">' + (b.detail || '') + '</div></div>';
    }).join('');
    const d = (x, dp) => x != null ? x.toFixed(dp != null ? dp : 2) : '—';
    const dec = (x) => x ? 'min ' + d(x.min,3) + ' · p25 ' + d(x.p25,3) + ' · p50 ' + d(x.p50,3) + ' · p75 ' + d(x.p75,3) + ' · p90 ' + d(x.p90,3) + ' · max ' + d(x.max,3) : '—';
    const hours = Object.entries(tm.hourHist || {}).sort((a,b) => a[0]-b[0]).map(([h,c]) => h + 'h:' + c).join(' · ');
    const rf = l.repeatFade || {};
    const fr = l.firePattern || {};
    const mm = x => { if (x == null) return '—'; const m = Math.floor(x / 60), sc = Math.round(x % 60); return m + 'm' + String(sc).padStart(2, '0') + 's'; };
    const fireRows = ['5m','15m','1h'].filter(tf => fr[tf]).map(tf => {
      const fp = fr[tf];
      const bk = fp.fireBuckets || [];
      const maxC = Math.max(1, ...bk.map(b => b.count));
      const bars = bk.map(b => '<span class="firebar" style="height:' + Math.max(8, Math.round(b.count / maxC * 100)) + '%" title="+' + mm(b.sec) + ' → ' + b.count + ' fills"></span>').join('');
      const sr = fp.sizeRatio && fp.sizeRatio.p50 != null ? (fp.sizeRatio.p50 > 1.15 ? 'up ' + fp.sizeRatio.p50.toFixed(2) + 'x' : fp.sizeRatio.p50 < 0.85 ? 'down ' + fp.sizeRatio.p50.toFixed(2) + 'x' : 'flat') : '—';
      const pd = fp.priceDelta && fp.priceDelta.p50 != null ? (fp.priceDelta.p50 > 0 ? '+' : '') + fp.priceDelta.p50.toFixed(3) : '—';
      const skip = fp.skipGaps && fp.skipGaps.p50 != null ? (fp.skipGaps.p50 >= 1 ? 'skip ' + fp.skipGaps.p50 + ' / ~1 in ' + Math.round(fp.skipGaps.p50 + 1) : 'every window') : '—';
      return '<tr><td><b>' + tf + '</b><div class="firebar-row">' + bars + '</div><div class="firebar-tip">12 buckets · open → close</div></td>' +
        '<td>' + fp.windows + ' / ' + fp.buys + '</td>' +
        '<td>' + d(fp.buysPerWindow && fp.buysPerWindow.p50, 1) + ' (max ' + d(fp.buysPerWindow && fp.buysPerWindow.max) + ')</td>' +
        '<td>' + mm(fp.firstBuySec && fp.firstBuySec.p50) + '</td>' +
        '<td>' + mm(fp.lastBuySec && fp.lastBuySec.p50) + '</td>' +
        '<td>' + mm(fp.gapSec && fp.gapSec.p50) + ' (p90 ' + mm(fp.gapSec && fp.gapSec.p90) + ')</td>' +
        '<td>' + (fp.firstHalfShare != null ? Math.round(fp.firstHalfShare * 100) + '%' : '—') + '</td>' +
        '<td>' + sr + '</td><td>' + pd + '</td><td>' + skip + '</td></tr>';
    }).join('');
    const stratRead = (l.strategyRead || '').split('\\n').filter(Boolean).map(x => '<div>' + x + '</div>').join('');
    const fireTbl = fireRows ? '<table class="fire-tbl"><thead><tr><th>Window / fire timeline</th><th>Windows / fills</th><th>Fills/window</th><th>First buy</th><th>Last buy</th><th>Gap between fills</th><th>Fills 1st half</th><th>Size trend</th><th>Price Δ/fill</th><th>Window skipping</th></tr></thead><tbody>' + fireRows + '</tbody></table>' : '';

    el.innerHTML =
      (stratRead ? '<div class="strat-read">' + stratRead + '</div>' : '') +
      '<div class="behaviors">' + behaviors + '</div>' +
      fireTbl +
      '<div class="kv">' +
        '<span class="k">Observed</span><span>' + d(o.spanHours,1) + 'h · ' + o.windows + ' windows · ' + o.trades + ' trades (' + o.buys + ' buys / ' + o.sells + ' sells / ' + o.redeems + ' redeems)</span>' +
        '<span class="k">Volume</span><span>$' + d(o.volumeUsdc) + ' spent buying</span>' +
        '<span class="k">Realized</span><span class="' + pClass(o.realizedPnl) + '">' + sgn(o.realizedPnl) + '</span>' +
        '<span class="k">Open positions</span><span class="' + pClass(o.currentCashPnl) + '">' + sgn(o.currentCashPnl) + ' (value $' + d(o.currentValue) + ' / cost $' + d(o.currentInit) + ')</span>' +
        '<span class="k">Net (realized + open)</span><span class="' + pClass(o.netPnl) + '">' + sgn(o.netPnl) + '</span>' +
        '<span class="k">Windows redeemed</span><span>' + d(o.winRate,1) + '% · net-profitable ' + d(o.profitableWindows,1) + '% · avg edge ' + sgn(o.avgEdgePerWindow) + '/window</span>' +
        '<span class="k">Market mix</span><span>5m ' + (mix.counts['5m']||0) + ' (' + (mix.usdc['5m']||0).toFixed(0) + '$) · 15m ' + (mix.counts['15m']||0) + ' (' + (mix.usdc['15m']||0).toFixed(0) + '$)</span>' +
        '<span class="k">Sides</span><span>UP ' + (mix.sides.UP||0) + ' / DOWN ' + (mix.sides.DOWN||0) + ' · mixed windows ' + o.mixedWindows + '</span>' +
        '<span class="k">Buy price</span><span>' + dec(st.buyPrice) + '</span>' +
        '<span class="k">Buy size</span><span>' + dec(st.buySize) + ' shares</span>' +
        '<span class="k">Buys/window</span><span>' + dec(st.buysPerWindow) + '</span>' +
        '<span class="k">Cost/window</span><span>$' + d(st.costPerWindow && st.costPerWindow.p50) + ' median (max $' + d(st.costPerWindow && st.costPerWindow.max) + ')</span>' +
        '<span class="k">Entry timing</span><span>' + Object.entries(tm.entryFracBuckets || {}).map(([k,v]) => k + '=' + v).join(' ') + '</span>' +
        '<span class="k">Hour activity</span><span>' + hours + '</span>' +
        '<span class="k">Repeat vs fade</span><span>repeat ' + (rf.repeat||0) + ' / fade ' + (rf.fade||0) + ' (vs previous window winner)</span>' +
      '</div>';
  }

  document.getElementById('pause-btn').addEventListener('click', async () => {
    try { const r = await fetch('/api/pause', { method: 'POST' }); const d = await r.json(); statusEl.textContent = d.ok ? '⏸️ Paused' : '❌ ' + (d.error||'failed'); } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });
  document.getElementById('resume-btn').addEventListener('click', async () => {
    try { const r = await fetch('/api/resume', { method: 'POST' }); const d = await r.json(); statusEl.textContent = d.ok ? '▶️ Resumed' : '❌ ' + (d.error||'failed'); } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });
  document.getElementById('learn-btn').addEventListener('click', async () => {
    statusEl.textContent = '🧠 refreshing learning model…';
    try { const r = await fetch('/api/learn'); const d = await r.json(); statusEl.textContent = d.learning ? '🧠 fingerprint ready' : '❌ ' + (d.learningError||'not ready'); } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });

  socket.on('state', s => {
    document.getElementById('wallet-tag').textContent = 'watching ' + (s.watchWallet || '—');
    const warnEl = document.getElementById('wallet-warn');
    const warnText = document.getElementById('wallet-warn-text');
    if (s.resolveError) { warnText.textContent = s.resolveError; warnEl.style.display = 'block'; }
    else if (s.lastPollError) { warnText.textContent = 'Last poll failed: ' + s.lastPollError; warnEl.style.display = 'block'; }
    else { warnEl.style.display = 'none'; }

    const modeBadge = document.getElementById('mode-badge');
    modeBadge.className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    modeBadge.textContent = s.dryRun ? 'DEMO' : '🔴 LIVE';

    const m = s.master || {};
    const l = s.learning ? s.learning.overview : null;
    document.getElementById('m-realized').textContent = l ? sgn(l.realizedPnl) : '—';
    document.getElementById('m-realized-sub').textContent = l ? '$' + l.volumeUsdc.toFixed(0) + ' volume' : 'volume —';
    document.getElementById('m-windows').textContent = l ? l.windows : '—';
    document.getElementById('m-windows-sub').textContent = l ? l.spanHours.toFixed(1) + 'h observed' : '—';
    document.getElementById('m-winrate').textContent = l ? l.winRate.toFixed(1) + '%' : '—';
    document.getElementById('m-winrate-sub').textContent = l ? l.profitableWindows.toFixed(1) + '% net-profitable' : '—';
    document.getElementById('m-net').textContent = l ? sgn(l.netPnl) : '—';
    document.getElementById('m-net').className = 'stat-val ' + (l ? pClass(l.netPnl) : '');
    document.getElementById('m-net-sub').textContent = 'open ' + (l ? sgn(l.currentCashPnl) : '—');
    document.getElementById('bankroll').textContent = '$' + (s.bankroll || 0).toFixed(2);
    document.getElementById('bankroll').nextElementSibling.textContent = 'demo $' + (s.demoCapital || 0).toFixed(0);
    const tp = document.getElementById('mirror-pnl');
    tp.textContent = sgn(s.totalPnl); tp.className = 'stat-val ' + pClass(s.totalPnl);
    document.getElementById('mirror-pnl-sub').textContent = 'equity $' + (s.markValue || 0).toFixed(2);
    document.getElementById('mirror-winrate').textContent = s.winRate != null ? s.winRate + '%' : '—';
    document.getElementById('mirror-winloss').textContent = (s.wins || 0) + 'W / ' + (s.losses || 0) + 'L';
    document.getElementById('open-count').textContent = (m.positionsCount != null ? m.positionsCount : '—') + ' / ' + (s.positions || []).length;
    const tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ON' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');
    document.getElementById('last-poll').textContent = s.lastPollError ? '⚠️ error' : (s.lastPollAt ? new Date(s.lastPollAt).toISOString().slice(11,19) + 'Z' : '—');
    document.getElementById('uptime').textContent = 'uptime ' + fmt(s.uptime || 0);

    document.getElementById('equity-val').textContent = '$' + (s.markValue || 0).toFixed(2);
    document.getElementById('equity-val').className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = '<svg class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none">' + buildEquitySvg(s.equityCurve, 600, 90, s.demoCapital) + '</svg>';

    renderLearning(s);

    const masterByKey = {};
    (m.positions || []).forEach(p => masterByKey[p.conditionId + ':' + p.outcome] = p);
    const botByKey = {};
    (s.positions || []).forEach(p => botByKey[p.conditionId + ':' + p.outcome] = p);
    const allKeys = Array.from(new Set([...Object.keys(masterByKey), ...Object.keys(botByKey)]));
    const posWrap = document.getElementById('positions-wrap');
    if (allKeys.length > 0) {
      posWrap.innerHTML = '<table class="tbl"><thead><tr><th>Window</th><th>Side</th><th>Master</th><th>Bot Sh</th><th>Bot Avg</th><th>Bot Cost</th></tr></thead><tbody>' +
        allKeys.slice(0, 60).map(k => {
          const mb = masterByKey[k], b = botByKey[k];
          const title = (mb && mb.title) || (b && b.title) || k;
          const side = (mb && mb.outcome) || (b && b.outcome) || '—';
          const sideCls = side.toUpperCase().startsWith('U') ? 'side-up' : (side.toUpperCase().startsWith('D') ? 'side-down' : '');
          return '<tr><td title="' + (mb && mb.slug || b && b.slug || '') + '">' + short(mb && mb.slug || b && b.slug || '') + '</td>' +
            '<td class="' + sideCls + '">' + side + '</td>' +
            '<td>' + (mb ? mb.size : 0) + '</td>' +
            '<td>' + (b ? b.shares : 0) + '</td>' +
            '<td>' + (b ? b.avgPrice.toFixed(3) : '—') + '</td>' +
            '<td>' + (b ? '$' + b.cost.toFixed(2) : '—') + '</td></tr>';
        }).join('') + '</tbody></table>';
    } else {
      posWrap.innerHTML = '<div class="empty">No open positions</div>';
    }

    const rb = document.getElementById('resolved-body');
    if (s.windowHistory && s.windowHistory.length > 0) {
      rb.innerHTML = s.windowHistory.map(w => {
        const sideCls = w.side.toUpperCase().startsWith('U') ? 'side-up' : 'side-down';
        return '<tr><td>' + short(w.slug) + '</td><td class="' + sideCls + '">' + w.side + '</td><td>' + w.shares + '</td><td>' + w.avgPrice.toFixed(3) + '</td>' +
          '<td class="' + pClass(w.pnl) + '">' + sgn(w.pnl) + '</td></tr>';
      }).join('');
    } else {
      rb.innerHTML = '<tr><td colspan="5" class="empty">No resolved windows yet</td></tr>';
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const sideCls = t.side.toUpperCase().startsWith('U') ? 'side-up' : 'side-down';
        const fo = t.fireOffset != null ? '+' + Math.floor(t.fireOffset / 60) + ':' + String(Math.round(t.fireOffset % 60)).padStart(2, '0') : '—';
        return '<tr><td>' + new Date(t.t * 1000).toISOString().slice(11, 19) + '</td>' +
          '<td>' + fo + '</td>' +
          '<td><span class="' + (t.action === 'BUY' ? 'pnl-pos' : 'pnl-neg') + '">' + t.action + '</span></td>' +
          '<td>' + short(t.slug) + '</td>' +
          '<td class="' + sideCls + '">' + t.side + '</td>' +
          '<td>' + t.price.toFixed(3) + '</td>' +
          '<td>' + t.shares + '</td>' +
          '<td>$' + (t.cost || 0).toFixed(2) + '</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="8" class="empty">No mirrored trades yet</td></tr>';
    }

    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('💥') ? '#e8304a'
                  : l.includes('💰')||l.includes('✅') ? '#00a854'
                  : l.includes('🧠') ? '#b8860b'
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

console.log('🪞 Polymarket Binary Copy-Trading Bot — DEMO MODE — mirroring master binary trades');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
