'use strict';

const SOURCE_PROXY_WALLET = '0x23ecee90767f510347d5005dc680ff5d24c7325c';
const SOURCE_OWNER_EOA = '0x5eee21f22ac3bb72c979d801270d7f322d6b2d6f';
const STARTING_PAPER_CAPITAL = 500;
const MAX_OPEN_NOTIONAL = 500;
const TAKER_FEE_RATE = 0.0005;
const DEFAULT_POLL_MS = 5_000;
const PORTFOLIO_REFRESH_MS = 15_000;
const MAX_SAVED_TRADES = 250;
const MAX_SAVED_EVENTS = 120;
const MAX_SEEN_FILL_IDS = 20_000;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function signedSize(value) {
  return finite(value);
}

function roundSize(value, decimals = 8) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.min(12, Math.max(0, decimals));
  return Math.trunc(value * factor) / factor;
}

function fillDelta(fill) {
  const quantity = Math.abs(finite(fill.quantity));
  if (fill.side === 'long') return quantity;
  if (fill.side === 'short') return -quantity;
  return 0;
}

function attributedExposure(currentSize, baselineSize) {
  const current = signedSize(currentSize);
  const baseline = signedSize(baselineSize);
  if (baseline === 0 || current === 0) return current;
  if (Math.sign(current) !== Math.sign(baseline)) return current;
  const newExposure = Math.max(0, Math.abs(current) - Math.abs(baseline));
  return Math.sign(current) * newExposure;
}

function positionMark(position) {
  const size = signedSize(position.size);
  const entry = finite(position.entry_price);
  const pnl = finite(position.unrealized_pnl);
  if (size === 0) return null;
  const mark = entry + (pnl / size);
  return Number.isFinite(mark) && mark > 0 ? mark : null;
}

function makeInitialState(now) {
  return {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    status: 'connecting',
    statusMessage: 'Connecting to Polymarket Perps public data.',
    source: {
      proxyWallet: SOURCE_PROXY_WALLET,
      ownerEoa: SOURCE_OWNER_EOA,
      registered: null,
      equity: null,
      positionCount: 0,
      baselinePositionCount: 0,
      baselineAt: null,
      lastFillAt: null,
      lastPortfolioAt: null,
      lastPollAt: null,
      lastError: null,
    },
    sizing: {
      paperCapital: STARTING_PAPER_CAPITAL,
      maxOpenNotional: MAX_OPEN_NOTIONAL,
      sourceEquityAtStart: null,
      multiplier: null,
      feeRate: TAKER_FEE_RATE,
    },
    account: {
      startingCapital: STARTING_PAPER_CAPITAL,
      cash: STARTING_PAPER_CAPITAL,
      realizedPnl: 0,
      fees: 0,
      fundingPnl: 0,
      floatingPnl: 0,
      equity: STARTING_PAPER_CAPITAL,
      openNotional: 0,
      peakEquity: STARTING_PAPER_CAPITAL,
      maxDrawdown: 0,
    },
    baselinePositions: {},
    sourcePositions: {},
    instruments: {},
    marks: {},
    positions: [],
    trades: [],
    events: [],
    seenFillIds: [],
    lastProcessedAt: null,
    stats: {
      sourceFillsSeen: 0,
      copiedFills: 0,
      ignoredBaselineFills: 0,
      ignoredZeroChangeFills: 0,
      capLimitedEntries: 0,
      copiedGrossNotional: 0,
    },
  };
}

class PerpsCopyBot {
  constructor({
    api,
    store = null,
    clock = () => Date.now(),
    pollIntervalMs = DEFAULT_POLL_MS,
    portfolioRefreshMs = PORTFOLIO_REFRESH_MS,
    paperCapital = STARTING_PAPER_CAPITAL,
    maxOpenNotional = MAX_OPEN_NOTIONAL,
  } = {}) {
    if (!api) throw new Error('A Perps public API client is required');
    this.api = api;
    this.store = store;
    this.clock = clock;
    this.pollIntervalMs = pollIntervalMs;
    this.portfolioRefreshMs = portfolioRefreshMs;
    this.paperCapital = paperCapital;
    this.maxOpenNotional = maxOpenNotional;
    this.state = makeInitialState(this.clock());
    this.timer = null;
    this.polling = false;
  }

  async initialize() {
    if (this.store) {
      const saved = await this.store.load();
      if (saved) {
        this.state = saved;
        this.addEvent('PAPER_STATE_RESTORED', 'Restored the separate Perps paper ledger.');
        await this.pollOnce();
        return this.snapshot();
      }
    }
    await this.bootstrap();
    return this.snapshot();
  }

  async bootstrap() {
    this.state.status = 'connecting';
    this.state.statusMessage = 'Checking the source account and taking a no-replay baseline.';
    try {
      const registered = await this.api.registration(SOURCE_OWNER_EOA);
      this.state.source.registered = registered.registered === true;
      if (!this.state.source.registered) {
        this.state.status = 'waiting_for_registration';
        this.state.statusMessage = 'The Perps owner account is not visible as registered yet.';
        await this.persist();
        return;
      }

      const instruments = await this.api.instruments();
      this.state.instruments = Object.fromEntries(
        (Array.isArray(instruments) ? instruments : instruments.data || [])
          .map((item) => [String(item.instrument_id ?? item.id), {
            id: Number(item.instrument_id ?? item.id),
            symbol: item.display_symbol || item.symbol || `Instrument ${item.instrument_id ?? item.id}`,
            priceDecimals: Number(item.price_decimals ?? item.priceDecimals ?? 2),
            quantityDecimals: Number(item.quantity_decimals ?? item.quantityDecimals ?? 6),
            priceBounds: finite(item.price_bounds ?? item.priceBounds, 0),
            minNotional: finite(item.min_notional ?? item.minNotional, 0),
            category: item.category || 'unknown',
          }]),
      );

      // Read the fill watermark first, then the portfolio. Any fill after that
      // portfolio snapshot will have a timestamp beyond baselineAt and be copied.
      const baselineFills = await this.api.fills(SOURCE_OWNER_EOA);
      const portfolio = await this.api.portfolio(SOURCE_OWNER_EOA);
      const equity = finite(portfolio.equity);
      if (!(equity > 0)) throw new Error('Source Perps equity is unavailable or non-positive');

      const baselineAt = finite(portfolio.timestamp, this.clock());
      const sourcePositions = {};
      const baselinePositions = {};
      const marks = {};
      for (const position of portfolio.positions || []) {
        const id = String(position.instrument_id ?? position.instrumentId);
        const size = signedSize(position.size);
        if (!id || size === 0) continue;
        sourcePositions[id] = size;
        baselinePositions[id] = size;
        const mark = positionMark(position);
        if (mark !== null) marks[id] = mark;
      }

      this.state.source.equity = equity;
      this.state.source.positionCount = Object.keys(sourcePositions).length;
      this.state.source.baselinePositionCount = Object.keys(sourcePositions).length;
      this.state.source.baselineAt = baselineAt;
      this.state.source.lastPortfolioAt = finite(portfolio.timestamp, this.clock());
      this.state.source.lastPollAt = this.clock();
      this.state.baselinePositions = baselinePositions;
      this.state.sourcePositions = sourcePositions;
      this.state.marks = marks;
      this.state.sizing.sourceEquityAtStart = equity;
      this.state.sizing.multiplier = this.paperCapital / equity;
      this.state.sizing.paperCapital = this.paperCapital;
      this.state.sizing.maxOpenNotional = this.maxOpenNotional;
      this.state.lastProcessedAt = baselineAt;
      this.rememberFills(baselineFills.data || []);
      this.state.status = 'running';
      this.state.statusMessage = 'Copying new source fills only; positions open at startup are baseline, not adopted.';
      this.addEvent(
        'BASELINE_READY',
        `Started clean at ${new Date(baselineAt).toISOString()}; ${Object.keys(sourcePositions).length} pre-existing source positions are not copied.`,
      );
      this.recalculateAccount();
      await this.persist();
    } catch (error) {
      this.state.status = 'degraded';
      this.state.statusMessage = 'Waiting for public Perps data to recover; no entries are fabricated.';
      this.state.source.lastError = error.message || String(error);
      this.addEvent('SOURCE_READ_ERROR', this.state.source.lastError);
      await this.persist();
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.state.source.lastError = error.message || String(error);
        this.state.status = 'degraded';
        this.state.statusMessage = 'Perps data is temporarily unavailable; paper positions are retained.';
        this.persist().catch(() => {});
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stopAndFlush() {
    this.stop();
    await this.persist();
  }

  async pollOnce() {
    if (this.polling) return this.snapshot();
    this.polling = true;
    try {
      if (this.state.source.registered !== true || !this.state.source.baselineAt) {
        await this.bootstrap();
        return this.snapshot();
      }

      const now = this.clock();
      if (!this.state.source.lastPortfolioAt
        || now - this.state.source.lastPortfolioAt >= this.portfolioRefreshMs) {
        await this.refreshPortfolio();
      }

      await this.processNewFills();
      this.state.source.lastPollAt = now;
      this.state.source.lastError = null;
      this.state.status = 'running';
      this.state.statusMessage = 'Watching all Perps instruments; paper mode only.';
      this.recalculateAccount();
      await this.persist();
    } catch (error) {
      this.state.status = 'degraded';
      this.state.statusMessage = 'Perps data is temporarily unavailable; paper positions are retained.';
      this.state.source.lastError = error.message || String(error);
      this.addEvent('SOURCE_READ_ERROR', this.state.source.lastError);
      await this.persist();
    } finally {
      this.polling = false;
    }
    return this.snapshot();
  }

  async refreshPortfolio() {
    const portfolio = await this.api.portfolio(SOURCE_OWNER_EOA);
    const positions = portfolio.positions || [];
    const nextSourcePositions = {};
    const nextMarks = { ...this.state.marks };
    for (const position of positions) {
      const id = String(position.instrument_id ?? position.instrumentId);
      const size = signedSize(position.size);
      if (!id || size === 0) continue;
      nextSourcePositions[id] = size;
      const mark = positionMark(position);
      if (mark !== null) nextMarks[id] = mark;
    }
    this.state.sourcePositions = nextSourcePositions;
    this.state.source.equity = finite(portfolio.equity, this.state.source.equity);
    this.state.source.positionCount = Object.keys(nextSourcePositions).length;
    this.state.source.lastPortfolioAt = finite(portfolio.timestamp, this.clock());
    this.state.marks = nextMarks;
    for (const position of this.state.positions) {
      const mark = nextMarks[String(position.instrumentId)];
      if (Number.isFinite(mark) && mark > 0) {
        position.markPrice = mark;
        position.markUpdatedAt = this.state.source.lastPortfolioAt;
      }
    }
    this.recalculateAccount();
    this.enforceExposureCap();
  }

  async processNewFills() {
    const seen = new Set(this.state.seenFillIds);
    const collected = [];
    let cursor = null;
    let pageCount = 0;
    let reachedKnown = false;

    do {
      const page = await this.api.fills(SOURCE_OWNER_EOA, cursor);
      const rows = Array.isArray(page.data) ? page.data : [];
      for (const fill of rows) {
        const id = String(fill.trade_id ?? fill.tradeId ?? '');
        const timestamp = finite(fill.timestamp);
        if (id && seen.has(id)) {
          reachedKnown = true;
          continue;
        }
        if (timestamp < finite(this.state.lastProcessedAt, this.state.source.baselineAt)) {
          this.rememberFills([fill]);
          reachedKnown = true;
          continue;
        }
        if (timestamp <= finite(this.state.source.baselineAt)) {
          this.rememberFills([fill]);
          this.state.stats.ignoredBaselineFills += 1;
          reachedKnown = true;
          continue;
        }
        if (id) collected.push(fill);
      }
      pageCount += 1;
      cursor = page.cursor || null;
      if (reachedKnown || page.more !== true || !cursor || pageCount >= 30) break;
    } while (true);

    collected.sort((a, b) => {
      const timeDifference = finite(a.timestamp) - finite(b.timestamp);
      if (timeDifference !== 0) return timeDifference;
      return String(a.trade_id).localeCompare(String(b.trade_id), undefined, { numeric: true });
    });

    for (const fill of collected) {
      const id = String(fill.trade_id ?? fill.tradeId ?? '');
      if (id && new Set(this.state.seenFillIds).has(id)) continue;
      this.state.stats.sourceFillsSeen += 1;
      this.applySourceFill(fill);
      this.rememberFills([fill]);
      const timestamp = finite(fill.timestamp);
      this.state.lastProcessedAt = Math.max(finite(this.state.lastProcessedAt), timestamp);
      this.state.source.lastFillAt = timestamp || this.state.source.lastFillAt;
    }
  }

  applySourceFill(fill) {
    const instrumentId = String(fill.instrument_id ?? fill.instrumentId ?? '');
    const quantity = Math.abs(finite(fill.quantity));
    const delta = fillDelta(fill);
    const price = finite(fill.price);
    if (!instrumentId || quantity === 0 || delta === 0 || !(price > 0)) {
      this.addEvent('FILL_SKIPPED', `Skipped malformed source fill ${fill.trade_id ?? 'unknown'}.`);
      return;
    }
    const before = Number.isFinite(Number(fill.previous_size))
      ? signedSize(fill.previous_size)
      : finite(this.state.sourcePositions[instrumentId]);
    const after = before + delta;
    const baseline = finite(this.state.baselinePositions[instrumentId]);
    const eligible = attributedExposure(after, baseline);
    const multiplier = finite(this.state.sizing.multiplier);
    const desired = roundSize(eligible * multiplier, 8);
    this.state.sourcePositions[instrumentId] = after;
    this.state.marks[instrumentId] = price;
    const instrument = this.state.instruments[instrumentId] || {
      id: Number(instrumentId),
      symbol: fill.symbol || `Instrument ${instrumentId}`,
      priceDecimals: 2,
      quantityDecimals: 8,
    };
    const beforePaperSize = this.findPosition(instrumentId)?.size || 0;
    const changed = this.movePositionToTarget(instrument, desired, price, {
      sourceFillId: String(fill.trade_id ?? fill.tradeId),
      sourceTimestamp: finite(fill.timestamp),
      sourceSide: fill.side,
    });
    if (!changed) {
      this.state.stats.ignoredZeroChangeFills += 1;
      this.addEvent('FILL_NOT_COPIED', `${instrument.symbol}: source fill did not change eligible exposure.`);
      return;
    }
    this.state.stats.copiedFills += 1;
    this.state.stats.copiedGrossNotional += Math.abs((desired - beforePaperSize) * price);
    this.addEvent(
      'FILL_COPIED',
      `${instrument.symbol}: source ${fill.side} ${quantity} @ ${price}; paper exposure ${beforePaperSize} → ${this.findPosition(instrumentId)?.size || 0}.`,
    );
  }

  movePositionToTarget(instrument, targetSize, basePrice, sourceMeta) {
    let position = this.findPosition(String(instrument.id));
    const currentSize = position?.size || 0;
    const target = roundSize(targetSize, instrument.quantityDecimals ?? 8);
    if (Math.abs(target - currentSize) < 1e-10) return false;

    if (currentSize !== 0 && (target === 0 || Math.sign(currentSize) !== Math.sign(target))) {
      this.executePaperDelta(instrument, -currentSize, basePrice, sourceMeta, position);
      position = this.findPosition(String(instrument.id));
    }

    const afterClose = position?.size || 0;
    let remainingTarget = target;
    if (afterClose !== 0 && target !== 0 && Math.sign(afterClose) === Math.sign(target)) {
      remainingTarget = target - afterClose;
    }

    if (remainingTarget !== 0) {
      const isAdding = afterClose === 0 || Math.sign(afterClose) === Math.sign(remainingTarget);
      if (isAdding) {
        const available = Math.max(0, this.maxOpenNotional - this.calculateOpenNotional());
        const maxAdditional = available / basePrice;
        const allowed = Math.min(Math.abs(remainingTarget), maxAdditional);
        if (allowed < Math.abs(remainingTarget)) {
          this.state.stats.capLimitedEntries += 1;
          this.addEvent('EXPOSURE_CAP', `${instrument.symbol}: entry clipped by the $${this.maxOpenNotional} open-notional limit.`);
        }
        if (allowed > 0) {
          this.executePaperDelta(
            instrument,
            Math.sign(remainingTarget) * roundSize(allowed, instrument.quantityDecimals ?? 8),
            basePrice,
            sourceMeta,
            this.findPosition(String(instrument.id)),
          );
        }
      } else {
        this.executePaperDelta(instrument, remainingTarget, basePrice, sourceMeta, position);
      }
    }
    this.recalculateAccount();
    return true;
  }

  executePaperDelta(instrument, signedDelta, basePrice, sourceMeta, existingPosition) {
    const size = Math.abs(signedDelta);
    if (!(size > 0)) return;
    const current = existingPosition || this.findPosition(String(instrument.id));
    const tick = 10 ** -Math.min(10, Math.max(0, Number(instrument.priceDecimals ?? 2)));
    const executionPrice = Math.max(tick, basePrice + (Math.sign(signedDelta) * tick));
    const fee = Math.abs(size * executionPrice) * TAKER_FEE_RATE;
    const now = this.clock();
    const tradeBase = {
      id: `${sourceMeta.sourceFillId}:${this.state.trades.length}`,
      sourceFillId: sourceMeta.sourceFillId,
      sourceTimestamp: sourceMeta.sourceTimestamp,
      timestamp: now,
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      side: signedDelta > 0 ? 'BUY' : 'SELL',
      quantity: size,
      price: executionPrice,
      fee,
      feeRate: TAKER_FEE_RATE,
      slippageTicks: 1,
      sourceSide: sourceMeta.sourceSide,
    };

    const closesExisting = current
      && current.size !== 0
      && Math.sign(current.size) !== Math.sign(signedDelta);
    if (closesExisting) {
      const closeSize = Math.min(Math.abs(current.size), size);
      const realized = Math.sign(current.size) * (executionPrice - current.averageEntryPrice) * closeSize;
      current.realizedPnl += realized;
      current.fees += fee;
      current.size = roundSize(current.size + Math.sign(signedDelta) * closeSize, 10);
      this.state.account.realizedPnl += realized;
      this.state.account.fees += fee;
      this.state.account.cash += realized - fee;
      this.state.trades.unshift({
        ...tradeBase,
        action: 'CLOSE',
        quantity: closeSize,
        realizedPnl: realized,
        netRealizedPnl: realized - fee,
      });
      if (Math.abs(current.size) < 1e-10) {
        this.state.positions = this.state.positions.filter((item) => item !== current);
      }
      const remainder = size - closeSize;
      if (remainder > 1e-10) {
        this.openPaperPosition(instrument, Math.sign(signedDelta) * remainder, executionPrice, fee * remainder / size, tradeBase);
      }
    } else {
      this.openPaperPosition(instrument, signedDelta, executionPrice, fee, tradeBase);
    }
    this.state.trades = this.state.trades.slice(0, MAX_SAVED_TRADES);
    this.recalculateAccount();
  }

  openPaperPosition(instrument, signedDelta, executionPrice, fee, tradeBase) {
    const id = String(instrument.id);
    let position = this.findPosition(id);
    const size = Math.abs(signedDelta);
    if (!position) {
      position = {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        size: 0,
        averageEntryPrice: 0,
        markPrice: this.state.marks[id] || executionPrice,
        markUpdatedAt: this.state.source.lastPortfolioAt || this.clock(),
        realizedPnl: 0,
        fees: 0,
        openedAt: this.clock(),
      };
      this.state.positions.push(position);
    }
    const oldAbs = Math.abs(position.size);
    const newAbs = oldAbs + size;
    position.averageEntryPrice = newAbs === 0
      ? 0
      : ((oldAbs * position.averageEntryPrice) + (size * executionPrice)) / newAbs;
    position.size = roundSize(position.size + signedDelta, 10);
    position.fees += fee;
    this.state.account.fees += fee;
    this.state.account.cash -= fee;
    this.state.trades.unshift({
      ...tradeBase,
      action: 'OPEN',
      quantity: size,
      realizedPnl: 0,
      netRealizedPnl: -fee,
      fee,
    });
  }

  enforceExposureCap() {
    this.recalculateAccount();
    if (this.state.account.openNotional <= this.maxOpenNotional + 1e-6) return;
    const ordered = [...this.state.positions].sort((a, b) => {
      return (Math.abs(b.size) * b.markPrice) - (Math.abs(a.size) * a.markPrice);
    });
    for (const position of ordered) {
      const excess = this.state.account.openNotional - this.maxOpenNotional;
      if (excess <= 1e-6) break;
      const mark = position.markPrice;
      if (!(mark > 0)) continue;
      const trim = Math.min(Math.abs(position.size), excess / mark);
      const instrument = this.state.instruments[String(position.instrumentId)] || {
        id: position.instrumentId,
        symbol: position.symbol,
        priceDecimals: 2,
        quantityDecimals: 8,
      };
      this.executePaperDelta(
        instrument,
        -Math.sign(position.size) * trim,
        mark,
        { sourceFillId: 'exposure-cap', sourceTimestamp: this.clock(), sourceSide: 'risk' },
        position,
      );
      const latestTrade = this.state.trades[0];
      if (latestTrade) latestTrade.action = 'CAP_TRIM';
      this.recalculateAccount();
    }
  }

  calculateOpenNotional() {
    return this.state.positions.reduce((sum, position) => {
      const mark = finite(position.markPrice, position.averageEntryPrice);
      return sum + Math.abs(position.size) * mark;
    }, 0);
  }

  recalculateAccount() {
    let floating = 0;
    for (const position of this.state.positions) {
      const mark = finite(position.markPrice, position.averageEntryPrice);
      position.unrealizedPnl = position.size * (mark - position.averageEntryPrice);
      position.notional = Math.abs(position.size) * mark;
      floating += position.unrealizedPnl;
    }
    this.state.account.floatingPnl = floating;
    this.state.account.openNotional = this.calculateOpenNotional();
    this.state.account.equity = this.state.account.cash + floating + this.state.account.fundingPnl;
    this.state.account.peakEquity = Math.max(
      finite(this.state.account.peakEquity, this.state.account.startingCapital),
      this.state.account.equity,
    );
    this.state.account.maxDrawdown = Math.max(
      finite(this.state.account.maxDrawdown),
      this.state.account.peakEquity - this.state.account.equity,
    );
    this.state.updatedAt = this.clock();
  }

  findPosition(instrumentId) {
    return this.state.positions.find((item) => String(item.instrumentId) === String(instrumentId));
  }

  rememberFills(fills) {
    const set = new Set(this.state.seenFillIds);
    for (const fill of fills) {
      const id = fill?.trade_id ?? fill?.tradeId;
      if (id !== undefined && id !== null) set.add(String(id));
    }
    this.state.seenFillIds = [...set].slice(-MAX_SEEN_FILL_IDS);
  }

  addEvent(type, message) {
    this.state.events.unshift({ type, message, timestamp: this.clock() });
    this.state.events = this.state.events.slice(0, MAX_SAVED_EVENTS);
  }

  async persist() {
    if (!this.store) return;
    try {
      await this.store.save(this.state);
    } catch (error) {
      this.state.status = 'persistence_error';
      this.state.statusMessage = 'Paper history could not be saved; inspect the service before continuing.';
      this.state.source.lastError = `Paper ledger save failed: ${error.message || String(error)}`;
      throw error;
    }
  }

  snapshot() {
    this.recalculateAccount();
    return JSON.parse(JSON.stringify({
      ...this.state,
      now: this.clock(),
      mode: 'PAPER ONLY',
      source: { ...this.state.source },
      positions: this.state.positions.map((position) => ({ ...position })),
      trades: this.state.trades.slice(0, 100),
      events: this.state.events.slice(0, 40),
    }));
  }
}

module.exports = {
  PerpsCopyBot,
  attributedExposure,
  fillDelta,
  positionMark,
  SOURCE_PROXY_WALLET,
  SOURCE_OWNER_EOA,
  STARTING_PAPER_CAPITAL,
  MAX_OPEN_NOTIONAL,
  TAKER_FEE_RATE,
};
