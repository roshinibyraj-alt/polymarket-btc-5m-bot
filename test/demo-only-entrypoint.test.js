'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startApplication = require('../index');

test('entrypoint remains paper-only even when LIVE_TRADING is true', async (t) => {
  let started = 0;
  let stopped = 0;
  const bot = {
    start() { started += 1; },
    stop() { stopped += 1; },
    snapshot() { return { mode: 'DEMO ONLY', status: 'scanning', now: Date.now() }; },
  };
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  const app = startApplication({
    env: { LIVE_TRADING: 'true' },
    port: 0,
    bot,
  });
  await new Promise((resolve) => app.server.once('listening', resolve));
  t.after(async () => {
    bot.stop();
    await new Promise((resolve) => app.server.close(resolve));
    console.warn = previousWarn;
  });

  assert.equal(started, 1);
  assert.equal(require.cache[require.resolve('../live-bot')], undefined);
  assert.equal(require.cache[require.resolve('../polymarket-trader')], undefined);
  assert.match(warnings.join(' '), /ignored.*paper mode/i);
  const health = await fetch(`http://127.0.0.1:${app.server.address().port}/api/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, 'DEMO');
  assert.equal(stopped, 0);
});
