/**
 * ═══════════════════════════════════════════════════════════════
 * YOLO ENGINE — Server + WebSocket
 * ═══════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { YoloEngine } = require('./bot');

const PORT = process.env.PORT || 8080;

// ─── Express App ────────────────────────────────────────────────

const app = express();
app.use(express.json());
// Try multiple paths for static files (handles flat upload vs proper folder structure)
const publicPaths = [
  path.join(__dirname, 'public'),
  __dirname, // fallback: serve from root if public/ doesn't exist
];
for (const p of publicPaths) {
  app.use(express.static(p));
}

const server = http.createServer(app);

// ─── WebSocket ──────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

function broadcast(type, data) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// ─── Initialize Bot ─────────────────────────────────────────────

const botConfig = {
  apiKeyId: process.env.KALSHI_API_KEY_ID,
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi-key.pem',
  env: process.env.KALSHI_ENV || 'demo',
  startingBankroll: parseInt(process.env.STARTING_BANKROLL || '100') * 100,
  targetBankroll: parseInt(process.env.TARGET_BANKROLL || '10000') * 100,
  timeLimitHours: parseFloat(process.env.TIME_LIMIT_HOURS || '48'),
  scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS || '30'),
  strategyMode: process.env.STRATEGY_MODE || 'edge_hunter',
  maxBetFraction: parseFloat(process.env.MAX_BET_FRACTION || '0.5'),
  minEdge: parseFloat(process.env.MIN_EDGE_THRESHOLD || '0.05'),
  destructMode: process.env.DESTRUCT_MODE || 'withdraw',
  dryRun: !process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY_BASE64 || process.env.DRY_RUN === 'true',
};

const bot = new YoloEngine(botConfig);

// Wire up bot events to WebSocket
const botEvents = [
  'status', 'started', 'stopped', 'log', 'bet_signal',
  'order_placed', 'order_error', 'bet_result', 'positions_update',
  'self_destruct_initiated', 'self_destruct_complete', 'target_hit', 'error',
];

botEvents.forEach((event) => {
  bot.on(event, (data) => broadcast(event, data));
});

// ─── REST API ───────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json(bot.getStatus());
});

app.post('/api/start', async (req, res) => {
  try {
    await bot.start();
    res.json({ ok: true, status: bot.getStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/stop', async (req, res) => {
  await bot.stop();
  res.json({ ok: true, status: bot.getStatus() });
});

app.post('/api/pause', (req, res) => {
  bot.pause();
  res.json({ ok: true, status: bot.getStatus() });
});

app.post('/api/resume', (req, res) => {
  bot.resume();
  res.json({ ok: true, status: bot.getStatus() });
});

app.get('/api/stats', (req, res) => {
  res.json(bot.strategy.getStats());
});

// ─── Dashboard Route ────────────────────────────────────────────

app.get('/', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');
  if (require('fs').existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else if (require('fs').existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else {
    res.status(404).send('Dashboard not found. Make sure index.html exists in public/ folder or project root.');
  }
});

// ─── Start Server ───────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  🎰 YOLO Engine Dashboard: http://localhost:${PORT}`);
  console.log(`  📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`  🔧 Mode: ${botConfig.dryRun ? 'DRY RUN (no real orders)' : 'LIVE'}`);
  console.log(`  🎯 Target: $${botConfig.targetBankroll / 100} in ${botConfig.timeLimitHours}h\n`);

  if (botConfig.dryRun) {
    console.log('  ⚠️  No API key detected — running in DRY RUN mode');
    console.log('  ⚠️  Set KALSHI_API_KEY_ID in .env for live trading\n');
  }
});

// ─── WebSocket Connection Handler ───────────────────────────────

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  // Send current status immediately
  ws.send(JSON.stringify({
    type: 'status',
    data: bot.getStatus(),
    timestamp: Date.now(),
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.action) {
        case 'start':
          bot.start();
          break;
        case 'stop':
          bot.stop();
          break;
        case 'pause':
          bot.pause();
          break;
        case 'resume':
          bot.resume();
          break;
      }
    } catch (e) {
      console.warn('[WS] Invalid message:', e.message);
    }
  });

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ─── Graceful Shutdown ──────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Received SIGINT, shutting down...');
  await bot.stop();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[SHUTDOWN] Received SIGTERM, shutting down...');
  await bot.stop();
  server.close();
  process.exit(0);
});
