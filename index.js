'use strict';

const LiveBot = require('./live-bot');
const startLiveServer = require('./live-server');
const marketData = require('./wick-market-data');
const PolymarketTrader = require('./polymarket-trader');
const { JsonStateStore } = require('./state-store');
const { feed: chainlinkFeed } = require('./chainlink-feed');

function startApplication({
  env = process.env,
  port = Number(env.PORT || 8080),
  trader = null,
  dataProvider = marketData,
} = {}) {
  const tradingEnabled = String(env.LIVE_TRADING || '').toLowerCase() === 'true';
  const flowTestEnabled = String(env.LIVE_ORDER_FLOW_TEST || '').toLowerCase() === 'true';
  const exchange = trader || (tradingEnabled && env.PRIVATE_KEY ? new PolymarketTrader(env.PRIVATE_KEY) : null);
  const stateStore = env.BOT_STATE_DIR ? new JsonStateStore(env.BOT_STATE_DIR) : null;
  const bot = new LiveBot({
    trader: exchange,
    marketData: dataProvider,
    priceFeed: chainlinkFeed,
    stateStore,
    requirePersistentState: tradingEnabled,
    tradingEnabled,
    flowTestEnabled,
  });
  const server = startLiveServer(bot, port);
  bot.start();

  const shutdown = () => {
    bot.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { bot, server };
}

if (require.main === module) startApplication();

module.exports = startApplication;
