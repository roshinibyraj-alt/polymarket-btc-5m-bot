'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGY, candleColor, classifyCandleTransition } = require('../minute-candle-strategy');

const START = 1_800_000_000_000;
function candle(minute, color, windowStart = START) {
  const open = 100;
  const close = color === 'GREEN' ? 101 : color === 'RED' ? 99 : 100;
  const start = windowStart + (minute - 1) * 60_000;
  return { start, closeAt: start + 59_999, open, high: Math.max(open, close), low: Math.min(open, close), close };
}

test('fixed paper strategy is BTC 5m with 200 shares per eligible color-change trigger', () => {
  assert.deepEqual(STRATEGY.assets, ['BTC']);
  assert.deepEqual(STRATEGY.timeframes, ['5m']);
  assert.equal(STRATEGY.sharesPerTrigger, 200);
  assert.equal(STRATEGY.maximumEntriesPerWindow, 1);
  assert.equal(STRATEGY.maximumEntryAsk, 0.50);
  assert.equal(STRATEGY.oppositeSignalVetoBestBid, 0.65);
  assert.equal(STRATEGY.signalValidityMs, 60_000);
  assert.equal(STRATEGY.takeProfitMid, 0.99);
  assert.equal(STRATEGY.stopLossMid, 0.00);
  assert.equal(STRATEGY.firstSignalCandle, 2);
  assert.equal(STRATEGY.lastSignalCandle, 4);
  assert.equal(STRATEGY.execution, 'PAPER ONLY');
});

test('minute 2 same color means no signal; a different candle chooses the new candle side', () => {
  const same = classifyCandleTransition({
    candle: candle(2, 'GREEN'),
    previousCandle: candle(1, 'GREEN'),
    windowStart: START,
  });
  const changedUp = classifyCandleTransition({
    candle: candle(2, 'GREEN'),
    previousCandle: candle(1, 'RED'),
    windowStart: START,
  });
  const changedDown = classifyCandleTransition({
    candle: candle(2, 'RED'),
    previousCandle: candle(1, 'GREEN'),
    windowStart: START,
  });
  assert.equal(same.side, null);
  assert.equal(changedUp.side, 'UP');
  assert.equal(changedDown.side, 'DOWN');
});

test('minute 1 and minute 5 are excluded; minute 2 through 4 are eligible', () => {
  for (const minute of [1, 5]) {
    const result = classifyCandleTransition({
      candle: candle(minute, 'GREEN'),
      previousCandle: candle(minute - 1, 'RED'),
      windowStart: START,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.side, null);
  }
  for (const minute of [2, 3, 4]) {
    const result = classifyCandleTransition({
      candle: candle(minute, 'GREEN'),
      previousCandle: candle(minute - 1, 'RED'),
      windowStart: START,
    });
    assert.equal(result.eligible, true);
    assert.equal(result.side, 'UP');
  }
});

test('doji candles do not create a directional signal', () => {
  const result = classifyCandleTransition({
    candle: candle(3, 'DOJI'),
    previousCandle: candle(2, 'RED'),
    windowStart: START,
  });
  assert.equal(candleColor(candle(3, 'DOJI')), 'DOJI');
  assert.equal(result.side, null);
});

test('comparison requires the immediately preceding candle from the same window', () => {
  const missing = classifyCandleTransition({
    candle: candle(2, 'GREEN'),
    previousCandle: candle(1, 'RED', START - 300_000),
    windowStart: START,
  });
  assert.equal(missing.side, null);
  assert.match(missing.reason, /immediately previous/);
});
