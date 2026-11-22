'use strict';

const NearResolutionMarketBot = require('./near-resolution-bot');
const { GammaMarketScanner } = require('./gamma-market-scanner');
const startServer = require('./server');
const { PaperStateStore, paperStateFilePath } = require('./paper-state-store');

function startApplication({
  env = process.env,
  port = Number(env.PORT || 8080),
  bot: suppliedBot = null,
  marketScanner = null,
  feedFactory = null,
  paperStateStore = null,
} = {}) {
  if (String(env.LIVE_TRADING || '').toLowerCase() === 'true') {
    console.warn('[safety] LIVE_TRADING=true is ignored; this entrypoint is hardwired to paper mode.');
  }
  if (String(env.LIVE_ORDER_FLOW_TEST || '').toLowerCase() === 'true') {
    console.warn('[safety] LIVE_ORDER_FLOW_TEST is ignored; no real order modules are loaded.');
  }
  const scanner = marketScanner || new GammaMarketScanner();
  const bot = suppliedBot || new NearResolutionMarketBot({
    marketScanner: scanner,
    ...(feedFactory ? { feedFactory } : {}),
  });
  const railwayRuntime = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID);
  const store = paperStateStore || (!suppliedBot && railwayRuntime
    ? new PaperStateStore(paperStateFilePath(env))
    : null);
  const server = startServer(bot, port, null, { listen: !store });
  let shutdownRequested = false;
  let ready = Promise.resolve();
  const resetVersion = `${String(env.PAPER_HISTORY_RESET_VERSION || '').trim()}|${bot.persistenceStrategyVersion}`;

  if (store) {
    ready = (async () => {
      const restored = await store.load();
      let historySource;
      if (restored?.paperStrategyVersion !== bot.persistenceStrategyVersion
        || restored?.paperHistoryResetVersion !== resetVersion) {
        const freshState = bot.serializePersistentState();
        freshState.paperHistoryResetVersion = resetVersion;
        bot.restorePersistentState(freshState);
        historySource = restored ? 'strategy replacement reset' : 'fresh strategy ledger';
      } else if (restored) {
        bot.restorePersistentState(restored);
        historySource = 'persistent volume';
      } else {
        const freshState = bot.serializePersistentState();
        freshState.paperHistoryResetVersion = resetVersion;
        bot.restorePersistentState(freshState);
        historySource = 'fresh strategy ledger';
      }
      bot.attachPersistenceStore(store);
      await bot.persistState(true);
      if (shutdownRequested) return;
      const restoredState = bot.snapshot();
      const positionCount = Array.isArray(restoredState.positions)
        ? restoredState.positions.length
        : 'unknown';
      const settledCount = Number.isFinite(Number(restoredState.account?.settledTrades))
        ? restoredState.account.settledTrades
        : 'unknown';
      console.log(
        `[paper-state] restored from ${historySource}: ${positionCount} positions, `
        + `${settledCount} settled, cash $${Number(restoredState.account?.cash).toFixed(2)}`,
      );
      server.listen(port, () => {
        console.log(`[dashboard] listening on :${port} after paper ledger initialization`);
      });
      bot.start();
    })().catch((error) => {
      bot.status = 'history_restore_failed';
      bot.error = `Paper history could not be restored: ${error.message || String(error)}`;
      console.error(`[paper-state] ${bot.error}`);
      process.exitCode = 1;
    });
  } else {
    if (typeof bot.serializePersistentState === 'function'
      && typeof bot.restorePersistentState === 'function') {
      const freshState = bot.serializePersistentState();
      freshState.paperHistoryResetVersion = resetVersion;
      bot.restorePersistentState(freshState);
    }
    bot.start();
  }

  const shutdown = async () => {
    shutdownRequested = true;
    try {
      if (typeof bot.stopAndFlush === 'function') await bot.stopAndFlush();
      else bot.stop();
    } catch (error) {
      console.error(`[paper-state] final save failed: ${error.message || String(error)}`);
    }
    if (server.listening) {
      server.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { bot, server, ready };
}

if (require.main === module) startApplication();

module.exports = startApplication;
