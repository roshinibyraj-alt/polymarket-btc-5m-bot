'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../public/pressure-dashboard.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];

function renderDashboard(state) {
  const elements = new Map();
  const makeElement = () => ({
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    dataset: {},
    attributes: {},
    style: {},
    querySelector: () => ({ textContent: '' }),
    querySelectorAll: () => [],
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const context = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
    },
    fetch: async () => ({ ok: true, json: async () => state }),
    setInterval: () => 0,
    Date,
    Number,
    Math,
    String,
    Intl,
    Array,
    Object,
    JSON,
    Error,
  };
  vm.runInNewContext(script, context);
  return new Promise((resolve) => setImmediate(() => resolve(elements)));
}

function sampleState(eventMessage = 'Model review completed.') {
  const at = 1_800_000_001_000;
  const questions = {};
  for (const [key, prompt] of [
    ['buyUP', 'Why should I buy UP?'],
    ['avoidUP', 'Why should I not buy UP?'],
    ['holdUP', 'Why should I hold UP?'],
    ['sellUP', 'Why should I sell UP now?'],
    ['buyDOWN', 'Why should I buy DOWN?'],
    ['avoidDOWN', 'Why should I not buy DOWN?'],
    ['holdDOWN', 'Why should I hold DOWN?'],
    ['sellDOWN', 'Why should I sell DOWN now?'],
  ]) {
    questions[key] = { prompt, answer: key === 'buyUP' ? 'YES' : 'NO', reason: 'Sample rationale.' };
  }
  return {
    now: at,
    status: 'RUNNING',
    statusReason: 'Model active.',
    strategy: { name: 'BTC 5-minute explainable decision model' },
    websocket: { status: 'CONNECTED' },
    account: {
      initialCapital: 3000,
      cash: 2930,
      availableCash: 2930,
      equity: 3002,
      realizedPnl: 0,
      unrealizedPnl: 2,
      openPositions: 1,
      pendingResolution: 0,
    },
    markets: [{
      asset: 'BTC',
      timeframe: '5m',
      title: 'Bitcoin Up or Down',
      slug: 'btc-updown-5m-1',
      start: at - 1000,
      end: at + 239_000,
      marketStatus: 'OPEN',
      sideStates: {
        UP: { bestBid: 0.55, bestAsk: 0.56 },
        DOWN: { bestBid: 0.43, bestAsk: 0.45 },
      },
    }],
    orders: [{
      placedAt: at,
      action: 'BUY_TAKER',
      side: 'UP',
      requestedShares: 50,
      filledShares: 50,
      fillPrice: 0.56,
      fees: 0.86,
      status: 'FILLED',
    }],
    events: [{ time: at, type: 'MODEL_REVIEW', message: eventMessage, outcome: 'neutral' }],
    modelEngine: {
      status: 'CONNECTED',
      historyStatus: 'READY',
      price: 68_123,
      tickAgeMs: 120,
      currentCandle: { open: 68_000 },
      closedCandles: [{ open: 67_900, close: 68_000 }],
      tradeFlow: { buyCount: 25, sellCount: 15, imbalance: 0.25 },
      reviewIntervalMs: 15_000,
      nextReviewAt: at + 10_000,
      latestReview: {
        at,
        secondsRemaining: 239,
        probabilityUp: 0.68,
        probabilityDown: 0.32,
        data: { ready: true, reasons: [] },
        actions: [{ type: 'BUY', side: 'UP', shares: 50 }],
        sides: {
          UP: { netEdgePerShare: 0.1, fullSizeVisible: true },
          DOWN: { netEdgePerShare: -0.1, fullSizeVisible: true },
        },
        estimate: { components: [{ key: 'tradePressure', score: 0.6 }] },
        questions,
      },
      recentReviews: [],
      tradeHistory: [
        {
          id: 'winning-trade',
          side: 'UP',
          status: 'RESOLVED_WIN',
          result: 'WIN',
          shares: 50,
          entryPrice: 0.56,
          exitPrice: 1,
          realizedPnl: 21.14,
          entryFees: 0.86,
          exitFees: 0,
          entryAt: at - 300_000,
          exitAt: at,
          exitReason: 'OFFICIAL_RESOLUTION',
        },
        {
          id: 'losing-trade',
          side: 'DOWN',
          status: 'RESOLVED_LOSS',
          result: 'LOSS',
          shares: 50,
          entryPrice: 0.65,
          exitPrice: 0,
          realizedPnl: -33.25,
          entryFees: 0.75,
          exitFees: 0,
          entryAt: at - 600_000,
          exitAt: at - 300_000,
          exitReason: 'OFFICIAL_RESOLUTION',
        },
      ],
      sides: {
        UP: {
          shares: 50,
          allInAverageCost: 0.58,
          totalCost: 28,
          entryFees: 0.86,
          unrealizedPnl: 1,
          openPositionCount: 1,
        },
        DOWN: { shares: 0, allInAverageCost: null, totalCost: 0, entryFees: 0, unrealizedPnl: 0, openPositionCount: 0 },
      },
    },
  };
}

test('dashboard shows the BTC model, eight answers, independent positions, and paper orders', async () => {
  assert.ok(script, 'dashboard inline script is present');
  const elements = await renderDashboard(sampleState());
  assert.equal(elements.get('marketTitle').textContent, 'Bitcoin Up or Down');
  assert.equal(elements.get('upProbability').textContent, '68.0%');
  assert.equal(elements.get('downProbability').textContent, '32.0%');
  assert.match(elements.get('questionGrid').innerHTML, /Why should I buy UP/);
  assert.match(elements.get('questionGrid').innerHTML, /Why should I sell DOWN now/);
  assert.match(elements.get('tradeHistory').innerHTML, /Entry price/);
  assert.match(elements.get('tradeHistory').innerHTML, /Exit price/);
  assert.match(elements.get('tradeHistory').innerHTML, /\$1\.0000/);
  assert.match(elements.get('tradeHistory').innerHTML, /trade-card win/);
  assert.match(elements.get('tradeHistory').innerHTML, /trade-card loss/);
  assert.match(elements.get('tradeHistory').innerHTML, /-\$33\.25/);
  assert.match(elements.get('upShares').textContent, /50 shares/);
  assert.match(elements.get('orderRows').innerHTML, /Buy Taker/);
  assert.match(html, /@media \(max-width: 680px\)/);
  assert.match(html, /eight explicit answers per review/);
  assert.match(html, /PAPER ONLY/);
  assert.doesNotMatch(html, /cross-pair|dip-and-bounce|1\.22/);
});

test('dashboard escapes event text before rendering it', async () => {
  const elements = await renderDashboard(sampleState('<script>alert(1)</script>'));
  assert.doesNotMatch(elements.get('eventRows').innerHTML, /<script>/);
  assert.match(elements.get('eventRows').innerHTML, /&lt;script&gt;/);
});
