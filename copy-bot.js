'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET COPY-TRADING BOT — DEMO MODE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Watches a target wallet's trade activity via Polymarket's public
 *  Data API (https://data-api.polymarket.com/activity) and mirrors
 *  each new trade as a PAPER trade against a simulated bankroll.
 *
 *  DEMO MODE ONLY — no real orders are ever placed. LIVE mode is
 *  stubbed out (setMode(true) will log a warning and refuse to place
 *  real orders) until a live executor is wired in on top of this.
 *
 *  SIZING — mirrors the source wallet's trade size, scaled down by
 *  MIRROR_SCALE (default 0.01 = mirror 1% of their share size), with
 *  an optional MIRROR_FIXED_SHARES override that ignores their size
 *  entirely and always mirrors a flat share count instead.
 *
 *  DETECTION — polls /activity every POLL_INTERVAL_MS. Trades are
 *  de-duplicated by transactionHash (+ asset, since one tx can touch
 *  multiple outcome tokens), so nothing gets mirrored twice.
 *
 *  POSITION TRACKING — simple per-token running position (shares +
 *  average cost). BUY increases it and spends paper bankroll; SELL
 *  reduces it and credits paper bankroll, realizing P&L on the
 *  portion sold.
 * ═══════════════════════════════════════════════════════════════
 */

const DATA_API = 'https://data-api.polymarket.com';

const WATCH_WALLET       = (process.env.WATCH_WALLET || '0xb5de863cfef62edecbf1f0e39d0c6acc82df2c54').toLowerCase();
const POLL_INTERVAL_MS   = Number(process.env.POLL_INTERVAL_MS || 5000);
const DEMO_CAPITAL       = Number(process.env.DEMO_CAPITAL || 2000);
const MIRROR_SCALE       = Number(process.env.MIRROR_SCALE || 0.01);     // mirror this fraction of their share size
const MIRROR_FIXED_SHARES = process.env.MIRROR_FIXED_SHARES ? Number(process.env.MIRROR_FIXED_SHARES) : null; // overrides scaling if set
const MIN_MIRROR_SHARES  = Number(process.env.MIN_MIRROR_SHARES || 1);   // don't bother mirroring dust trades below this
const ACTIVITY_LIMIT     = Number(process.env.ACTIVITY_LIMIT || 100);

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
let seenTxKeys = new Set();     // `${transactionHash}:${asset}` already processed
let initialScanDone = false;    // first poll just seeds seenTxKeys, doesn't mirror history
let lastPollAt = null;
let lastPollError = null;
let sourceFeed = [];            // most recent raw trades from the watched wallet, for the dashboard

let positions = {};             // token_id -> { tokenId, marketTitle, outcome, shares, avgCost }
let bankroll = DEMO_CAPITAL;
let realizedPnl = 0;
let wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: DEMO_CAPITAL }];

function recordEquity() {
  const v = round2(bankroll); // paper mark-to-cost; live prices per open token aren't polled here yet
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
function mirrorShares(sourceShares) {
  if (MIRROR_FIXED_SHARES != null) return MIRROR_FIXED_SHARES;
  return Math.max(0, round4(sourceShares * MIRROR_SCALE));
}

// ─────────────────────────────────────────
//  Watched-wallet polling
// ─────────────────────────────────────────
async function fetchWalletActivity() {
  const url = `${DATA_API}/activity?user=${WATCH_WALLET}&type=TRADE&limit=${ACTIVITY_LIMIT}&sortBy=TIMESTAMP&sortDirection=DESC`;
  return getJSON(url);
}

function normalizeTrade(raw) {
  // Field names vary slightly across Data API responses — read defensively.
  const txHash = raw.transactionHash || raw.txHash || raw.hash || null;
  const asset = raw.asset || raw.token_id || raw.tokenId || raw.assetId || null;
  const side = (raw.side || '').toUpperCase();
  const shares = Number(raw.size ?? raw.tokens ?? raw.shares ?? 0);
  const price = Number(raw.price ?? 0);
  const usdcSize = Number(raw.usdcSize ?? (shares * price));
  const title = raw.title || raw.eventTitle || raw.slug || 'Unknown market';
  const outcome = raw.outcome || raw.outcomeName || '?';
  const timestamp = Number(raw.timestamp || 0);
  return { txHash, asset, side, shares, price, usdcSize, title, outcome, timestamp, raw };
}

async function pollWallet() {
  let activity;
  try {
    activity = await fetchWalletActivity();
    lastPollAt = Date.now();
    lastPollError = null;
  } catch (e) {
    lastPollError = e.message;
    log(`⚠️  activity fetch failed: ${e.message}`);
    return;
  }
  if (!Array.isArray(activity)) return;

  const trades_ = activity.map(normalizeTrade).filter(t => t.txHash && t.asset);
  // Data API returns newest-first; process oldest-first so mirrored order matches reality.
  trades_.sort((a, b) => a.timestamp - b.timestamp);

  sourceFeed = trades_.slice(-40).reverse();

  if (!initialScanDone) {
    // First run: just record what's already happened, don't mirror historical trades.
    for (const t of trades_) seenTxKeys.add(`${t.txHash}:${t.asset}`);
    initialScanDone = true;
    log(`👀 watching ${WATCH_WALLET} — seeded with ${trades_.length} existing trade(s), mirroring starts from here`);
    return;
  }

  for (const t of trades_) {
    const key = `${t.txHash}:${t.asset}`;
    if (seenTxKeys.has(key)) continue;
    seenTxKeys.add(key);
    if (seenTxKeys.size > 5000) {
      // trim oldest-ish by just recreating from current feed window to avoid unbounded growth
      seenTxKeys = new Set(Array.from(seenTxKeys).slice(-3000));
    }
    if (!tradingEnabled) continue;
    await mirrorTrade(t);
  }
}

// ─────────────────────────────────────────
//  Mirroring
// ─────────────────────────────────────────
async function mirrorTrade(t) {
  if (t.shares <= 0 || t.price <= 0) return;
  const shares = mirrorShares(t.shares);
  if (shares < MIN_MIRROR_SHARES) {
    log(`⏭️  source ${t.side} ${t.shares}sh "${t.title}" (${t.outcome}) @ ${t.price.toFixed(2)} — mirrored size ${shares}sh below MIN_MIRROR_SHARES, skipped`);
    return;
  }

  if (t.side === 'BUY') {
    const cost = round2(shares * t.price);
    if (cost > bankroll) {
      log(`⏭️  mirror BUY skipped — insufficient paper bankroll ($${bankroll.toFixed(2)} < $${cost.toFixed(2)}) for "${t.title}" (${t.outcome})`);
      return;
    }
    bankroll = round2(bankroll - cost);
    const pos = positions[t.asset] || { tokenId: t.asset, marketTitle: t.title, outcome: t.outcome, shares: 0, avgCost: 0 };
    const newShares = round4(pos.shares + shares);
    pos.avgCost = newShares > 0 ? round4(((pos.avgCost * pos.shares) + (t.price * shares)) / newShares) : 0;
    pos.shares = newShares;
    pos.marketTitle = t.title;
    pos.outcome = t.outcome;
    positions[t.asset] = pos;

    log(`✅ MIRRORED BUY — ${shares}sh @ ${t.price.toFixed(2)} "${t.title}" (${t.outcome}) | cost=$${cost.toFixed(2)} | source traded ${t.shares}sh (scale=${MIRROR_FIXED_SHARES != null ? 'fixed' : MIRROR_SCALE})`);
    registerTrade({ side: 'BUY', title: t.title, outcome: t.outcome, price: t.price, shares, cost, sourceShares: t.shares, txHash: t.txHash });
    recordEquity();
  } else if (t.side === 'SELL') {
    const pos = positions[t.asset];
    if (!pos || pos.shares <= 0) {
      log(`⏭️  source SELL "${t.title}" (${t.outcome}) — no mirrored position to sell, skipped`);
      return;
    }
    const sellShares = Math.min(shares, pos.shares);
    const proceeds = round2(sellShares * t.price);
    const costBasis = round2(sellShares * pos.avgCost);
    const profit = round2(proceeds - costBasis);
    bankroll = round2(bankroll + proceeds);
    realizedPnl = round2(realizedPnl + profit);
    pos.shares = round4(pos.shares - sellShares);
    if (pos.shares <= 0) delete positions[t.asset]; else positions[t.asset] = pos;
    if (profit >= 0) wins++; else losses++;

    const icon = profit >= 0 ? '💰' : '💥';
    log(`${icon} MIRRORED SELL — ${sellShares}sh @ ${t.price.toFixed(2)} "${t.title}" (${t.outcome}) | proceeds=$${proceeds.toFixed(2)} | pnl=$${profit.toFixed(2)} | source traded ${t.shares}sh`);
    registerTrade({ side: 'SELL', title: t.title, outcome: t.outcome, price: t.price, shares: sellShares, proceeds, profit, sourceShares: t.shares, txHash: t.txHash });
    recordEquity();
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const heldCost = round2(Object.values(positions).reduce((s, p) => s + p.shares * p.avgCost, 0));
  const markValue = round2(bankroll + heldCost); // no live pricing feed for held tokens yet — cost basis is the mark
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
    },
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
      await pollWallet();
      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Mirroring paused (still watching + logging the source wallet)'); return { ok: true }; }
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
  log(`🚀 Polymarket Copy-Trading Bot — DEMO MODE`);
  log(`👀 watching wallet ${WATCH_WALLET} | polling every ${POLL_INTERVAL_MS}ms | $${DEMO_CAPITAL} paper capital | mirror size = ${MIRROR_FIXED_SHARES != null ? MIRROR_FIXED_SHARES + 'sh fixed' : (MIRROR_SCALE * 100) + '% of source size'} | min ${MIN_MIRROR_SHARES}sh to mirror`);
  log(`⚠️  DEMO MODE — paper trades only, no real orders will ever be placed by this build`);
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
