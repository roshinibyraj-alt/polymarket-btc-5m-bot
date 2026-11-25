'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGY, candleColor, classifyMinuteEntry } = require('../minute-candle-strategy');

const START = 1_800_000_000_000;
const INTERVAL = STRATEGY.candleIntervalMs;

function candleAt(start, color) {
  const open = 100;
  const close = color === 'GREEN' ? 101 : color === 'RED' ? 99 : 100;
  return {
    start,
    closeAt: start + INTERVAL - 1,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    closed: true,
    source: 'BINANCE_1M_WEBSOCKET',
  };
}

test('strategy schedules one paper entry for only the first three one-minute intervals', () => {
  assert.deepEqual(STRATEGY.assets, ['BTC']);
  assert.deepEqual(STRATEGY.timeframes, ['5m']);
  assert.equal(STRATEGY.sharesPerTrigger, 200);
  assert.equal(STRATEGY.maximumEntriesPerWindow, 3);
  assert.equal(STRATEGY.firstSignalCandle, 1);
  assert.equal(STRATEGY.lastSignalCandle, 3);
  assert.equal(STRATEGY.maximumEntryAsk, null);
  assert.equal(STRATEGY.takeProfitMid, 0.99);
  assert.equal(STRATEGY.stopLossMid, null);
  assert.equal(STRATEGY.execution, 'PAPER ONLY');
});

test('a previous RED candle buys UP and a previous GREEN candle buys DOWN', () => {
  const red = classifyMinuteEntry({
    previousCandle: candleAt(START - INTERVAL, 'RED'),
    targetCandleStart: START,
    windowStart: START,
  });
  const green = classifyMinuteEntry({
    previousCandle: candleAt(START, 'GREEN'),
    targetCandleStart: START + INTERVAL,
    windowStart: START,
  });
  assert.equal(red.side, 'UP');
  assert.equal(red.referenceColor, 'RED');
  assert.equal(green.side, 'DOWN');
  assert.equal(green.referenceColor, 'GREEN');
});

test('minutes 1 through 3 use the prior closed candle; minutes 4 and 5 are excluded', () => {
  for (let minute = 1; minute <= 3; minute += 1) {
    const targetCandleStart = START + (minute - 1) * INTERVAL;
    const previousCandle = candleAt(targetCandleStart - INTERVAL, minute % 2 ? 'RED' : 'GREEN');
    const result = classifyMinuteEntry({ previousCandle, targetCandleStart, windowStart: START });
    assert.equal(result.eligible, true);
    assert.equal(result.candleNumber, minute);
    assert.equal(result.side, minute % 2 ? 'UP' : 'DOWN');
  }
  for (const minute of [4, 5]) {
    const targetCandleStart = START + (minute - 1) * INTERVAL;
    const previousCandle = candleAt(targetCandleStart - INTERVAL, 'RED');
    const result = classifyMinuteEntry({ previousCandle, targetCandleStart, windowStart: START });
    assert.equal(result.eligible, false);
    assert.equal(result.candleNumber, minute);
    assert.equal(result.side, null);
    assert.match(result.reason, /outside the entry schedule/);
  }
});

test('minute 1 accepts the previous window final candle as its reference', () => {
  const result = classifyMinuteEntry({
    previousCandle: candleAt(START - INTERVAL, 'GREEN'),
    targetCandleStart: START,
    windowStart: START,
  });
  assert.equal(result.candleNumber, 1);
  assert.equal(result.side, 'DOWN');
});

test('a doji or missing immediately previous candle has no directional side', () => {
  const doji = classifyMinuteEntry({
    previousCandle: candleAt(START - INTERVAL, 'DOJI'),
    targetCandleStart: START,
    windowStart: START,
  });
  const missing = classifyMinuteEntry({
    previousCandle: candleAt(START - 2 * INTERVAL, 'RED'),
    targetCandleStart: START,
    windowStart: START,
  });
  assert.equal(candleColor(candleAt(START, 'DOJI')), 'DOJI');
  assert.equal(doji.side, null);
  assert.match(doji.reason, /previous candle was DOJI/);
  assert.equal(missing.side, null);
  assert.match(missing.reason, /previous closed one-minute candle is not available/);
});
