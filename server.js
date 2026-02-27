const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const BTCScalper = require('./scalper');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const bot = new BTCScalper();

// API
app.get('/api/status', (req, res) => res.json(bot.getStatus()));
app.get('/api/correction', (req, res) => res.json(bot.correction.getStatus()));
app.post('/api/start', async (req, res) => { await bot.start(); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { bot.stop(); res.json({ ok: true }); });
app.post('/api/pause', (req, res) => { bot.paused = !bot.paused; res.json({ paused: bot.paused }); });

// WebSocket
const broadcast = (data) => { const msg = JSON.stringify(data); wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); }); };

bot.on('status', s => broadcast({ type: 'status', data: s }));
bot.on('log', l => broadcast({ type: 'log', data: l }));
bot.on('correction', c => broadcast({ type: 'correction', data: c }));

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'status', data: bot.getStatus() }));
});

// Periodic broadcast
setInterval(() => { if (bot.running) broadcast({ type: 'status', data: bot.getStatus() }); }, 5000);

server.listen(PORT, () => console.log(`\n🎰 YOLO ENGINE v2.0 — BTC SCALPER\n🌐 http://localhost:${PORT}\n`));
