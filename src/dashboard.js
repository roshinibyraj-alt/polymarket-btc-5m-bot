// src/dashboard.js — a minimal live dashboard using only Node's built-in http module
// (no extra dependencies to install). Serves a single auto-refreshing HTML page plus
// a small JSON API that the page polls.

const http = require('http');

function renderPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BTC 5m Paper Trading Dashboard</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 16px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: #8b949e; font-size: 13px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 14px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: 500; }
    .pos { color: #3fb950; } .neg { color: #f85149; }
    .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
    .sig { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin: 2px; background: #21262d; }
    .up { color: #3fb950; } .down { color: #f85149; } .flat { color: #8b949e; }
    .warn { background: #3d2a00; border: 1px solid #9e6a03; color: #e3b341; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>BTC 5-Minute Paper Trading Bot</h1>
  <div class="sub" id="updated">Loading...</div>
  <div class="warn">⚠️ Simulated market pricing (fixed spread), not live Polymarket order book. Resolves against Binance.US spot, not the Chainlink feed Polymarket actually uses — treat as directional signal testing, not real P&L.</div>

  <div class="card">
    <div style="color:#8b949e;font-size:13px;margin-bottom:6px;">Latest signals (window open)</div>
    <div id="signals">-</div>
  </div>

  <table id="strategyTable">
    <thead><tr><th>Strategy</th><th>Bankroll</th><th>Trades</th><th>Win Rate</th><th>ROI</th></tr></thead>
    <tbody></tbody>
  </table>

  <div class="card">
    <div style="color:#8b949e;font-size:13px;margin-bottom:6px;">Recent resolutions</div>
    <div id="recent">-</div>
  </div>

<script>
async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    document.getElementById('updated').textContent = 'Last update: ' + new Date(data.updatedAt).toLocaleTimeString() + ' | BTC: $' + (data.lastPrice ? data.lastPrice.toFixed(2) : '-');

    const sigHtml = Object.entries(data.signals || {}).map(function(entry) {
      var name = entry[0], s = entry[1];
      return '<span class="sig ' + s.direction + '">' + name + ': ' + s.direction + ' (' + s.confidence.toFixed(2) + ')</span>';
    }).join('');
    document.getElementById('signals').innerHTML = sigHtml || 'Waiting for first window...';

    const tbody = document.querySelector('#strategyTable tbody');
    tbody.innerHTML = (data.strategies || []).map(function(s) {
      return '<tr><td>' + s.name + '</td><td>$' + s.bankroll.toFixed(2) + '</td><td>' + s.trades +
        '</td><td>' + (s.winRate * 100).toFixed(1) + '%</td><td class="' + (s.roi >= 0 ? 'pos' : 'neg') + '">' +
        (s.roi * 100).toFixed(2) + '%</td></tr>';
    }).join('');

    const recentHtml = (data.recentTrades || []).slice().reverse().map(function(t) {
      var resultSpan = t.won ? '<span class="pos">WIN</span>' : '<span class="neg">LOSS</span>';
      var pnlStr = (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2);
      return '<div>' + new Date(t.windowStart).toLocaleTimeString() + ' — <b>' + t.strategy + '</b>: ' +
        t.side + ' — ' + resultSpan + ' (' + pnlStr + ')</div>';
    }).join('');
    document.getElementById('recent').innerHTML = recentHtml || 'No resolutions yet.';
  } catch (e) {
    document.getElementById('updated').textContent = 'Error fetching status: ' + e.message;
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

function startDashboard(getState, port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getState()));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPage());
  });

  const listenPort = port || process.env.PORT || 3000;
  server.listen(listenPort, () => {
    console.log(`[Dashboard] Listening on port ${listenPort}`);
  });
  return server;
}

module.exports = { startDashboard };
