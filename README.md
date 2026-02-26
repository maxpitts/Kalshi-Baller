# 🎰 YOLO ENGINE

**Turn $100 into $10,000 on Kalshi in 48 hours — or self-destruct trying.**

```
  ╔═══════════════════════════════════════════╗
  ║         🎰  YOLO ENGINE v1.0  🎰         ║
  ║                                           ║
  ║  $100 → $10,000 in 48h or bust            ║
  ║  3 strategies. 1 countdown. 0 chill.      ║
  ╚═══════════════════════════════════════════╝
```

## ⚡ Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env with your Kalshi API credentials
```

### 3. Run in demo mode (no real money)
```bash
npm start
# or
DRY_RUN=true node server.js
```

### 4. Open the dashboard
```
http://localhost:3000
```

Hit **START** and watch the chaos unfold.

---

## 🔑 Kalshi API Setup

1. Go to [kalshi.com/account/profile](https://kalshi.com/account/profile)
2. Find the **API Keys** section
3. Click **Create New API Key**
4. **Save the private key immediately** — it won't be shown again
5. Place the `.pem` file in the project root as `kalshi-key.pem`
6. Copy the Key ID into your `.env`:

```env
KALSHI_API_KEY_ID=a952bcbe-ec3b-4b5b-xxxx-xxxxxxxxxxxx
KALSHI_PRIVATE_KEY_PATH=./kalshi-key.pem
KALSHI_ENV=demo   # "demo" for testing, "production" for real money
```

### Demo vs Production
| | Demo | Production |
|---|---|---|
| URL | `demo-api.kalshi.co` | `api.elections.kalshi.com` |
| Money | Fake | Real |
| Markets | Limited | All |

**Always test in demo first.**

---

## 🎯 Strategy Modes

### `edge_hunter` (Default — Recommended)
- Scans all open markets for mispriced contracts
- Uses Kelly-adjacent bet sizing based on estimated edge
- Focuses on cheap contracts ($0.02-$0.40) with high asymmetric payoff
- Gets more aggressive as the countdown progresses

### `momentum`
- Chases high-volume markets with active trading
- Rides the crowd — bets on the direction of flow
- More moderate sizing, higher frequency

### `full_send`
- ALL-IN on the single best opportunity each round
- Maximum aggression, maximum variance
- Pick this if you want maximum drama

---

## ⚙️ Configuration

All settings in `.env`:

| Setting | Default | Description |
|---|---|---|
| `STARTING_BANKROLL` | 100 | Starting balance in dollars |
| `TARGET_BANKROLL` | 10000 | Target balance in dollars |
| `TIME_LIMIT_HOURS` | 48 | Hours before self-destruct |
| `STRATEGY_MODE` | edge_hunter | Strategy to use |
| `MAX_BET_FRACTION` | 0.5 | Max % of bankroll per bet |
| `MIN_EDGE_THRESHOLD` | 0.05 | Minimum edge to place bet |
| `SCAN_INTERVAL_SECONDS` | 30 | How often to scan markets |
| `DESTRUCT_MODE` | withdraw | What happens at time-out |

### Destruct Modes
- **`withdraw`** — Cancel all orders, close positions
- **`halt`** — Stop bot, leave positions open
- **`nuke`** — Cancel everything + delete config files

---

## 📊 Dashboard

The web dashboard at `http://localhost:3000` shows:

- **Live countdown** — Time remaining until self-destruct
- **Bankroll tracker** — Current balance + P&L chart
- **Active bet** — What the bot is currently positioned on
- **Stats** — Win rate, total wagered, peak balance
- **Event log** — Real-time log of all bot activity

Updates via WebSocket in real-time.

---

## 🏗️ Architecture

```
yolo-engine/
├── server.js          # Express + WebSocket server
├── bot.js             # Main bot engine with countdown
├── kalshi-client.js   # Kalshi API client (RSA-PSS auth)
├── scanner.js         # Market scanner & edge detection
├── strategy.js        # Bet sizing & selection strategies
├── public/
│   └── index.html     # Live dashboard
├── .env.example       # Config template
└── package.json
```

### How it works

1. **Scanner** pulls all open Kalshi markets and scores them by edge, asymmetry, volume, time-to-expiry, and fee impact
2. **Strategy Engine** takes the top opportunities and decides what to bet on and how much, based on your chosen mode and current urgency (time pressure + progress toward goal)
3. **Bot** executes the bet via the Kalshi API and monitors positions
4. **Countdown** ticks down. If time expires → self-destruct sequence
5. **Dashboard** shows everything in real-time via WebSocket

---

## 🛡️ Risk Disclaimer

**This bot is designed to be extremely aggressive.** It is fundamentally a high-risk gambling tool. The expected outcome is losing your initial stake.

- Only use money you can afford to lose
- Start with demo mode to understand behavior
- The 100x target in 48 hours requires exceptional luck
- Past performance (even in demo) does not predict future results
- This is not financial advice

---

## 📡 API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Current bot status |
| POST | `/api/start` | Start the bot |
| POST | `/api/stop` | Stop the bot |
| POST | `/api/pause` | Pause scanning |
| POST | `/api/resume` | Resume scanning |
| GET | `/api/stats` | Strategy statistics |

WebSocket connects at `ws://localhost:3000` for real-time updates.

---

Built for chaos. Not for retirement accounts. 🎲
