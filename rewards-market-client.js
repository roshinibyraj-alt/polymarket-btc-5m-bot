'use strict';

const REWARDS_URL = 'https://clob.polymarket.com/rewards/markets/multi';
const REQUEST_TIMEOUT_MS = 5_000;

function activeConfigs(configs, now = Date.now()) {
  return (Array.isArray(configs) ? configs : []).filter((item) => {
    const rate = Number(item.rate_per_day ?? item.ratePerDay ?? 0);
    const start = item.start_date ? Date.parse(item.start_date) : null;
    const end = item.end_date ? Date.parse(item.end_date) : null;
    const startValid = start == null || (Number.isFinite(start) && start <= now);
    const endValid = end == null || (Number.isFinite(end) && end >= now);
    return rate > 0 && startValid && endValid;
  });
}

class RewardsMarketClient {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async getMarketRewards(market) {
    if (typeof this.fetchImpl !== 'function') {
      return { status: 'UNAVAILABLE', reason: 'Fetch is not available in this runtime.' };
    }
    const slug = String(market?.slug || '');
    if (!slug) return { status: 'UNAVAILABLE', reason: 'Market slug is missing.' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = `${REWARDS_URL}?q=Bitcoin&page_size=500`;
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Rewards API returned HTTP ${response.status}.`);
      const payload = await response.json();
      const list = Array.isArray(payload?.data) ? payload.data : [];
      const row = list.find((item) => String(item.market_slug || item.slug || '') === slug);
      if (!row) {
        return {
          status: 'MARKET_NOT_LISTED',
          reason: 'This market was not returned by the public reward-market list.',
          checkedAt: this.now(),
        };
      }

      const configs = activeConfigs(row.rewards_config, this.now());
      return {
        status: configs.length ? 'ACTIVE_ALLOCATION' : 'NO_ACTIVE_ALLOCATION',
        marketSlug: slug,
        checkedAt: this.now(),
        minimumDisplayedShares: Number(row.rewards_min_size) || null,
        maximumDisplayedSpreadCents: Number(row.rewards_max_spread) || null,
        activeAllocations: configs.map((item) => ({
          ratePerDay: Number(item.rate_per_day ?? item.ratePerDay) || 0,
          start: item.start_date || null,
          end: item.end_date || null,
        })),
      };
    } catch (error) {
      return {
        status: 'UNAVAILABLE',
        reason: error.name === 'AbortError' ? 'Reward lookup timed out.' : error.message,
        checkedAt: this.now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = RewardsMarketClient;
module.exports.activeConfigs = activeConfigs;
