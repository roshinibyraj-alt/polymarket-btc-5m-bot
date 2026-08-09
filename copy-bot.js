'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET PERPS COPY-TRADING BOT — DEMO MODE
 *  MIRRORS A MASTER PERPS WALLET (LONG / SHORT)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Reads the master wallet's Polymarket Perpetuals portfolio from the
 *  PUBLIC perps API and mirrors it in paper:
 *
 *    GET /v1/info/portfolio?address=<wallet>   (master positions)
 *    GET /v1/info/tickers                       (mark prices)
 *
 *  Every POLL_INTERVAL_MS the bot diffs the master portfolio against
 *  the last poll:
 *
 *    master had no position, now has size   -> bot OPENS (same direction)
 *    master's size grows                    -> bot ADDS proportionally
 *    master's size shrinks                  -> bot REDUCES proportionally
 *    master flips LONG <-> SHORT            -> bot closes then re-opens
 *    master had size, now 0                 -> bot CLOSES fully
 *
 *  Direction comes from the sign of the perps size: positive = LONG,
 *  negative = SHORT. All reads are public — no private key needed.
 *  Positions are mirrored in PAPER only (see setMode).
 *
 *  WATCH_WALLET accepts a perps account address (0x...) or a profile
 *  username (@abc9901) which is resolved from the profile page.
 * ═══════════════════════════════════════════════════════════════
 */

const PERPS_INFO_API = 'https://api.perpetuals.polymarket.com/v1/info';

const WATCH_WALLET            = (process.env.WATCH_WALLET || '0x2070f45c22e44a52cb42210d1112a0bfb6a9a0c7').trim();
const POLL_INTERVAL_MS        = Number(process.env.POLL_INTERVAL_MS || 5000);
const DEMO_CAPITAL            = Number(process.env.DEMO_CAPITAL || 20000);
const MIRROR_SCALE            = Number(process.env.MIRROR_SCALE || 0.01);          // bot target = |master size| * this
const MIRROR_FIXED_SIZE       = process.env.MIRROR_FIXED_SIZE ? Number(process.env.MIRROR_FIXED_SIZE) : null; // if set, flat magnitude whenever master > 0
const MIN_MIRROR_SIZE         = Number(process.env.MIN_MIRROR_SIZE || 0.0001);     // ignore deltas smaller than this
const MIRROR_EXISTING_ON_START = (process.env.MIRROR_EXISTING_ON_START ?? 'true').toLowerCase() === 'true';

let DRY_RUN = true; // this build only ever runs DRY_RUN=true — see setMode()

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

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-copy-bot/1.0', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Wallet resolution (address or @username)
// ─────────────────────────────────────────
let watchAddress = null;
let resolveError = null;

async function resolveMasterWallet(input) {
  const s = String(input || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  const name = s.replace(/^@/, '');
  log(`🔎 resolving perps wallet for @${name} from the profile page...`);
  const res = await fetch(`https://polymarket.com/@${encodeURIComponent(name)}`, {
    headers: { 'User-Agent': 'polymarket-copy-bot/1.0' },
  });
  if (!res.ok) throw new Error(`profile page HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/walletAddress\\?"?\s*:\s*\\?"?(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`could not find a perps walletAddress on @${name}'s profile`);
  log(`🔎 @${name} -> perps wallet ${m[1].toLowerCase()}`);
  return m[1].toLowerCase();
}

// ─────────────────────────────────────────
//  Market data — public REST (mark prices)
// ─────────────────────────────────────────
let markCache = {}; // instrumentId -> mark

function markPriceOf(key) {
  const m = markCache[key];
  return m && m > 0 ? m : null;
}

async function refreshTickers() {
  try {
    const tickers = await getJSON(`${PERPS_INFO_API}/tickers`);
    if (!Array.isArray(tickers)) return;
    for (const t of tickers) {
      if (t && t.instrument_id != null && t.mark_price != null) {
        markCache[String(t.instrument_id)] = Number(t.mark_price);
      }
    }
  } catch (e) {
    // display/valuation only — never block position syncing
  }
}

// ─────────────────────────────────────────
//  State
// ─────────────────────────────────────────
let initialScanDone = false;
let lastPollAt = null;
let lastPollError = null;
let lastEmptyWarnAt = 0;
let masterMap = {};  // instrumentId -> { key, symbol, size (signed), entryPrice, unrealizedPnl, leverage }
let positions = {};  // instrumentId -> { key, symbol, side ('LONG'|'SHORT'), size (magnitude), avgPrice }
let lastSkipWarn = {}; // instrumentId -> timestamp (throttle insufficient-bankroll logs)
let bankroll = DEMO_CAPITAL;
let realizedPnl = 0;
let wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: DEMO_CAPITAL }];

function markValue() {
  let total = bankroll;
  for (const p of Object.values(positions)) {
    const mark = markPriceOf(p.key) || p.avgPrice;
    total += p.side === 'LONG' ? p.size * mark : -p.size * mark;
  }
  return round2(total);
}

function recordEquity() {
  const v = markValue();
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
//  Sizing policy
// ─────────────────────────────────────────
function targetBotSize(masterSize) {
  if (!masterSize || Math.abs(masterSize) <= 0) return 0;
  const magnitude = MIRROR_FIXED_SIZE != null
    ? MIRROR_FIXED_SIZE
    : round4(Math.abs(masterSize) * MIRROR_SCALE);
  return Math.sign(masterSize) * Math.abs(magnitude); // keep direction
}

// ─────────────────────────────────────────
//  Master polling — PUBLIC PERPS PORTFOLIO (drives mirroring)
// ─────────────────────────────────────────
async function fetchMasterPortfolio() {
  return getJSON(`${PERPS_INFO_API}/portfolio?address=${watchAddress}`);
}

function normalizePosition(r) {
  const key = String(r.instrument_id ?? r.instrumentId);
  const symbol = r.symbol || `instrument-${key}`;
  const size = Number(r.size ?? 0); // signed: >0 LONG, <0 SHORT
  const entryPrice = Number(r.entry_price ?? r.entryPrice ?? 0);
  const unrealizedPnl = Number(r.unrealized_pnl ?? r.unrealizedPnl ?? 0);
  const leverage = Number(r.leverage ?? 1);
  return { key, symbol, size, entryPrice, unrealizedPnl, leverage };
}

async function pollMasterPositions() {
  if (!watchAddress) {
    lastPollError = resolveError || 'watch wallet not resolved';
    return;
  }
  let raw;
  try {
    raw = await fetchMasterPortfolio();
    lastPollAt = Date.now();
    lastPollError = null;
  } catch (e) {
    lastPollError = e.message;
    if (Date.now() - lastEmptyWarnAt > 30000) {
      lastEmptyWarnAt = Date.now();
      log(`⚠️  portfolio fetch failed: ${e.message}`);
    }
    return;
  }

  const rows = raw && Array.isArray(raw.positions) ? raw.positions : [];
  const newMasterMap = {};
  for (const row of rows) {
    const p = normalizePosition(row);
    if (!p.key || p.size === 0) continue;
    newMasterMap[p.key] = p;
  }
  const masterCount = Object.keys(newMasterMap).length;
  if (masterCount === 0 && Date.now() - lastEmptyWarnAt > 60000) {
    lastEmptyWarnAt = Date.now();
    log(`ℹ️  master perps portfolio is empty (0 positions) — nothing to mirror`);
  }

  if (!initialScanDone) {
    initialScanDone = true;
    masterMap = newMasterMap;
    log(`👀 watching ${watchAddress} — ${Object.keys(masterMap).length} open perps position(s) found`);
    if (MIRROR_EXISTING_ON_START) {
      for (const key of Object.keys(masterMap)) {
        if (tradingEnabled) await syncToken(key, masterMap[key]);
      }
    } else {
      log(`ℹ️  MIRROR_EXISTING_ON_START=false — existing open positions were NOT mirrored, only future changes will be`);
    }
    return;
  }

  const keys = new Set([...Object.keys(newMasterMap), ...Object.keys(positions)]);
  for (const key of keys) {
    if (!tradingEnabled) continue;
    await syncToken(key, newMasterMap[key] || null);
  }
  masterMap = newMasterMap;
}

// ─────────────────────────────────────────
//  Paper mirroring helpers
// ─────────────────────────────────────────
function paperOpen(key, symbol, side, size, price) {
  if (size <= 0) return;
  const cost = round2(size * price);
  if (cost > bankroll) {
    if (Date.now() - (lastSkipWarn[key] || 0) > 30000) {
      lastSkipWarn[key] = Date.now();
      log(`⏭️  can't OPEN ${symbol} ${side} ${size} @ ${price.toFixed(2)} — need $${cost.toFixed(2)}, have $${bankroll.toFixed(2)} paper bankroll`);
    }
    return;
  }
  if (side === 'LONG') bankroll = round2(bankroll - cost);
  else bankroll = round2(bankroll + cost); // short proceeds received
  const prev = positions[key];
  const prevQty = prev ? prev.size : 0;
  const newQty = round4(prevQty + size);
  const prevCost = prev ? prev.avgPrice * prev.size : 0;
  const avgPrice = newQty > 0 ? round4((prevCost + cost) / newQty) : 0;
  positions[key] = { key, symbol, side, size: newQty, avgPrice };
  const reason = prevQty === 0 ? 'OPEN' : 'ADD';
  log(`✅ ${reason} — ${symbol} ${side} ${size} @ ${price.toFixed(2)} | cost=$${cost.toFixed(2)}`);
  registerTrade({ side: 'BUY', reason, symbol, dir: side, price, size, cost });
  recordEquity();
}

function paperClosePartial(key, price, deltaSize, masterSize) {
  const bot = positions[key];
  if (!bot || deltaSize <= 0) return;
  const closing = Math.min(deltaSize, bot.size);
  let profit;
  if (bot.side === 'LONG') {
    const proceeds = round2(closing * price);
    bankroll = round2(bankroll + proceeds);
    profit = round2((price - bot.avgPrice) * closing);
  } else {
    const buyback = round2(closing * price);
    bankroll = round2(bankroll - buyback);
    profit = round2((bot.avgPrice - price) * closing);
  }
  realizedPnl = round2(realizedPnl + profit);
  if (profit >= 0) wins++; else losses++;
  const newSize = round4(bot.size - closing);
  if (newSize <= 0.0001) delete positions[key];
  else positions[key] = { ...bot, size: newSize };
  const icon = profit >= 0 ? '💰' : '💥';
  log(`${icon} REDUCE — ${bot.symbol} ${bot.side} ${closing} @ ${price.toFixed(2)} | pnl=$${profit.toFixed(2)}${masterSize != null ? ` | master now ${masterSize}` : ''}`);
  registerTrade({ side: 'SELL', reason: 'REDUCE', symbol: bot.symbol, dir: bot.side, price, size: closing, profit });
  recordEquity();
}

function paperCloseAll(key, price) {
  const bot = positions[key];
  if (!bot) return;
  const size = bot.size;
  let proceeds;
  if (bot.side === 'LONG') {
    proceeds = round2(size * price);
    bankroll = round2(bankroll + proceeds);
  } else {
    proceeds = round2(size * price); // buyback cost
    bankroll = round2(bankroll - proceeds);
  }
  const profit = round2((bot.side === 'LONG' ? price - bot.avgPrice : bot.avgPrice - price) * size);
  realizedPnl = round2(realizedPnl + profit);
  if (profit >= 0) wins++; else losses++;
  delete positions[key];
  const icon = profit >= 0 ? '💰' : '💥';
  log(`${icon} CLOSE — ${bot.symbol} ${bot.side} ${size} @ ${price.toFixed(2)} | proceeds=$${proceeds.toFixed(2)} | pnl=$${profit.toFixed(2)}`);
  registerTrade({ side: 'SELL', reason: 'CLOSE', symbol: bot.symbol, dir: bot.side, price, size, proceeds, profit });
  recordEquity();
}

// ─────────────────────────────────────────
//  Sync one instrument's bot position toward its target
// ─────────────────────────────────────────
async function syncToken(key, masterInfo) {
  const masterSize = masterInfo ? masterInfo.size : 0;      // signed
  const target = targetBotSize(masterSize);                  // signed
  const bot = positions[key];
  const botSigned = bot ? (bot.side === 'SHORT' ? -bot.size : bot.size) : 0;

  const symbol = masterInfo?.symbol || bot?.symbol || `instrument-${key}`;
  const price = (masterInfo && masterInfo.entryPrice > 0 ? masterInfo.entryPrice : null)
    || markPriceOf(key) || bot?.avgPrice || null;
  if (!price || price <= 0) {
    log(`⏭️  skip sync for ${symbol} — no usable price yet`);
    return;
  }

  // nothing to change
  if (Math.abs(round4(target - botSigned)) < MIN_MIRROR_SIZE) return;

  // sign flip: close the old direction fully, then open the new one
  if (bot && botSigned !== 0 && target !== 0 && Math.sign(botSigned) !== Math.sign(target)) {
    paperCloseAll(key, price);
    paperOpen(key, symbol, target > 0 ? 'LONG' : 'SHORT', Math.abs(target), price);
    return;
  }

  if (target === 0) {
    if (bot) paperCloseAll(key, price);
    return;
  }

  const side = target > 0 ? 'LONG' : 'SHORT';
  const absTarget = Math.abs(target);
  const absBot = Math.abs(botSigned);

  // no position yet -> open in the target direction
  if (!bot || absBot === 0) {
    paperOpen(key, symbol, side, absTarget, price);
    return;
  }

  // same direction as the target -> add or reduce by the size difference
  const diff = round4(absTarget - absBot);
  if (diff >= MIN_MIRROR_SIZE) {
    paperOpen(key, symbol, side, diff, price);
  } else if (diff <= -MIN_MIRROR_SIZE) {
    paperClosePartial(key, price, -diff, masterSize);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const mv = markValue();
  const masterList = Object.values(masterMap).map(m => ({
    ...m,
    side: m.size > 0 ? 'LONG' : 'SHORT',
    size: Math.abs(m.size),
  }));
  const botList = Object.values(positions).map(p => {
    const mark = markPriceOf(p.key) || p.avgPrice;
    return {
      ...p,
      mark,
      unrealizedPnl: round2(((p.side === 'LONG' ? 1 : -1) * (mark - p.avgPrice)) * p.size),
    };
  });
  return {
    dryRun: DRY_RUN, tradingEnabled,
    watchWallet: watchAddress || WATCH_WALLET,
    resolveError,
    demoCapital: DEMO_CAPITAL, bankroll, markValue: mv,
    realizedPnl, totalPnl: round2(mv - DEMO_CAPITAL),
    wins, losses,
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastPollAt, lastPollError,
    masterPositionsCount: Object.keys(masterMap).length,
    config: {
      pollIntervalMs: POLL_INTERVAL_MS,
      mirrorScale: MIRROR_SCALE,
      mirrorFixedSize: MIRROR_FIXED_SIZE,
      minMirrorSize: MIN_MIRROR_SIZE,
      mirrorExistingOnStart: MIRROR_EXISTING_ON_START,
    },
    masterPositions: masterList,
    positions: botList,
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
      await refreshTickers();
      await pollMasterPositions();
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

// LIVE mode is intentionally not implemented yet — this bot is demo-only.
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
  log(`🚀 Polymarket PERPS Copy-Trading Bot — DEMO MODE — LONG/SHORT POSITION MIRRORING`);
  try {
    watchAddress = await resolveMasterWallet(WATCH_WALLET);
  } catch (e) {
    resolveError = `cannot resolve watch wallet "${WATCH_WALLET}": ${e.message}`;
    log(`❌ ${resolveError}`);
  }
  log(`👀 target master perps wallet ${watchAddress || WATCH_WALLET} | polling every ${POLL_INTERVAL_MS}ms | $${DEMO_CAPITAL} paper capital | target = ${MIRROR_FIXED_SIZE != null ? MIRROR_FIXED_SIZE + ' (fixed magnitude)' : (MIRROR_SCALE * 100) + '% of master size'} | existing-on-start mirroring: ${MIRROR_EXISTING_ON_START ? 'ON' : 'OFF'}`);
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
