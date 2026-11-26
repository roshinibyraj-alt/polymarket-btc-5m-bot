'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PerpsPublicApi } = require('./perps-public-api');
const { PerpsPaperStore } = require('./perps-paper-store');
const { PerpsCopyBot } = require('./perps-copy-bot');
const startServer = require('./server');

async function startApplication({
  env = process.env,
  port = Number(env.PORT || 8080),
  api = null,
  store = null,
  bot = null,
  listen = true,
} = {}) {
  if (String(env.LIVE_TRADING || '').toLowerCase() === 'true') {
    throw new Error('Safety stop: this copy bot is paper-only; LIVE_TRADING must not be enabled.');
  }

  const resolvedStore = store || new PerpsPaperStore(
    env.PERPS_COPY_LEDGER_PATH
      || (env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID
        ? '/data/perps-copy-paper-state.json'
        : path.join(__dirname, '.data', 'perps-copy-paper-state.json')),
  );
  const railwayRuntime = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID);
  if (railwayRuntime && !fs.existsSync(path.dirname(resolvedStore.filePath))) {
    throw new Error(`Perps paper-history storage is unavailable at ${path.dirname(resolvedStore.filePath)}.`);
  }

  const resolvedBot = bot || new PerpsCopyBot({
    api: api || new PerpsPublicApi(),
    store: resolvedStore,
  });
  await resolvedBot.initialize();
  resolvedBot.start();
  const server = startServer(resolvedBot, port, { listen });

  console.log('MODE: PAPER ONLY — Polymarket Perps public fills; no wallet signing or order placement.');
  console.log(`[paper-state] using separate ledger ${resolvedStore.filePath}`);

  const shutdown = async () => {
    try {
      await resolvedBot.stopAndFlush();
    } catch (error) {
      console.error(`[paper-state] final save failed: ${error.message || String(error)}`);
    }
    if (server.listening) server.close(() => process.exit(0));
    else process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { bot: resolvedBot, server };
}

if (require.main === module) {
  startApplication().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
  });
}

module.exports = { startApplication };
