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
  assert.match(html, /Minute 1 is the reference/);
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

test('dashboard keeps the fixed-size candle color and single-entry explanation', () => {
  assert.match(html, /200 shares on the current candle’s side/);
  assert.match(html, /At most one buy may fill per five-minute window/);
  assert.match(html, /Minute 5 has no new signal/);
  assert.match(html, /PAPER ONLY/);
});

test('dashboard clearly explains the entry gate and opposite-signal veto', () => {
  assert.match(html, /best ask must be below \$0\.50/);
  assert.match(html, /best bid is above \$0\.65/);
  assert.match(html, /ignore later signals/);
  assert.match(html, /keep that signal active until the next one-minute candle closes/);
  assert.match(html, /\$0\.99 \(credit \$1\/share\)/);
  assert.match(html, /\$0\.00 \(credit \$0\/share\)/);
  assert.match(html, /id="upMid"/);
  assert.match(html, /id="downMid"/);
});
