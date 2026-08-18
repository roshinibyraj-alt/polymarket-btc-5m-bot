'use strict';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const WINDOW_TYPES = {
  '5m':  { seconds: 300, buyIntervalMs: 8000,  entryDelay: 15, sizes: { cheap: 40, mid: 80, strong: 150 }, budget: 1200 },
  '15m': { seconds: 900, buyIntervalMs: 25000, entryDelay: 20, sizes: { cheap: 60, mid: 120, strong: 120 }, budget: 1300 },
};

const MIN_ORDER_SHARES = 5;

function round2(n) { return Math.round(n * 100) / 100; }

function createMomentumEngine(cfg, trader) {
  const {
    label = 'MOMENTUM-DCA',
    startingCapital = 10000,
    feeTheta = 0.07,
    rebatePct = 0,
  } = cfg;

  const engine = {
    bankroll: startingCapital,
    startingCapital,
    equity: startingCapital,
    wins: 0, losses: 0, windowsDecided: 0,
    realizedPnlTotal: 0,
    totalFeesPaid: 0, totalVolume: 0,
    equityCurve: [{ t: Date.now(), equity: startingCapital }],
    history: [],
    current: null,
    pending: [],  // windows waiting for resolution
    maxDrawdown: { pct: 0, dollars: 0 },
  };

  let log = () => {};
  let slog = () => {};
  const nowFn = () => Date.now();
  const nowSec = () => Math.floor(Date.now() / 1000);

  function getJSON(url, timeout = 3000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, { signal: ctrl.signal })
      .then(r => { clearTimeout(timer); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch(e => { clearTimeout(timer); throw e; });
  }

  function computeFee(shares, price) {
    return shares * feeTheta * price * (1 - price);
  }

  // ── Market Discovery ──
  function freshLeg(windowTs, slugPrefix, windowType) {
    const slug = `${slugPrefix}${windowTs}`;
    return {
      slug, conditionId: null, upTokenId: null, downTokenId: null,
      upAsk: null, upBid: null, downAsk: null, downBid: null,
      discovered: false, lastDiscoveryAttempt: 0,
      resolved: false, winner: null, resolutionMethod: null,
      windowType,
    };
  }

  async function discoverLeg(leg) {
    if (leg.discovered) return;
    const now = nowFn();
    if (now - leg.lastDiscoveryAttempt < 3000) return;
    leg.lastDiscoveryAttempt = now;
    try {
      const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`);
      const ev = Array.isArray(events) ? events[0] : null;
      if (!ev || !ev.markets || !ev.markets.length) return;
      const mk = ev.markets[0];
      leg.conditionId = mk.conditionId;
      const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
      const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
      const tokens = outcomes.map((o, i) => ({ outcome: o, token_id: tokenIds[i] || null }));
      const up = tokens.find(t => /up/i.test(t.outcome));
      const down = tokens.find(t => /down/i.test(t.outcome));
      if (!up || !down || !up.token_id || !down.token_id) return;
      leg.upTokenId = up.token_id;
      leg.downTokenId = down.token_id;
      leg.discovered = true;
      log(`🎯 discovered ${leg.slug} — Up ${String(up.token_id).slice(0,10)}… / Down ${String(down.token_id).slice(0,10)}…`);
    } catch (e) {
      log(`⚠️ discover failed: ${e.message}`);
    }
  }

  async function refreshLegPrices(leg) {
    if (!leg.upTokenId || !leg.downTokenId) return;
    try {
      const [upAsk, upBid, dnAsk, dnBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=SELL`).catch(() => null),
      ]);
      leg.upAsk = upAsk?.price != null ? Number(upAsk.price) : null;
      leg.upBid = upBid?.price != null ? Number(upBid.price) : null;
      leg.downAsk = dnAsk?.price != null ? Number(dnAsk.price) : null;
      leg.downBid = dnBid?.price != null ? Number(dnBid.price) : null;
    } catch (_) {}
  }

  // ── Trade Execution ──
  async function executeBuy(tokenId, shares, price) {
    if (!trader) return { ok: false, reason: 'no-trader' };
    if (shares < MIN_ORDER_SHARES) return { ok: false, reason: 'below-min' };
    try {
      const resp = await trader.placeFokLimitOrder(tokenId, 'BUY', price, shares);
      if (resp && resp.isFilled) {
        const avgPrice = resp.avgPrice || price;
        const filled = resp.filledShares || shares;
        const notional = round2(filled * avgPrice);
        const fee = computeFee(filled, avgPrice);
        const netFee = round2(fee - round2(fee * rebatePct));
        const cost = round2(notional + netFee);
        engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
        engine.totalVolume = round2(engine.totalVolume + notional);
        return { ok: true, filled, avgPrice, notional, fee, cost };
      }
      return { ok: false, reason: 'not-filled' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // ── Momentum Tracking ──
  function momentumScore(leg) {
    const up = leg.upAsk || 0;
    const dn = leg.downAsk || 0;
    return { up, dn, delta: up - dn };
  }

  function pickSize(price, sideMomentum, otherMomentum, wt) {
    const s = WINDOW_TYPES[wt].sizes;
    if (price < 0.30) return s.cheap;
    if (price > 0.60 && sideMomentum > otherMomentum) return s.strong;
    return s.mid;
  }

  // ── Window Management ──
  function freshTrade(windowTs, wt) {
    const cfg = WINDOW_TYPES[wt];
    const slugPrefix = wt === '5m' ? 'btc-updown-5m-' : 'btc-updown-15m-';
    return {
      windowTs,
      windowType: wt,
      closeAt: (windowTs + cfg.seconds) * 1000,
      entryDelayMs: cfg.entryDelay * 1000,
      leg: freshLeg(windowTs, slugPrefix, wt),
      phase: 'waiting',
      buys: [],
      upShares: 0, dnShares: 0,
      upCost: 0, dnCost: 0,
      totalSpent: 0,
      totalShares: 0,
      buyCount: 0,
      lastBuyAt: 0,
      pnl: null, win: null, settled: false,
      momentumHistory: [],
    };
  }

  async function tick() {
    const now = nowFn();

    // Check ALL active windows (both 5m and 15m)
    for (const wt of ['5m', '15m']) {
      const cfg = WINDOW_TYPES[wt];
      const windowTs = Math.floor(nowSec() / cfg.seconds) * cfg.seconds;
      const key = wt;

      // Settle old windows
      if (engine.current && engine.current[key] && engine.current[key].windowTs !== windowTs) {
        const old = engine.current[key];
        if (!old.settled) await settle(old);
      }

      // New window
      if (!engine.current) engine.current = {};
      if (!engine.current[key] || engine.current[key].windowTs !== windowTs) {
        engine.current[key] = freshTrade(windowTs, wt);
        log(`🆕 [${wt}] window ${windowTs} opened — starting in ${cfg.entryDelay}s`);
      }

      const t = engine.current[key];
      if (t.settled) continue;

      // Discover
      if (!t.leg.discovered) {
        await discoverLeg(t.leg);
        continue;
      }

      // Refresh prices
      await refreshLegPrices(t.leg);

      // Window end?
      if (now >= t.closeAt) {
        await settle(t);
        continue;
      }

      // Entry delay
      const secsIntoWindow = (now / 1000) - windowTs;
      if (secsIntoWindow < cfg.entryDelay) {
        t.phase = 'waiting';
        continue;
      }

      // Budget check
      if (t.totalSpent >= cfg.budget) {
        t.phase = 'budget-exceeded';
        continue;
      }

      // Buy interval check
      if (now - t.lastBuyAt < cfg.buyIntervalMs) {
        t.phase = 'trading';
        continue;
      }

      // Momentum
      const mom = momentumScore(t.leg);
      t.momentumHistory.push({ t: now, up: mom.up, dn: mom.dn });
      if (t.momentumHistory.length > 30) t.momentumHistory.shift();

      // Buy BOTH sides
      const upAsk = t.leg.upAsk;
      const dnAsk = t.leg.downAsk;

      // UP
      if (upAsk != null && upAsk > 0.01 && upAsk < 0.99) {
        const shares = pickSize(upAsk, mom.up, mom.dn, wt);
        const cost = round2(shares * upAsk);
        if (t.totalSpent + cost <= cfg.budget && engine.bankroll >= cost) {
          const res = await executeBuy(t.leg.upTokenId, shares, upAsk);
          if (res.ok) {
            t.upShares = round2(t.upShares + res.filled);
            t.upCost = round2(t.upCost + res.cost);
            t.totalSpent = round2(t.totalSpent + res.cost);
            t.totalShares = round2(t.totalShares + res.filled);
            t.buyCount++;
            t.lastBuyAt = now;
            engine.bankroll = round2(engine.bankroll - res.cost);
            t.buys.push({ side: 'up', shares: res.filled, price: res.avgPrice, cost: res.cost, ts: now });
            log(`📈 [${wt}] UP ${res.filled}sh @${res.avgPrice.toFixed(3)} = $${res.cost.toFixed(2)}`);
          }
        }
      }

      if (t.totalSpent >= cfg.budget) { t.phase = 'budget-exceeded'; continue; }

      // DOWN
      if (dnAsk != null && dnAsk > 0.01 && dnAsk < 0.99) {
        const shares = pickSize(dnAsk, mom.dn, mom.up, wt);
        const cost = round2(shares * dnAsk);
        if (t.totalSpent + cost <= cfg.budget && engine.bankroll >= cost) {
          const res = await executeBuy(t.leg.downTokenId, shares, dnAsk);
          if (res.ok) {
            t.dnShares = round2(t.dnShares + res.filled);
            t.dnCost = round2(t.dnCost + res.cost);
            t.totalSpent = round2(t.totalSpent + res.cost);
            t.totalShares = round2(t.totalShares + res.filled);
            t.buyCount++;
            t.lastBuyAt = now;
            engine.bankroll = round2(engine.bankroll - res.cost);
            t.buys.push({ side: 'down', shares: res.filled, price: res.avgPrice, cost: res.cost, ts: now });
            log(`📉 [${wt}] DN ${res.filled}sh @${res.avgPrice.toFixed(3)} = $${res.cost.toFixed(2)}`);
          }
        }
      }

      t.phase = 'trading';
    }
  }

  async function settle(t) {
    if (t.settled) return;
    t.settled = true;

    const leg = t.leg;
    if (!leg.resolved && leg.conditionId) {
      try {
        const mkts = await getJSON(`${GAMMA}/markets?condition_id=${leg.conditionId}`);
        const mk = Array.isArray(mkts) ? mkts[0] : null;
        if (mk && mk.closed) {
          const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : (mk.outcomePrices || []);
          const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
          const upIdx = outcomes.findIndex(o => /up/i.test(o));
          const dnIdx = outcomes.findIndex(o => /down/i.test(o));
          if (upIdx >= 0 && dnIdx >= 0) {
            const upWin = prices[upIdx] != null && Number(prices[upIdx]) >= 0.5;
            leg.winner = upWin ? 'up' : 'down';
            leg.resolved = true;
            leg.resolutionMethod = 'final-price';
          }
        }
      } catch (_) {}
    }

    let payout = 0;
    if (leg.winner === 'up') payout = t.upShares;
    else if (leg.winner === 'down') payout = t.dnShares;

    const pnl = round2(payout - t.totalSpent);
    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnlTotal = round2(engine.realizedPnlTotal + pnl);
    engine.windowsDecided++;

    const won = t.totalSpent > 0 && pnl > 0;
    if (t.totalSpent > 0) {
      if (won) engine.wins++; else engine.losses++;
    }

    t.pnl = pnl;
    t.win = t.totalSpent > 0 ? won : null;
    t.winner = leg.winner;

    engine.history.unshift({
      windowTs: t.windowTs, windowType: t.windowType, slug: leg.slug, winner: leg.winner,
      upShares: t.upShares, dnShares: t.dnShares,
      upCost: t.upCost, dnCost: t.dnCost,
      totalSpent: t.totalSpent, totalShares: t.totalShares,
      buyCount: t.buyCount, payout, pnl,
      resolvedAt: nowFn(),
    });
    if (engine.history.length > 200) engine.history.pop();

    const wt = t.windowType;
    const summary = leg.winner ? `winner ${leg.winner.toUpperCase()}` : 'unresolved';
    log(`🏁 [${wt}] [${leg.slug}] ${summary} — UP ${t.upShares}sh/$${t.upCost.toFixed(2)} DN ${t.dnShares}sh/$${t.dnCost.toFixed(2)} | spent $${t.totalSpent.toFixed(2)} payout $${payout.toFixed(2)} P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    recordEquity();
  }

  function recordEquity() {
    engine.equity = round2(engine.bankroll);
    engine.equityCurve.push({ t: Date.now(), equity: engine.equity });
    if (engine.equityCurve.length > 2000) engine.equityCurve.shift();
    const peak = engine.equityCurve.reduce((m, p) => Math.max(m, p.equity), 0);
    if (peak > 0) {
      const dd = (peak - engine.equity) / peak;
      if (dd > engine.maxDrawdown.pct) {
        engine.maxDrawdown = { pct: round2(dd), dollars: round2(peak - engine.equity) };
      }
    }
  }

  function buildState() {
    const cur = engine.current || {};
    return {
      label, bankroll: engine.bankroll, equity: engine.equity,
      startingCapital,
      wins: engine.wins, losses: engine.losses,
      winRate: engine.windowsDecided > 0 ? round2((engine.wins / engine.windowsDecided) * 100) : null,
      windowsDecided: engine.windowsDecided,
      realizedPnlTotal: engine.realizedPnlTotal,
      totalFeesPaid: engine.totalFeesPaid, totalVolume: engine.totalVolume,
      maxDrawdown: engine.maxDrawdown,
      dryRun: !trader,
      current5m: cur['5m'] ? summarizeWindow(cur['5m']) : null,
      current15m: cur['15m'] ? summarizeWindow(cur['15m']) : null,
      history: engine.history.slice(0, 50),
      equityCurve: engine.equityCurve,
      config: { feeTheta, rebatePct },
    };
  }

  function summarizeWindow(t) {
    const cfg = WINDOW_TYPES[t.windowType];
    return {
      slug: t.leg?.slug, phase: t.phase, windowType: t.windowType,
      upAsk: t.leg?.upAsk, upBid: t.leg?.upBid,
      downAsk: t.leg?.downAsk, downBid: t.leg?.downBid,
      upShares: t.upShares, dnShares: t.dnShares,
      upCost: t.upCost, dnCost: t.dnCost,
      totalSpent: t.totalSpent, totalShares: t.totalShares,
      buyCount: t.buyCount, budget: cfg.budget,
      timeLeft: Math.max(0, t.closeAt - nowFn()),
    };
  }

  async function start() {
    slog(`⛏ ${label} — Momentum DCA bot, 5m + 15m windows`);
    slog(`⚙️  Capital: $${startingCapital}`);
    slog(`⚙️  5m: sizes ${WINDOW_TYPES['5m'].sizes.cheap}/${WINDOW_TYPES['5m'].sizes.mid}/${WINDOW_TYPES['5m'].sizes.strong}sh, every ${WINDOW_TYPES['5m'].buyIntervalMs/1000}s, budget $${WINDOW_TYPES['5m'].budget}`);
    slog(`⚙️  15m: sizes ${WINDOW_TYPES['15m'].sizes.cheap}/${WINDOW_TYPES['15m'].sizes.mid}/${WINDOW_TYPES['15m'].sizes.strong}sh, every ${WINDOW_TYPES['15m'].buyIntervalMs/1000}s, budget $${WINDOW_TYPES['15m'].budget}`);
    if (!trader) slog('⚠️  DEMO MODE — no trader connected');

    // Run at fastest interval (5m pace = 8s)
    const tickMs = WINDOW_TYPES['5m'].buyIntervalMs;
    while (true) {
      try {
        await tick();
      } catch (e) {
        log(`⚠️ tick error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, tickMs));
    }
  }

  return { start, buildState, _log: (fn) => { log = fn; }, _slog: (fn) => { slog = fn; } };
}

module.exports = { createMomentumEngine };
