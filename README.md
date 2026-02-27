# ₿ YOLO ENGINE v2 — BTC 15-Minute Scalper

**$100 → $10,000 in 48 hours. BTC only. Self-correcting brain.**

```
  ╔═══════════════════════════════════════════╗
  ║    ₿  YOLO ENGINE v2.0  ₿                ║
  ║                                           ║
  ║  BTC 15-Min Scalper + Correction Engine   ║
  ║  Momentum signals. Adaptive sizing.       ║
  ║  192 bets per 48h. 0 chill.              ║
  ╚═══════════════════════════════════════════╝
```

## How It Works

1. **BTC Feed** — Pulls live BTC price from CoinGecko/Binance/Coinbase every 15s
2. **Momentum Signals** — Computes 1m/5m/15m momentum, volatility, direction (UP/DOWN/NEUTRAL)
3. **Market Scanner** — Finds Kalshi BTC 15-min contracts (KXBTC15M series) expiring in 3-25 min
4. **Edge Calculator** — Compares momentum model probability vs market price. Only bets when edge > threshold
5. **Correction Engine** — Tracks every outcome by direction, price tier, volatility regime, time-of-day. Dynamically adjusts edge thresholds, position sizing, and direction bias
6. **Order Execution** — Places limit orders with 2¢ price improvement, cancels stale orders

## Quick Start

```bash
npm install
# Edit .env with your Kalshi API credentials
DRY_RUN=true node server.js
# Open http://localhost:3000
```

## Deploy to Railway

1. Push to GitHub
2. Connect repo to Railway
3. Add env vars: `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_BASE64`, `KALSHI_ENV=production`
4. Generate domain, open dashboard, hit START

## Correction Engine

The self-correcting brain tracks outcomes across 5 dimensions:

| Dimension | Tracks | Adjusts |
|---|---|---|
| **Direction** | Win rate for UP/DOWN/NEUTRAL bets | Avoids cold directions, boosts hot ones |
| **Price Tier** | Safe (70-97¢) / Moderate (35-69¢) / Risky (3-34¢) | Shifts sizing between tiers |
| **Volatility** | Low / Medium / High vol regimes | Adjusts edge threshold per regime |
| **Time Window** | Morning / Midday / Afternoon / Evening | Weights toward profitable windows |
| **Streaks** | Consecutive wins/losses | 3+ losses → 55% size, 5+ → 35%. 3+ wins → 112%, 5+ → 125% |

## Architecture

```
yolo-engine-v2/
├── server.js            # Express + WebSocket
├── scalper.js           # Core bot engine
├── kalshi-client.js     # Kalshi API (RSA-PSS auth)
├── btc-feed.js          # BTC price + momentum signals
├── correction-engine.js # Self-correcting adaptive brain
├── public/index.html    # Live dashboard
├── railway.json         # Railway deploy config
└── package.json
```

## Risk Disclaimer

This is an aggressive automated betting bot. The expected outcome is losing your money. Only use money you can afford to lose. Not financial advice.
