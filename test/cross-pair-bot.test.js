'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CrossPairBot = require('../cross-pair-bot');
const config = require('../config');

const WINDOW_MS = 5 * 60_000;
const START = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;

function createBot(now = START + 1000) {
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.35,
    btcDown: 0.40,
    ethUp: 0.38,
    ethDown: 0.44,
  }, now);
  return { bot, setNow(value) { now = value; }, getNow() { return now; } };
}

function setWindow(bot, start, asks, updatedAt = start + 1000) {
  for (const asset of ['BTC', 'ETH']) {
    const record = bot.records.get(`${asset}:5m`);
    record.market = {
      id: `${asset.toLowerCase()}-${start}`,
      slug: `${asset.toLowerCase()}-updown-5m-${start}`,
      title: `${asset} 5m test`,
      asset,
      start,
      end: start + WINDOW_MS,
      tokens: {
        UP: `${asset.toLowerCase()}-${start}-up-token`,
        DOWN: `${asset.toLowerCase()}-${start}-down-token`,
      },
      feesEnabled: true,
      feeSchedule: { rate: 0 },
    };
    record.marketStatus = 'OPEN';
    for (const side of ['UP', 'DOWN']) {
      const ask = asks[`${asset.toLowerCase()}${side === 'UP' ? 'Up' : 'Down'}`];
      record.quotes[side] = {
        status: 'LIVE',
        bestBid: Math.max(0.01, ask - 0.01),
        bestAsk: ask,
        bidSize: 2000,
        askSize: 2000,
        mid: (Math.max(0.01, ask - 0.01) + ask) / 2,
        updatedAt,
        receivedAt: updatedAt,
        sequence: updatedAt,
        tokenId: record.market.tokens[side],
        marketId: record.market.id,
        marketSlug: record.market.slug,
        windowStart: start,
        windowEnd: start + WINDOW_MS,
        asks: [{ price: ask, size: 2000 }],
        bids: [{ price: Math.max(0.01, ask - 0.01), size: 2000 }],
      };
    }
  }
}

function settlePair(bot, cycle, btcWinner, ethWinner, now) {
  for (const positionId of cycle.legPositionIds) {
    const position = bot.positions.find(item => item.id === positionId);
    assert.ok(position);
    position.status = 'PENDING_RESOLUTION';
  }
  bot.settleMarket(`btc-${cycle.windowStart}`, btcWinner, now);
  bot.settleMarket(`eth-${cycle.windowStart}`, ethWinner, now + 1);
}

test('four pairs are independent and each requires a strict ask-sum below $0.80', () => {
  const { bot, getNow } = createBot();
  const btcUp = bot.records.get('BTC:5m').quotes.UP;
  const ethDown = bot.records.get('ETH:5m').quotes.DOWN;

  btcUp.bestAsk = 0.36;
  btcUp.asks = [{ price: 0.36, size: 2000 }];
  btcUp.sequence = getNow() + 1;
  btcUp.askSize = 2000;
  ethDown.bestAsk = 0.44;
  ethDown.asks = [{ price: 0.44, size: 2000 }];
  ethDown.sequence = getNow() + 1;
  ethDown.askSize = 2000;
  bot.evaluateCrossPairs(getNow());
  assert.equal(
    bot.positions.filter(position => position.pairId === 'btc-up-eth-down').length,
    0,
    'a sum exactly equal to $0.80 must not trigger the first pair',
  );
  assert.equal(bot.positions.filter(position => position.pairId === 'eth-up-btc-down').length, 2);
  assert.equal(bot.positions.filter(position => position.pairId === 'btc-up-eth-up').length, 2);
  assert.equal(bot.positions.filter(position => position.pairId === 'btc-down-eth-down').length, 0);

  btcUp.bestAsk = 0.35;
  btcUp.asks = [{ price: 0.35, size: 2000 }];
  btcUp.sequence = getNow() + 2;
  bot.evaluateCrossPairs(getNow());
  assert.equal(bot.positions.length, 6, 'each qualifying pair should enter independently');
  assert.deepEqual(bot.positions.map(position => position.shares), Array(6).fill(config.CROSS_PAIR_BASE_SHARES));
  assert.equal(bot.crossPairCycles.length, 3);
  assert.ok(bot.crossPairCycles.every(cycle => cycle.legPositionIds.length === 2));
  assert.equal(bot.snapshot().crossPairs.length, 4);
  assert.equal(bot.snapshot().strategy.id, CrossPairBot.STRATEGY.id);
  assert.equal(bot.snapshot().strategy.resolutionPollMs, 5000);
});

test('entry audits save matched market, token, book levels, timestamps, fills, and market fee', () => {
  const { bot, getNow } = createBot();
  bot.records.get('BTC:5m').market.feeSchedule = { rate: 0.05 };
  bot.records.get('ETH:5m').market.feeSchedule = { rate: 0.01 };
  bot.evaluateCrossPairs(getNow());

  const btcOrder = bot.orders.find(order =>
    order.pairId === 'btc-up-eth-down' && order.asset === 'BTC');
  const ethOrder = bot.orders.find(order =>
    order.pairId === 'btc-up-eth-down' && order.asset === 'ETH');
  assert.equal(btcOrder.executionModel, 'CLOB_VISIBLE_DEPTH_SHARED_PAPER_V2');
  assert.equal(btcOrder.executionAudit.modeledLatencyMs, null);
  assert.equal(btcOrder.executionAudit.marketId, `btc-${START}`);
  assert.equal(btcOrder.executionAudit.tokenId, `btc-${START}-up-token`);
  assert.equal(btcOrder.executionAudit.sourceUpdatedAt, getNow());
  assert.deepEqual(btcOrder.executionAudit.asks, [{ price: 0.35, size: 2000 }]);
  assert.deepEqual(btcOrder.executionAudit.simulatedFills, [
    { shares: 10, price: 0.35, value: 3.5, fee: 0.11375 },
  ]);
  assert.equal(btcOrder.fee, 0.11375);
  assert.equal(ethOrder.fee, 0.02464);
  assert.equal(btcOrder.executionAudit.feeScheduleSource, 'Gamma market fee schedule');
  assert.equal(bot.snapshot().executionAudit.auditedOrderCount, 6);
});

test('stale or previous-window token quotes cannot trigger new entries', () => {
  const now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.35,
    btcDown: 0.65,
    ethUp: 0.55,
    ethDown: 0.40,
  }, now);
  const quote = bot.records.get('BTC:5m').quotes.UP;
  quote.tokenId = 'previous-window-token';
  bot.evaluateCrossPairs(now);
  assert.equal(bot.crossPairCycles.length, 0);

  quote.tokenId = `btc-${START}-up-token`;
  quote.updatedAt = now - config.CROSS_PAIR_MAX_QUOTE_AGE_MS - 1;
  quote.receivedAt = quote.updatedAt;
  bot.evaluateCrossPairs(now);
  assert.equal(bot.crossPairCycles.length, 0);
  assert.equal(bot.snapshot().crossPairs.find(pair => pair.id === 'btc-up-eth-down').status, 'WAITING_FOR_QUOTES');
});

test('the same displayed ask depth is not counted twice across overlapping pairs', () => {
  const now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.35,
    btcDown: 0.65,
    ethUp: 0.40,
    ethDown: 0.40,
  }, now);
  bot.records.get('BTC:5m').quotes.UP.asks = [{ price: 0.35, size: 10 }];
  bot.records.get('BTC:5m').quotes.UP.askSize = 10;
  bot.evaluateCrossPairs(now);

  const btcUpOrders = bot.orders.filter(order => order.asset === 'BTC' && order.side === 'UP');
  assert.equal(btcUpOrders.reduce((sum, order) => sum + order.filledShares, 0), 10);
  assert.equal(btcUpOrders.filter(order => order.filledShares === 0).length, 1);
});

test('floating P&L sweeps visible bids and subtracts estimated sell fees', () => {
  const now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.35,
    btcDown: 0.60,
    ethUp: 0.55,
    ethDown: 0.40,
  }, now);
  bot.records.get('BTC:5m').market.feeSchedule = { rate: 0.05 };
  bot.evaluateCrossPairs(now);

  const position = bot.positions.find(item => item.pairId === 'btc-up-eth-down' && item.asset === 'BTC');
  const record = bot.records.get('BTC:5m');
  const quote = record.quotes.UP;
  quote.bestBid = 0.50;
  quote.bidSize = 5;
  quote.bids = [{ price: 0.50, size: 5 }, { price: 0.40, size: 5 }];
  quote.updatedAt = now + 10;
  quote.receivedAt = now + 10;
  quote.sequence = now + 10;
  bot.markPositions(now + 10, record.key, 'UP');

  assert.equal(position.markBid, 0.45);
  assert.equal(position.estimatedLiquidationProceeds, 4.5);
  assert.equal(position.estimatedExitFee, 0.1225);
  assert.equal(position.unrealizedPnl, 0.76375);
  assert.equal(position.markStatus, 'LIVE_DEPTH_SWEEP');
  const account = bot.accountSnapshot();
  assert.ok(Math.abs(account.unrealizedPnl - bot.positions
    .filter(item => item.status === 'OPEN')
    .reduce((sum, item) => sum + item.unrealizedPnl, 0)) < 1e-9);
  assert.equal(account.equity, Number((bot.initialCapital + account.realizedPnl + account.unrealizedPnl).toFixed(6)));
});

test('all pair sizes stay at 10 after wins or losses', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const btcUpEthDown = bot.crossPairCycles.find(cycle => cycle.pairId === 'btc-up-eth-down');
  assert.ok(btcUpEthDown);

  settlePair(bot, btcUpEthDown, 'DOWN', 'UP', getNow() + 1000);
  assert.equal(bot.crossPairSizing['btc-up-eth-down'].nextShares, 10);
  assert.equal(btcUpEthDown.sizingOutcome, 'PAIR_LOSS');
  assert.ok(Object.values(bot.crossPairSizing).every(item => item.nextShares === 10));

  const nextStart = START + WINDOW_MS;
  const nextNow = nextStart + 1000;
  setWindow(bot, nextStart, {
    btcUp: 0.30,
    btcDown: 0.40,
    ethUp: 0.35,
    ethDown: 0.35,
  }, nextNow);
  bot.evaluateCrossPairs(nextNow);
  const nextCycle = bot.crossPairCycles.find(cycle =>
    cycle.pairId === 'btc-up-eth-down' && cycle.windowStart === nextStart);
  assert.ok(nextCycle);
  assert.equal(nextCycle.sharesPerLeg, 10);
});

test('a $0.99 best bid closes at the modeled $1-per-share payout', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const position = bot.positions.find(item => item.id === cycle.legPositionIds[0]);
  const record = bot.records.get(`${position.asset}:5m`);
  const quote = record.quotes[position.side];
  quote.bestBid = 0.99;
  quote.updatedAt = getNow() + 100;
  quote.receivedAt = getNow() + 100;
  quote.sequence = getNow() + 100;

  bot.checkTakeProfits(record, position.side, quote, getNow() + 100);

  assert.equal(position.status, 'TAKE_PROFIT');
  assert.equal(position.exitPrice, 0.99);
  assert.equal(position.exitPayout, 1);
  assert.ok(position.realizedPnl > 0);
  assert.equal(cycle.status, 'OPEN');
  assert.equal(bot.crossPairSizing[cycle.pairId].nextShares, 10);
});

test('a fresh empty bid book triggers the $0 stop-loss', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');

  for (const positionId of cycle.legPositionIds) {
    const position = bot.positions.find(item => item.id === positionId);
    const record = bot.records.get(`${position.asset}:5m`);
    const quote = record.quotes[position.side];
    quote.bestBid = null;
    quote.updatedAt = getNow() + 100;
    quote.receivedAt = getNow() + 100;
    quote.sequence = getNow() + 100;
    quote.bids = [];
    bot.checkStopLosses(record, position.side, quote, getNow() + 100);
    assert.equal(position.status, 'STOP_LOSS');
    assert.equal(position.exitPrice, 0);
    assert.equal(position.exitPayout, 0);
    assert.ok(position.realizedPnl < 0);
  }

  assert.equal(cycle.status, 'CLOSED');
  assert.equal(cycle.sizingOutcome, 'PAIR_LOSS');
  assert.equal(bot.crossPairSizing[cycle.pairId].nextShares, 10);
  assert.ok(Object.values(bot.crossPairSizing).every(item => item.nextShares === 10));
});

test('positions keep their final live mark while awaiting resolution', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const position = bot.positions.find(item => item.id === cycle.legPositionIds[0]);
  const record = bot.records.get(`${position.asset}:5m`);
  const quote = record.quotes[position.side];
  quote.bestBid = 0.31;
  quote.updatedAt = getNow() + 20;
  quote.receivedAt = getNow() + 20;
  quote.sequence = getNow() + 20;
  quote.bids = [{ price: 0.31, size: 2000 }];
  bot.markPositions(getNow() + 20, record.key, position.side);
  const lastMarkPnl = position.unrealizedPnl;

  bot.expireMarket(record, START + WINDOW_MS);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  assert.equal(position.markBid, 0.31);
  assert.equal(position.unrealizedPnl, lastMarkPnl);
  assert.equal(position.markStatus, 'LAST_MARK_PENDING_RESOLUTION');

  const restored = new CrossPairBot({ now: getNow });
  restored.restoreLedger(bot.exportLedger());
  const restoredPosition = restored.positions.find(item => item.id === position.id);
  assert.equal(restoredPosition.status, 'PENDING_RESOLUTION');
  assert.equal(restoredPosition.markBid, 0.31);
  assert.equal(restoredPosition.unrealizedPnl, lastMarkPnl);
});

test('open positions wait for official resolution at window end', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const end = START + WINDOW_MS;
  bot.expireMarket(bot.records.get('BTC:5m'), end);
  bot.expireMarket(bot.records.get('ETH:5m'), end);

  assert.equal(cycle.status, 'PENDING_RESOLUTION');
  assert.ok(cycle.legPositionIds.every(id =>
    bot.positions.find(position => position.id === id)?.status === 'PENDING_RESOLUTION'));
  assert.equal(cycle.sizingApplied, false);

  settlePair(bot, cycle, 'UP', 'DOWN', end + 1);
  assert.equal(cycle.status, 'CLOSED');
  assert.equal(cycle.sizingOutcome, 'PAIR_PROFIT');
});

test('a pair stays open when its asks rise and the opposite pair enters independently', () => {
  let now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.30,
    btcDown: 0.60,
    ethUp: 0.55,
    ethDown: 0.40,
  }, now);
  bot.evaluateCrossPairs(now);
  const firstPair = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  assert.ok(firstPair);
  assert.equal(bot.crossPairCycles.length, 1, 'only the intended first pair should qualify');

  const setQuote = (asset, side, ask, bid, tick) => {
    const quote = bot.records.get(`${asset}:5m`).quotes[side];
    quote.bestAsk = ask;
    quote.bestBid = bid;
    quote.updatedAt = tick;
    quote.receivedAt = tick;
    quote.sequence = tick;
    quote.askSize = 2000;
    quote.bidSize = 2000;
    quote.asks = [{ price: ask, size: 2000 }];
    quote.bids = [{ price: bid, size: 2000 }];
  };
  now += 500;
  setQuote('BTC', 'UP', 0.62, 0.61, now);
  setQuote('ETH', 'DOWN', 0.60, 0.59, now);
  setQuote('ETH', 'UP', 0.39, 0.38, now);
  setQuote('BTC', 'DOWN', 0.38, 0.37, now);
  bot.evaluateCrossPairs(now);

  assert.equal(firstPair.legPositionIds.every(id =>
    bot.positions.find(position => position.id === id)?.status === 'OPEN'), true);
  assert.equal(bot.orders.filter(order => order.action === 'SELL_TAKER').length, 0);
  assert.equal(firstPair.reverseExitAskSum, undefined);

  const inverseCycle = bot.crossPairCycles.find(item =>
    item.pairId === 'eth-up-btc-down' && item.windowStart === START);
  assert.ok(inverseCycle, 'the opposite pair should enter when its own asks fall below $0.80');
  assert.equal(inverseCycle.entryAskSum, 0.77);
  assert.ok(inverseCycle.legPositionIds.every(id =>
    bot.positions.find(position => position.id === id)?.status === 'OPEN'));
  assert.equal(bot.snapshot().strategy.inverseExitAskSumAtOrAbove, undefined);
  assert.equal(bot.snapshot().crossPairs.every(pair => pair.inverseExitThreshold === undefined), true);
});

test('the inverse pair does not enter when its own combined asks are not below $0.80', () => {
  let now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.30,
    btcDown: 0.60,
    ethUp: 0.55,
    ethDown: 0.40,
  }, now);
  bot.evaluateCrossPairs(now);
  const firstPair = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  assert.ok(firstPair);

  const setQuote = (asset, side, ask, bid, tick) => {
    const quote = bot.records.get(`${asset}:5m`).quotes[side];
    quote.bestAsk = ask;
    quote.bestBid = bid;
    quote.updatedAt = tick;
    quote.sequence = tick;
    quote.asks = [{ price: ask, size: 2000 }];
    quote.bids = [{ price: bid, size: 2000 }];
  };
  now += 500;
  setQuote('BTC', 'UP', 0.62, 0.61, now);
  setQuote('ETH', 'DOWN', 0.60, 0.59, now);
  setQuote('ETH', 'UP', 0.45, 0.44, now);
  setQuote('BTC', 'DOWN', 0.40, 0.39, now);
  bot.evaluateCrossPairs(now);

  assert.equal(firstPair.legPositionIds.every(id =>
    bot.positions.find(position => position.id === id)?.status === 'OPEN'), true);
  assert.equal(bot.orders.filter(order => order.action === 'SELL_TAKER').length, 0);
  assert.equal(firstPair.reverseExitStatus, undefined);
  assert.equal(bot.crossPairCycles.some(item => item.pairId === 'eth-up-btc-down'), false);
});

test('official outcomes are checked every five seconds and settle only when published', async () => {
  assert.equal(config.DIP_BOUNCE_RESOLUTION_POLL_MS, 5000);
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const end = START + WINDOW_MS;
  bot.expireMarket(bot.records.get('BTC:5m'), end);
  bot.expireMarket(bot.records.get('ETH:5m'), end);

  let shouldResolve = false;
  let checks = 0;
  bot.marketData.getMarket = async id => {
    checks += 1;
    return {
      id,
      closed: shouldResolve,
      outcomes: ['Up', 'Down'],
      outcomePrices: shouldResolve ? ['1', '0'] : ['0.5', '0.5'],
    };
  };
  bot.marketData.resolvedWinner = market => market.closed ? 'UP' : null;

  await bot.checkResolutions(end);
  assert.equal(checks, 2, 'check once for each BTC and ETH market');
  assert.ok(bot.positions.every(position => position.status === 'PENDING_RESOLUTION'));

  await bot.checkResolutions(end + 4999);
  assert.equal(checks, 2, 'do not poll faster than the configured interval');

  shouldResolve = true;
  await bot.checkResolutions(end + 5000);
  assert.equal(checks, 4);
  assert.ok(bot.positions.every(position => position.status === 'RESOLVED_WIN' || position.status === 'RESOLVED_LOSS'));
});

test('a pair waits for its unresolved previous cycle, without blocking the other pair', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const otherCycle = bot.crossPairCycles.find(item => item.pairId === 'eth-up-btc-down');
  assert.ok(cycle);
  assert.ok(otherCycle);
  settlePair(bot, otherCycle, 'DOWN', 'UP', getNow() + 500);
  bot.expireMarket(bot.records.get('BTC:5m'), START + WINDOW_MS);
  bot.expireMarket(bot.records.get('ETH:5m'), START + WINDOW_MS);

  const nextStart = START + WINDOW_MS;
  const nextNow = nextStart + 1000;
  setWindow(bot, nextStart, {
    btcUp: 0.30,
    btcDown: 0.40,
    ethUp: 0.35,
    ethDown: 0.35,
  }, nextNow);
  bot.evaluateCrossPairs(nextNow);

  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'btc-up-eth-down').length, 1);
  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'eth-up-btc-down').length, 2);
  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'btc-up-eth-up').length, 1);
  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'btc-down-eth-down').length, 1);
  assert.equal(bot.pairWindowStates['btc-up-eth-down'].status, 'WAITING_FOR_RESOLUTION');
  const pairCard = bot.snapshot(nextNow).crossPairs.find(item => item.id === 'btc-up-eth-down');
  assert.equal(pairCard.currentCycle.status, 'PENDING_RESOLUTION');
  assert.ok(pairCard.currentCycle.legs.some(leg => leg.position?.status === 'PENDING_RESOLUTION'));
});

test('the new ledger stores pair sizing and restores open pair positions', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  bot.crossPairSizing['btc-up-eth-down'].nextShares = 1000;
  const saved = bot.exportLedger();
  assert.equal(saved.strategyId, CrossPairBot.STRATEGY.id);

  const restored = new CrossPairBot({ now: getNow });
  restored.restoreLedger(saved);
  assert.equal(restored.crossPairSizing['btc-up-eth-down'].nextShares, 10);
  assert.equal(restored.positions.length, 6);
  assert.equal(restored.crossPairCycles.length, 3);
  assert.equal(restored.snapshot().strategy.id, CrossPairBot.STRATEGY.id);
  const pair = restored.snapshot().crossPairs.find(item => item.id === 'btc-up-eth-down');
  assert.equal(pair.trades[0].legs[0].position.shares, 10);
  assert.equal(pair.trades.length, 1);
  assert.equal(restored.snapshot().crossPairs.length, 4);
});

test('history migration labels old fills unaudited without changing their money or positions', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const ledger = bot.exportLedger();
  const snapshot = ledger.snapshot;
  const cashBefore = snapshot.account.cash;
  const positionCountBefore = snapshot.positions.length;
  const firstOrder = snapshot.orders[0];
  const legacyOrderId = firstOrder.id;
  delete firstOrder.executionModel;
  delete firstOrder.executionAudit;
  const legacyPositionId = snapshot.positions[0].id;
  delete snapshot.positions[0].executionModel;
  const costBefore = snapshot.positions[0].totalCost;
  const feesBefore = snapshot.positions[0].fees;

  const restored = new CrossPairBot({ now: getNow });
  restored.restoreLedger(ledger);

  assert.equal(restored.cash, cashBefore);
  assert.equal(restored.positions.length, positionCountBefore);
  assert.equal(restored.positions[0].totalCost, costBefore);
  assert.equal(restored.positions[0].fees, feesBefore);
  assert.equal(restored.positions.find(item => item.id === legacyPositionId).executionModel, 'LEGACY_UNAUDITED');
  assert.equal(restored.orders.find(item => item.id === legacyOrderId).executionModel, 'LEGACY_UNAUDITED');
  assert.equal(restored.snapshot().executionAudit.legacyUnauditedOrderCount, 1);
});
