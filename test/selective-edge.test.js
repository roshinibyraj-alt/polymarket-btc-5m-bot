'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Bot = require('../selective-edge-bot');
const Feed = require('../edge-price-feed');
const { RULES, forecast, candidate, marketFee, freshQuote, normalCdf } = require('../edge-model');

const START = 1_800_000_000_000;
function fixture() {
  let now = START + 90_000;
  const candles = Array.from({ length: 120 }, (_, i) => {
    const start = START - (119 - i) * 60_000;
    const open = 60_000;
    const close = open * (i % 2 ? 1.0008 : 0.9992);
    return { start, closeAt: start + 59_999, open, close,
      high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, closed: true };
  });
  const market = { id: 'current', slug: 'btc-current', start: START, end: START + 300_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' }, feesEnabled: true,
    feeSchedule: { rate: 0.05, exponent: 1 }, raw: { description: '60-second TWAP' } };
  const feed = { status: 'CONNECTED', historyStatus: 'READY', price: 60_220, tickAt: now,
    messageAgeMs: 0, closedCandles: candles, currentCandle: { start: START + 60_000, open: 60_100, close: 60_220 } };
  const quote = (side, ask) => ({
    bestAsk: ask, bestBid: ask - 0.01, mid: ask - 0.005, updatedAt: now, receivedAt: now,
    marketId: market.id, marketSlug: market.slug, tokenId: market.tokens[side],
    windowStart: market.start, windowEnd: market.end, sequence: 1,
    asks: [{ price: ask, size: 1000 }], bids: [{ price: ask - 0.01, size: 1000 }],
  });
  const binanceFeed = { start: async () => {}, stop() {}, snapshot: () => feed };
  const bot = new Bot({ now: () => now, binanceFeed, marketData: {
    getAssetMarket: async () => market, connectMarketStream: () => ({ close() {} }),
    getMarket: async () => ({}), resolvedWinner: () => null,
  } });
  const record = bot.records.get('BTC:5m');
  record.market = market;
  record.marketStatus = 'OPEN';
  record.targetStart = START;
  record.quotes.UP = quote('UP', 0.40);
  record.quotes.DOWN = quote('DOWN', 0.60);
  bot.websocket.status = 'CONNECTED';
  const advance = ms => {
    now += ms;
    feed.tickAt = now;
    for (const q of Object.values(record.quotes)) {
      q.updatedAt = now; q.receivedAt = now; q.sequence++;
    }
    return now;
  };
  return { bot, record, market, feed, now: () => now, advance, quote };
}

test('forecast uses only completed history and explicit Binance proxy uncertainty', () => {
  const f = fixture();
  const result = forecast({ feed: f.feed, market: f.market, now: f.now() });
  assert.equal(result.ready, true);
  assert.equal(result.anchor, 60_000);
  assert.equal(result.twap, true);
  assert.equal(result.proxy, true);
  assert.ok(result.lowerUp < result.rawUp);
  assert.ok(result.lowerUp + result.lowerDown < 1);
  assert.ok(result.basisBufferUsd >= 15);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
});

test('stale, future and disconnected ticks cannot create signals', () => {
  const f = fixture();
  for (const patch of [{ messageAgeMs: 2001 }, { tickAt: f.now() + 2000 }, { status: 'RECONNECTING' }]) {
    assert.equal(forecast({ feed: { ...f.feed, ...patch }, market: f.market, now: f.now() }).ready, false);
  }
});

test('missing and gapped candles block forecasting; window open is not first observed tick', () => {
  const f = fixture();
  assert.equal(forecast({ feed: { ...f.feed, closedCandles: [] }, market: f.market, now: f.now() }).ready, false);
  f.feed.closedCandles.splice(-4, 1);
  assert.equal(forecast({ feed: f.feed, market: f.market, now: f.now() }).ready, false);
});

test('invalid high/low data never produces a NaN forecast', () => {
  const f = fixture();
  f.feed.closedCandles[50].high = null;
  const m = forecast({ feed: f.feed, market: f.market, now: f.now() });
  assert.equal(m.ready, false);
  assert.match(m.reason, /Invalid candle ranges/);
});

test('market fees use explicit metadata, not a fee-free fallback', () => {
  assert.equal(marketFee({}), null);
  assert.equal(marketFee({ feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 2 } }), null);
  assert.deepEqual(marketFee({ feesEnabled: false }), { rate: 0, exponent: 1 });
});

test('candidate counts depth, taker fees and slippage reserve within risk budget', () => {
  const f = fixture();
  const model = forecast({ feed: f.feed, market: f.market, now: f.now() });
  const c = candidate({ model, quote: f.record.quotes.UP, market: f.market, side: 'UP', now: f.now(), budget: 15 });
  assert.ok(c.eligible, JSON.stringify(c));
  assert.ok(c.filledShares <= 50);
  assert.ok(c.cost + c.fees <= 15);
  assert.ok(Math.abs(c.fees - c.filledShares * 0.05 * 0.4 * 0.6) < 1e-9);
  assert.ok(Math.abs(c.netEdge - (c.conservativeProbability - c.allInCost - 0.01)) < 1e-9);
});

test('thin books fill only half the visible size and never synthesize shares', () => {
  const f = fixture();
  f.record.quotes.UP.asks[0].size = 12;
  const c = candidate({ model: { lowerUp: 0.8, lowerDown: 0.1, rawUp: 0.9 },
    quote: f.record.quotes.UP, market: f.market, side: 'UP', now: f.now(), budget: 15 });
  assert.equal(c.filledShares, 6);
  assert.equal(c.eligible, true);
});

test('wrong tokens, prior-window books, stale and crossed quotes fail validation', () => {
  const f = fixture();
  for (const patch of [{ tokenId: 'old-token' }, { windowStart: START - 300_000 },
    { marketId: 'previous' }, { updatedAt: f.now() - 2500 }, { bestBid: 0.9 }]) {
    assert.equal(Boolean(freshQuote({ ...f.record.quotes.UP, ...patch }, f.market, 'UP', f.now())), false);
  }
});

function enter(f) {
  f.bot.evaluate(f.now());
  f.bot.evaluate(f.advance(1000));
  f.bot.evaluate(f.advance(1000));
  assert.ok(f.bot.pendingEntry, JSON.stringify(f.bot.latestDecision));
  f.bot.evaluate(f.advance(500));
  assert.equal(f.bot.positions.length, 1);
}

test('three fresh confirmations then a later book are required before entry', () => {
  const f = fixture();
  enter(f);
  const p = f.bot.positions[0];
  assert.equal(p.side, 'UP');
  assert.ok(p.shares <= 50);
  assert.equal(p.entryPrice, 0.4);
  assert.ok(f.bot.orders[0].latencyMs >= RULES.fillLatencyMs);
  assert.ok(Math.abs(f.bot.cash - (3000 - p.totalCost - p.fees)) < 1e-9);
});

test('one entry per window; no adding, martingale, or forced opposite entries', () => {
  const f = fixture();
  enter(f);
  for (let i = 0; i < 8; i++) f.bot.evaluate(f.advance(1000));
  assert.equal(f.bot.positions.length, 1);
  assert.equal(f.bot.latestDecision.code, 'WINDOW_USED');
});

test('fallback buys the best safely quoted side after two consecutive empty windows', () => {
  const f = fixture();
  f.feed.price = 60_000;
  for (const minute of [1, 2]) f.feed.closedCandles.push({
    start: START + minute * 60_000, closeAt: START + minute * 60_000 + 59_999,
    open: 60_000, high: 60_002, low: 59_998, close: 60_000, closed: true,
  });
  f.feed.currentCandle = { start: START + 180_000, open: 60_000, close: 60_000 };
  f.record.quotes.UP.bestAsk = 0.95;
  f.record.quotes.UP.bestBid = 0.94;
  f.record.quotes.UP.asks = [{ price: 0.95, size: 1000 }];
  f.record.quotes.DOWN.bestAsk = 0.04;
  f.record.quotes.DOWN.bestBid = 0.03;
  f.record.quotes.DOWN.asks = [{ price: 0.04, size: 1000 }];
  f.advance(90_000);
  assert.equal(f.bot.cadenceFallbackDue(f.market, 179), false);
  assert.equal(f.bot.cadenceFallbackDue(f.market, 180), true);
  enter(f);
  const position = f.bot.positions[0];
  assert.equal(position.cadenceFallback, true);
  assert.ok(position.totalCost + position.fees <= RULES.perWindowDollarCap);
  assert.ok(position.shares <= RULES.maxShares);
  assert.equal(f.bot.orders[0].cadenceFallback, true);
  assert.ok([0.04, 0.95].includes(position.entryPrice));
  assert.equal(f.bot.latestDecision.code, 'CADENCE_FALLBACK_BUY');
  assert.equal(f.bot.cadenceFallbackDue(f.market, 190), false);
});

test('the cadence fallback waits after a trade in the immediately preceding window', () => {
  const f = fixture();
  f.market.start = START + 300_000;
  f.market.end = START + 600_000;
  f.market.id = 'second-window';
  assert.equal(f.bot.cadenceFallbackDue(f.market, 180), true);
  f.bot.positions.push({ marketId: 'first-window', windowStart: START, shares: 10 });
  assert.equal(f.bot.cadenceFallbackDue(f.market, 180), false);
  f.market.start = START + 600_000;
  f.market.end = START + 900_000;
  assert.equal(f.bot.cadenceFallbackDue(f.market, 180), true);
});

test('fallback remains blocked by unsafe books, unknown fees, and risk stop', () => {
  const f = fixture();
  const c = (side, ask, patches = {}) => candidate({
    model: { lowerUp: 0.3, lowerDown: 0.3, rawUp: 0.5 }, quote: { ...f.record.quotes[side],
      bestAsk: ask, bestBid: ask - 0.01, asks: [{ price: ask, size: 1000 }], ...patches },
    market: f.market, side, now: f.now(), budget: 15, cadenceFallback: true,
  });
  assert.match(c('UP', 0.5, { updatedAt: f.now() - 3000 }).reason, /Stale/);
  assert.match(c('UP', 0.5, { bestBid: 0.40 }).reason, /Spread/);
  assert.equal(c('UP', 0.5).eligible, true); // Standard fixture has valid known fees.
  const noFees = { ...f.market, feesEnabled: true, feeSchedule: null };
  assert.match(candidate({ model: { lowerUp: 0.3, lowerDown: 0.3, rawUp: 0.5 },
    quote: f.record.quotes.UP, market: noFees, side: 'UP', now: f.now(),
    budget: 15, cadenceFallback: true }).reason, /fee schedule/);
  f.bot.riskStopped = true;
  f.advance(90_000);
  f.bot.evaluate(f.now());
  assert.equal(f.bot.latestDecision.code, 'RISK_STOP');
});

test('a stale repeated Binance tick does not count as a fresh confirmation', () => {
  const f = fixture();
  f.bot.evaluate(f.now());
  const tick = f.feed.tickAt;
  f.advance(1000);
  f.feed.tickAt = tick;
  f.bot.evaluate(f.now());
  assert.equal(f.bot.confirmation.count, 1);
  assert.equal(f.bot.pendingEntry, null);
});

test('no new book means no paper fill and expired request cancels', () => {
  const f = fixture();
  f.bot.evaluate(f.now());
  f.bot.evaluate(f.advance(1000));
  f.bot.evaluate(f.advance(1000));
  const sequence = f.record.quotes.UP.sequence;
  f.advance(500); f.record.quotes.UP.sequence = sequence;
  f.bot.evaluate(f.now());
  assert.equal(f.bot.positions.length, 0);
  f.advance(1600);
  f.bot.evaluate(f.now());
  assert.equal(f.bot.pendingEntry, null);
  assert.equal(f.bot.positions.length, 0);
});

test('execution revalidation cancels when asks move to a bad price', () => {
  const f = fixture();
  f.bot.evaluate(f.now());
  f.bot.evaluate(f.advance(1000));
  f.bot.evaluate(f.advance(1000));
  f.advance(500);
  Object.assign(f.record.quotes.UP, { bestBid: 0.86, bestAsk: 0.87, asks: [{ price: 0.87, size: 500 }] });
  f.bot.evaluate(f.now());
  assert.equal(f.bot.positions.length, 0);
  assert.equal(f.bot.latestDecision.code, 'ORDER_CANCELLED');
});

test('opening and late windows skip; exposure and drawdown stop new buys', () => {
  const f = fixture();
  f.market.start = f.now() - 5000;
  f.bot.evaluate(f.now());
  assert.equal(f.bot.latestDecision.code, 'OPENING_WAIT');
  f.market.start = START;
  f.bot.evaluate(f.advance(130_000));
  assert.equal(f.bot.latestDecision.code, 'LATE_WINDOW');
  const g = fixture();
  g.bot.maxDrawdown = 150;
  g.bot.evaluate(g.now());
  assert.equal(g.bot.latestDecision.code, 'RISK_STOP');
  assert.equal(g.bot.riskStopped, true);
});

test('paper positions hold through empty bids and $0.99 instead of fake early payouts', () => {
  const f = fixture();
  enter(f);
  const cash = f.bot.cash;
  f.bot.checkTakeProfits(f.record, 'UP', { mid: 0.99, bestBid: 0.99 }, f.now());
  f.bot.checkStopLosses(f.record, 'UP', { bestBid: null }, f.now());
  assert.equal(f.bot.positions[0].status, 'OPEN');
  assert.equal(f.bot.cash, cash);
});

test('official settlement credits exactly once and reconciles cash, P&L, fees and Brier score', () => {
  const f = fixture();
  enter(f);
  const p = f.bot.positions[0];
  f.bot.expireMarket(f.record, f.market.end);
  f.bot.settleMarket('current', 'UP', f.market.end + 5000);
  const cash = f.bot.cash;
  f.bot.settleMarket('current', 'UP', f.market.end + 10_000);
  assert.equal(f.bot.cash, cash);
  assert.equal(p.status, 'RESOLVED_WIN');
  assert.ok(Math.abs(cash - (3000 + p.shares - p.totalCost - p.fees)) < 1e-8);
  assert.ok(Math.abs(f.bot.accountSnapshot().equity - 3000 - p.realizedPnl) < 1e-8);
  assert.equal(f.bot.statistics().settledWindows, 1);
  assert.ok(f.bot.statistics().brierScore >= 0);
});

test('pending prior markets do not block current window and count toward total exposure', () => {
  const f = fixture();
  enter(f);
  f.bot.expireMarket(f.record, f.market.end);
  const first = f.bot.positions[0];
  assert.equal(first.status, 'PENDING_RESOLUTION');
  assert.ok(f.bot.riskSnapshot().openCost > 0);
  // No global freeze merely because settlement is pending.
  f.market.id = 'next-market'; f.record.marketStatus = 'OPEN';
  for (const q of Object.values(f.record.quotes)) q.marketId = f.market.id;
  f.bot.evaluate(f.advance(1000));
  assert.notEqual(f.bot.latestDecision.code, 'WINDOW_USED');
});

test('restart restores risk and history but never a pending signal or duplicate entry', () => {
  const f = fixture();
  enter(f);
  f.bot.riskStopped = true;
  const ledger = JSON.parse(JSON.stringify(f.bot.exportLedger()));
  const g = fixture();
  g.bot.restoreLedger(ledger);
  assert.equal(g.bot.positions.length, 1);
  assert.equal(g.bot.riskStopped, true);
  assert.equal(g.bot.pendingEntry, null);
  assert.equal(g.bot.cash, f.bot.cash);
});

test('official losing settlement loses only entry cost and does not increase the next stake', () => {
  const f = fixture();
  enter(f);
  const p = f.bot.positions[0];
  f.bot.expireMarket(f.record, f.market.end);
  f.bot.settleMarket('current', 'DOWN', f.market.end + 5000);
  assert.equal(p.realizedPnl, -p.totalCost - p.fees);
  assert.equal(p.exitPrice, 0);
  assert.ok(f.bot.riskSnapshot().perWindowBudget <= 15);
  assert.ok(Math.abs(f.bot.cash - f.bot.accountSnapshot().equity) < 1e-9);
});

test('risk budget includes pending-resolution costs and cannot exceed total exposure cap', () => {
  const f = fixture();
  f.bot.positions.push({ status: 'PENDING_RESOLUTION', totalCost: 59, fees: 0.5, shares: 100 });
  assert.equal(f.bot.riskSnapshot().perWindowBudget, 0.5);
  f.bot.evaluate(f.now());
  assert.equal(f.bot.latestDecision.code, 'EXPOSURE_CAP');
});

test('a fresh reconnect must receive an initial book before price deltas can hydrate it', () => {
  const f = fixture();
  f.bot.tokenRefs.set('up-token', { recordKey: 'BTC:5m', side: 'UP' });
  const change = { event_type: 'price_change', timestamp: f.now(),
    price_changes: [{ asset_id: 'up-token', side: 'SELL', price: '0.4', size: '900' }] };
  const before = f.record.quotes.UP.sequence;
  f.bot.handleMarketMessage(change);
  assert.equal(f.record.quotes.UP.sequence, before);
  f.bot.handleMarketMessage({ event_type: 'book', timestamp: f.now(), asset_id: 'up-token',
    bids: [{ price: '0.39', size: '1000' }], asks: [{ price: '0.40', size: '1000' }] });
  assert.ok(f.bot.hydrated.has('up-token'));
  assert.equal(f.record.quotes.UP.bestAsk, 0.4);
  f.bot.handleMarketMessage({ event_type: 'book', timestamp: f.now() - 5000, asset_id: 'up-token',
    bids: [], asks: [{ price: '0.01', size: '1000' }] });
  assert.equal(f.record.quotes.UP.bestAsk, 0.4);
});

test('new strategy snapshots exclude obsolete TP, sizing progression and candle signal rules', () => {
  const f = fixture();
  const s = f.bot.snapshot();
  assert.equal(s.mode, 'PAPER ONLY');
  assert.equal(RULES.id, 'btc-5m-selective-edge-paper-v2-cadence');
  assert.equal(s.strategy.id, RULES.id);
  assert.equal(s.sizingByAsset, undefined);
  assert.equal(s.strategy.entry.includes('Cadence fallback'), true);
  assert.ok(s.edgeEngine.latestDecision === null);
  assert.equal(s.edgeEngine.statistics.brierScore, null);
});

test('combined Binance stream separates live trades from candle history freshness', () => {
  const f = fixture();
  const feed = new Feed({ now: f.now });
  feed.status = 'CONNECTED';
  feed.handleMessage(JSON.stringify({ data: { e: 'aggTrade', s: 'BTCUSDT', p: '60010', T: f.now(), a: 1 } }));
  assert.equal(feed.snapshot().price, 60010);
  assert.equal(feed.snapshot().messageAgeMs, 0);
  f.advance(2500);
  assert.equal(feed.snapshot().messageAgeMs, 2500);
  feed.handleMessage(JSON.stringify({ data: { e: 'aggTrade', s: 'BTCUSDT', p: '1', T: f.now() - 5000, a: 2 } }));
  assert.equal(feed.snapshot().price, 60010);
});
