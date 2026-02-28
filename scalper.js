const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const KalshiClient = require('./kalshi-client');
const BTCFeed = require('./btc-feed');
const CorrectionEngine = require('./correction-engine');

const CORR_FILE = './correction-state.json';

class BTCScalper extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = {
      startBankroll: cfg.startBankroll || +process.env.STARTING_BANKROLL || 100,
      target: cfg.target || +process.env.TARGET_BANKROLL || 10000,
      hours: cfg.hours || +process.env.TIME_LIMIT_HOURS || 48,
      scanMs: cfg.scanMs || +process.env.SCAN_INTERVAL_MS || 12000,
      priceMs: cfg.priceMs || +process.env.PRICE_POLL_MS || 15000,
      maxBetPct: cfg.maxBetPct || +process.env.MAX_BET_FRACTION || 0.10,
      minEdge: cfg.minEdge || +process.env.MIN_EDGE || 0.02,
      maxBets: cfg.maxBets || +process.env.MAX_SIMULTANEOUS_BETS || 8,
      dryRun: process.env.DRY_RUN === 'true',
    };

    this.kalshi = new KalshiClient();
    this.feed = new BTCFeed();
    this.correction = new CorrectionEngine();

    this.running = false; this.paused = false; this.startTime = null;
    this.bankroll = this.cfg.startBankroll; this.peak = this.cfg.startBankroll;
    this.activeOrders = new Map(); this.activeTickers = new Set(); this.processedFills = new Set();
    this.bets = []; this.log = [];
    this.totalBets = 0; this.totalWins = 0; this.totalLosses = 0; this.totalWagered = 0;
    this._intervals = []; this._cycleCount = 0;
    this._microBets = 0; this._microWins = 0;

    // Streak tracking (for stats, no longer pauses)
    this._streak = 0;
    this._pausedUntil = 0;       // only used by emergency drawdown exit

    // Restore correction state
    try { if (fs.existsSync(CORR_FILE)) this.correction.restore(fs.readFileSync(CORR_FILE, 'utf8')); } catch(e){}
    this.correction.on('update', ev => this.emit('correction', ev));
    this._log('🎰 BTC Scalper initialized', `$${this.cfg.startBankroll} → $${this.cfg.target} in ${this.cfg.hours}h`);
  }

  async start() {
    if (this.running) return;
    this.running = true; this.startTime = Date.now();
    this._log('🚀 STARTED', this.cfg.dryRun ? 'DRY RUN' : '🔴 LIVE');

    try { const b = await this.kalshi.getBalance(); this.bankroll = (b.balance||0)/100; this.peak = this.bankroll; this._log('💰 Balance', `$${this.bankroll.toFixed(2)}`); } catch(e) { this._log('⚠️ Balance failed', e.message); }

    await this.feed.fetchPrice();
    this._intervals.push(setInterval(() => this.feed.fetchPrice().catch(()=>{}), this.cfg.priceMs));
    this._intervals.push(setInterval(() => this._cycle(), this.cfg.scanMs));
    this._intervals.push(setInterval(() => { try { fs.writeFileSync(CORR_FILE, this.correction.serialize()); } catch(e){} }, 60000));
    setTimeout(() => this._cycle(), 2000);
    this.emit('started');
  }

  stop() {
    this.running = false;
    this._intervals.forEach(i => clearInterval(i)); this._intervals = [];
    try { fs.writeFileSync(CORR_FILE, this.correction.serialize()); } catch(e){}
    this._log('🛑 STOPPED'); this.emit('stopped');
  }

  async _cycle() {
    if (!this.running || this.paused) return;
    this._cycleCount++;
    try {
      const elapsed = (Date.now() - this.startTime) / 3600000;
      if (elapsed >= this.cfg.hours) { this._log('💀 TIME UP'); this.stop(); return; }
      if (this.bankroll >= this.cfg.target) { this._log('🎯 TARGET HIT', `$${this.bankroll.toFixed(2)}`); this.stop(); return; }

      // Update balance
      try { const b = await this.kalshi.getBalance(); const nb = (b.balance||0)/100;
        if (Math.abs(nb - this.bankroll) > 0.01) { this._log(nb > this.bankroll ? '📈' : '📉', `$${this.bankroll.toFixed(2)} → $${nb.toFixed(2)}`); this.bankroll = nb; if (nb > this.peak) this.peak = nb; }
      } catch(e){}

      await this._checkResolutions();
      await this._managePositions();  // TP/SL early exits
      await this._cancelStale();

      if (this.activeOrders.size >= this.cfg.maxBets) { this.emit('status', this.getStatus()); return; }

      // Emergency drawdown pause (only triggered by 60%+ drawdown)
      if (this._pausedUntil > Date.now()) {
        const secsLeft = Math.ceil((this._pausedUntil - Date.now()) / 1000);
        if (this._cycleCount % 4 === 0) this._log('🚨 Emergency pause', `${secsLeft}s left — drawdown protection`);
        this.emit('status', this.getStatus());
        return;
      }

      const sig = this.feed.getSignals();
      if (!sig.price) { this._log('⚠️ No BTC price'); return; }

      // Heartbeat
      const src = this.feed.candleSource || this.feed.source || '?';
      const dd = this.peak > 0 ? ((1 - this.bankroll/this.peak)*100).toFixed(0) : '0';
      const streakStr = this._streak > 0 ? `W${this._streak}` : this._streak < 0 ? `L${Math.abs(this._streak)}` : '-';
      this._log('💓 Cycle', `$${sig.price?.toLocaleString()} | bank:$${this.bankroll.toFixed(2)} dd:${dd}% | ${streakStr} | ${this.totalWins}W/${this.totalLosses}L | [${src}]`);

      await this._findAndBet(sig);
      this.emit('status', this.getStatus());
    } catch(e) { this._log('❌ Error', e.message); }
  }


  async _findAndBet(sig) {
    let markets = [];

    // ── BROAD MARKET DISCOVERY ──
    // Scan every short-term crypto series we can find
    // Not just 15M — also 5M, 1H if they exist
    const series = [
      // 15-minute markets
      'KXBTC15M', 'KXETH15M', 'KXSOL15M',
      // 5-minute markets (if available)
      'KXBTC5M', 'KXETH5M', 'KXSOL5M',
      // Other potential series
      'KXDOGE15M', 'KXADA15M', 'KXAVAX15M', 'KXLINK15M', 'KXMATIC15M',
      'KXDOGE5M', 'KXBNB15M', 'KXXRP15M',
    ];

    // Batch fetch — skip unknown series silently
    const fetches = series.map(async (ticker) => {
      try {
        const r = await this.kalshi.getMarkets({ series_ticker: ticker, status: 'open', limit: 50 });
        return r.markets || [];
      } catch(e) { return []; }
    });
    const results = await Promise.all(fetches);
    for (const batch of results) markets.push(...batch);

    // Also do a broad sweep to discover markets we might not know about
    if (this._cycleCount % 10 === 1) {
      try {
        const r = await this.kalshi.getMarkets({ status: 'open', limit: 1000 });
        const all = r.markets || [];
        const crypto = all.filter(m => {
          const t = (m.ticker || '').toUpperCase();
          const title = (m.title || '').toLowerCase();
          return (t.includes('5M') || t.includes('15M') || t.includes('10M') ||
                  title.includes('5 min') || title.includes('10 min') || title.includes('15 min')) &&
                 (title.includes('bitcoin') || title.includes('ethereum') || title.includes('solana') ||
                  title.includes('crypto') || title.includes('doge') || title.includes('xrp') ||
                  t.includes('BTC') || t.includes('ETH') || t.includes('SOL'));
        });
        // Add any we didn't already have
        const existing = new Set(markets.map(m => m.ticker));
        for (const m of crypto) {
          if (!existing.has(m.ticker)) markets.push(m);
        }
        if (crypto.length > markets.length - crypto.length) {
          this._log('🔍 Discovery', `Found ${crypto.length} extra markets from broad scan`);
        }
      } catch(e) {}
    }

    // Deduplicate
    const seen = new Set();
    markets = markets.filter(m => {
      if (seen.has(m.ticker)) return false;
      seen.add(m.ticker); return true;
    });

    if (this._cycleCount % 5 === 1) this._log('📡 Markets', `${markets.length} total`);

    if (!markets.length) { this._log('🔍 No markets'); return; }

    const now = Date.now();

    // ── DIAGNOSTIC ──
    if (this._cycleCount % 4 === 0 && markets.length > 0) {
      const inWindow = markets.filter(m => {
        const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time).getTime();
        const mins = (exp - now) / 60000;
        return mins >= 0.3 && mins <= 5;
      });
      if (inWindow.length > 0) {
        const samples = inWindow.slice(0, 4).map(m => {
          const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time);
          const mins = ((exp.getTime() - now) / 60000).toFixed(1);
          return `${m.ticker} Y:${m.yes_ask||'?'}¢ N:${m.no_ask||'?'}¢ ${mins}m`;
        });
        this._log('🔎 DIAG', samples.join(' | '));
      }
    }

    // ── FILTER: 0.3-5 min window ──
    // Allow RE-ENTRY: don't filter by activeTickers anymore.
    // Instead, track by ticker+tier to allow multiple entries at different tiers.
    const candidates = markets.filter(m => {
      const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time).getTime();
      const mins = (exp - now) / 60000;
      return mins >= 0.3 && mins <= 5;
    });

    if (!candidates.length) return;

    // Analyze ALL candidates (they're already filtered to 0.3-5 min)
    const scored = [];
    for (const m of candidates.slice(0, 15)) {
      try {
        const a = await this._analyze(m, sig);
        if (a) scored.push(a);
        await new Promise(r => setTimeout(r, 100)); // faster between calls
      } catch(e) {}
    }

    if (!scored.length && this._cycleCount % 4 === 0) {
      this._log('📊 No opps', `Scanned ${Math.min(candidates.length, 15)} markets in window`);
    }

    // Sort by EV, take best opportunities
    scored.sort((a, b) => b.ev - a.ev);
    const slots = this.cfg.maxBets - this.activeOrders.size;
    for (const opp of scored.slice(0, slots)) await this._place(opp);
  }

  // ════════════════════════════════════════════════════════════
  //  UNIFIED SCALP ANALYZER — Full 15-Minute Window
  //
  //  REALITY: These markets are almost never 50/50. BTC is
  //  usually clearly above or below the strike.
  //
  //  STRATEGY: Buy the favorite across every time horizon.
  //  Early entries get TP'd by position manager as price rises.
  //  Late entries ride to settlement.
  //
  //  The SAME market gets multiple bites:
  //  → 12 min left: buy NO@65¢ → TP at 78¢ (+13¢)
  //  → 5 min left: buy NO@82¢ → TP at 90¢ (+8¢)
  //  → 1 min left: buy NO@93¢ → settles at 100 (+7¢)
  // ════════════════════════════════════════════════════════════

  async _analyze(market, sig) {
    let yesAsk = market.yes_ask || null;
    let noAsk = market.no_ask || null;

    if (!yesAsk && !noAsk) {
      try {
        const ob = await this.kalshi.getOrderbook(market.ticker);
        const book = ob.orderbook || ob;
        yesAsk = book.yes?.length ? book.yes[0][0] : null;
        noAsk = book.no?.length ? book.no[0][0] : null;
      } catch(e) { return null; }
    }
    if (!yesAsk && !noAsk) return null;

    const exp = new Date(market.close_time || market.expiration_time || market.expected_expiration_time);
    const minsLeft = (exp - Date.now()) / 60000;
    if (minsLeft < 0.3 || minsLeft > 15) return null;

    // ── VIG CHECK ──
    if (yesAsk && noAsk && yesAsk + noAsk > 105) return null;

    // ── FIND THE FAVORITE ──
    let favSide, favPrice, favPayout;
    if ((yesAsk || 0) > (noAsk || 0)) {
      favSide = 'yes'; favPrice = yesAsk; favPayout = 100 - yesAsk;
    } else {
      favSide = 'no'; favPrice = noAsk; favPayout = 100 - noAsk;
    }

    // ── TIME-BASED TIERS ──
    // LESSON LEARNED: 55-75¢ is NOT a favorite. It's a coin flip
    // with a label. Entry at 72¢ went to 1¢. The market flips
    // constantly in the first 10 minutes.
    //
    // ONLY trade when:
    // 1. Price is HIGH (85¢+) = real conviction, not noise
    // 2. Time is SHORT (<5 min) = less time for reversal
    //
    // Tier   | Time Left  | Buy Range | Logic
    // -------|------------|-----------|------
    // LATE   | 3-5 min    | 85-92¢    | Strong conviction confirmed
    // SNIPE  | 1-3 min    | 88-95¢    | Nearly decided
    // LOCK   | 0.3-1 min  | 91-97¢    | All but certain

    let minPrice, maxPrice, tier;
    if (minsLeft > 5) {
      return null; // too early — "favorites" flip constantly
    } else if (minsLeft > 3) {
      minPrice = 85; maxPrice = 92; tier = 'LATE';
    } else if (minsLeft > 1) {
      minPrice = 88; maxPrice = 95; tier = 'SNIPE';
    } else {
      minPrice = 91; maxPrice = 97; tier = 'LOCK';
    }

    if (favPrice < minPrice || favPrice > maxPrice) return null;

    // ── DEDUP: don't stack same ticker+tier ──
    // Allow re-entry at a DIFFERENT tier (e.g., LATE then SNIPE then LOCK)
    // But don't buy the same ticker at the same tier twice
    const tierKey = `${market.ticker}:${tier}`;
    for (const [, order] of this.activeOrders) {
      if (order.ticker === market.ticker && order.tier === tier) return null;
    }
    // Also limit to max 2 active positions on same ticker
    let sameTickerCount = 0;
    for (const [, order] of this.activeOrders) {
      if (order.ticker === market.ticker) sameTickerCount++;
    }
    if (sameTickerCount >= 2) return null;

    // ── TRUE PROBABILITY MODEL ──
    // Market price is a good estimate, but close to expiry it
    // underestimates certainty. For early entries, the edge is
    // momentum continuation → position manager captures via TP.

    let timeBonus;
    if (minsLeft < 1)      timeBonus = 0.05;
    else if (minsLeft < 3) timeBonus = 0.04;
    else                   timeBonus = 0.03;

    const trueProb = Math.min(0.98, favPrice / 100 + timeBonus);

    // ── FEE + EV ──
    const fee = 0.07 * (favPrice / 100) * (1 - favPrice / 100);
    const feeCents = fee * 100;
    const netPayout = favPayout - feeCents;
    if (netPayout < 2) return null;

    const ev = (trueProb * netPayout) - ((1 - trueProb) * favPrice);
    if (ev <= 0) return null;

    const edge = timeBonus + (netPayout > 10 ? 0.01 : 0);

    const reason = `${tier} ${favSide.toUpperCase()}@${favPrice}¢ ${minsLeft.toFixed(1)}min pay:${favPayout}¢ trueP:${(trueProb*100).toFixed(0)}% EV:${ev.toFixed(1)}¢`;
    this._log('🔬 Found', `${market.ticker} ${reason}`);

    // All trades are micro-sized (1-2 contracts) — high frequency, small risk
    const isMicro = true;

    return {
      ticker: market.ticker, title: market.title || market.ticker,
      side: favSide, price: favPrice, edge: +Math.max(edge, 0.02).toFixed(3),
      fee: +fee.toFixed(3), ev: +ev.toFixed(1),
      modelProb: +trueProb.toFixed(3),
      direction: favSide === 'yes' ? 'UP' : 'DOWN',
      volRegime: isMicro ? 'micro' : 'scalp',
      timeWindow: this.correction.getCurrentTimeWindow(),
      minsLeft: +minsLeft.toFixed(1), btcPrice: sig.price, tier,
      payout: favPayout, netPayout: +netPayout.toFixed(1),
      isMicro,
      ta: { score: 0, conf: 0, rsi: 0, macd: 0, bbPctB: 0, vwap: 0, regime: tier, reasons: [reason] }
    };
  }

  async _place(opp) {
    // ── DRAWDOWN PROTECTION ──
    const drawdown = 1 - (this.bankroll / this.peak);
    const drawdownMult = drawdown > 0.5 ? 0.25 : drawdown > 0.3 ? 0.5 : 1.0;
    if (drawdown > 0.3 && this._cycleCount % 10 === 0) {
      this._log('🛡️ Drawdown', `${(drawdown*100).toFixed(0)}% from peak — sizing ${drawdownMult < 1 ? 'reduced' : 'normal'}`);
    }

    let contracts, cost;
    const tierLabel = opp.tier || (opp.isMicro ? 'MICRO' : 'SCALP');

    if (opp.isMicro || opp.volRegime === 'micro') {
      // ── MICRO SIZING: 1-2 contracts, max $1 or 5% of bank ──
      const maxRisk = Math.min(1.00, this.bankroll * 0.05) * drawdownMult;
      contracts = Math.max(1, Math.min(2, Math.floor((maxRisk * 100) / opp.price)));
      cost = (contracts * opp.price) / 100;
      if (cost > this.bankroll * 0.08) return;
    } else {
      // ── SCALP SIZING: Kelly for early entries with more room ──
      const b = (100 - opp.price) / opp.price;
      const p = opp.modelProb || 0.55;
      const q = 1 - p;
      let kellyFraction = (b * p - q) / b;
      kellyFraction = Math.max(0, Math.min(0.15, kellyFraction));
      const halfKelly = kellyFraction * 0.5;

      const sizeMult = this.correction.getSizeMultiplier();
      let maxBet = this.bankroll * halfKelly * sizeMult * drawdownMult;
      maxBet = Math.max(1, Math.min(maxBet, this.bankroll * 0.12));
      contracts = Math.max(1, Math.floor((maxBet * 100) / opp.price));
      cost = (contracts * opp.price) / 100;
      if (cost > this.bankroll * 0.15) return;
    }

    this._log('🎯 BET', `[${tierLabel}] ${opp.side.toUpperCase()} ${opp.ticker} @ ${opp.price}¢ ×${contracts} ($${cost.toFixed(2)}) | EV:${opp.ev||'?'}¢ | ${opp.minsLeft}min`);

    if (this.cfg.dryRun) {
      const id = 'dry-' + uuidv4().slice(0,8);
      this.activeOrders.set(id, { ...opp, contracts, cost, id, at: new Date() });
      this.activeTickers.add(opp.ticker); this.totalBets++; this.totalWagered += cost;
      this._log('🏜️ DRY RUN', `$${cost.toFixed(2)}`); return;
    }

    try {
      const res = await this.kalshi.placeOrder({
        ticker: opp.ticker, action: 'buy', side: opp.side, type: 'limit', count: contracts,
        ...(opp.side === 'yes' ? { yes_price: opp.price } : { no_price: opp.price }),
        client_order_id: uuidv4(),
      });
      const id = res.order?.order_id || uuidv4();
      this.activeOrders.set(id, { ...opp, contracts, cost, id, at: new Date() });
      this.activeTickers.add(opp.ticker); this.totalBets++; this.totalWagered += cost;
      this._log('✅ ORDER', `${id.slice(0,8)} $${cost.toFixed(2)} ${opp.side.toUpperCase()} ${opp.ticker}`);
    } catch(e) { this._log('❌ Order failed', e.message); }
  }

  // ════════════════════════════════════════════════
  //  POSITION MANAGEMENT — TP / SL / TIME EXIT
  //
  //  Core logic: our edge is mean reversion to ~50¢.
  //  Once the market corrects, holding is a coin flip.
  //  Lock in profits early. Cut losers before expiry.
  // ════════════════════════════════════════════════

  async _managePositions() {
    if (this.activeOrders.size === 0) return;

    // ── EMERGENCY DRAWDOWN EXIT ──
    // If bankroll drops 60%+ from peak, close EVERYTHING
    const drawdown = this.peak > 0 ? 1 - (this.bankroll / this.peak) : 0;
    const emergencyExit = drawdown >= 0.60;
    if (emergencyExit) {
      this._log('🚨 EMERGENCY EXIT', `Drawdown ${(drawdown*100).toFixed(0)}% — closing all positions`);
    }

    // Tighter SL when in significant drawdown
    const slThreshold = drawdown > 0.40 ? -6 : drawdown > 0.25 ? -8 : -10;

    for (const [id, order] of this.activeOrders.entries()) {
      // Skip dry run orders — can't sell them
      if (id.startsWith('dry-')) continue;
      // Skip micro bets for normal TP/SL — they ride to expiry
      // (but emergency drawdown exit below still applies)
      const isMicro = id.startsWith('micro-') || order.volRegime === 'micro';
      if (isMicro && !emergencyExit) continue;

      try {
        // Get current orderbook for this market
        const ob = await this.kalshi.getOrderbook(order.ticker);
        const book = ob.orderbook || ob;

        // Current bid = what we could sell at right now
        // If we own YES, the YES bid is our exit price
        // If we own NO, the NO bid is our exit price
        let currentBid = null;
        if (order.side === 'yes' && book.yes?.length) {
          // YES bids are sorted by price desc
          currentBid = book.yes[book.yes.length - 1]?.[0] || book.yes[0]?.[0];
          // Actually on Kalshi, to sell YES we look at YES bid side
          // The orderbook format varies — try to get the best bid
          currentBid = book.yes[0]?.[0]; // highest bid
        } else if (order.side === 'no' && book.no?.length) {
          currentBid = book.no[0]?.[0];
        }

        if (!currentBid) continue; // no liquidity to exit

        const entry = order.price;
        const pnlPerContract = currentBid - entry; // positive = profit
        const pnlPct = (pnlPerContract / entry) * 100;
        const totalPnl = (pnlPerContract * order.contracts) / 100;

        // Time until expiry
        const exp = new Date(order.minsLeft ? Date.now() + order.minsLeft * 60000 : 0);
        const minsRemaining = order.minsLeft != null
          ? order.minsLeft - ((Date.now() - new Date(order.at).getTime()) / 60000)
          : 99;

        let exitReason = null;

        // ── EMERGENCY: close everything at 60%+ drawdown ──
        if (emergencyExit) {
          exitReason = `🚨 EMERGENCY DD ${(drawdown*100).toFixed(0)}% — closing`;
        }

        // ── TAKE PROFIT ──
        // If bid is 6+¢ above entry, we've captured most of the edge → lock it in
        if (!exitReason && pnlPerContract >= 6) {
          exitReason = `TP +${pnlPerContract}¢/ct ($${totalPnl.toFixed(2)})`;
        }

        // ── STOP LOSS (tighter when in drawdown) ──
        // Normal: -10¢, 25%+ DD: -8¢, 40%+ DD: -6¢
        if (!exitReason && pnlPerContract <= slThreshold) {
          exitReason = `SL ${pnlPerContract}¢/ct ($${totalPnl.toFixed(2)}) [limit:${slThreshold}¢]`;
        }

        // ── TIME-BASED EXIT ──
        // If <2 min left AND we're in any profit → sell to lock it in
        // (holding through last 2 min is pure coin flip territory)
        if (!exitReason && minsRemaining < 2 && pnlPerContract >= 2) {
          exitReason = `TIME TP +${pnlPerContract}¢ <2min left`;
        }

        // ── MEAN REVERSION COMPLETE ──
        // If we bought at 42¢ and bid is now 49-51¢, fair value reached → exit
        if (!exitReason && pnlPerContract >= 3 && currentBid >= 47 && currentBid <= 53) {
          exitReason = `FAIR VALUE reached (bid:${currentBid}¢)`;
        }

        if (!exitReason) continue;

        // ── EXECUTE SELL ──
        this._log('💰 EXIT', `${order.side.toUpperCase()} ${order.ticker} | ${exitReason} | entry:${entry}¢ now:${currentBid}¢`);

        try {
          await this.kalshi.placeOrder({
            ticker: order.ticker, action: 'sell', side: order.side, type: 'limit',
            count: order.contracts,
            ...(order.side === 'yes' ? { yes_price: currentBid } : { no_price: currentBid }),
            client_order_id: uuidv4(),
          });

          const won = pnlPerContract > 0;
          if (won) {
            this.totalWins++;
            this.bankroll += totalPnl;
            this.peak = Math.max(this.peak, this.bankroll);
            this._streak = Math.max(0, this._streak) + 1;
            this._log('🎉 EARLY WIN', `${order.ticker} +$${totalPnl.toFixed(2)} | bank:$${this.bankroll.toFixed(2)}`);
          } else {
            this.totalLosses++;
            this.bankroll += totalPnl;
            this._streak = Math.min(0, this._streak) - 1;
            this._log('🛑 EARLY CUT', `${order.ticker} -$${Math.abs(totalPnl).toFixed(2)} | bank:$${this.bankroll.toFixed(2)}`);
          }

          this.bets.push({ ...order, result: won ? 'early_tp' : 'early_sl', won, pnl: +totalPnl.toFixed(2), exitPrice: currentBid, resolvedAt: new Date().toISOString() });
          this.activeOrders.delete(id);
          this.activeTickers.delete(order.ticker);
        } catch(sellErr) {
          this._log('⚠️ Sell failed', `${order.ticker}: ${sellErr.message}`);
        }

        await new Promise(r => setTimeout(r, 200)); // rate limit
      } catch(e) {
        // Orderbook fetch failed — skip this position, check next cycle
      }
    }

    // After emergency exit, pause for 30 min to prevent re-entering
    if (emergencyExit && this.activeOrders.size === 0) {
      this._pausedUntil = Date.now() + (30 * 60000);
      this._log('🚨 EMERGENCY PAUSE', `All positions closed. Pausing 30min to protect remaining bankroll $${this.bankroll.toFixed(2)}`);
    }
  }

  async _checkResolutions() {
    for (const [id, order] of this.activeOrders.entries()) {
      try {
        const r = await this.kalshi.getMarket(order.ticker);
        const m = r.market || r;

        // Kalshi lifecycle: active → closed → determined → settled
        const isResolved = m.status === 'settled' || m.status === 'determined' || m.status === 'closed';
        const result = m.result; // 'yes' or 'no' or null

        if (isResolved && result) {
          const won = result === order.side;
          const pnl = won ? ((100 - order.price) * order.contracts / 100) : -(order.price * order.contracts / 100);

          this.correction.recordOutcome({ ticker: order.ticker, side: order.side, buyPrice: order.price, contracts: order.contracts, won, pnl, direction: order.direction, volRegime: order.volRegime });

          if (won) {
            this.totalWins++;
            this.bankroll += pnl;
            this.peak = Math.max(this.peak, this.bankroll);
            this._streak = Math.max(0, this._streak) + 1;
            if (order.volRegime === 'micro') { this._microBets++; this._microWins++; }
            this._log('🎉 WIN', `${order.ticker} → ${result} (we had ${order.side}) | +$${pnl.toFixed(2)} | bank:$${this.bankroll.toFixed(2)} | streak:+${this._streak}${order.volRegime==='micro'?' [MICRO]':''}`);
          } else {
            this.totalLosses++;
            this.bankroll += pnl;
            this._streak = Math.min(0, this._streak) - 1;
            if (order.volRegime === 'micro') this._microBets++;
            this._log('💀 LOSS', `${order.ticker} → ${result} (we had ${order.side}) | -$${Math.abs(pnl).toFixed(2)} | bank:$${this.bankroll.toFixed(2)} | streak:${this._streak}${order.volRegime==='micro'?' [MICRO]':''}`);
          }

          this.bets.push({ ...order, result, won, pnl: +pnl.toFixed(2), resolvedAt: new Date().toISOString() });
          this.activeOrders.delete(id); this.activeTickers.delete(order.ticker);
        } else if (isResolved && !result) {
          // Market closed/determined but no result yet — check again next cycle
          this._log('⏳ Awaiting result', `${order.ticker} status=${m.status} result=${result}`);
        }
      } catch(e) {
        // 404 = market gone, remove
        if (e.message?.includes('404') || e.message?.includes('not found')) {
          this._log('⚠️ Market gone', `${order.ticker} — removing from tracking`);
          this.activeOrders.delete(id); this.activeTickers.delete(order.ticker);
        } else {
          this._log('⚠️ Resolution check error', `${order.ticker}: ${e.message}`);
        }
      }
    }

    // Also check via settlements/fills for any we might have missed
    if (this.activeOrders.size > 0) {
      try {
        const fills = await this.kalshi.getFills({ limit: 50 });
        const fillList = fills.fills || [];
        for (const [id, order] of this.activeOrders.entries()) {
          const settled = fillList.find(f => f.ticker === order.ticker && f.type === 'settlement');
          if (settled) {
            const won = settled.side === order.side && settled.is_taker !== undefined; // settlement fills
            this._log('📋 Found settlement fill', `${order.ticker} via fills API`);
          }
        }
      } catch(e) { /* fills check is supplementary */ }
    }
  }

  async _cancelStale() {
    const now = Date.now();
    for (const [id, o] of this.activeOrders.entries()) {
      if ((now - new Date(o.at).getTime()) / 1000 > 300 && !id.startsWith('dry-')) {
        try { await this.kalshi.cancelOrder(id); } catch(e){}
        this.activeOrders.delete(id); this.activeTickers.delete(o.ticker);
        this._log('🗑️ Stale cancelled', id.slice(0,8));
      }
    }
  }

  getStatus() {
    const elapsed = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
    const rem = Math.max(0, this.cfg.hours * 3600 - elapsed);
    return {
      running: this.running, paused: this.paused, dryRun: this.cfg.dryRun,
      bankroll: +this.bankroll.toFixed(2), start: this.cfg.startBankroll, target: this.cfg.target, peak: +this.peak.toFixed(2),
      pnl: +(this.bankroll - this.cfg.startBankroll).toFixed(2),
      pnlPct: +((this.bankroll / this.cfg.startBankroll - 1) * 100).toFixed(1),
      progress: +Math.min(100, ((this.bankroll - this.cfg.startBankroll) / (this.cfg.target - this.cfg.startBankroll) * 100)).toFixed(1),
      countdown: { h: Math.floor(rem/3600), m: Math.floor((rem%3600)/60), s: Math.floor(rem%60), total: Math.floor(rem) },
      stats: { bets: this.totalBets, wins: this.totalWins, losses: this.totalLosses, wr: this.totalBets > 0 ? Math.round(this.totalWins/this.totalBets*100) : 0, wagered: +this.totalWagered.toFixed(2), streak: this._streak, drawdown: this.peak > 0 ? +((1 - this.bankroll/this.peak)*100).toFixed(1) : 0, emergencyPause: this._pausedUntil > Date.now(), microBets: this._microBets, microWins: this._microWins },
      active: Array.from(this.activeOrders.values()).map(o => ({ ticker: o.ticker, side: o.side, price: o.price, contracts: o.contracts, dir: o.direction, mins: o.minsLeft })),
      btc: this.feed.getStatus(),
      correction: this.correction.getStatus(),
      recentBets: this.bets.slice(-20).reverse(),
      log: this.log.slice(-40).reverse(),
    };
  }

  _log(ev, detail = '') {
    const entry = { t: new Date().toISOString(), ev, d: detail };
    this.log.push(entry); if (this.log.length > 100) this.log.shift();
    console.log(`[SCALP] ${ev} ${detail}`);
    this.emit('log', entry);
  }
}

module.exports = BTCScalper;
