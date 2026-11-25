'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/minute-dashboard.html'), 'utf8');

test('simple mobile dashboard shows large CLOB UP/DOWN prices and live 1-minute candles', () => {
  assert.match(html, /aria-label="Current Polymarket prices"/);
  assert.match(html, /id="upAsk"/);
  assert.match(html, /id="downAsk"/);
  assert.match(html, /font-size: clamp\(30px/);
  assert.match(html, /aria-label="Five one-minute candles"/);
  assert.match(html, /id="candleStrip"/);
  assert.match(html, /Minute 1 is reference-only/);
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

test('dashboard explains same-color entries and opposite-color exits', () => {
  assert.match(html, /Two green candles in a row buy 200 UP shares/);
  assert.match(html, /a color change sells the held side/);
  assert.match(html, /Minute 5 is skipped/);
  assert.match(html, /PAPER ONLY/);
});

test('dashboard explains uncapped entry prices and midpoint exits', () => {
  assert.match(html, /There is no \$0\.50 price cap/);
  assert.match(html, /Do not buy the new side on that same candle/);
  assert.match(html, /Midpoint take-profit at \$0\.99 credits \$1\/share/);
  assert.match(html, /midpoint stop at \$0\.00 credits \$0\/share/);
  assert.match(html, /id="upMid"/);
  assert.match(html, /id="downMid"/);
});
