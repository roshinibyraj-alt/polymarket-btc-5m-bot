'use strict';

// Read-only live smoke test: discover non-crypto markets and load real CLOB books.
// It never submits or simulates an order.
const { GammaMarketScanner, MAX_HORIZON_MS } = require('../gamma-market-scanner');

async function main() {
  const scanner = new GammaMarketScanner({ maxPages: 100 });
  const now = Date.now();
  const result = await scanner.scanMarkets({ now, horizonMs: MAX_HORIZON_MS });
  if (!result.markets.length) throw new Error('No active non-crypto markets were discovered');

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
      tokenId: outcome.tokenId,
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
    completeCoverage: result.complete,
    exampleMarket: {
      title: market.title,
      eventTitle: market.eventTitle,
      secondsUntilEnd: Math.round((market.endAt - now) / 1000),
      outcomes: market.outcomes.map(({ label, tokenId }) => ({ label, tokenId })),
      books,
    },
    ordersSubmitted: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
