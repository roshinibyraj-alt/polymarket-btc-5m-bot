'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET BINARY COPY-TRADING BOT — DEMO MODE
 *  MIRRORS A MASTER WALLET'S BINARY (UP/DOWN) TRADES
 * ═══════════════════════════════════════════════════════════════
 *
 *  Watches a master wallet that trades Polymarket BINARY markets
 *  (e.g. BTC 5m/15m Up or Down) and mirrors every trade in paper:
 *
 *    GET data-api.polymarket.com/trades?user=<wallet>    (new trades)
 *    GET data-api.polymarket.com/positions?user=<wallet> (master state)
 *    GET gamma-api.polymarket.com/markets?condition_ids= (resolution)
 *
 *  Every POLL_INTERVAL_MS the bot picks up NEW master buys/sells:
 *    master BUY  -> paper BUY (same shares x MIRROR_SCALE, same price)
 *    master SELL -> paper SELL (reduce, realize at the trade price)
 *  When a mirrored market resolves, the paper position settles at
 *  $1/share (won) or $0 (lost) — winners never need a manual redeem
 *  in paper, the payout is the same $1/share.
 *
 *  A LEARNING MODEL (learn-model.js) continuously fingerprints the
 *  master's strategy: market mix, stakes, entry prices/timing,
 *  per-window win rate, edge per window, repeat-vs-fade, and named
 *  behavior labels — surfaced on the dashboard "Learning" panel.
 *
 *  Demo-only: DRY_RUN=true, no wallet/keys needed. Reads are public.
 * ═══════════════════════════════════════════════════════════════
 */

const { analyze, describe, fetchActivity, fetchPositions } = require('./learn-model');

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

const WATCH_WALLET             = (process.env.WATCH_WALLET || '0x251c1a283703beed41590b0875a8dcb8ddd1541f').trim();
const POLL_INTERVAL_MS         = Number(process.env.POLL_INTERVAL_MS || 2000); // fast pickup — mirrors the master within ~2s of each fire
const POSITION_SWEEP_INTERVAL_MS = Number(process.env.POSITION_SWEEP_INTERVAL_MS || 30000);
const LEARN_REFRESH_MS         = Number(process.env.LEARN_REFRESH_MS || 10 * 60 * 1000);
const DEMO_CAPITAL             = Number(process.env.DEMO_CAPITAL || 20000);
const MIRROR_SCALE             = Number(process.env.MIRROR_SCALE || 1);          // bot shares = master shares x this
const MIRROR_FIXED_SHARES      = process.env.MIRROR_FIXED_SHARES ? Number(process.env.MIRROR_FIXED_SHARES) : null; // fixed size when set
const MIRROR_EXISTING_ON_START = (process.env.MIRROR_EXISTING_ON_START ?? 'true').toLowerCase() === 'true';
const MAX_POSITION_USDC        = Number(process.env.MAX_POSITION_USDC || 20000); // skip buys that would exceed this cost per mirrored window

let DRY_RUN = true; // demo-only — see setMode()

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// Seconds between the trade timestamp and its window's open (the slug's
// trailing epoch is the window open time). Used to tag every mirrored
// fill with exactly when inside the window the master fired.
function windowSecOf(slug) {
  if (!slug) return null;
  if (/-5m-/.test(slug)) return 300;
  if (/-15m-/.test(slug)) return 900;
  if (/-1h-/.test(slug) || /-60m-/.test(slug)) return 3600;
  return null;
}
function fireOffset(t) {
  const w = windowSecOf(t.slug);
  if (!w || !t.timestamp) return null;
  return t.timestamp % w; // slug epoch is aligned to the window open
}
function fmtOffset(off) {
  if (off == null) return '';
  const m = Math.floor(off / 60), sec = Math.round(off % 60);
  return `+${m}:${String(sec).padStart(2, '0')}`;
}
function fireTag(t) {
  const off = fireOffset(t);
  return off == null ? '' : ` [fire ${fmtOffset(off)}]`;
}

let emitFn = () => {};
let slog = () => {};
let startTime = Date.now();
let logs = [];
let tradeLog = [];           // mirrored trade events (for the dashboard table)
let tradingEnabled = true;
let equityCurve = [{ t: Date.now(), equity: DEMO_CAPITAL }];
let totalEquityCurve = [];
let learning = null;
let learningError = null;

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
//  Master wallet resolution (0x... or @username)
// ─────────────────────────────────────────
let watchAddress = null;
let resolveError = null;

async function resolveMasterWallet(input) {
  const s = String(input || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  const name = s.replace(/^@/, '');
  log(`🔎 resolving wallet for @${name} from the profile page...`);
  const res = await fetch(`https://polymarket.com/@${encodeURIComponent(name)}`, {
    headers: { 'User-Agent': 'polymarket-copy-bot/1.0' },
  });
  if (!res.ok) throw new Error(`profile page HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/walletAddress\\?"?\s*:\s*\\?"?(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`could not find a walletAddress on @${name}'s profile`);
  log(`🔎 @${name} -> wallet ${m[1].toLowerCase()}`);
  return m[1].toLowerCase();
}

// ─────────────────────────────────────────
//  Paper mirror state
// ─────────────────────────────────────────
let masterPositions = [];     // latest master positions snapshot
let lastPollAt = null;
let lastPollError = null;
let lastTradeTs = null;       // newest master trade timestamp already processed
let seenTrades = new Set();   // dedupe key `tx|cond|outcome|ts|size|price` (survives API duplicate rows)
let mirror = {};              // key `${conditionId}:${outcome}` -> paper position
let bankroll = DEMO_CAPITAL;
let realizedPnl = 0;
let wins = 0, losses = 0;
let windowHistory = [];       // settled mirrored windows
let condMeta = {};            // slug -> { resolved, winner }
let lastSweepAt = 0;

const key = (conditionId, outcome) => `${conditionId}:${outcome}`;

function markValue() {
  let v = bankroll;
  for (const p of Object.values(mirror)) {
    if (p.status !== 'open') continue;
    v += p.shares * (p.curPrice != null ? p.curPrice : p.avgPrice);
  }
  return round2(v);
}

function recordEquity() {
  const v = markValue();
  equityCurve.push({ t: Date.now(), equity: v });
  if (equityCurve.length > 500) equityCurve.shift();
  totalEquityCurve.push({ t: Date.now(), equity: v });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}

function pushTradeLog(entry) {
  tradeLog.push(entry);
  if (tradeLog.length > 200) tradeLog.shift();
}

// ─────────────────────────────────────────
//  Gamma resolution lookup (per conditionId)
// ─────────────────────────────────────────
async function sweepResolutions() {
  const open = Object.values(mirror).filter((p) => p.status === 'open');
  const need = open.filter((p) => p.slug && (!condMeta[p.slug] || !condMeta[p.slug].resolved));
  if (!need.length) { settleOpenPositions(); return; }
  // Resolve via the event-by-slug endpoint (one market per event for
  // the BTC up/down series); outcomes+outcomePrices on a closed event
  // give the authoritative winner. Concurrent, chunked.
  const CONC = 8, CHUNK = 40;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async (p) => {
      try {
        const ev = await getJSON(`${GAMMA_API}/events?slug=${encodeURIComponent(p.slug)}`);
        const markets = (Array.isArray(ev) && ev.length && Array.isArray(ev[0].markets)) ? ev[0].markets : [];
        const mk = markets.find((m) => m.conditionId === p.conditionId) || markets[0];
        if (!mk || !mk.closed) return;
        let winner = null;
        try {
          const outs = JSON.parse(mk.outcomes || '[]');
          const prices = JSON.parse(mk.outcomePrices || '[]');
          const upIdx = outs.findIndex((o) => /up|yes|true/i.test(o));
          if (prices.length === 2 && upIdx >= 0 && prices[upIdx] != null) {
            winner = parseFloat(prices[upIdx]) > 0.5 ? 'UP' : 'DOWN';
          }
        } catch (_) {}
        if (winner) condMeta[p.slug] = { resolved: true, winner };
      } catch (_) { /* skip this window this sweep */ }
    }));
  }
  settleOpenPositions();
}

// Settles every open mirrored position whose market is resolved (winner
// known in condMeta) at $1/share won / $0 lost.
function settleOpenPositions() {
  for (const p of Object.values(mirror)) {
    if (p.status !== 'open') continue;
    const meta = condMeta[p.slug];
    if (!meta || !meta.resolved) continue;
    const won = p.outcome.toUpperCase().startsWith('U') ? meta.winner === 'UP' : meta.winner === 'DOWN';
    p.status = won ? 'won' : 'lost';
    p.resolvedWon = won;
    p.payout = won ? p.shares : 0;
    p.pnl = round2(p.payout - p.cost);
    p.resolvedAt = new Date().toISOString();
    bankroll = round2(bankroll + p.payout);
    realizedPnl = round2(realizedPnl + p.pnl);
    if (won) wins++; else losses++;
    windowHistory.push({
      conditionId: p.conditionId, slug: p.slug, title: p.title, side: p.outcome,
      shares: p.shares, avgPrice: p.avgPrice, cost: p.cost, payout: p.payout,
      pnl: p.pnl, won, resolvedAt: p.resolvedAt,
    });
    if (windowHistory.length > 500) windowHistory.shift();
    log(`${won ? '✅' : '💥'} RESOLVED ${p.slug} — ${p.outcome} ${won ? 'WON' : 'LOST'} | ${p.shares}sh @ avg $${p.avgPrice.toFixed(3)} | cost $${p.cost.toFixed(2)} payout $${p.payout.toFixed(2)} pnl ${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)} | bankroll $${bankroll.toFixed(2)}`);
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Mirroring trades
// ─────────────────────────────────────────
function mirrorBuy(t) {
  const k = key(t.conditionId, t.outcome);
  let shares = MIRROR_FIXED_SHARES != null ? MIRROR_FIXED_SHARES : round4((t.size || 0) * MIRROR_SCALE);
  if (!shares || shares <= 0) return;
  const cost = shares * (t.price || 0);
  const pos = mirror[k];
  const posCost = pos ? pos.cost : 0;
  if (posCost + cost > MAX_POSITION_USDC) {
    log(`⏭️ skip mirror buy ${t.slug} ${t.outcome} — would exceed MAX_POSITION_USDC $${MAX_POSITION_USDC} (${(posCost + cost).toFixed(2)})`);
    return;
  }
  if (bankroll < cost) {
    log(`⏭️ skip mirror buy ${t.slug} ${t.outcome} $${cost.toFixed(2)} — insufficient bankroll $${bankroll.toFixed(2)}`);
    return;
  }
  if (pos) {
    const newShares = pos.shares + shares;
    pos.avgPrice = round4((pos.shares * pos.avgPrice + shares * (t.price || 0)) / newShares);
    pos.shares = newShares;
    pos.cost = round2(pos.cost + cost);
    pos.buys++;
    pos.lastPrice = t.price;
  } else {
    mirror[k] = {
      conditionId: t.conditionId, outcome: t.outcome, title: t.title, slug: t.slug,
      shares, avgPrice: t.price, cost: round2(cost), buys: 1, lastPrice: t.price,
      status: 'open', openedAt: new Date().toISOString(), curPrice: t.price,
    };
  }
  bankroll = round2(bankroll - cost);
  pushTradeLog({ t: t.timestamp, action: 'BUY', slug: t.slug, side: t.outcome, price: t.price, shares, cost: round2(cost), profit: null, fireOffset: fireOffset(t) });
  log(`🛒 MIRROR BUY ${t.slug} ${t.outcome} ${shares}sh @ $${t.price.toFixed(3)} ($${cost.toFixed(2)})${fireTag(t)} | bankroll $${bankroll.toFixed(2)}`);
}

function mirrorSell(t) {
  const k = key(t.conditionId, t.outcome);
  const pos = mirror[k];
  if (!pos || pos.status !== 'open') return;
  let sellShares = MIRROR_FIXED_SHARES != null ? Math.min(MIRROR_FIXED_SHARES, pos.shares) : round4((t.size || 0) * MIRROR_SCALE);
  sellShares = Math.min(sellShares, pos.shares);
  if (sellShares <= 0) return;
  const proceeds = sellShares * (t.price || pos.avgPrice);
  const realized = round2(proceeds - sellShares * pos.avgPrice);
  pos.shares = round4(pos.shares - sellShares);
  pos.cost = round2(pos.cost - sellShares * pos.avgPrice);
  bankroll = round2(bankroll + proceeds);
  realizedPnl = round2(realizedPnl + realized);
  pushTradeLog({ t: t.timestamp, action: 'SELL', slug: t.slug, side: t.outcome, price: t.price, shares: sellShares, cost: round2(proceeds), profit: realized, fireOffset: fireOffset(t) });
  log(`🔄 MIRROR SELL ${t.slug} ${t.outcome} ${sellShares}sh @ $${(t.price || pos.avgPrice).toFixed(3)}${fireTag(t)} | realized ${realized >= 0 ? '+' : ''}$${realized.toFixed(2)} | bankroll $${bankroll.toFixed(2)}`);
  if (pos.shares <= 0.001) { pos.status = 'closed'; pos.closedAt = new Date().toISOString(); }
}

async function pollMasterTrades() {
  // Two pages (0..200) so a burst of fills can never fall between polls.
  const base = `${DATA_API}/trades?user=${encodeURIComponent(watchAddress)}&limit=100`;
  const [p0, p1] = await Promise.all([getJSON(base), getJSON(base + '&offset=100')]);
  const data = [...(Array.isArray(p0) ? p0 : []), ...(Array.isArray(p1) ? p1 : [])];
  if (!data.length) return;
  // First poll is only a BASELINE: the master's current positions were
  // already mirrored from the positions snapshot, so recent trades must
  // not be re-mirrored. Only NEW trades (after the baseline) are copied.
  if (lastTradeTs == null) {
    lastTradeTs = Math.max(0, ...data.map((t) => t.timestamp));
    return;
  }
  // Newest first from the API; copy every fill the master fires EXACTLY
  // (same shares x scale, same price), including multiple fills in the
  // same window and even in the same second (composite dedupe key, so
  // identical API duplicate rows collapse but distinct fills survive).
  const fresh = data.filter((t) => t.timestamp >= (lastTradeTs || 0));
  if (!fresh.length) return;
  const sorted = fresh.slice().sort((a, b) => a.timestamp - b.timestamp);
  lastTradeTs = Math.max(lastTradeTs || 0, ...data.map((t) => t.timestamp));
  for (const t of sorted) {
    const dk = [t.transactionHash, t.conditionId, t.outcome, t.timestamp, t.size, t.price].join('|');
    if (seenTrades.has(dk)) continue;
    seenTrades.add(dk);
    if (seenTrades.size > 20000) seenTrades.clear(); // keep the set bounded
    if (!t.conditionId || !t.outcome) continue;
    if (!tradingEnabled) continue;
    if (t.side === 'BUY') mirrorBuy(t);
    else if (t.side === 'SELL') mirrorSell(t);
  }
  recordEquity();
}

async function pollMasterPositions() {
  masterPositions = await fetchPositions(watchAddress);
  for (const p of masterPositions) {
    if (p.curPrice != null) {
      const mk = mirror[key(p.conditionId, p.outcome)];
      if (mk && mk.status === 'open') mk.curPrice = Number(p.curPrice) || mk.curPrice;
    }
    // Fast path: a redeemable master position means the market resolved
    // AND that side won — settle without a gamma round-trip.
    if (p.redeemable === true && p.outcome && p.slug && (!condMeta[p.slug] || !condMeta[p.slug].resolved)) {
      const winner = String(p.outcome).toUpperCase().startsWith('U') ? 'UP' : 'DOWN';
      condMeta[p.slug] = { resolved: true, winner };
    }
  }
  settleOpenPositions();
  recordEquity();
}

// ─────────────────────────────────────────
//  Learning model refresh
// ─────────────────────────────────────────
async function refreshLearning() {
  try {
    log('🧠 refreshing master strategy fingerprint...');
    const [activity, positions] = await Promise.all([fetchActivity(watchAddress), fetchPositions(watchAddress)]);
    learning = analyze(activity, positions);
    log(`🧠 fingerprint: ${describe(learning)}`);
    learningError = null;
  } catch (e) {
    learningError = e.message;
    log(`⚠️ learning refresh failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  Loop
// ─────────────────────────────────────────
let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      await pollMasterTrades();
      const now = Date.now();
      if (now - lastSweepAt >= POSITION_SWEEP_INTERVAL_MS) {
        lastSweepAt = now;
        await Promise.all([pollMasterPositions(), sweepResolutions()]);
      }
      lastPollAt = Date.now();
      lastPollError = null;
      emitFn('state', buildState());
    } catch (e) {
      lastPollError = e.message;
      log(`⚠️ Loop error: ${e.message}`);
      emitFn('state', buildState());
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const mv = markValue();
  const winRate = (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null;
  const masterCashPnl = round2(masterPositions.reduce((s, p) => s + (p.cashPnl || 0), 0));
  const mirrorList = Object.values(mirror).filter((p) => p.status === 'open').map((p) => ({ ...p }));
  const masterList = masterPositions.map((p) => ({
    conditionId: p.conditionId, outcome: p.outcome, title: p.title, slug: p.slug,
    size: p.size, avgPrice: p.avgPrice, cashPnl: p.cashPnl, curPrice: p.curPrice, redeemable: p.redeemable,
  }));
  return {
    dryRun: DRY_RUN,
    tradingEnabled,
    watchWallet: watchAddress || WATCH_WALLET,
    resolveError,
    demoCapital: DEMO_CAPITAL,
    bankroll,
    markValue: mv,
    realizedPnl,
    totalPnl: round2(mv - DEMO_CAPITAL),
    wins, losses, winRate,
    windowHistory: windowHistory.slice(-40).reverse(),
    master: {
      positionsCount: masterPositions.length,
      currentCashPnl: masterCashPnl,
      currentValue: round2(masterPositions.reduce((s, p) => s + (p.currentValue || 0), 0)),
      positions: masterList,
    },
    positions: mirrorList,
    equityCurve,
    totalEquityCurve,
    trades: tradeLog.slice(-80).reverse(),
    logs: logs.slice(-100),
    learning,
    learningError,
    config: {
      pollIntervalMs: POLL_INTERVAL_MS,
      positionSweepIntervalMs: POSITION_SWEEP_INTERVAL_MS,
      mirrorScale: MIRROR_SCALE,
      mirrorFixedShares: MIRROR_FIXED_SHARES,
      maxPositionUsdc: MAX_POSITION_USDC,
      mirrorExistingOnStart: MIRROR_EXISTING_ON_START,
    },
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastPollAt,
    lastPollError,
  };
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Mirroring paused (still watching + logging the master wallet)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Mirroring resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

// Demo-only build — LIVE mode would need private keys/signing.
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
  watchAddress = await resolveMasterWallet(WATCH_WALLET);
  log(`🚀 Binary Copy-Trading Bot — DEMO MODE — watching ${watchAddress}`);
  log(`   mirroring: buys/sells on binary markets, ${MIRROR_SCALE}x scale, $${DEMO_CAPITAL} demo capital, resolve at $1/$0`);

  // Mirror the master's CURRENT open positions so paper equity starts
  // at the same point, then run the learning model on the full record.
  if (MIRROR_EXISTING_ON_START) {
    try {
      await pollMasterPositions();
      let seeded = 0;
      for (const p of masterPositions) {
        const k = key(p.conditionId, p.outcome);
        if (mirror[k] || !p.size || !p.avgPrice) continue;
        const shares = MIRROR_FIXED_SHARES != null ? Math.min(MIRROR_FIXED_SHARES, p.size) : round4(p.size * MIRROR_SCALE);
        const cost = round2(shares * p.avgPrice);
        if (!shares) continue;
        mirror[k] = {
          conditionId: p.conditionId, outcome: p.outcome, title: p.title, slug: p.slug,
          shares, avgPrice: p.avgPrice, cost, buys: 1, lastPrice: p.avgPrice,
          status: 'open', openedAt: new Date().toISOString(), curPrice: p.curPrice != null ? p.curPrice : p.avgPrice,
          seeded: true,
        };
        bankroll = round2(bankroll - cost);
        seeded++;
      }
      log(`👀 mirrored ${seeded} existing master position(s) (cost $${round2(DEMO_CAPITAL - bankroll)}) — bankroll $${bankroll.toFixed(2)}`);
      recordEquity();
    } catch (e) {
      log(`⚠️ existing-position mirror failed: ${e.message}`);
    }
  }
  refreshLearning();
  setInterval(refreshLearning, LEARN_REFRESH_MS).unref();
  mainLoop();
}

module.exports = { init, getStatus, pauseTrading, resumeTrading, setMode };
