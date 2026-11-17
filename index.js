'use strict';

const PressureForecastBot = require('./pressure-forecast-bot');
const startServer = require('./server');
const marketData = require('./wick-market-data');
const BinanceTickFeed = require('./binance-tick-feed');
const { PaperStateStore, paperStateFilePath } = require('./paper-state-store');

const PAPER_HISTORY_IMPORT_URL = 'https://polymarket-btc-5m-bot-production.up.railway.app/api/state';

async function fetchPaperHistory(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Existing paper history returned HTTP ${response.status}`);
  return response.json();
}

function startApplication({
  env = process.env,
  port = Number(env.PORT || 8080),
  bot: suppliedBot = null,
  dataProvider = marketData,
  priceFeed = null,
  paperStateStore = null,
  historyImporter = fetchPaperHistory,
  historyImportUrl = env.PAPER_HISTORY_IMPORT_URL || PAPER_HISTORY_IMPORT_URL,
} = {}) {
  if (String(env.LIVE_TRADING || '').toLowerCase() === 'true') {
    console.warn('[safety] LIVE_TRADING=true is ignored; this entrypoint is hardwired to paper mode.');
  }
  const feed = priceFeed || new BinanceTickFeed();
  const bot = suppliedBot || new PressureForecastBot({
    marketData: dataProvider,
    priceFeed: feed,
  });
  const railwayRuntime = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID);
  const store = paperStateStore || (!suppliedBot && railwayRuntime
    ? new PaperStateStore(paperStateFilePath(env))
    : null);
  const server = startServer(bot, port, null, { listen: !store });
  let shutdownRequested = false;
  let ready = Promise.resolve();

  if (store) {
    ready = (async () => {
      const restored = await store.load();
      if (restored) {
        bot.restorePersistentState(restored);
      } else {
        const snapshot = await historyImporter(historyImportUrl);
        bot.restoreFromSnapshot(snapshot);
      }
      bot.attachPersistenceStore(store);
      await bot.persistState(true);
      if (shutdownRequested) return;
      server.listen(port, () => {
        console.log(`[dashboard] listening on :${port} after paper history restore`);
      });
      bot.start();
    })().catch((error) => {
      bot.status = 'history_restore_failed';
      bot.error = `Paper history could not be restored: ${error.message || String(error)}`;
      console.error(`[paper-state] ${bot.error}`);
      process.exitCode = 1;
    });
  } else {
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
