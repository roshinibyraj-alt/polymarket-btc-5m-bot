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
    classList: { add() {}, remove() {} },
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
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

test('dashboard shows four independent pairs, open legs, and the no-inverse-sell rule', async () => {
  assert.ok(script, 'dashboard inline script is present');
  const cycle = {
    id: 'btc-up-eth-down-1',
    status: 'OPEN',
    entryAt: 1_800_000_001_000,
    windowStart: 1_800_000_000_000,
    entryAskSum: 0.75,
    sharesPerLeg: 10,
    legs: ['BTC', 'ETH'].map((asset, index) => ({
      asset,
      side: index === 0 ? 'UP' : 'DOWN',
      filledShares: 10,
      requestedShares: 10,
      position: {
        status: 'OPEN',
        shares: 10,
        initialShares: 10,
        requestedShares: 10,
        entryPrice: 0.35,
        initialCost: 3.5,
        markBid: 0.36,
        unrealizedPnl: 1,
        partialRealizedPnl: 0,
      },
      order: { status: 'FILLED', filledShares: 10, requestedShares: 10, averagePrice: 0.35 },
    })),
  };
  const pairs = ['BTC UP + ETH DOWN', 'ETH UP + BTC DOWN', 'BTC UP + ETH UP', 'BTC DOWN + ETH DOWN'].map((label, index) => ({
    id: `pair-${index}`,
    label,
    inversePairLabel: 'opposite pair',
    secondsRemaining: 150,
    combinedAsk: 0.75,
    entryThreshold: 0.8,
    status: index === 0 ? 'ENTERED' : 'ARMED',
    nextSharesPerLeg: 10,
    entered: index === 0,
    windowStart: cycle.windowStart,
    currentCycle: index === 0 ? cycle : null,
    trades: index === 0 ? [cycle] : [],
  }));
  const elements = await renderDashboard({
    now: cycle.entryAt,
    status: 'RUNNING',
    statusReason: 'Monitoring BTC and ETH 5-minute markets',
    strategy: { name: 'BTC/ETH four-pair fixed-size paper strategy', version: 'no-inverse-exit' },
    ledgerPersistence: { enabled: true, restored: true },
    websocket: { status: 'CONNECTED', lastMessageAt: cycle.entryAt },
    account: {
      initialCapital: 3000,
      cash: 2930,
      equity: 3002,
      realizedPnl: 0,
      unrealizedPnl: 2,
      openPositions: 2,
      wins: 0,
      losses: 0,
      equityCurve: [],
    },
    markets: [],
    crossPairs: pairs,
    positions: [],
    orders: [],
    events: [],
  });

  assert.match(elements.get('sizingGrid').innerHTML, /BTC UP \+ ETH DOWN/);
  assert.match(elements.get('sizingGrid').innerHTML, /10 \/ leg/);
  assert.match(elements.get('sizingGrid').innerHTML, /Floating P&L/);
  assert.match(elements.get('sizingGrid').innerHTML, /Position exits/);
  assert.match(elements.get('sizingGrid').innerHTML, /Awaiting|Open/);
  assert.doesNotMatch(elements.get('sizingGrid').innerHTML, /1\.22|SELLING_REMAINDER|REVERSAL_EXITING/);
  assert.match(html, /Ask-sum entries \+ independent exits/);
  assert.match(html, /Pairs do not force-sell one another/);
  assert.match(html, /official resolution/);
  assert.match(html, /SIMULATION ONLY/);
  assert.match(html, /@media \(max-width:420px\)/);
});

test('dashboard escapes market and event text before rendering it', async () => {
  const elements = await renderDashboard({
    status: 'RUNNING',
    now: Date.now(),
    account: {},
    markets: [{ asset: 'BTC', timeframe: '5m', title: '<img src=x>', marketStatus: 'OPEN', sideStates: {} }],
    positions: [],
    orders: [],
    events: [{ time: Date.now(), message: '<script>alert(1)</script>', outcome: 'neutral' }],
    strategy: {},
    websocket: {},
  });
  assert.doesNotMatch(elements.get('marketGrid').innerHTML, /<script>|<img/);
  assert.doesNotMatch(elements.get('eventList').innerHTML, /<script>/);
  assert.match(elements.get('marketGrid').innerHTML, /&lt;img/);
});
