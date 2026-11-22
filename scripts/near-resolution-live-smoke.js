'use strict';

// Read-only live smoke test: discover non-sports, non-crypto markets and load CLOB books.
// It never submits or simulates an order.
const { GammaMarketScanner, MAX_HORIZON_MS } = require('../gamma-market-scanner');

async function main() {
  const scanner = new GammaMarketScanner({ maxPages: 100 });
  const now = Date.now();
  const result = await scanner.scanMarkets({ now, horizonMs: MAX_HORIZON_MS });
  if (!result.complete) throw new Error('Gamma market scan did not complete');
  if (!result.markets.length) {
    console.log(JSON.stringify({
      status: 'scan-ok-no-eligible-markets',
      rowsScanned: result.rowsSeen,
      pages: result.pageCount,
      cryptoMarketsExcluded: result.cryptoExcluded,
      sportsMarketsExcluded: result.sportsExcluded,
      activeEligibleMarkets: 0,
      clobBookLoaded: false,
      note: 'No non-sports, non-crypto markets are currently ending within two hours; the bot will keep scanning without placing entries.',
    }, null, 2));
    return;
  }

  const market = result.markets.find((candidate) => candidate.outcomes.length >= 2);
  if (!market) throw new Error('No market with mapped outcome IDs was discovered');
  const books = [];
  for (const outcome of market.outcomes.slice(0, 3)) {
    const book = await scanner.getBook(outcome.tokenId);
    if (!Array.isArray(book.bids) || !Array.isArray(book.asks)) {
      throw new Error(`CLOB did not return a valid book for ${outcome.label}`);
    }
    books.push({
      outcome: outcome.label,
      bestBid: book.bids[0] ? Number(book.bids[0].price) : null,
      bestAsk: book.asks[0] ? Number(book.asks[0].price) : null,
    });
  }

  console.log(JSON.stringify({
    smokeTest: 'PASS',
    live: true,
    marketsFound: result.markets.length,
    pagesRead: result.pageCount,
    rowsScanned: result.rowsSeen,
    cryptoMarketsExcluded: result.cryptoExcluded,
    sportsMarketsExcluded: result.sportsExcluded,
    completeCoverage: result.complete,
    exampleMarket: {
      title: market.title,
      eventTitle: market.eventTitle,
      secondsUntilEnd: Math.round((market.endAt - now) / 1000),
      outcomes: market.outcomes.map(({ label }) => label),
      books,
    },
    ordersSubmitted: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
