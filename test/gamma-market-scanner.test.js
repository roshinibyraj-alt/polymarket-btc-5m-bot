'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GammaMarketScanner,
  isCryptoMarket,
  isSportsMarket,
  normalizeMarket,
  normalizeOutcomes,
} = require('../gamma-market-scanner');

function rawMarket(overrides = {}) {
  return {
    id: 'market-1',
    slug: 'team-a-vs-team-b',
    question: 'Will Team A win?',
    active: true,
    closed: false,
    enableOrderBook: true,
    acceptingOrders: true,
    endDate: new Date(2_000_000).toISOString(),
    version: 'v1',
    outcomes: '["Yes", "No"]',
    clobTokenIds: '["token-yes", "token-no"]',
    outcomePrices: '["0.80", "0.20"]',
    ...overrides,
  };
}

test('non-crypto market outcomes map to their actual labels and CLOB IDs', () => {
  const market = normalizeMarket(rawMarket(), { now: 1_000_000 });
  assert.equal(market.title, 'Will Team A win?');
  assert.deepEqual(market.outcomes, [
    { index: 0, label: 'Yes', tokenId: 'token-yes', lastPrice: 0.8 },
    { index: 1, label: 'No', tokenId: 'token-no', lastPrice: 0.2 },
  ]);
});

test('V2 outcome position IDs are preserved with named outcomes', () => {
  const outcomes = normalizeOutcomes(rawMarket({
    version: 'v2',
    outcomes: '["Home team", "Draw", "Away team"]',
    positionIds: '["home-position", "draw-position", "away-position"]',
    clobTokenIds: null,
    outcomePrices: '["0.81", "0.08", "0.11"]',
  }));
  assert.deepEqual(outcomes.map((outcome) => [outcome.label, outcome.tokenId]), [
    ['Home team', 'home-position'],
    ['Draw', 'draw-position'],
    ['Away team', 'away-position'],
  ]);
});

test('crypto market metadata, names, and tickers are excluded without treating ordinary links as crypto', () => {
  assert.equal(isCryptoMarket(rawMarket({ question: 'Bitcoin Up or Down?' })), true);
  assert.equal(isCryptoMarket(rawMarket({ slug: 'eth-updown-15m-123' })), true);
  assert.equal(isCryptoMarket(rawMarket({ cryptoMarketConfigId: 'cfg-1' })), true);
  assert.equal(isCryptoMarket(rawMarket({
    question: 'Will the game stream link work?',
    description: 'See the official live link for the result.',
  })), false);
});

test('sports metadata and categories exclude sports markets without excluding political markets', () => {
  assert.equal(isSportsMarket(rawMarket({ sportsMarketType: 'spreads' })), true);
  assert.equal(isSportsMarket(rawMarket({
    events: [{ title: 'A vs B', series: [{ title: 'Premier League', ticker: 'epl' }] }],
  })), true);
  assert.equal(isSportsMarket(rawMarket({
    tags: [{ label: 'Sports', slug: 'sports' }],
  })), true);
  assert.equal(isSportsMarket(rawMarket({
    question: 'Will the Senate pass the bill?',
    category: 'Politics',
    events: [],
  })), false);
});

test('market normalization rejects crypto, sports, ended, distant, and non-tradable markets', () => {
  const now = 1_000_000;
  assert.equal(normalizeMarket(rawMarket({ question: 'Bitcoin above $100k?' }), { now }), null);
  assert.equal(normalizeMarket(rawMarket({ sportsMarketType: 'totals' }), { now }), null);
  assert.equal(normalizeMarket(rawMarket({ endDate: new Date(now - 1).toISOString() }), { now }), null);
  assert.equal(normalizeMarket(rawMarket({ endDate: new Date(now + 7_300_000).toISOString() }), { now }), null);
  assert.equal(normalizeMarket(rawMarket({ acceptingOrders: false }), { now }), null);
  assert.equal(normalizeMarket(rawMarket({
    outcomes: '["Yes", "No"]',
    clobTokenIds: '["only-one-id"]',
  }), { now }), null);
});

test('Gamma scanner paginates, filters the exact horizon, and reports discovered outcomes', async () => {
  const now = 1_000_000;
  const requests = [];
  const pages = [
    {
      markets: [
      rawMarket(),
      rawMarket({ id: 'crypto', slug: 'btc-updown', question: 'BTC Up or Down?' }),
      rawMarket({ id: 'sports', sportsMarketType: 'spreads' }),
      ],
      next_cursor: 'page-2',
    },
    {
      markets: [],
      next_cursor: null,
    },
  ];
  const scanner = new GammaMarketScanner({
    pageSize: 2,
    maxPages: 5,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      const cursor = parsed.searchParams.get('after_cursor');
      const body = pages[cursor === 'page-2' ? 1 : 0];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await scanner.scanMarkets({ now, horizonMs: 7_200_000 });
  assert.equal(result.markets.length, 1);
  assert.equal(result.cryptoExcluded, 1);
  assert.equal(result.sportsExcluded, 1);
  assert.equal(result.complete, true);
  assert.equal(result.pageCount, 2);
  assert.equal(requests[0].pathname, '/markets/keyset');
  assert.equal(requests[1].searchParams.get('after_cursor'), 'page-2');
  assert.equal(requests[0].searchParams.get('end_date_min'), new Date(now).toISOString());
  assert.equal(requests[0].searchParams.get('end_date_max'), new Date(now + 7_200_000).toISOString());
});

test('Gamma scanner marks a page-capped market list incomplete', async () => {
  const now = 1_000_000;
  const page = {
    markets: Array.from({ length: 2 }, (_, index) => rawMarket({
      id: `market-${index}`,
      slug: `market-${index}`,
    })),
    next_cursor: 'more',
  };
  const scanner = new GammaMarketScanner({
    pageSize: 2,
    maxPages: 1,
    fetchImpl: async () => new Response(JSON.stringify(page), { status: 200 }),
  });
  const result = await scanner.scanMarkets({ now, horizonMs: 7_200_000 });
  assert.equal(result.complete, false);
  assert.equal(result.pageCount, 1);
});
