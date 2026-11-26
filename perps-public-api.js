'use strict';

const DEFAULT_BASE_URL = 'https://api.perpetuals.polymarket.com';

class PerpsPublicApi {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = 12_000,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async get(path) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Perps API returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const detail = body?.error || body?.message || `HTTP ${response.status}`;
      const error = new Error(`Perps API request failed: ${detail}`);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after')) || null;
      throw error;
    }
    return body;
  }

  registration(address) {
    return this.get(`/v1/info/registered?address=${encodeURIComponent(address)}`);
  }

  portfolio(address) {
    return this.get(`/v1/info/portfolio?address=${encodeURIComponent(address)}`);
  }

  instruments() {
    return this.get('/v1/info/instruments');
  }

  book(instrumentId) {
    return this.get(`/v1/info/book?instrument_id=${encodeURIComponent(instrumentId)}&depth=100`);
  }

  fees() {
    return this.get('/v1/info/fees');
  }

  tickers() {
    return this.get('/v1/info/tickers');
  }

  fills(address, cursor = null) {
    const params = new URLSearchParams({ address, sort: 'desc' });
    if (cursor) params.set('cursor', cursor);
    return this.get(`/v1/info/fills?${params.toString()}`);
  }
}

module.exports = { PerpsPublicApi, DEFAULT_BASE_URL };
