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

test('fixed paper strategy is BTC 5m with one 200-share entry per eligible candle', () => {
  assert.deepEqual(STRATEGY.assets, ['BTC']);
  assert.deepEqual(STRATEGY.timeframes, ['5m']);
  assert.equal(STRATEGY.sharesPerTrigger, 200);
  assert.equal(STRATEGY.maximumEntriesPerWindow, 4);
  assert.equal(STRATEGY.maximumEntryAsk, null);
  assert.equal(STRATEGY.oppositeSignalVetoBestBid, null);
  assert.equal(STRATEGY.signalValidityMs, 60_000);
  assert.equal(STRATEGY.takeProfitMid, 0.99);
  assert.equal(STRATEGY.stopLossMid, null);
  assert.equal(STRATEGY.firstSignalCandle, 1);
  assert.equal(STRATEGY.lastSignalCandle, 4);
  assert.equal(STRATEGY.execution, 'PAPER ONLY');
});

test('consecutive colors enter their direction; a changed color exits the previous direction', () => {
  const sameGreen = classifyCandleTransition({
    candle: candle(2, 'GREEN'),
    previousCandle: candle(1, 'GREEN'),
    windowStart: START,
  });
  const sameRed = classifyCandleTransition({
    candle: candle(2, 'RED'),
    previousCandle: candle(1, 'RED'),
    windowStart: START,
  });
  const toRed = classifyCandleTransition({
    candle: candle(2, 'RED'),
    previousCandle: candle(1, 'GREEN'),
    windowStart: START,
  });
  const toGreen = classifyCandleTransition({
    candle: candle(2, 'GREEN'),
    previousCandle: candle(1, 'RED'),
    windowStart: START,
  });
  assert.equal(sameGreen.side, 'UP');
  assert.equal(sameRed.side, 'DOWN');
  assert.equal(toRed.side, null);
  assert.equal(toRed.colorChanged, true);
  assert.equal(toRed.exitSide, 'UP');
  assert.equal(toGreen.side, null);
  assert.equal(toGreen.colorChanged, true);
  assert.equal(toGreen.exitSide, 'DOWN');
});

test('minute 1 compares with the previous window and minutes 2–4 remain eligible', () => {
  const firstMinute = classifyCandleTransition({
    candle: candle(1, 'GREEN'),
    previousCandle: candle(5, 'GREEN', START - 300_000),
    windowStart: START,
  });
  assert.equal(firstMinute.eligible, true);
  assert.equal(firstMinute.side, 'UP');

  const minuteFive = classifyCandleTransition({
    candle: candle(5, 'GREEN'),
    previousCandle: candle(4, 'GREEN'),
    windowStart: START,
  });
  assert.equal(minuteFive.eligible, false);
  assert.equal(minuteFive.side, null);

  for (const minute of [2, 3, 4]) {
    const result = classifyCandleTransition({
      candle: candle(minute, 'GREEN'),
      previousCandle: candle(minute - 1, 'GREEN'),
      windowStart: START,
    });
    assert.equal(result.eligible, true);
    assert.equal(result.side, 'UP');
  }
});

test('doji candles do not create entry or exit signals', () => {
  const result = classifyCandleTransition({
    candle: candle(3, 'DOJI'),
    previousCandle: candle(2, 'RED'),
    windowStart: START,
  });
  assert.equal(candleColor(candle(3, 'DOJI')), 'DOJI');
  assert.equal(result.side, null);
  assert.equal(result.colorChanged, false);
});

test('comparison requires the immediately preceding candle, including across the window boundary', () => {
  const missing = classifyCandleTransition({
    candle: candle(1, 'GREEN'),
    previousCandle: candle(4, 'RED', START - 300_000),
    windowStart: START,
  });
  assert.equal(missing.side, null);
  assert.equal(missing.colorChanged, false);
  assert.match(missing.reason, /immediately previous/);

  const boundaryChange = classifyCandleTransition({
    candle: candle(1, 'RED'),
    previousCandle: candle(5, 'GREEN', START - 300_000),
    windowStart: START,
  });
  assert.equal(boundaryChange.eligible, true);
  assert.equal(boundaryChange.colorChanged, true);
  assert.equal(boundaryChange.exitSide, 'UP');
});
