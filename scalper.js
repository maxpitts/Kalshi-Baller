/**
 * YOLO ENGINE v3 — LEARN-FIRST SCALPER
 * 
 * Phase 1 (LEARN): Watch markets resolve. Record everything.
 *                   Build empirical probability tables.
 * Phase 2 (TRADE): Bet ONLY when observed win rates exceed market price.
 *                   Keep learning from every trade.
 *
 * It gets smarter over time. More data = better decisions.
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const DATA_FILE = './learned_data.json';

class BTCScalper extends EventEmitter {
  constructor(cfg = {}) {
    super();
    const KalshiClient = require('./kalshi-client');
    const BTCFeed = require('./btc-feed');

    this.kalshi = new KalshiClient();
    this.feed = new BTCFeed();

    this.cfg = {
      scanMs: cfg.scanMs || +process.env.SCAN_INTERVAL_MS || 10000,
      dryRun: (process.env.DRY_RUN || 'false').toLowerCase() === 'true',
      minObservations: +process.env.MIN_OBSERVATIONS || 10,
      minEdge: +(process.env.MIN_EDGE || 0.06),
      maxBets: +process.env.MAX_SIMULTANEOUS_BETS || 6,
    };

    this.running = false;
    this.paused = false;
    this._intervals = [];
    this._cycleCount = 0;

    // Bankroll
    this.bankroll = +process.env.STARTING_BANKROLL || 60;
    this.peak = this.bankroll;
    this.totalBets = 0; this.totalWins = 0; this.totalLosses = 0;
    this.totalWagered = 0; this._streak = 0;
    this._pausedUntil = 0;

    // Active tracking
    this.activeOrders = new Map();
    this.activeTickers = new Set();

    // Market watching
    this.watchlist = new Map();

    // Learned data — empirical results from watching markets resolve
    this.learnedData = { outcomes: [], buckets: {}, totalObserved: 0 };
    this._loadData();

    // Correction engine stub (for server.js compat)
    this.correction = {
      getCurrentTimeWindow: () => 'all',
      getSizeMultiplier: () => 1.0,
      getStatus: () => ({ stub: true }),
      restore: () => {},
      on: () => {},
    };

    // Log + history
    this.logs = [];
    this.bets = [];

    console.log(`[SCALPER] v3 LEARN-FIRST | bank:$${this.bankroll} | minObs:${this.cfg.minObservations} | dryRun:${this.cfg.dryRun}`);
    console.log(`[SCALPER] Learned data: ${this.learnedData.totalObserved} observations loaded`);
  }

  // ═══════════════════
  //  DATA PERSISTENCE
  // ═══════════════════

  _loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        this.learnedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        console.log(`[SCALPER] Loaded ${this.learnedData.totalObserved} observations`);
      }
    } catch(e) { console.log('[SCALPER] Starting fresh — no prior data'); }
  }

  _saveData() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(this.learnedData)); } catch(e) {}
  }

  // ═══════════════════
  //  LOGGING
  // ═══════════════════

  _log(tag, msg) {
    const entry = { t: new Date().toISOString(), tag, msg, ev: tag, d: msg };
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.splice(0, 50);
    console.log(`[${tag}] ${msg}`);
    this.emit('log', entry);
  }

  // ═══════════════════
  //  START / STOP
  // ═══════════════════

  async start() {
    if (this.running) return;
    this.running = true;

    try {
      const bal = await this.kalshi.getBalance();
      if (bal.balance != null) {
        this.bankroll = bal.balance / 100;
        this.peak = Math.max(this.peak, this.bankroll);
        this._log('💰 Balance', `$${this.bankroll.toFixed(2)}`);
      }
    } catch(e) { this._log('⚠️ Balance', e.message); }

    try { await this.feed.fetchCandles(); } catch(e) {}
    this._intervals.push(setInterval(() => this.feed.fetchCandles().catch(() => {}), 30000));
    this._intervals.push(setInterval(() => this._cycle(), this.cfg.scanMs));
    this._cycle();

    const phase = this.learnedData.totalObserved >= this.cfg.minObservations ? 'TRADING' : 'LEARNING';
    this._log('🚀 Started', `Phase: ${phase} | ${this.learnedData.totalObserved}/${this.cfg.minObservations} obs | dryRun:${this.cfg.dryRun}`);
  }

  stop() {
    this.running = false;
    this._intervals.forEach(i => clearInterval(i));
    this._intervals = [];
    this._saveData();
    this._log('🛑 Stopped', `${this.learnedData.totalObserved} observations saved`);
  }

  // ═══════════════════
  //  MAIN CYCLE
  // ═══════════════════

  async _cycle() {
    if (!this.running || this.paused) return;
    this._cycleCount++;

    try {
      if (this._cycleCount % 20 === 0) {
        try {
          const bal = await this.kalshi.getBalance();
          if (bal.balance != null) {
            this.bankroll = bal.balance / 100;
            this.peak = Math.max(this.peak, this.bankroll);
          }
        } catch(e) {}
      }

      const sig = this.feed.getSignals();
      const btcPrice = sig.price || 0;
      const phase = this.learnedData.totalObserved >= this.cfg.minObservations ? 'TRADE' : 'LEARN';

      if (this._cycleCount % 5 === 1) {
        this._log('💓 Cycle', `BTC:$${btcPrice.toFixed(0)} | bank:$${this.bankroll.toFixed(2)} | ${phase} | obs:${this.learnedData.totalObserved} | ${this.totalWins}W/${this.totalLosses}L | watching:${this.watchlist.size}`);
      }

      if (this._pausedUntil > Date.now()) {
        this.emit('status', this.getStatus());
        return;
      }

      await this._discoverMarkets(btcPrice);
      await this._checkResolutions();

      if (phase === 'TRADE' && this.activeOrders.size < this.cfg.maxBets) {
        await this._findTrades(sig);
      }

      this.emit('status', this.getStatus());
    } catch(e) {
      this._log('❌ Error', e.message);
    }
  }

  // ══════════════════════════════════════
  //  MARKET DISCOVERY & WATCHING
  //  Find markets. Snapshot their prices.
  //  When they expire, record the outcome.
  // ══════════════════════════════════════

  async _discoverMarkets(btcPrice) {
    const series = ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXBTC5M', 'KXETH5M', 'KXSOL5M'];

    let markets = [];
    const fetches = series.map(async (s) => {
      try {
        const r = await this.kalshi.getMarkets({ series_ticker: s, status: 'open', limit: 50 });
        return r.markets || [];
      } catch(e) { return []; }
    });
    const results = await Promise.all(fetches);
    for (const batch of results) markets.push(...batch);

    const seen = new Set();
    markets = markets.filter(m => { if (seen.has(m.ticker)) return false; seen.add(m.ticker); return true; });

    const now = Date.now();

    for (const m of markets) {
      const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time).getTime();
      const minsLeft = (exp - now) / 60000;
      if (minsLeft < 0 || minsLeft > 20) continue;

      if (!this.watchlist.has(m.ticker)) {
        this.watchlist.set(m.ticker, {
          market: m, expiry: exp, snapshots: [], logged: false, resolved: false,
        });
      }

      const watch = this.watchlist.get(m.ticker);

      // Update market data (prices change each cycle)
      watch.market = m;

      // Take snapshot
      watch.snapshots.push({
        t: now,
        minsLeft: +minsLeft.toFixed(2),
        yesAsk: m.yes_ask || null,
        noAsk: m.no_ask || null,
        btcPrice,
      });

      // Log market structure ONCE — dump all fields
      if (!watch.logged) {
        watch.logged = true;
        const important = {
          ticker: m.ticker, title: m.title, subtitle: m.subtitle,
          yes_sub_title: m.yes_sub_title, no_sub_title: m.no_sub_title,
          floor_strike: m.floor_strike, cap_strike: m.cap_strike,
          category: m.category, yes_ask: m.yes_ask, no_ask: m.no_ask,
          open_time: m.open_time, close_time: m.close_time,
          status: m.status,
        };
        // Filter nulls
        const clean = {};
        for (const [k, v] of Object.entries(important)) { if (v != null) clean[k] = v; }
        this._log('📋 New', JSON.stringify(clean).slice(0, 400));
      }

      // Log prices when in window
      if (minsLeft <= 5 && minsLeft > 0.3 && this._cycleCount % 2 === 0) {
        const fav = Math.max(m.yes_ask || 0, m.no_ask || 0);
        const favSide = (m.yes_ask || 0) > (m.no_ask || 0) ? 'Y' : 'N';
        this._log('👁️ Watch', `${m.ticker.slice(-15)} ${favSide}:${fav}¢ Y:${m.yes_ask||'?'} N:${m.no_ask||'?'} ${minsLeft.toFixed(1)}m`);
      }
    }

    // Cleanup old resolved entries
    for (const [ticker, w] of this.watchlist.entries()) {
      if (now - w.expiry > 10 * 60000 && w.resolved) {
        this.watchlist.delete(ticker);
      }
    }
  }

  // ══════════════════════════════════════
  //  RESOLUTION — THIS IS WHERE WE LEARN
  //
  //  When markets settle, record what happened
  //  at every price/time snapshot we took.
  //  Build empirical probability tables.
  // ══════════════════════════════════════

  async _checkResolutions() {
    const now = Date.now();

    for (const [ticker, w] of this.watchlist.entries()) {
      if (w.resolved) continue;
      if (now < w.expiry + 3000) continue;

      try {
        const data = await this.kalshi.getMarket(ticker);
        const m = data.market || data;
        const result = m.result;

        if (!result) {
          // Not settled yet — check if status says something
          if (m.status === 'finalized' || m.status === 'settled') {
            // settled but no result field? weird, skip
          }
          continue;
        }

        w.resolved = true;
        w.result = result;

        // Record outcome for each snapshot
        for (const snap of w.snapshots) {
          if (snap.minsLeft > 6 || snap.minsLeft < 0.2) continue;
          if (!snap.yesAsk || !snap.noAsk) continue;

          const fav = Math.max(snap.yesAsk, snap.noAsk);
          const favSide = snap.yesAsk > snap.noAsk ? 'yes' : 'no';
          const favWon = favSide === result;

          // Bucket by 5¢ increments and 1-min time bands
          const priceBucket = Math.round(fav / 5) * 5;
          const timeBucket = Math.ceil(snap.minsLeft);
          const key = `fav${priceBucket}_${timeBucket}m`;

          if (!this.learnedData.buckets[key]) {
            this.learnedData.buckets[key] = { wins: 0, losses: 0 };
          }
          this.learnedData.buckets[key][favWon ? 'wins' : 'losses']++;
        }

        this.learnedData.outcomes.push({
          ticker, result,
          title: w.market.title || '',
          snapshots: w.snapshots.length,
          resolvedAt: new Date().toISOString(),
        });
        if (this.learnedData.outcomes.length > 500) {
          this.learnedData.outcomes = this.learnedData.outcomes.slice(-500);
        }

        this.learnedData.totalObserved++;
        this._saveData();

        const lastSnap = w.snapshots[w.snapshots.length - 1];
        this._log('📚 Result', `${ticker} → ${result.toUpperCase()} | Y:${lastSnap?.yesAsk}¢ N:${lastSnap?.noAsk}¢ | obs:${this.learnedData.totalObserved}`);

        if (this.learnedData.totalObserved % 3 === 0) {
          this._logBuckets();
        }

      } catch(e) {
        if (e.message?.includes('404')) w.resolved = true;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    // Check active orders
    for (const [id, order] of this.activeOrders.entries()) {
      if (now < order.expiry + 3000) continue;

      try {
        const data = await this.kalshi.getMarket(order.ticker);
        const m = data.market || data;
        if (!m.result) continue;

        const won = m.result === order.side;
        const pnl = won
          ? (order.payout * order.contracts / 100)
          : -(order.price * order.contracts / 100);

        this.bankroll += pnl;
        if (won) {
          this.totalWins++;
          this.peak = Math.max(this.peak, this.bankroll);
          this._streak = Math.max(0, this._streak) + 1;
          this._log('🎉 WIN', `${order.side.toUpperCase()} ${order.ticker} @${order.price}¢ ×${order.contracts} +$${pnl.toFixed(2)} | bank:$${this.bankroll.toFixed(2)}`);
        } else {
          this.totalLosses++;
          this._streak = Math.min(0, this._streak) - 1;
          this._log('💀 LOSS', `${order.side.toUpperCase()} ${order.ticker} @${order.price}¢ result:${m.result.toUpperCase()} -$${Math.abs(pnl).toFixed(2)} | bank:$${this.bankroll.toFixed(2)}`);
        }

        this.bets.push({ ...order, result: m.result, won, pnl: +pnl.toFixed(2) });
        this.activeOrders.delete(id);
        this.activeTickers.delete(order.ticker);

        if (this.peak > 0 && (1 - this.bankroll / this.peak) >= 0.60) {
          this._pausedUntil = Date.now() + 30 * 60000;
          this._log('🚨 EMERGENCY', '60%+ drawdown, pausing 30min');
        }
      } catch(e) {
        if (e.message?.includes('404')) {
          this.activeOrders.delete(id);
          this.activeTickers.delete(order.ticker);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // ══════════════════════════════════════
  //  BUCKET TABLE — What we've learned
  // ══════════════════════════════════════

  _logBuckets() {
    const keys = Object.keys(this.learnedData.buckets).sort();
    const lines = [];
    for (const key of keys) {
      const b = this.learnedData.buckets[key];
      const n = b.wins + b.losses;
      if (n < 2) continue;
      lines.push(`${key}:${(b.wins/n*100).toFixed(0)}%(${n})`);
    }
    if (lines.length) this._log('📊 Data', lines.join(' | '));
  }

  // ══════════════════════════════════════
  //  TRADING — EMPIRICAL EDGE ONLY
  //
  //  Only bet when observed data shows
  //  favorite wins MORE than market implies.
  // ══════════════════════════════════════

  async _findTrades(sig) {
    const now = Date.now();

    for (const [ticker, w] of this.watchlist.entries()) {
      if (w.resolved) continue;
      if (this.activeTickers.has(ticker)) continue;
      if (this.activeOrders.size >= this.cfg.maxBets) break;

      const minsLeft = (w.expiry - now) / 60000;
      if (minsLeft < 0.3 || minsLeft > 5) continue;

      const m = w.market;
      if (!m.yes_ask || !m.no_ask) continue;

      const fav = Math.max(m.yes_ask, m.no_ask);
      const favSide = m.yes_ask > m.no_ask ? 'yes' : 'no';
      const favPrice = favSide === 'yes' ? m.yes_ask : m.no_ask;

      // Look up observed win rate
      const priceBucket = Math.round(fav / 5) * 5;
      const timeBucket = Math.ceil(minsLeft);
      const key = `fav${priceBucket}_${timeBucket}m`;

      let observedWR = null, dataSource = key, sampleSize = 0;

      const bucket = this.learnedData.buckets[key];
      if (bucket && (bucket.wins + bucket.losses) >= 3) {
        sampleSize = bucket.wins + bucket.losses;
        observedWR = bucket.wins / sampleSize;
        dataSource = `${key}(${sampleSize})`;
      } else {
        // Check neighbors
        const nearby = this._getNearbyWinRate(priceBucket, timeBucket);
        if (nearby) {
          observedWR = nearby.wr;
          sampleSize = nearby.n;
          dataSource = `~${nearby.key}(${nearby.n})`;
        }
      }

      if (observedWR === null) continue; // no data yet

      const marketImplied = favPrice / 100;
      const edge = observedWR - marketImplied;

      if (edge >= this.cfg.minEdge) {
        const payout = 100 - favPrice;
        const edgePct = edge * 100;
        let maxContracts = edgePct >= 15 ? 4 : edgePct >= 10 ? 3 : 2;
        const maxRisk = this.bankroll * 0.10;
        const contracts = Math.max(1, Math.min(maxContracts, Math.floor((maxRisk * 100) / favPrice)));
        const cost = (contracts * favPrice) / 100;
        if (cost > this.bankroll * 0.15) continue;

        this._log('🎯 BET', `${favSide.toUpperCase()} ${ticker} @${favPrice}¢ ×${contracts} ($${cost.toFixed(2)}) | obsWR:${(observedWR*100).toFixed(0)}% mkt:${favPrice}¢ edge:${(edge*100).toFixed(1)}% | ${minsLeft.toFixed(1)}m | ${dataSource}`);

        if (this.cfg.dryRun) {
          const id = 'dry-' + uuidv4().slice(0, 8);
          this.activeOrders.set(id, { ticker, side: favSide, price: favPrice, payout, contracts, cost, id, at: new Date(), expiry: w.expiry });
          this.activeTickers.add(ticker);
          this.totalBets++; this.totalWagered += cost;
          this._log('🏜️ DRY', `$${cost.toFixed(2)}`);
        } else {
          try {
            const res = await this.kalshi.placeOrder({
              ticker, action: 'buy', side: favSide, type: 'limit', count: contracts,
              ...(favSide === 'yes' ? { yes_price: favPrice } : { no_price: favPrice }),
              client_order_id: uuidv4(),
            });
            const id = res.order?.order_id || uuidv4();
            this.activeOrders.set(id, { ticker, side: favSide, price: favPrice, payout, contracts, cost, id, at: new Date(), expiry: w.expiry });
            this.activeTickers.add(ticker);
            this.totalBets++; this.totalWagered += cost;
            this._log('✅ ORDER', `${id.slice(0, 8)} $${cost.toFixed(2)} ${favSide.toUpperCase()} ${ticker}`);
          } catch(e) { this._log('❌ Failed', e.message); }
        }
      } else if (this._cycleCount % 4 === 0 && minsLeft < 3) {
        this._log('🔍 Skip', `${ticker.slice(-15)} obsWR:${observedWR?(observedWR*100).toFixed(0)+'%':'?'} mkt:${favPrice}¢ edge:${(edge*100).toFixed(1)}% ${dataSource}`);
      }
    }
  }

  _getNearbyWinRate(priceBucket, timeBucket) {
    const candidates = [];
    for (let dp = -5; dp <= 5; dp += 5) {
      for (let dt = -1; dt <= 1; dt++) {
        const p = priceBucket + dp;
        const t = timeBucket + dt;
        if (t < 1 || p < 50) continue;
        const key = `fav${p}_${t}m`;
        const b = this.learnedData.buckets[key];
        if (b && (b.wins + b.losses) >= 3) {
          candidates.push({ key, wr: b.wins / (b.wins + b.losses), n: b.wins + b.losses });
        }
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.n - a.n);
    return candidates[0];
  }

  // ═══════════════════
  //  STATUS
  // ═══════════════════

  getStatus() {
    const phase = this.learnedData.totalObserved >= this.cfg.minObservations ? 'TRADING' : 'LEARNING';
    const pnl = +(this.bankroll - (+process.env.STARTING_BANKROLL || 60)).toFixed(2);

    // Active positions as array for dashboard
    const active = [];
    for (const [id, o] of this.activeOrders) {
      active.push({ id, ticker: o.ticker, side: o.side, price: o.price, contracts: o.contracts, cost: o.cost });
    }

    // Next expiry countdown
    let nextExpiry = null;
    for (const [, w] of this.watchlist) {
      if (!w.resolved && (!nextExpiry || w.expiry < nextExpiry)) nextExpiry = w.expiry;
    }
    let countdown = null;
    if (nextExpiry) {
      const t = Math.max(0, Math.floor((nextExpiry - Date.now()) / 1000));
      countdown = { total: t, h: Math.floor(t/3600), m: Math.floor((t%3600)/60), s: t % 60 };
    }

    return {
      running: this.running, paused: this.paused, phase,
      bankroll: +this.bankroll.toFixed(2), peak: +this.peak.toFixed(2),
      pnl,
      btcPrice: this.feed.getSignals().price || 0,
      btc: { price: this.feed.getSignals().price || 0 },
      source: this.feed.candleSource || this.feed.source || '?',
      strategy: phase === 'LEARNING' ? `Learning (${this.learnedData.totalObserved}/${this.cfg.minObservations})` : `Data-Driven (${this.learnedData.totalObserved} obs)`,
      active,
      countdown,
      watching: this.watchlist.size,
      log: this.logs.slice(-30),
      recentBets: this.bets.slice(-20).map(b => ({
        ...b, ticker: b.ticker, side: b.side, won: b.won,
        pnl: b.pnl, price: b.price,
      })),
      stats: {
        bets: this.totalBets, wins: this.totalWins, losses: this.totalLosses,
        wr: this.totalBets > 0 ? Math.round(this.totalWins / this.totalBets * 100) : 0,
        wagered: +this.totalWagered.toFixed(2), streak: this._streak,
        drawdown: this.peak > 0 ? +((1 - this.bankroll / this.peak) * 100).toFixed(1) : 0,
        observations: this.learnedData.totalObserved,
        bucketCount: Object.keys(this.learnedData.buckets).length,
      },
      bucketData: this.learnedData.buckets,
    };
  }
}

module.exports = BTCScalper;
