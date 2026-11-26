'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'perps-copy-dashboard.html'));

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function startServer(bot, port, { listen = true } = {}) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/healthz') {
      const state = bot.snapshot();
      const healthy = state.status !== 'persistence_error';
      sendJson(response, healthy ? 200 : 503, {
        ok: healthy,
        mode: state.mode,
        status: state.status,
        now: state.now,
      });
      return;
    }
    if (pathname === '/api/state') {
      sendJson(response, 200, bot.snapshot());
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(INDEX_HTML);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  if (listen) {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[dashboard] listening on :${port}`);
    });
  }
  return server;
}

module.exports = startServer;
