'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  LEARN MODEL — strategy fingerprint of the master binary wallet
 * ═══════════════════════════════════════════════════════════════
 *
 *  Reads the master wallet's full public activity feed
 *  (data-api.polymarket.com/activity) plus its open positions and
 *  answers: WHAT strategy is this wallet actually running?
 *
 *  Outputs a structured fingerprint: volume, market mix, stakes,
 *  entry-price/entry-timing habits, per-window win rate, edge per
 *  window, repeat-vs-fade behavior, and named strategy behaviors
 *  with confidence scores. Used by the dashboard "Learning" panel.
 *
 *  Honesty note: the fingerprint is computed from REAL on-chain
 *  trades, not assumptions — if the master is losing money, the
 *  model reports it.
 * ═══════════════════════════════════════════════════════════════
 */

const DATA_API = 'https://data-api.polymarket.com';

function q(a, p) { return a[Math.floor(p * (a.length - 1))]; }
function deciles(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return {
    min: +s[0].toFixed(4), p10: +q(s, 0.10).toFixed(4), p25: +q(s, 0.25).toFixed(4),
    p50: +q(s, 0.50).toFixed(4), p75: +q(s, 0.75).toFixed(4), p90: +q(s, 0.90).toFixed(4),
    max: +s[s.length - 1].toFixed(4),
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

// ─────────────────────────────────────────
//  Fetch helpers (public, keyless)
// ─────────────────────────────────────────
async function pageJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-copy-bot/1.0' } });
    const text = await res.text();
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

async function fetchActivity(address, maxRows = 20000) {
  const out = [];
  for (let off = 0; off < maxRows; off += 200) {
    const a = await pageJSON(`${DATA_API}/activity?user=${encodeURIComponent(address)}&limit=200&offset=${off}`);
    if (!a.length) break;
    out.push(...a);
    if (out.length >= maxRows) break;
  }
  return out;
}

async function fetchPositions(address) {
  const out = [];
  for (let off = 0; off < 5000; off += 500) {
    const p = await pageJSON(`${DATA_API}/positions?user=${encodeURIComponent(address)}&limit=500&offset=${off}`);
    if (!p.length) break;
    out.push(...p);
    if (p.length < 500) break;
  }
  return out;
}

// ─────────────────────────────────────────
//  Analysis
// ─────────────────────────────────────────
function timeframeOf(slug) {
  if (!slug) return 'other';
  if (/-5m-/.test(slug)) return '5m';
  if (/-15m-/.test(slug)) return '15m';
  if (/-1h-/.test(slug) || /-60m-/.test(slug)) return '1h';
  return 'other';
}

function windowSecOf(slug) {
  const tf = timeframeOf(slug);
  return tf === '5m' ? 300 : tf === '15m' ? 900 : tf === '1h' ? 3600 : null;
}

function analyze(activity, positions) {
  if (!Array.isArray(activity)) activity = [];
  if (!Array.isArray(positions)) positions = [];

  const trades = activity.filter((a) => a.type === 'TRADE');
  const buys = trades.filter((a) => a.side === 'BUY');
  const sells = trades.filter((a) => a.side === 'SELL');
  const redeems = activity.filter((a) => a.type === 'REDEEM');

  const tss = trades.map((t) => t.timestamp).sort((a, b) => a - b);
  const spanH = tss.length ? (tss[tss.length - 1] - tss[0]) / 3600 : 0;

  const buyUsdc = buys.reduce((s, t) => s + (t.usdcSize || 0), 0);
  const sellUsdc = sells.reduce((s, t) => s + (t.usdcSize || 0), 0);
  const redeemUsdc = redeems.reduce((s, t) => s + (t.usdcSize || 0), 0);
  const realizedPnl = redeemUsdc + sellUsdc - buyUsdc;
  const currentCashPnl = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
  const currentInit = positions.reduce((s, p) => s + (p.initialValue || 0), 0);
  const currentValue = positions.reduce((s, p) => s + (p.currentValue || 0), 0);

  // Per-condition (per-window) ledger: buy-side, cost, redeemed?
  const cond = {};
  for (const a of activity) {
    const c = a.conditionId;
    if (!c) continue;
    cond[c] = cond[c] || { buys: 0, buyUsdc: 0, buyShares: 0, redeems: 0, redUsdc: 0, slug: a.slug, sides: {}, sizes: [], prices: [], times: [], firstTs: a.timestamp };
    const r = cond[c];
    if (a.type === 'TRADE' && a.side === 'BUY') {
      r.buys++; r.buyUsdc += a.usdcSize || 0; r.buyShares += a.size || 0;
      r.sides[a.outcome] = (r.sides[a.outcome] || 0) + 1;
      r.sizes.push(a.size || 0); r.prices.push(a.price || 0); r.times.push(a.timestamp);
    } else if (a.type === 'REDEEM') {
      r.redeems++; r.redUsdc += a.usdcSize || 0;
    }
  }
  const rows = Object.values(cond);
  let won = 0, lost = 0, mixed = 0, wonPnl = 0, lostPnl = 0;
  const perWindowCost = [], perWindowPayout = [], buysPerWindow = [], perWindowPnl = [];
  const entryOffsets = []; // seconds after window open
  const entryFracBuckets = { '0-20%': 0, '20-40%': 0, '40-60%': 0, '60-80%': 0, '80-100%': 0 };
  const hourHist = {};
  const repeatFade = { repeat: 0, fade: 0, unknown: 0 };
  const sideCount = { UP: 0, DOWN: 0 };
  const tfCount = { '5m': 0, '15m': 0, '1h': 0, other: 0 };
  const tfUsdc = { '5m': 0, '15m': 0, '1h': 0, other: 0 };

  const sorted = rows.slice().sort((a, b) => a.firstTs - b.firstTs);

  // Per-timeframe FIRE-PATTERN accumulators: at what second inside the
  // window does the master fire, in what cadence, and how do fill sizes
  // and prices move across consecutive buys of the same window (ladder
  // logic). "Skip cadence" = how many windows the master sits out.
  const tfStats = {}; // tf -> { windows, buys, buysPerWindow[], firstSec[], lastSec[], gaps[], sizeRatios[], priceDeltas[], firstHalfFrac[], skipGaps[], openTs }
  function tfAcc(tf) {
    if (!tfStats[tf]) tfStats[tf] = { windows: 0, buys: 0, buysPerWindow: [], buyMinute: {}, firstSec: [], lastSec: [], gaps: [], sizeRatios: [], priceDeltas: [], firstHalfFrac: [], skipGaps: [], openTs: null };
    return tfStats[tf];
  }
  function openTsOf(slug) {
    const m = /-(\d+)$/.exec(slug || '');
    return m ? Number(m[1]) : null;
  }

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const tf = timeframeOf(r.slug);
    tfCount[tf] = (tfCount[tf] || 0) + 1;
    tfUsdc[tf] = (tfUsdc[tf] || 0) + r.buyUsdc;
    const sides = Object.keys(r.sides);
    const mainSide = sides.sort((a, b) => r.sides[b] - r.sides[a])[0] || null;
    const mainSideNorm = mainSide && mainSide.toUpperCase().startsWith('U') ? 'UP' : mainSide && mainSide.toUpperCase().startsWith('D') ? 'DOWN' : mainSide;
    if (mainSideNorm) sideCount[mainSideNorm] = (sideCount[mainSideNorm] || 0) + 1;
    if (sides.length > 1) mixed++;

    // winner of this window: redeemed side won; else the opposite lost.
    const rWon = r.redeems > 0;
    if (rWon) { won++; wonPnl += r.redUsdc - r.buyUsdc; } else { lost++; lostPnl += -r.buyUsdc; }

    perWindowCost.push(r.buyUsdc);
    perWindowPayout.push(rWon ? r.redUsdc : 0);
    perWindowPnl.push(rWon ? r.redUsdc - r.buyUsdc : -r.buyUsdc);
    buysPerWindow.push(r.buys);

    const wSec = windowSecOf(r.slug);
    if (wSec) {
      for (const ts of r.times) {
        const off = ts % wSec;
        entryOffsets.push(off);
        const frac = off / wSec;
        const key = frac < 0.2 ? '0-20%' : frac < 0.4 ? '20-40%' : frac < 0.6 ? '40-60%' : frac < 0.8 ? '60-80%' : '80-100%';
        entryFracBuckets[key]++;
        const d = new Date(ts * 1000);
        hourHist[d.getUTCHours()] = (hourHist[d.getUTCHours()] || 0) + 1;
      }

      // --- fire-pattern learning for this window ---
      const acc = tfAcc(tf);
      acc.windows++;
      acc.buys += r.buys;
      acc.buysPerWindow.push(r.buys);
      const fills = r.times.map((ts, ix) => ({ ts, size: r.sizes[ix] || 0, price: r.prices[ix] || 0 })).sort((a, b) => a.ts - b.ts);
      if (fills.length) {
        const offs = fills.map((f) => f.ts % wSec);
        acc.firstSec.push(Math.min(...offs));
        acc.lastSec.push(Math.max(...offs));
        acc.firstHalfFrac.push(offs.filter((o) => o < wSec / 2).length / offs.length);
        const NB = 12; // twelve equal buckets per window
        for (const o of offs) {
          const b = Math.min(NB - 1, Math.floor(o / (wSec / NB)));
          acc.buyMinute[b] = (acc.buyMinute[b] || 0) + 1;
        }
        for (let j = 1; j < fills.length; j++) {
          const gap = fills[j].ts - fills[j - 1].ts;
          if (gap > 0) acc.gaps.push(gap);
          if (fills[j - 1].size > 0) acc.sizeRatios.push(fills[j].size / fills[j - 1].size);
          acc.priceDeltas.push(fills[j].price - fills[j - 1].price);
        }
      }
      const ots = openTsOf(r.slug);
      if (ots != null && acc.openTs != null && ots > acc.openTs) {
        const skipped = Math.round((ots - acc.openTs) / wSec) - 1;
        if (skipped >= 0 && skipped < 500) acc.skipGaps.push(skipped);
      }
      acc.openTs = ots;
      // --- end fire-pattern ---

      // repeat vs fade: did the master buy the SAME side as the previous
      // window's winner (momentum) or the opposite (fade)?
      if (i > 0) {
        const prev = sorted[i - 1];
        const prevWon = prev.redeems > 0;
        const prevSides = Object.keys(prev.sides);
        const prevMain = prevSides.sort((a, b) => prev.sides[b] - prev.sides[a])[0];
        if (prevMain && mainSide) {
          const prevWinner = prevWon ? prevMain : (prevMain === 'UP' ? 'DOWN' : 'UP');
          if (mainSide === prevWinner) repeatFade.repeat++;
          else repeatFade.fade++;
        }
      }
    } else {
      repeatFade.unknown++;
    }
  }

  const nWindows = rows.length;
  const winRate = nWindows ? won / nWindows : null;
  const profitableWindows = nWindows ? perWindowPnl.filter((p) => p >= 0).length / nWindows : null;
  const avgCost = perWindowCost.length ? perWindowCost.reduce((a, b) => a + b, 0) / perWindowCost.length : 0;

  // ─────────────────────────────────────────
  //  Fire pattern (per timeframe) — at WHICH TIME inside the window
  //  the master fires, in what cadence, and the ladder logic across
  //  consecutive fills of the same window.
  // ─────────────────────────────────────────
  const TF_SEC = { '5m': 300, '15m': 900, '1h': 3600 };
  const firePattern = {};
  for (const [tf, acc] of Object.entries(tfStats)) {
    if (!acc.windows) continue;
    const wSec = TF_SEC[tf] || null;
    firePattern[tf] = {
      windows: acc.windows,
      buys: acc.buys,
      buysPerWindow: deciles(acc.buysPerWindow),
      firstBuySec: deciles(acc.firstSec),
      lastBuySec: deciles(acc.lastSec),
      gapSec: deciles(acc.gaps),
      sizeRatio: deciles(acc.sizeRatios),       // next-fill size / previous-fill size
      priceDelta: deciles(acc.priceDeltas),     // next-fill price - previous-fill price
      firstHalfShare: acc.firstHalfFrac.length ? round2(acc.firstHalfFrac.reduce((a, b) => a + b, 0) / acc.firstHalfFrac.length) : null,
      skipGaps: deciles(acc.skipGaps),          // windows skipped between traded windows (0 = every window)
      fireBuckets: wSec ? Object.entries(acc.buyMinute).map(([b, c]) => ({ sec: Math.round(Number(b) * (wSec / 12)), count: c })).sort((a, b) => a.sec - b.sec) : [],
    };
  }

  const domTf = Object.entries(tfStats).sort((a, b) => (b[1] ? b[1].buys : 0) - (a[1] ? a[1].buys : 0))[0];
  const domName = domTf ? domTf[0] : null;
  const fp5 = firePattern['5m'], fp15 = firePattern['15m'];

  // Behavior detection (named strategies + confidence)
  const behaviors = [];
  if (sells.length === 0 && redeems.length > 0) {
    behaviors.push({ name: 'HOLD-TO-RESOLUTION', confidence: 1, detail: 'never sells — buys and redeems winning windows' });
  }
  const bpw = deciles(buysPerWindow);
  if (bpw && bpw.p50 >= 3) {
    behaviors.push({ name: 'LADDER BUYER', confidence: Math.min(1, bpw.p50 / 10), detail: `median ${bpw.p50} buys per window (max ${bpw.max}) — adds as the window develops` });
  }
  const buyPrices = buys.map((t) => t.price);
  const pd = deciles(buyPrices);
  const dipShare = buyPrices.length ? buyPrices.filter((p) => p <= 0.33).length / buyPrices.length : 0;
  const highShare = buyPrices.length ? buyPrices.filter((p) => p >= 0.60).length / buyPrices.length : 0;
  if (pd && pd.p50 >= 0.55) {
    behaviors.push({ name: 'WINNER-CHASER', confidence: Math.min(1, pd.p50 * 1.4), detail: `median entry $${pd.p50.toFixed(2)} — buys the likely winner at high prices for thin margins` });
  }
  if (dipShare >= 0.15) {
    behaviors.push({ name: 'DIP BUYER', confidence: Math.min(1, dipShare * 3), detail: `${(dipShare * 100).toFixed(0)}% of buys at ≤ $0.33` });
  }

  // --- fire-timing / ladder-logic behaviors ---
  const mm = (x) => x != null ? `${Math.floor(x / 60)}m${String(Math.round(x % 60)).padStart(2, '0')}s` : '—';
  const totalBuys = buys.length || 1;
  const lateShare = ((entryFracBuckets['60-80%'] || 0) + (entryFracBuckets['80-100%'] || 0)) / totalBuys;
  if (lateShare >= 0.45) {
    behaviors.push({ name: 'LATE CHASER', confidence: Math.min(1, lateShare * 1.6), detail: `${(lateShare * 100).toFixed(0)}% of fills land in the final 40% of the window` });
  }
  const early5 = fp5 && fp5.firstBuySec && fp5.firstBuySec.p50 != null && fp5.firstBuySec.p50 <= 60;
  const early15 = fp15 && fp15.firstBuySec && fp15.firstBuySec.p50 != null && fp15.firstBuySec.p50 <= 180;
  if (early5 || early15) {
    const src = early5 ? fp5 : fp15;
    behaviors.push({ name: 'EARLY ENTRANT', confidence: 0.7, detail: `first fill lands ${mm(src.firstBuySec.p50)} into the window (median) — opens the position early` });
  }
  const gapRef = (fp5 && fp5.gapSec && fp5.gapSec.p50 != null) ? fp5.gapSec : (fp15 && fp15.gapSec && fp15.gapSec.p50 != null) ? fp15.gapSec : null;
  if (gapRef && gapRef.p50 <= 90 && gapRef.p90 != null && gapRef.p90 <= 240) {
    behaviors.push({ name: 'REGULAR CADENCE', confidence: 0.75, detail: `re-fires every ~${mm(gapRef.p50)} (p90 ${mm(gapRef.p90)}) — fills on a repeating timer inside the window` });
  }
  const sizeRef = (fp5 && fp5.sizeRatio) || (fp15 && fp15.sizeRatio);
  if (sizeRef && sizeRef.p50 != null) {
    if (sizeRef.p50 > 1.15) behaviors.push({ name: 'SCALING-UP', confidence: 0.65, detail: `each re-fill is ${(sizeRef.p50 * 100).toFixed(0)}% of the previous (median) — increases size as the window develops` });
    else if (sizeRef.p50 < 0.85) behaviors.push({ name: 'SCALING-DOWN', confidence: 0.65, detail: `each re-fill is ${(sizeRef.p50 * 100).toFixed(0)}% of the previous (median) — front-loads size then trims` });
  }
  const priceRef = (fp5 && fp5.priceDelta) || (fp15 && fp15.priceDelta);
  if (priceRef && priceRef.p50 != null) {
    if (priceRef.p50 > 0.02) behaviors.push({ name: 'CHASES-UP', confidence: 0.6, detail: `re-fills at +$${priceRef.p50.toFixed(3)}/share (median) — adds at rising prices` });
    else if (priceRef.p50 < -0.02) behaviors.push({ name: 'AVERAGES-DOWN', confidence: 0.6, detail: `re-fills at ${priceRef.p50.toFixed(3)}/share (median) — adds into dips` });
  }
  const skipRef = (fp5 && fp5.skipGaps) || (fp15 && fp15.skipGaps);
  if (skipRef && skipRef.p50 != null && skipRef.p50 >= 1) {
    behaviors.push({ name: 'SELECTIVE WINDOWS', confidence: 0.7, detail: `skips a median of ${skipRef.p50} window(s) between trades — fires on ~1 in ${Math.round(skipRef.p50 + 1)} windows` });
  }
  // --- end fire-timing behaviors ---

  const edge = nWindows ? realizedPnl / nWindows : 0;
  const totalNet = realizedPnl + currentCashPnl;
  behaviors.push({
    name: totalNet > 50 ? 'PROFITABLE' : (totalNet < -50 ? 'LOSING' : 'BREAKEVEN'),
    confidence: 1,
    detail: `realized +$${round2(realizedPnl)} over ${spanH.toFixed(1)}h (${nWindows} windows, ${(winRate != null ? winRate * 100 : 0).toFixed(1)}% windows redeemed, ${(profitableWindows != null ? profitableWindows * 100 : 0).toFixed(1)}% net-profitable) + current positions ${currentCashPnl >= 0 ? '+' : ''}$${round2(currentCashPnl)} = net ${totalNet >= 0 ? '+' : ''}$${round2(totalNet)} | avg edge ${edge >= 0 ? '+' : ''}$${edge.toFixed(2)}/window`,
  });

  // Plain-language STRATEGY READ: one line per timeframe describing
  // when the master fires, cadence, ladder logic, and window skipping.
  function readTf(tf) {
    const f = firePattern[tf];
    if (!f || !f.windows) return null;
    const bpw = f.buysPerWindow ? f.buysPerWindow.p50 : null;
    const sr = f.sizeRatio && f.sizeRatio.p50 != null ? (f.sizeRatio.p50 > 1.15 ? 'scales size UP' : f.sizeRatio.p50 < 0.85 ? 'scales size DOWN' : 'keeps size flat') : null;
    const pd = f.priceDelta && f.priceDelta.p50 != null ? (f.priceDelta.p50 > 0.02 ? 'chases up' : f.priceDelta.p50 < -0.02 ? 'averages down' : 'fills flat prices') : null;
    const skip = f.skipGaps && f.skipGaps.p50 != null && f.skipGaps.p50 >= 1 ? ` | fires on ~1 in ${Math.round(f.skipGaps.p50 + 1)} windows` : '';
    return `${tf}: ${f.windows} windows, ${f.buys} fills | opens ${mm(f.firstBuySec.p50)} in, re-fires every ~${mm(f.gapSec.p50)} (median ${bpw} fills/window, last ${mm(f.lastBuySec.p50)}) | ${sr}, ${pd}, ${(f.firstHalfShare * 100).toFixed(0)}% of fills in first half${skip}`;
  }
  const strategyRead = [readTf('5m'), readTf('15m'), readTf('1h')].filter(Boolean).join('\n') || 'insufficient window data yet';

  return {
    fetchedAt: new Date().toISOString(),
    strategyRead,
    overview: {
      spanHours: round2(spanH),
      windows: nWindows,
      trades: trades.length, buys: buys.length, sells: sells.length, redeems: redeems.length,
      volumeUsdc: round2(buyUsdc),
      realizedPnl: round2(realizedPnl),
      currentInit: round2(currentInit),
      currentValue: round2(currentValue),
      currentCashPnl: round2(currentCashPnl),
      netPnl: round2(totalNet),
      winRate: winRate != null ? round2(winRate * 100) : null,
      profitableWindows: profitableWindows != null ? round2(profitableWindows * 100) : null,
      avgEdgePerWindow: round2(edge),
      mixedWindows: mixed,
    },
    mix: {
      counts: tfCount,
      usdc: tfUsdc,
      sides: sideCount,
    },
    stakes: {
      buySize: deciles(buys.map((t) => t.size)),
      buyPrice: pd,
      buysPerWindow: bpw,
      costPerWindow: deciles(perWindowCost),
      payoutPerWindow: deciles(perWindowPayout.filter((x) => x > 0)),
      pnlPerWindow: deciles(perWindowPnl),
    },
    timing: {
      entrySecondsAfterOpen: deciles(entryOffsets),
      entryFracBuckets,
      hourHist,
    },
    repeatFade,
    firePattern,
    behaviors,
  };
}

function describe(f) {
  if (!f) return 'learning model not ready';
  const o = f.overview;
  const lines = [
    `Master wallet over the last ${o.spanHours}h: ${o.windows} windows, ${(o.winRate != null ? o.winRate : 0).toFixed(1)}% win rate.`,
    `Realized ${o.realizedPnl >= 0 ? '+' : ''}$${o.realizedPnl} on $${o.volumeUsdc} volume; current positions ${o.currentCashPnl >= 0 ? '+' : ''}$${o.currentCashPnl}; net ${o.netPnl >= 0 ? '+' : ''}$${o.netPnl}.`,
    `Behaviors: ${f.behaviors.map((b) => `${b.name} (${Math.round(b.confidence * 100)}%)`).join(', ')}.`,
    `Fire pattern: ${(f.strategyRead || '').split('\n').join(' | ')}`,
  ];
  return lines.join(' ');
}

module.exports = { analyze, describe, fetchActivity, fetchPositions };
