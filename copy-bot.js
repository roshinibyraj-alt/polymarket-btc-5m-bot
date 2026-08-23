'use strict';

const DATA_API  = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

const WATCH_WALLET = (process.env.WATCH_WALLET || '0x32ed2e546b187ca15e2841edc82b22c713cf8ec3').trim();
const POLL_MS      = Number(process.env.POLL_INTERVAL_MS || 1000);
const SWEEP_MS     = Number(process.env.POSITION_SWEEP_INTERVAL_MS || 5000);
const CAPITAL      = Number(process.env.DEMO_CAPITAL || 20000);

function round2(n) { return Math.round(n * 100) / 100; }

let emitFn = () => {};
let slogFn = () => {};
let logs = [];
let trades = [];
let positions = {};
let bankroll = CAPITAL;
let wins = 0, losses = 0;
let realizedPnl = 0;
let equityCurve = [{ t: Date.now(), equity: CAPITAL }];
let watchAddress = null;
let seenTradeIds = new Set();
let biggestBuy = null;
let smallestBuy = null;
let masterPositions = [];
let windowCapitalStats = {
  '5m': { highest: null, lowest: null },
  '15m': { highest: null, lowest: null },
};
let startTime = Date.now();

// Active windows: key = slug
let windows = {};
// Resolved windows kept only for summary stats, removed from dashboard
let resolvedWindows = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 500) logs.shift();
  slogFn(line);
}

async function getJSON(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'copy-bot/5.0' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function key(cid, outcome) { return cid + ':' + outcome; }

function windowType(slug) {
  if (!slug) return 'unknown';
  if (/-5m-/i.test(slug)) return '5m';
  if (/-15m-/i.test(slug)) return '15m';
  if (/-1h-/i.test(slug) || /-60m-/i.test(slug)) return '1h';
  return 'unknown';
}

function fireOffsetSeconds(t) {
  const wt = windowType(t.slug);
  const wsec = wt === '5m' ? 300 : wt === '15m' ? 900 : wt === '1h' ? 3600 : null;
  if (!wsec || !t.timestamp) return null;
  return t.timestamp % wsec;
}

function updateWindowCapitalRecord(w) {
  const bucket = windowCapitalStats[w.type];
  if (!bucket) return;
  const snapshot = {
    slug: w.slug,
    type: w.type,
    totalCost: w.totalCost,
    upCost: w.upCost,
    downCost: w.downCost,
    upShares: w.upShares,
    downShares: w.downShares,
    updatedAt: Date.now(),
  };
  if (!bucket.highest || snapshot.totalCost > bucket.highest.totalCost) bucket.highest = { ...snapshot };
  if (!bucket.lowest || snapshot.totalCost < bucket.lowest.totalCost) bucket.lowest = { ...snapshot };
}

function shortSlug(s) {
  if (!s) return '';
  const m = s.match(/(\d{10,})/);
  if (m) return '...' + m[1].slice(-6);
  return s.length > 20 ? s.slice(0, 20) + '...' : s;
}

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

  const copyShares = masterShares;
  const cost = round2(copyShares * price);
  if (cost > bankroll) { log(`⚠️ No funds for $${cost.toFixed(2)}`); return; }

  const slug = t.slug || t.title || cid;
  const title = t.title || slug;
  const wt = windowType(slug);
  const offset = fireOffsetSeconds(t);

  // Update position
  if (positions[k]) {
    const p = positions[k];
    const totalSh = round2(p.shares + copyShares);
    p.avgPrice = round2(((p.shares * p.avgPrice) + cost) / totalSh);
    p.shares = totalSh;
    p.cost = round2(p.cost + cost);
    p.buys++;
    p.masterTotalShares = round2((p.masterTotalShares || 0) + masterShares);
    p.masterBuys = (p.masterBuys || 0) + 1;
  } else {
    positions[k] = {
      conditionId: cid, outcome, title, slug,
      shares: copyShares, avgPrice: price, cost,
      buys: 1, status: 'open', openedAt: new Date().toISOString(), curPrice: price,
      masterTotalShares: masterShares, masterBuys: 1,
    };
  }
  bankroll = round2(bankroll - cost);

  // Track per-window totals
  const wk = slug || cid;
  if (!windows[wk]) {
    windows[wk] = {
      slug: wk, type: wt, title,
      upShares: 0, downShares: 0, upCost: 0, downCost: 0,
      upMasterShares: 0, downMasterShares: 0,
      upBuys: 0, downBuys: 0,
      totalCost: 0, totalMasterShares: 0, totalBuys: 0,
      trades: [], resolved: false,
    };
  }
  const win = windows[wk];
  win.conditionIds = win.conditionIds || {};
  win.conditionIds[cid] = true;
  const isUp = outcome.toLowerCase() === 'up' || outcome.toLowerCase().includes('up');
  if (isUp) {
    win.upShares = round2(win.upShares + copyShares);
    win.upCost = round2(win.upCost + cost);
    win.upMasterShares = round2(win.upMasterShares + masterShares);
    win.upBuys++;
  } else {
    win.downShares = round2(win.downShares + copyShares);
    win.downCost = round2(win.downCost + cost);
    win.downMasterShares = round2(win.downMasterShares + masterShares);
    win.downBuys++;
  }
  win.totalCost = round2(win.totalCost + cost);
  win.totalMasterShares = round2(win.totalMasterShares + masterShares);
  win.totalBuys++;

  const tradeRecord = {
    t: Math.floor(Date.now() / 1000), timestamp: Math.floor(Date.now() / 1000), type: wt, side: outcome.toLowerCase(),
    shares: copyShares, price, cost, masterShares, masterPrice: price,
    slug: shortSlug(slug), fireOffset: offset, windowSlug: wk,
  };
  trades.push(tradeRecord);
  if (trades.length > 500) trades = trades.slice(-250);
  win.trades.push(tradeRecord);

  // Biggest / smallest tracking (by cost)
  if (!biggestBuy || cost > biggestBuy.cost) {
    biggestBuy = { ...tradeRecord, windowType: wt };
  }
  if (!smallestBuy || cost < smallestBuy.cost) {
    smallestBuy = { ...tradeRecord, windowType: wt };
  }

  log(`📥 COPY BUY ${outcome.toUpperCase()} ${copyShares}sh @${price.toFixed(3)} = $${cost.toFixed(2)} (master ${masterShares}sh) | window UP ${win.upShares}sh / DN ${win.downShares}sh`);
}

async function pollMasterPositions() {
  try {
    const data = await getJSON(`${DATA_API}/positions?user=${watchAddress}&limit=50`);
    if (Array.isArray(data)) masterPositions = data;
  } catch (_) {}
}

function updateOwnPricesFromMarket(market) {
  let outcomes = market.outcomes || [];
  let prices = market.outcomePrices || [];
  try {
    if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
    if (typeof prices === 'string') prices = JSON.parse(prices);
  } catch (_) { return; }

  for (const position of Object.values(positions)) {
    if (position.status !== 'open' || position.conditionId !== market.conditionId) continue;
    const index = outcomes.findIndex(outcome =>
      String(outcome).toLowerCase() === String(position.outcome).toLowerCase());
    const value = Number(prices[index]);
    if (Number.isFinite(value) && value >= 0 && value <= 1) position.curPrice = value;
  }
}

async function sweepResolutions() {
  const openKeys = Object.keys(positions).filter(k => positions[k].status === 'open');
  if (!openKeys.length) return;

  const byCid = {};
  for (const k of openKeys) {
    const cid = positions[k].conditionId;
    if (!byCid[cid]) byCid[cid] = [];
    byCid[cid].push(k);
  }

  // Cap: only check up to 5 conditionIds per sweep to avoid blocking
  const entries = Object.entries(byCid).slice(0, 5);
  for (const [cid, keys] of entries) {
    try {
      const mkts = await getJSON(`${GAMMA_API}/markets?condition_id=${cid}`);
      const mk = Array.isArray(mkts) ? mkts[0] : null;
      if (!mk) continue;
      updateOwnPricesFromMarket({ ...mk, conditionId: mk.conditionId || cid });
      if (!mk.closed) continue;
      const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : (mk.outcomePrices || []);
      const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
      for (const k of keys) {
        const p = positions[k];
        if (!p || p.status !== 'open' || p.conditionId !== cid) continue;
        const idx = outcomes.findIndex(o => o === p.outcome || o.toLowerCase() === p.outcome.toLowerCase());
        if (idx < 0) continue;
        const won = prices[idx] != null && Number(prices[idx]) >= 0.5;
        settlePosition(k, won);
      }
      finalizeResolvedWindows();
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
  p.status = 'settled';
  p.pnl = pnl;
  p.won = won;
  p.settledAt = new Date().toISOString();

  log(`🏁 ${won ? '✅ WIN' : '❌ LOSS'} ${p.outcome.toUpperCase()} ${shortSlug(p.slug)} — cost $${p.cost.toFixed(2)} payout $${payout.toFixed(2)} P&L ${sgn(pnl)}`);
  recordEquity();
}

function finalizeResolvedWindows() {
  for (const [windowKey, win] of Object.entries(windows)) {
    const conditionIds = Object.keys(win.conditionIds || {});
    if (!conditionIds.length) continue;
    const relatedPositions = Object.values(positions).filter(position =>
      conditionIds.includes(position.conditionId));
    const hasSettled = relatedPositions.some(position => position.status === 'settled');
    const stillOpen = relatedPositions.some(position => position.status === 'open');
    if (!hasSettled || stillOpen) continue;

    const legs = relatedPositions.filter(position => position.status === 'settled');
    const payout = round2(legs.reduce((sum, leg) => sum + (leg.won ? leg.shares : 0), 0));
    const cost = round2(legs.reduce((sum, leg) => sum + leg.cost, 0));
    const pnl = round2(payout - cost);
    const winners = [...new Set(legs.filter(leg => leg.won).map(leg => leg.outcome))];
    updateWindowCapitalRecord(win);
    if (pnl > 0) wins++; else if (pnl < 0) losses++;
    const resolvedWindow = {
      ...windowSummary(win),
      resolved: true,
      won: pnl > 0,
      pnl,
      payout,
      cost,
      winners,
      settledAt: new Date().toISOString(),
    };
    resolvedWindows.push(resolvedWindow);
    delete windows[windowKey];
    log(`📊 WINDOW ${shortSlug(win.slug)} — cost $${cost.toFixed(2)}, payout $${payout.toFixed(2)}, P&L ${sgn(pnl)} (${winners.join('/') || 'none'})`);
  }
  if (resolvedWindows.length > 100) resolvedWindows = resolvedWindows.slice(-50);
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

function sgn(n) { return (n > 0 ? '+$' : (n < 0 ? '-$' : '$')) + Math.abs(n).toFixed(2); }

function windowSummary(w) {
  return {
    slug: w.slug, type: w.type, title: w.title,
    upShares: w.upShares, downShares: w.downShares,
    upCost: w.upCost, downCost: w.downCost,
    upMasterShares: w.upMasterShares, downMasterShares: w.downMasterShares,
    upBuys: w.upBuys, downBuys: w.downBuys,
    totalCost: w.totalCost, totalMasterShares: w.totalMasterShares, totalBuys: w.totalBuys,
    resolved: !!w.resolved, won: w.won, winner: w.winner,
    pnl: w.pnl || 0, payout: w.payout || 0, settledAt: w.settledAt,
    fireOffset: w.trades[0] ? w.trades[0].fireOffset : null,
  };
}

function buildState() {
  const mv = markValue();
  const winRate = (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null;
  const active5m = Object.values(windows).filter(w => w.type === '5m');
  const active15m = Object.values(windows).filter(w => w.type === '15m');
  const masterTrades = masterPositions.map(p => ({
    size: Math.abs(p.size || 0), outcome: p.outcome, title: p.title, slug: p.slug,
    avgPrice: p.avgPrice, cashPnl: p.cashPnl, curPrice: p.curPrice,
  }));
  return {
    watchWallet: watchAddress || WATCH_WALLET,
    demoCapital: CAPITAL, bankroll, markValue: mv,
    realizedPnl, totalPnl: round2(mv - CAPITAL),
    wins, losses, winRate,
    biggestBuy, smallestBuy,
    positions: Object.values(positions).filter(p => p.status === 'open'),
    trades: trades.slice(-100).reverse(),
    windows5m: active5m.slice(0, 20).map(windowSummary),
    windows15m: active15m.slice(0, 20).map(windowSummary),
    masterTrades,
    resolvedWindows: resolvedWindows.slice(-12).reverse(),
    windowCapitalStats,
    serverTime: Date.now(),
    equityCurve,
    logs: logs.slice(-200),
    config: { pollMs: POLL_MS, copyPct: "100%", capital: CAPITAL },
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

let lastSweep = 0, lastPosPoll = 0;
let lastCleanup = 0;
const CLEANUP_MS = 300000; // 5 minutes

// Run a promise with a timeout — prevents the loop from freezing
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// Clean up old data to prevent memory leaks
function cleanup() {
  // Trim trades to last 200
  if (trades.length > 200) trades = trades.slice(-200);
  // Remove resolved windows older than 1 hour
  const cutoff = Date.now() - 3600000;
  for (const wk of Object.keys(windows)) {
    const w = windows[wk];
    if (w.resolved) delete windows[wk];
  }
  // Trim resolvedWindows
  if (resolvedWindows.length > 50) resolvedWindows = resolvedWindows.slice(-25);
  // Trim logs
  if (logs.length > 300) logs = logs.slice(-200);
}

async function mainLoop() {
  while (true) {
    const loopStart = Date.now();
    try {
      // Poll trades with 20s timeout — never let the loop freeze
      await withTimeout(pollMasterTrades(), 20000);
      const now = Date.now();
      if (now - lastPosPoll > 30000) { lastPosPoll = now; await withTimeout(pollMasterPositions(), 15000); }
      if (now - lastSweep > SWEEP_MS) { lastSweep = now; await withTimeout(sweepResolutions(), 15000); recordEquity(); }
      if (now - lastCleanup > CLEANUP_MS) { lastCleanup = now; cleanup(); }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️ Loop: ${e.message}`); }
    // Ensure minimum tick interval even if loop was fast
    const elapsed = Date.now() - loopStart;
    const wait = Math.max(100, POLL_MS - elapsed);
    await new Promise(r => setTimeout(r, wait));
  }
}

async function init(emit, slogFnArg) {
  emitFn = emit;
  slogFn = slogFnArg;
  watchAddress = await resolveMasterWallet(WATCH_WALLET);
  log(`🚀 Copy bot watching ${watchAddress} — 100% of master wallet — $${CAPITAL} demo`);
  await pollMasterPositions();
  log(`👀 Master has ${masterPositions.length} open positions`);
  mainLoop();
}

function pauseTrading() { log('⏸️ Paused'); return { ok: true }; }
function resumeTrading() { log('▶️ Resumed'); return { ok: true }; }
function getStatus() { return buildState(); }

module.exports = { init, getStatus, pauseTrading, resumeTrading };
