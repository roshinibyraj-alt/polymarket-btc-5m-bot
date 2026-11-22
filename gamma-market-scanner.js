'use strict';

const GAMMA_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';
const MAX_HORIZON_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;

const CRYPTO_NAMES = /\b(bitcoin|ethereum|ether|solana|dogecoin|ripple|binance coin|cardano|avalanche|chainlink|litecoin|shiba inu|polkadot|tron|hyperliquid|crypto|cryptocurrency|blockchain|digital asset|token price|stablecoin)\b/i;
const CRYPTO_TICKERS = /\b(BTC|XBT|ETH|SOL|DOGE|XRP|BNB|ADA|AVAX|HYPE|LTC|SHIB|DOT|TRX|PEPE|SUI|TON|USDC|USDT|UNI|ATOM|NEAR|APT|ARB|OP|FIL|BCH|ETC|MATIC|POL)\b/i;

function meaningful(value) {
  if (value == null || value === false || value === '') return false;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'number') return value !== 0;
  return true;
}

function boolIsFalse(value) {
  return value === false || String(value).toLowerCase() === 'false';
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).join(' ');
  if (value && typeof value === 'object') {
    return Object.values(value).map(asText).join(' ');
  }
  return '';
}

function isCryptoMarket(market) {
  if (meaningful(market?.cryptoMarketConfig)
    || meaningful(market?.cryptoMarketConfigId)
    || meaningful(market?.crypto_market_config)
    || meaningful(market?.crypto_market_config_id)) return true;

  const events = Array.isArray(market?.events) ? market.events : [];
  const tags = [
    ...(Array.isArray(market?.tags) ? market.tags : []),
    ...events.flatMap((event) => Array.isArray(event?.tags) ? event.tags : []),
  ];
  const headline = [
    market?.question,
    market?.title,
    market?.slug,
    market?.category,
    market?.ticker,
    market?.eventSlug,
    market?.groupItemTitle,
    market?.seriesSlug,
    market?.series?.map?.((series) => `${series?.title || ''} ${series?.slug || ''}`),
    events.map((event) => [
      event?.title,
      event?.slug,
      event?.category,
      event?.ticker,
      event?.seriesSlug,
      event?.series?.map?.((series) => `${series?.title || ''} ${series?.slug || ''}`),
    ]),
    tags.map((tag) => `${tag?.label || ''} ${tag?.slug || ''} ${tag?.name || ''}`),
  ].map(asText).join(' ');
  const descriptions = [
    market?.description,
    market?.resolutionSource,
    ...events.map((event) => event?.description),
  ].map(asText).join(' ');

  return CRYPTO_NAMES.test(`${headline} ${descriptions}`)
    || CRYPTO_TICKERS.test(headline);
}

function normalizeOutcomes(market) {
  const labels = parseList(market?.outcomes);
  const ids = parseList(
    String(market?.version || '').toLowerCase() === 'v2'
      ? (market?.positionIds ?? market?.position_ids ?? market?.clobTokenIds)
      : (market?.clobTokenIds ?? market?.clob_token_ids ?? market?.positionIds),
  );
  const prices = parseList(market?.outcomePrices ?? market?.outcome_prices);

  if (!labels.length && Array.isArray(market?.outcomes)) {
    labels.push(...market.outcomes);
  }

  const outcomes = labels.map((entry, index) => {
    const label = typeof entry === 'string'
      ? entry
      : entry?.name || entry?.label || entry?.title || entry?.outcome || '';
    const tokenId = typeof entry === 'object' && entry
      ? (entry.tokenId || entry.token_id || entry.positionId || entry.position_id
        || ids[index])
      : ids[index];
    const lastPrice = Number(prices[index] ?? entry?.price ?? entry?.lastPrice);
    if (!String(label).trim() || tokenId == null || !String(tokenId).trim()) return null;
    return {
      index,
      label: String(label).trim(),
      tokenId: String(tokenId),
      lastPrice: Number.isFinite(lastPrice) && lastPrice >= 0 && lastPrice <= 1
        ? lastPrice : null,
    };
  }).filter(Boolean);

  if (outcomes.length !== labels.length || outcomes.length < 2) return [];
  if (new Set(outcomes.map((outcome) => outcome.tokenId)).size !== outcomes.length) return [];
  return outcomes;
}

function normalizeMarket(market, {
  now = Date.now(),
  horizonMs = MAX_HORIZON_MS,
} = {}) {
  if (!market || typeof market !== 'object') return null;
  if (boolIsFalse(market.active) || market.closed === true || market.archived === true) return null;
  if (boolIsFalse(market.enableOrderBook) || boolIsFalse(market.acceptingOrders)
    || boolIsFalse(market.tradingEligible)) return null;
  if (isCryptoMarket(market)) return null;

  const endAt = Date.parse(market.endDate || market.endDateIso || market.end_date_iso);
  if (!Number.isFinite(endAt) || endAt <= now || endAt > now + horizonMs) return null;
  const outcomes = normalizeOutcomes(market);
  if (!outcomes.length) return null;

  const id = String(market.id || market.conditionId || market.condition_id || market.slug || '');
  if (!id) return null;

  const event = Array.isArray(market.events) ? market.events[0] : null;
  return {
    id,
    conditionId: market.conditionId || market.condition_id || null,
    slug: market.slug || null,
    title: market.question || market.title || market.slug || 'Polymarket market',
    eventTitle: event?.title || null,
    description: market.description || null,
    endAt,
    version: String(market.version || 'v1').toLowerCase(),
    outcomes,
    active: market.active !== false,
    acceptingOrders: market.acceptingOrders !== false,
    enableOrderBook: market.enableOrderBook !== false,
    feesEnabled: market.feesEnabled ?? market.fees_enabled ?? false,
    takerBaseFee: Number(market.takerBaseFee ?? market.taker_base_fee ?? 0),
    makerBaseFee: Number(market.makerBaseFee ?? market.maker_base_fee ?? 0),
    feeSchedule: market.feeSchedule ?? market.fee_schedule ?? null,
    takerFeeRate: market.takerFeeRate ?? market.taker_fee_rate ?? null,
    raw: market,
  };
}

class GammaMarketScanner {
  constructor({
    fetchImpl = globalThis.fetch,
    gammaUrl = GAMMA_URL,
    clobUrl = CLOB_URL,
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    timeoutMs = 15_000,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.gammaUrl = gammaUrl.replace(/\/$/, '');
    this.clobUrl = clobUrl.replace(/\/$/, '');
    this.pageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    this.maxPages = Math.max(1, Math.floor(maxPages));
    this.timeoutMs = timeoutMs;
  }

  async fetchJson(url) {
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`${new URL(url).host} HTTP ${response.status}${body ? `: ${body}` : ''}`);
    }
    return response.json();
  }

  async scanMarkets({
    now = Date.now(),
    horizonMs = MAX_HORIZON_MS,
    maxPages = this.maxPages,
  } = {}) {
    if (!Number.isFinite(now) || !Number.isFinite(horizonMs)
      || horizonMs <= 0 || horizonMs > MAX_HORIZON_MS) {
      throw new Error('Market scan horizon must be between 0 and two hours');
    }

    const discovered = new Map();
    let rowsSeen = 0;
    let cryptoExcluded = 0;
    let invalidMarkets = 0;
    let pageCount = 0;
    let cursor = null;
    let complete = true;

    const pageLimit = Math.max(1, Math.floor(maxPages));
    while (pageCount < pageLimit) {
      const url = new URL(`${this.gammaUrl}/markets/keyset`);
      url.searchParams.set('active', 'true');
      url.searchParams.set('closed', 'false');
      url.searchParams.set('end_date_min', new Date(now).toISOString());
      url.searchParams.set('end_date_max', new Date(now + horizonMs).toISOString());
      url.searchParams.set('order', 'endDate');
      url.searchParams.set('ascending', 'true');
      url.searchParams.set('limit', String(this.pageSize));
      if (cursor) url.searchParams.set('after_cursor', cursor);

      const response = await this.fetchJson(url.toString());
      const page = response?.markets;
      if (!Array.isArray(page)) throw new Error('Gamma returned an invalid keyset market response');
      pageCount += 1;
      rowsSeen += page.length;
      for (const rawMarket of page) {
        if (isCryptoMarket(rawMarket)) {
          cryptoExcluded += 1;
          continue;
        }
        const market = normalizeMarket(rawMarket, { now, horizonMs });
        if (!market) {
          invalidMarkets += 1;
          continue;
        }
        discovered.set(market.id, market);
      }

      const nextCursor = typeof response.next_cursor === 'string' && response.next_cursor
        ? response.next_cursor : null;
      if (!nextCursor) break;
      if (nextCursor === cursor) throw new Error('Gamma repeated a keyset cursor');
      cursor = nextCursor;
      if (pageCount === pageLimit) complete = false;
    }

    const markets = [...discovered.values()].sort((a, b) => a.endAt - b.endAt);
    return {
      markets,
      complete,
      pageCount,
      rowsSeen,
      cryptoExcluded,
      invalidMarkets,
      scannedAt: now,
      horizonEndsAt: now + horizonMs,
    };
  }

  async getMarket(id) {
    return this.fetchJson(`${this.gammaUrl}/markets/${encodeURIComponent(String(id))}`);
  }

  async getBook(tokenId) {
    return this.fetchJson(`${this.clobUrl}/book?token_id=${encodeURIComponent(String(tokenId))}`);
  }
}

module.exports = {
  CLOB_URL,
  GAMMA_URL,
  MAX_HORIZON_MS,
  GammaMarketScanner,
  isCryptoMarket,
  normalizeMarket,
  normalizeOutcomes,
  parseList,
};
