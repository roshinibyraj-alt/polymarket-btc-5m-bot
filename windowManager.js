// src/windowManager.js — tracks alignment to 5-minute UTC windows (matching how
// Polymarket's BTC up/down markets are typically time-bucketed). Verify the exact
// window boundaries and resolution price source against the specific Polymarket
// market you're trading — they may use a different exchange/index as the oracle.

const config = require('../config');

class WindowManager {
  constructor(onWindowOpen, onWindowClose) {
    this.windowMs = config.windowMinutes * 60 * 1000;
    this.onWindowOpen = onWindowOpen;
    this.onWindowClose = onWindowClose;
    this.currentWindowStart = null;
    this._timer = null;
  }

  start() {
    this._scheduleNextBoundary();
  }

  _scheduleNextBoundary() {
    const now = Date.now();
    const nextBoundary = Math.ceil(now / this.windowMs) * this.windowMs;
    const delay = nextBoundary - now;
    this._timer = setTimeout(() => this._onBoundary(nextBoundary), delay);
  }

  _onBoundary(boundaryTs) {
    if (this.currentWindowStart !== null) {
      this.onWindowClose(this.currentWindowStart, boundaryTs);
    }
    this.currentWindowStart = boundaryTs;
    // Fire the "open" callback slightly after the boundary so the decision uses
    // fresh post-boundary order book / trade state, per config.decisionOffsetSeconds.
    setTimeout(() => this.onWindowOpen(boundaryTs), config.decisionOffsetSeconds * 1000);
    this._scheduleNextBoundary();
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
  }
}

module.exports = WindowManager;
