'use strict';

const PressureForecastBot = require('./pressure-forecast-bot');
const startServer = require('./server');
const marketData = require('./wick-market-data');
const BinanceTickFeed = require('./binance-tick-feed');

function startApplication({
  env = process.env,
  port = Number(env.PORT || 8080),
  bot: suppliedBot = null,
  dataProvider = marketData,
  priceFeed = null,
} = {}) {
  if (String(env.LIVE_TRADING || '').toLowerCase() === 'true') {
    console.warn('[safety] LIVE_TRADING=true is ignored; this entrypoint is hardwired to paper mode.');
  }
  const feed = priceFeed || new BinanceTickFeed();
  const bot = suppliedBot || new PressureForecastBot({
    marketData: dataProvider,
    priceFeed: feed,
  });
  const server = startServer(bot, port);
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
