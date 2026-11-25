'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/minute-dashboard.html'), 'utf8');

test('simple mobile dashboard shows prices and the cross-window candle reference', () => {
  assert.match(html, /aria-label="Current Polymarket prices"/);
  assert.match(html, /id="upAsk"/);
  assert.match(html, /id="downAsk"/);
  assert.match(html, /font-size: clamp\(30px/);
  assert.match(html, /aria-label="Five one-minute candles"/);
  assert.match(html, /id="previousWindowReference"/);
  assert.match(html, /id="candleStrip"/);
  assert.match(html, /Minute 1 compares with the prior window’s last candle/);
});

test('strategy details are at the bottom after the monitoring sections', () => {
  const activityIndex = html.indexOf('aria-label="Recent activity"');
  const strategyIndex = html.indexOf('aria-label="Strategy details"');
  const footerIndex = html.indexOf('<footer class="footer">');
  assert.ok(activityIndex > 0);
  assert.ok(strategyIndex > activityIndex);
  assert.ok(footerIndex > strategyIndex);
  assert.match(html, /details>/);
});

test('dashboard explains reversed same-color entries and no signal exits', () => {
  assert.match(html, /Two green candles in a row buy 200 DOWN shares; two red candles in a row buy 200 UP shares/);
  assert.match(html, /color changes never sell/i);
  assert.match(html, /Minute 5 is skipped/);
  assert.match(html, /PAPER ONLY/);
});

test('dashboard explains uncapped entries, take-profit, and no stop-loss', () => {
  assert.match(html, /There is no \$0\.50 price cap/);
  assert.match(html, /do not create an entry on the change candle/i);
  assert.match(html, /At a \$0\.99 midpoint, take profit/);
  assert.match(html, /There is no stop-loss/);
  assert.match(html, /id="upMid"/);
  assert.match(html, /id="downMid"/);
});
