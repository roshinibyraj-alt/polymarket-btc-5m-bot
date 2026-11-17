'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeCombinedResults,
  maximumConcurrentWindowExposure,
} = require('../portfolio-analytics');

test('combined results count UP and DOWN positions by realized outcome', () => {
  const summary = summarizeCombinedResults([
    { side: 'UP', status: 'SETTLED_EXIT', realizedPnl: 12 },
    { side: 'DOWN', status: 'SETTLED_LOSS', realizedPnl: -8 },
    { side: 'UP', status: 'SETTLED_WIN', realizedPnl: 0 },
    { side: 'DOWN', status: 'OPEN', realizedPnl: null },
    { side: 'UP', status: 'PENDING_CLOB_RESULT', realizedPnl: null },
  ]);

  assert.equal(summary.settled, 3);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.breakEven, 1);
  assert.ok(Math.abs(summary.winRate - (100 / 3)) < 1e-12);
});

test('maximum exposure uses overlapping cost within each original window', () => {
  const maximum = maximumConcurrentWindowExposure([
    {
      windowStart: 1,
      slug: 'window-one',
      status: 'SETTLED_EXIT',
      totalCost: 40,
      openedAt: 100,
      settledAt: 300,
    },
    {
      windowStart: 1,
      slug: 'window-one',
      status: 'SETTLED_LOSS',
      totalCost: 25,
      openedAt: 200,
      settledAt: 250,
    },
    {
      windowStart: 2,
      slug: 'window-two',
      status: 'OPEN',
      totalCost: 50,
      openedAt: 100,
    },
  ], 500);

  assert.deepEqual(maximum, {
    windowStart: 1,
    slug: 'window-one',
    title: null,
    amount: 65,
    at: 200,
  });
});

test('pending resolution exposure remains committed and unfilled orders are excluded', () => {
  const maximum = maximumConcurrentWindowExposure([
    {
      windowStart: 1,
      status: 'PENDING_CLOB_RESULT',
      totalCost: 30,
      openedAt: 100,
    },
    {
      windowStart: 1,
      status: 'CANCELLED_UNFILLED',
      totalCost: 100,
      openedAt: 150,
    },
    {
      windowStart: 1,
      status: 'OPEN',
      totalCost: 20,
      openedAt: 200,
    },
  ], 500);

  assert.equal(maximum.amount, 50);
  assert.equal(maximum.at, 200);
});
