'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD = fs.readFileSync(path.join(__dirname, 'public', 'wick.html'));

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function startLiveServer(bot, port = Number(process.env.PORT || 8080)) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    if (pathname === '/api/healthz') {
      const state = bot.snapshot();
      const healthy = state.status === 'ready' || state.status === 'live_disabled';
      sendJson(res, healthy ? 200 : 503, {
        ok: healthy,
        mode: state.mode,
        status: state.status,
        tradingEnabled: state.tradingEnabled,
        accountReady: state.account?.accountReady === true,
        error: state.error,
        now: state.now,
      });
      return;
    }
    if (pathname === '/api/state') {
      sendJson(res, 200, bot.snapshot());
      return;
    }
    if (pathname === '/api/live-balance') {
      const state = bot.snapshot();
      sendJson(res, 200, {
        ...state.account,
        mode: state.mode,
        status: state.account?.status || state.status,
        tradingEnabled: state.tradingEnabled,
        error: state.account?.error || state.error,
        orders: state.orders,
        asOf: state.account?.asOf || null,
      });
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(DASHBOARD);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.listen(port, () => console.log(`[live-dashboard] listening on :${port}`));
  return server;
}

module.exports = startLiveServer;
