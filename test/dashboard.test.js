'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/edge-dashboard.html'), 'utf8');

test('active dashboard labels the experiment, large prices, costs and evidence honestly', () => {
  assert.match(html, /BTC Edge Lab/);
  assert.match(html, /profitability is unproven/i);
  assert.match(html, /No edge is guaranteed/i);
  assert.match(html, /UPask/);
  assert.match(html, /DOWNask/);
  assert.match(html, /Unrealized/);
  assert.match(html, /Brier score/);
  assert.match(html, /realizedPnl/);
  assert.match(html, /exitPrice/);
});

test('dashboard uses escaped strings, overlap-free polling and correct percentage units', () => {
  assert.match(html, /if\(inflight\)return/);
  assert.match(html, /fetch\('api\/state/);
  assert.match(html, /const esc=/);
  assert.match(html, /Number\(a\.winRate\)\.toFixed\(1\)/);
  assert.match(html, /recentDecisions\|\|\[\]\)\.slice\(0,12\)/);
  assert.match(html, /BTC ticks stale/);
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(js));
});
