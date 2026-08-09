'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET COPY-TRADING BOT — DEMO MODE
 *  POSITION-DIFF MIRRORING
 * ═══════════════════════════════════════════════════════════════
 *
 *  Every POLL_INTERVAL_MS, fetches the target wallet's CURRENT open
 *  positions from Polymarket's Data API
 *  (GET https://data-api.polymarket.com/positions?user=<wallet>) and
 *  diffs them against what it saw last poll, per outcome token:
 *
 *    master had 0, now has shares  -> bot OPENS a mirrored position
 *    master's size increased       -> bot ADDS proportionally
 *    master's size decreased       -> bot REDUCES proportionally
 *    master had shares, now has 0  -> bot CLOSES the position fully
 *
 *  This is state-diffing (not trade-log replay), so it naturally
 *  handles opens, closes, and partial adjustments the same way —
 *  the bot's target size for a token is always
 *  `master's current size × MIRROR_SCALE` (or a flat
 *  MIRROR_FIXED_SHARES while master holds any amount > 0), and each
 *  poll just moves the paper position toward that target.
 *
 *  DEMO MODE ONLY — no real orders are ever placed. LIVE mode is
 *  stubbed out (setMode(true) logs a warning and refuses) until a
 *  live executor is wired in on top of this.
 *
 *  MIRROR_EXISTING_ON_START (default true) — if the master wallet
 *  already has open positions the first time the bot polls, those
 *  are immediately mirrored as opens rather than being ignored.
 * ═══════════════════════════════════════════════════════════════
 */

const DATA_API = 'https://data-api.polymarket.com';

const WATCH_WALLET       = (process.env.WATCH_WALLET || '0xb5de863cfef62edecbf1f0e39d0c6acc82df2c54').toLowerCase();
const POLL_INTERVAL_MS   = Number(process.env.POLL_INTERVAL_MS || 5000);
const DEMO_CAPITAL       = Number(process.env.DEMO_CAPITAL || 2000);
const MIRROR_SCALE       = Number(process.env.MIRROR_SCALE || 0.01);     // bot target size = master size * this
const MIRROR_FIXED_SHARES = process.env.MIRROR_FIXED_SHARES ? Number(process.env.MIRROR_FIXED_SHARES) : null; // if set, bot target is this flat amount whenever master > 0
const MIN_MIRROR_SHARES  = Number(process.env.MIN_MIRROR_SHARES || 0.5); // ignore deltas smaller than this (dust / rounding)
const MIRROR_EXISTING_ON_START = (process.env.MIRROR_EXISTING_ON_START ?? 'true').toLowerCase() === 'true';
const POSITIONS_LIMIT    = Number(process.env.POSITIONS_LIMIT || 500);
const ACTIVITY_LIMIT     = Number(process.env.ACTIVITY_LIMIT || 40);

let DRY_RUN = true; // this bot only ever runs DRY_RUN=true today — see setMode()

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

let emitFn = () => {};
let slog = () => {};
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let totalEquityCurve = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-copy-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  State
// ─────────────────────────────────────────
let initialScanDone = false;
let lastPollAt = null;
let lastPollError = null;
let masterMap = {};             // asset -> { asset, size, avgPrice, curPrice, title, outcome, conditionId }
let sourceFeed = [];            // recent raw activity rows, display-only (not used for trading decisions)

let positions = {};             // asset -> { tokenId, marketTitle, outcome, shares, avgCost }
let bankroll = DEMO_CAPITAL;
let realizedPnl = 0;
let wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: DEMO_CAPITAL }];

function recordEquity() {
  const v = round2(bankroll); // paper mark-to-cost; no live pricing feed for held tokens polled here
  equityCurve.push({ t: Date.now(), equity: v });
  if (equityCurve.length > 500) equityCurve.shift();
  totalEquityCurve.push({ t: Date.now(), equity: v });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}

function registerTrade(entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Sizing policy — bot's TARGET size for a token given master's size
// ─────────────────────────────────────────
function targetBotShares(masterShares) {
  if (!masterShares || masterShares <= 0) return 0;
  if (MIRROR_FIXED_SHARES != null) return MIRROR_FIXED_SHARES;
  return Math.max(0, round4(masterShares * MIRROR_SCALE));
}

// ─────────────────────────────────────────
//  Master wallet polling — POSITIONS (drives mirroring decisions)
// ─────────────────────────────────────────
async function fetchMasterPositions() {
  const url = `${DATA_API}/positions?user=${WATCH_WALLET}&sortBy=CURRENT&sortDirection=DESC&limit=${POSITIONS_LIMIT}`;
  return getJSON(url);
}

function normalizePosition(r) {
  const asset = r.asset || r.token_id || r.tokenId || r.assetId;
  const size = Number(r.size ?? r.tokens ?? r.shares ?? 0);
  const avgPrice = Number(r.avgPrice ?? r.averagePrice ?? 0);
  const curPrice = Number(r.curPrice ?? r.currentPrice ?? r.price ?? avgPrice);
  const title = r.title || r.eventTitle || r.slug || 'Unknown market';
  const outcome = r.outcome || r.outcomeName || '?';
  const conditionId = r.conditionId || r.condition_id || null;
  return { asset, size, avgPrice, curPrice, title, outcome, conditionId };
}

async function pollMasterPositions() {
  let raw;
  try {
    raw = await fetchMasterPositions();
    lastPollAt = Date.now();
    lastPollError = null;
  } catch (e) {
    lastPollError = e.message;
    log(`⚠️  positions fetch failed: ${e.message}`);
    return;
  }
  if (!Array.isArray(raw)) return;

  const newMasterMap = {};
  for (const row of raw) {
    const p = normalizePosition(row);
    if (!p.asset || p.size <= 0) continue;
    newMasterMap[p.asset] = p;
  }

  if (!initialScanDone) {
    initialScanDone = true;
    masterMap = newMasterMap;
    log(`👀 watching ${WATCH_WALLET} — ${Object.keys(masterMap).length} open position(s) found`);
    if (MIRROR_EXISTING_ON_START) {
      for (const asset of Object.keys(masterMap)) {
        if (tradingEnabled) await syncToken(asset, masterMap[asset]);
      }
    } else {
      log(`ℹ️  MIRROR_EXISTING_ON_START=false — existing open positions were NOT mirrored, only future changes will be`);
    }
    return;
  }

  const tokens = new Set([...Object.keys(newMasterMap), ...Object.keys(positions)]);
  for (const asset of tokens) {
    if (!tradingEnabled) continue;
    await syncToken(asset, newMasterMap[asset] || null);
  }
  masterMap = newMasterMap;
}

// ─────────────────────────────────────────
//  Sync one token's bot position toward its target
// ─────────────────────────────────────────
async function syncToken(asset, masterInfo) {
  const masterShares = masterInfo ? masterInfo.size : 0;
  const target = targetBotShares(masterShares);
  const bot = positions[asset];
  const botShares = bot ? bot.shares : 0;
  const delta = round4(target - botShares);
  if (Math.abs(delta) < MIN_MIRROR_SHARES) return;

  const title = masterInfo?.title || bot?.marketTitle || 'Unknown market';
  const outcome = masterInfo?.outcome || bot?.outcome || '?';
  const price = (masterInfo?.curPrice > 0 ? masterInfo.curPrice : masterInfo?.avgPrice) || bot?.avgCost || null;
  if (!price || price <= 0) {
    log(`⏭️  skip sync for "${title}" (${outcome}) — no usable price yet`);
    return;
  }

  if (delta > 0) {
    const deltaShares = delta;
    const cost = round2(deltaShares * price);
    if (cost > bankroll) {
      log(`⏭️  can't ${botShares === 0 ? 'OPEN' : 'ADD'} "${title}" (${outcome}) — need $${cost.toFixed(2)}, have $${bankroll.toFixed(2)} paper bankroll`);
      return;
    }
    bankroll = round2(bankroll - cost);
    const newShares = round4(botShares + deltaShares);
    const prevCost = bot ? bot.avgCost * bot.shares : 0;
    const avgCost = newShares > 0 ? round4((prevCost + cost) / newShares) : 0;
    positions[asset] = { tokenId: asset, marketTitle: title, outcome, shares: newShares, avgCost };

    const reason = botShares === 0 ? 'OPEN' : 'ADD';
    log(`✅ ${reason} — bought ${deltaShares}sh @ ${price.toFixed(2)} "${title}" (${outcome}) | cost=$${cost.toFixed(2)} | master holds ${masterShares}sh`);
    registerTrade({ side: 'BUY', reason, title, outcome, price, shares: deltaShares, cost });
    recordEquity();
  } else {
    const deltaShares = round4(-delta);
    const proceeds = round2(deltaShares * price);
    const costBasis = round2(deltaShares * (bot ? bot.avgCost : 0));
    const profit = round2(proceeds - costBasis);
    bankroll = round2(bankroll + proceeds);
    realizedPnl = round2(realizedPnl + profit);
    const newShares = round4(botShares - deltaShares);
    if (newShares <= 0.0001) delete positions[asset];
    else positions[asset] = { ...bot, shares: newShares };
    if (profit >= 0) wins++; else losses++;

    const reason = target === 0 ? 'CLOSE' : 'REDUCE';
    const icon = profit >= 0 ? '💰' : '💥';
    log(`${icon} ${reason} — sold ${deltaShares}sh @ ${price.toFixed(2)} "${title}" (${outcome}) | proceeds=$${proceeds.toFixed(2)} | pnl=$${profit.toFixed(2)} | master holds ${masterShares}sh`);
    registerTrade({ side: 'SELL', reason, title, outcome, price, shares: deltaShares, proceeds, profit });
    recordEquity();
  }
}

// ─────────────────────────────────────────
//  Master wallet polling — ACTIVITY (display-only source feed)
// ─────────────────────────────────────────
async function fetchWalletActivity() {
  const url = `${DATA_API}/activity?user=${WATCH_WALLET}&type=TRADE&limit=${ACTIVITY_LIMIT}&sortBy=TIMESTAMP&sortDirection=DESC`;
  return getJSON(url);
}
function normalizeActivity(raw) {
  const side = (raw.side || '').toUpperCase();
  const shares = Number(raw.size ?? raw.tokens ?? raw.shares ?? 0);
  const price = Number(raw.price ?? 0);
  const title = raw.title || raw.eventTitle || raw.slug || 'Unknown market';
  const outcome = raw.outcome || raw.outcomeName || '?';
  const timestamp = Number(raw.timestamp || 0);
  return { side, shares, price, title, outcome, timestamp };
}
async function refreshSourceFeed() {
  try {
    const activity = await fetchWalletActivity();
    if (Array.isArray(activity)) sourceFeed = activity.map(normalizeActivity);
  } catch (e) {
    // display-only — don't let this block position syncing
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const heldCost = round2(Object.values(positions).reduce((s, p) => s + p.shares * p.avgCost, 0));
  const markValue = round2(bankroll + heldCost); // cost-basis mark — no live price feed on held tokens yet
  return {
    dryRun: DRY_RUN, tradingEnabled,
    watchWallet: WATCH_WALLET,
    demoCapital: DEMO_CAPITAL, bankroll, markValue,
    realizedPnl, totalPnl: round2(markValue - DEMO_CAPITAL),
    wins, losses,
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastPollAt, lastPollError,
    config: {
      pollIntervalMs: POLL_INTERVAL_MS,
      mirrorScale: MIRROR_SCALE,
      mirrorFixedShares: MIRROR_FIXED_SHARES,
      minMirrorShares: MIN_MIRROR_SHARES,
      mirrorExistingOnStart: MIRROR_EXISTING_ON_START,
    },
    masterPositions: Object.values(masterMap),
    positions: Object.values(positions),
    sourceFeed,
    equityCurve, totalEquityCurve,
    logs: logs.slice(-100),
    trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      await pollMasterPositions();
      await refreshSourceFeed();
      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Mirroring paused (still watching + logging the master wallet)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Mirroring resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

// LIVE mode is intentionally not implemented yet — this bot is demo-only
// until a real order executor is wired up. Calling setMode(true) refuses
// and stays in DRY_RUN.
function setMode(wantLive) {
  if (wantLive) {
    log('⚠️  LIVE mode requested but not implemented — this bot only places paper trades today. Staying in DEMO mode.');
    return { ok: false, dryRun: DRY_RUN, error: 'LIVE mode not implemented yet' };
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Polymarket Copy-Trading Bot — DEMO MODE — POSITION MIRRORING`);
  log(`👀 watching wallet ${WATCH_WALLET} | polling every ${POLL_INTERVAL_MS}ms | $${DEMO_CAPITAL} paper capital | target size = ${MIRROR_FIXED_SHARES != null ? MIRROR_FIXED_SHARES + 'sh fixed whenever master > 0' : (MIRROR_SCALE * 100) + '% of master size'} | opens when master opens, scales with adds/reduces, closes fully when master closes | existing-on-start mirroring: ${MIRROR_EXISTING_ON_START ? 'ON' : 'OFF'}`);
  log(`⚠️  DEMO MODE — paper trades only, no real orders will ever be placed by this build`);
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
