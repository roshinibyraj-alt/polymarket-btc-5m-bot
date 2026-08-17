'use strict';

const DATA_API  = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

const WATCH_WALLET = (process.env.WATCH_WALLET || '0x251c1a283703beed41590b0875a8dcb8ddd1541f').trim();
const POLL_MS      = Number(process.env.POLL_INTERVAL_MS || 1000);
const SWEEP_MS     = Number(process.env.POSITION_SWEEP_INTERVAL_MS || 15000);
const CAPITAL      = Number(process.env.DEMO_CAPITAL || 20000);
const COPY_PCT     = 0.05;

function round2(n) { return Math.round(n * 100) / 100; }

let emitFn = () => {};
let slogFn = () => {};
let logs = [];
let trades = [];
let positions = {};
let windowHistory = [];
let bankroll = CAPITAL;
let wins = 0, losses = 0;
let realizedPnl = 0;
let equityCurve = [{ t: Date.now(), equity: CAPITAL }];
let watchAddress = null;
let seenTradeIds = new Set();
let biggestBuy = null;
let smallestBuy = null;
let biggestBuys = [];
let smallestBuys = [];
let masterPositions = [];
let startTime = Date.now();

function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 500) logs.shift();
  slogFn(line);
}

async function getJSON(url, timeout = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'copy-bot/3.0' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function key(cid, outcome) { return cid + ':' + outcome; }

async function resolveMasterWallet(input) {
  if (!input.startsWith('@')) return input.toLowerCase();
  try {
    const data = await getJSON(`${DATA_API}/profile/${encodeURIComponent(input)}`);
    if (data && data.proxyWallet) return data.proxyWallet.toLowerCase();
  } catch (_) {}
  return input.toLowerCase();
}

async function pollMasterTrades() {
  try {
    const data = await getJSON(`${DATA_API}/trades?user=${watchAddress}&limit=20`);
    if (!Array.isArray(data)) return;
    for (const t of data) {
      const tid = t.id || t.transactionHash + t.timestamp;
      if (seenTradeIds.has(tid)) continue;
      seenTradeIds.add(tid);
      if (seenTradeIds.size > 5000) { const a = [...seenTradeIds]; seenTradeIds = new Set(a.slice(-2500)); }
      if (t.side !== 'BUY') continue;
      await mirrorBuy(t);
    }
  } catch (e) { log(`⚠️ Poll: ${e.message}`); }
}

async function mirrorBuy(t) {
  const cid = t.conditionId || t.market;
  const outcome = t.outcome;
  if (!cid || !outcome) return;
  const k = key(cid, outcome);
  const masterShares = Math.abs(Number(t.size) || 0);
  const price = Number(t.price) || 0;
  if (!masterShares || !price) return;

  const copyShares = round2(masterShares * COPY_PCT);
  const cost = round2(copyShares * price);
  if (cost > bankroll) { log(`⚠️ No funds for $${cost.toFixed(2)}`); return; }

  const slug = t.slug || t.title || cid;
  const title = t.title || slug;

  if (positions[k]) {
    const p = positions[k];
    const totalSh = round2(p.shares + copyShares);
    p.avgPrice = round2(((p.shares * p.avgPrice) + cost) / totalSh);
    p.shares = totalSh;
    p.cost = round2(p.cost + cost);
    p.buys++;
  } else {
    positions[k] = {
      conditionId: cid, outcome, title, slug,
      shares: copyShares, avgPrice: price, cost,
      buys: 1, status: 'open', openedAt: new Date().toISOString(), curPrice: price,
    };
  }
  bankroll = round2(bankroll - cost);

  const trade = {
    t: Math.floor(Date.now() / 1000), action: 'BUY', side: outcome,
    price, shares: copyShares, cost, slug, title,
    masterShares, masterPrice: price,
  };
  trades.push(trade);
  if (trades.length > 500) trades.shift();
  updateBigSmall(trade);

  log(`📥 COPY BUY ${outcome.toUpperCase()} ${copyShares}sh @${price.toFixed(3)} = $${cost.toFixed(2)} (master ${masterShares}sh) [${shortSlug(slug)}]`);
  emitFn('trade', trade);
}

function updateBigSmall(trade) {
  biggestBuys.push(trade);
  smallestBuys.push(trade);
  biggestBuys.sort((a, b) => b.shares - a.shares);
  smallestBuys.sort((a, b) => a.shares - b.shares);
  if (biggestBuys.length > 10) biggestBuys.length = 10;
  if (smallestBuys.length > 10) smallestBuys.length = 10;
}

function shortSlug(s) {
  if (!s) return '';
  const m = s.match(/(\d{10,})/);
  if (m) return '...' + m[1].slice(-6);
  return s.length > 20 ? s.slice(0, 20) + '...' : s;
}

async function pollMasterPositions() {
  try {
    const data = await getJSON(`${DATA_API}/positions?user=${watchAddress}&limit=50`);
    if (Array.isArray(data)) masterPositions = data;
  } catch (_) {}
}

async function sweepResolutions() {
  const openKeys = Object.keys(positions).filter(k => positions[k].status === 'open');
  if (!openKeys.length) return;
  const cids = [...new Set(openKeys.map(k => positions[k].conditionId))];
  for (const cid of cids) {
    try {
      const mkts = await getJSON(`${GAMMA_API}/markets?condition_ids=${encodeURIComponent(cid)}`);
      const mk = Array.isArray(mkts) ? mkts[0] : null;
      if (!mk || !mk.closed) continue;
      const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : (mk.outcomePrices || []);
      const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
      for (const k of openKeys) {
        const p = positions[k];
        if (p.conditionId !== cid) continue;
        const idx = outcomes.findIndex(o => o === p.outcome || o.toLowerCase() === p.outcome.toLowerCase());
        if (idx < 0) continue;
        const won = prices[idx] != null && Number(prices[idx]) >= 0.5;
        settlePosition(k, won);
      }
    } catch (_) {}
  }
}

function settlePosition(k, won) {
  const p = positions[k];
  if (!p || p.status !== 'open') return;
  const payout = won ? round2(p.shares) : 0;
  const pnl = round2(payout - p.cost);
  bankroll = round2(bankroll + payout);
  realizedPnl = round2(realizedPnl + pnl);
  if (won) wins++; else losses++;
  p.status = 'settled';
  p.pnl = pnl;
  p.won = won;
  p.settledAt = new Date().toISOString();

  windowHistory.push({
    slug: p.slug, side: p.outcome, shares: p.shares, avgPrice: p.avgPrice,
    cost: p.cost, payout, pnl, won, settledAt: p.settledAt,
  });
  if (windowHistory.length > 100) windowHistory.shift();

  log(`🏁 ${won ? '✅ WIN' : '❌ LOSS'} ${p.outcome.toUpperCase()} ${shortSlug(p.slug)} — P&L ${pnl >= 0 ? '+$' : '-$'}${Math.abs(pnl).toFixed(2)} (cost $${p.cost.toFixed(2)}, payout $${payout.toFixed(2)})`);
  recordEquity();
}

function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 2000) equityCurve.shift();
}

function markValue() {
  let v = bankroll;
  for (const k of Object.keys(positions)) {
    const p = positions[k];
    if (p.status === 'open') v += p.shares * (p.curPrice || p.avgPrice);
  }
  return round2(v);
}

function totalWindowsCost() {
  return round2(windowHistory.reduce((s, w) => s + w.cost, 0));
}
function totalWonCost() {
  return round2(windowHistory.filter(w => w.won).reduce((s, w) => s + w.cost, 0));
}
function totalLostCost() {
  return round2(windowHistory.filter(w => !w.won).reduce((s, w) => s + w.cost, 0));
}
function totalWonPnl() {
  return round2(windowHistory.filter(w => w.won).reduce((s, w) => s + w.pnl, 0));
}
function totalLostPnl() {
  return round2(windowHistory.filter(w => !w.won).reduce((s, w) => s + w.pnl, 0));
}

function buildState() {
  const mv = markValue();
  const winRate = (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null;
  return {
    watchWallet: watchAddress || WATCH_WALLET,
    demoCapital: CAPITAL,
    bankroll, markValue: mv,
    realizedPnl, totalPnl: round2(mv - CAPITAL),
    wins, losses, winRate,
    positions: Object.values(positions).filter(p => p.status === 'open'),
    trades: trades.slice(-100).reverse(),
    biggestBuy: biggestBuys[0] || null,
    smallestBuy: smallestBuys[0] || null,
    biggestBuys: biggestBuys.slice(0, 10),
    smallestBuys: smallestBuys.slice(0, 10),
    windowHistory: windowHistory.slice(-30).reverse(),
    totalWindows: windowHistory.length,
    totalWindowsCost: totalWindowsCost(),
    totalWonCost: totalWonCost(),
    totalLostCost: totalLostCost(),
    totalWonPnl: totalWonPnl(),
    totalLostPnl: totalLostPnl(),
    equityCurve,
    logs: logs.slice(-200),
    config: { pollMs: POLL_MS, copyPct: COPY_PCT, capital: CAPITAL },
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

let lastSweep = 0, lastPosPoll = 0;

async function mainLoop() {
  while (true) {
    try {
      await pollMasterTrades();
      const now = Date.now();
      if (now - lastPosPoll > 30000) { lastPosPoll = now; await pollMasterPositions(); }
      if (now - lastSweep > SWEEP_MS) { lastSweep = now; await sweepResolutions(); recordEquity(); }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️ Loop: ${e.message}`); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

async function init(emit, slogFnArg) {
  emitFn = emit;
  slogFn = slogFnArg;
  watchAddress = await resolveMasterWallet(WATCH_WALLET);
  log(`🚀 Copy bot watching ${watchAddress} — ${COPY_PCT * 100}% copy — $${CAPITAL} demo`);
  await pollMasterPositions();
  log(`👀 Master has ${masterPositions.length} open positions`);
  mainLoop();
}

function pauseTrading() { log('⏸️ Paused'); return { ok: true }; }
function resumeTrading() { log('▶️ Resumed'); return { ok: true }; }
function getStatus() { return buildState(); }

module.exports = { init, getStatus, pauseTrading, resumeTrading };
