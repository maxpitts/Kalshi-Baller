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
      scanMs: cfg.scanMs || +process.env.SCAN_INTERVAL_MS || 25000,
      priceMs: cfg.priceMs || +process.env.PRICE_POLL_MS || 15000,
      maxBetPct: cfg.maxBetPct || +process.env.MAX_BET_FRACTION || 0.10,
      minEdge: cfg.minEdge || +process.env.MIN_EDGE || 0.02,
      maxBets: cfg.maxBets || +process.env.MAX_SIMULTANEOUS_BETS || 4,
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

    // Loss streak circuit breaker
    this._streak = 0;            // negative = consecutive losses
    this._pausedUntil = 0;       // timestamp: don't bet until this time
    this._streakLimit = 4;       // pause after this many consecutive losses
    this._cooldownMs = 10 * 60000; // 10 min cooldown

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

      // Circuit breaker: pause after consecutive losses
      if (this._pausedUntil > Date.now()) {
        const secsLeft = Math.ceil((this._pausedUntil - Date.now()) / 1000);
        if (this._cycleCount % 4 === 0) this._log('🧊 Cooldown', `${secsLeft}s left after ${Math.abs(this._streak)} consecutive losses`);
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

    // Scan multiple crypto 15-min series
    const series = ['KXBTC15M', 'KXETH15M', 'KXSOL15M'];
    for (const ticker of series) {
      try {
        const r = await this.kalshi.getMarkets({ series_ticker: ticker, status: 'open', limit: 50 });
        const found = r.markets || [];
        markets.push(...found);
      } catch(e) {}
    }
    if (this._cycleCount % 5 === 1) this._log('📡 Markets', `${markets.length} across BTC/ETH/SOL`);

    // Fallback: broad search
    if (!markets.length) {
      try {
        const r = await this.kalshi.getMarkets({ status: 'open', limit: 1000 });
        const all = r.markets || [];
        markets = all.filter(m => {
          const t = (m.ticker || '').toUpperCase();
          const title = (m.title || '').toLowerCase();
          return (t.includes('15M') || title.includes('15 min')) &&
                 (t.includes('BTC') || t.includes('ETH') || t.includes('SOL') ||
                  title.includes('bitcoin') || title.includes('ethereum') || title.includes('solana'));
        });
        if (markets.length) this._log('📡 Fallback', `${markets.length} crypto 15m markets`);
      } catch(e2) { this._log('❌ Market fetch failed', e2.message); return; }
    }

    if (!markets.length) { this._log('🔍 No crypto 15m markets'); return; }

    const now = Date.now();

    // ── MAIN STRATEGY: uncertain middle, 2-25 min out ──
    const candidates = markets.filter(m => {
      if (this.activeTickers.has(m.ticker)) return false;
      const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time).getTime();
      const mins = (exp - now) / 60000;
      return mins >= 2 && mins <= 25;
    });

    // ── MICRO BETS: near-expiry sniping, 1-4 min out ──
    const microCandidates = markets.filter(m => {
      if (this.activeTickers.has(m.ticker)) return false;
      const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time).getTime();
      const mins = (exp - now) / 60000;
      return mins >= 1 && mins <= 4;
    });

    // Run micro bets first (they're time-sensitive)
    if (microCandidates.length > 0) {
      for (const m of microCandidates.slice(0, 4)) {
        try {
          const micro = await this._analyzeMicro(m, sig);
          if (micro) await this._placeMicro(micro);
          await new Promise(r => setTimeout(r, 150));
        } catch(e) {}
      }
    }

    if (!candidates.length) {
      // Log why we filtered everything
      const sample = markets[0];
      const exp = new Date(sample.close_time || sample.expiration_time || sample.expected_expiration_time);
      const mins = (exp.getTime() - now) / 60000;
      this._log('🔍 All filtered out', `${markets.length} markets, sample: ${sample.ticker} closes in ${mins.toFixed(1)}min (status:${sample.status})`);
      this._log('🔍 Sample fields', `close_time=${sample.close_time} exp=${sample.expiration_time} yes_ask=${sample.yes_ask} no_ask=${sample.no_ask}`);
      return;
    }
    this._log('🔍 Markets', `${candidates.length} BTC contracts in window`);

    const scored = [];
    for (const m of candidates.slice(0, 8)) {
      try {
        const a = await this._analyze(m, sig);
        if (a) scored.push(a);
        await new Promise(r => setTimeout(r, 200));
      } catch(e) { this._log('❌ Analyze error', `${m.ticker}: ${e.message}`); }
    }

    if (!scored.length) {
      this._log('📊 No opportunities', `Analyzed ${Math.min(candidates.length, 8)} markets, none passed`);
    }

    scored.sort((a, b) => b.edge - a.edge);
    const slots = this.cfg.maxBets - this.activeOrders.size;
    for (const opp of scored.slice(0, slots)) await this._place(opp);
  }

  async _analyze(market, sig) {
    // ══════════════════════════════════════════════════════════
    //  MISPRICING STRATEGY v2 — RESPECT THE MARKET
    //
    //  Lesson learned: when YES is 84¢ and NO is 16¢, the
    //  market KNOWS BTC is trending. That's not mispricing.
    //  Buying the 16¢ side is suicide.
    //
    //  Real edge exists ONLY in the uncertain middle (35-65¢).
    //  When the market can't decide, small mispricings appear.
    //
    //  Rules:
    //  1. ONLY trade when both sides are 30-70¢ (genuine uncertainty)
    //  2. NEVER buy anything under 30¢ (cheap for a reason)
    //  3. Buy the slightly cheaper side when spread exists
    //  4. Use BTC momentum to pick the right side, not fight it
    // ══════════════════════════════════════════════════════════

    let yesAsk = market.yes_ask || null;
    let noAsk = market.no_ask || null;

    // Fallback to orderbook
    if (!yesAsk && !noAsk) {
      try {
        const ob = await this.kalshi.getOrderbook(market.ticker);
        const book = ob.orderbook || ob;
        yesAsk = book.yes?.length ? book.yes[0][0] : null;
        noAsk = book.no?.length ? book.no[0][0] : null;
      } catch(e) { return null; }
    }
    if (!yesAsk && !noAsk) return null;

    // ── HARD FILTER: only trade in the uncertain zone ──
    // If either side is under 30¢, the market has strong conviction → skip
    if (yesAsk && yesAsk < 30) return null;
    if (noAsk && noAsk < 30) return null;
    // If either side is over 70¢, same thing
    if (yesAsk && yesAsk > 70) return null;
    if (noAsk && noAsk > 70) return null;

    // ── VIG CHECK ──
    if (yesAsk && noAsk && yesAsk + noAsk > 105) return null;

    const exp = new Date(market.close_time || market.expiration_time || market.expected_expiration_time);
    const minsLeft = (exp - Date.now()) / 60000;

    // ── DETERMINE WHICH SIDE TO BUY ──
    // Use market prices as INFORMATION, not something to fade.
    // The cheaper side in the 30-70 range is likely the one with slight edge.
    // Momentum confirms: if BTC trending up, lean YES. If down, lean NO.

    let side = null, price = null, edge = 0, reason = '';

    // Both sides available — buy the cheaper one if there's a spread
    if (yesAsk && noAsk) {
      const spread = Math.abs(yesAsk - noAsk);
      const mid = (yesAsk + noAsk) / 2;

      // Need at least 4¢ spread to have any edge after fees
      if (spread < 4) {
        return null; // too tight, no edge
      }

      // Momentum check: which way is BTC leaning?
      const momUp = (sig.momentum5m || 0) > 0.02;    // BTC trending up
      const momDown = (sig.momentum5m || 0) < -0.02;  // BTC trending down

      if (yesAsk < noAsk) {
        // YES is cheaper — market leans NO but not strongly
        if (momDown && yesAsk < 40) {
          // Momentum confirms NO side — don't buy YES against it
          return null;
        }
        side = 'yes'; price = yesAsk;
        // Edge: half the spread (conservative — we're buying the cheaper side, not predicting)
        edge = (spread / 2) / 100;
        reason = `YES cheaper: ${yesAsk}¢ vs NO ${noAsk}¢ (spread ${spread}¢)`;

        // Momentum bonus: if BTC trending UP and we're buying YES, add conviction
        if (momUp) {
          edge += 0.02;
          reason += ' +mom↑';
        }
      } else {
        // NO is cheaper — market leans YES but not strongly
        if (momUp && noAsk < 40) {
          // Momentum confirms YES side — don't buy NO against it
          return null;
        }
        side = 'no'; price = noAsk;
        edge = (spread / 2) / 100;
        reason = `NO cheaper: ${noAsk}¢ vs YES ${yesAsk}¢ (spread ${spread}¢)`;

        if (momDown) {
          edge += 0.02;
          reason += ' +mom↓';
        }
      }
    } else if (yesAsk && yesAsk >= 35 && yesAsk <= 48) {
      // Only YES available and it's in the buy zone
      side = 'yes'; price = yesAsk;
      edge = (50 - yesAsk) / 100;
      reason = `YES solo ${yesAsk}¢`;
    } else if (noAsk && noAsk >= 35 && noAsk <= 48) {
      side = 'no'; price = noAsk;
      edge = (50 - noAsk) / 100;
      reason = `NO solo ${noAsk}¢`;
    }

    if (!side || !price || edge <= 0) {
      return null;
    }

    // Fee calculation
    const fee = 0.07 * (price / 100) * (1 - price / 100);
    const netEdge = edge - fee;

    this._log('🔬 Found', `${market.ticker} ${reason} | edge:${(edge*100).toFixed(1)}% fee:${(fee*100).toFixed(1)}% net:${(netEdge*100).toFixed(1)}%`);

    // Need 2% net edge minimum
    if (netEdge < 0.02) {
      return null;
    }

    const dir = side === 'yes' ? 'UP' : 'DOWN';
    const vol = sig.volatility5m > 0.15 ? 'high' : sig.volatility5m > 0.05 ? 'medium' : 'low';

    return {
      ticker: market.ticker, title: market.title || market.ticker,
      side, price, edge: +edge.toFixed(3), fee: +fee.toFixed(3),
      modelProb: +(edge + price/100).toFixed(2),
      direction: dir, volRegime: vol,
      timeWindow: this.correction.getCurrentTimeWindow(),
      minsLeft: +minsLeft.toFixed(1), btcPrice: sig.price,
      ta: { score: sig.score||0, conf: sig.confidence||0, rsi: +(sig.rsi||0).toFixed(1), macd: sig.macdHist ? +(sig.macdHist).toFixed(2) : 0, bbPctB: +(sig.bbPctB||0).toFixed(2), vwap: +(sig.vwapDelta||0).toFixed(3), regime: sig.regime, reasons: [reason] }
    };
  }

  // ════════════════════════════════════════════════
  //  MICRO BETS — Near-Expiry Sniping
  //
  //  1-4 min from close, outcome is nearly decided.
  //  Buy the heavy favorite side for 1-2 contracts.
  //  High win rate, small profit per trade.
  //
  //  Key: ONLY buy the side momentum confirms.
  //  We're not predicting — we're reading the scoreboard
  //  late in the game and betting on the team that's winning.
  // ════════════════════════════════════════════════

  async _analyzeMicro(market, sig) {
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
    if (!yesAsk || !noAsk) return null;

    const exp = new Date(market.close_time || market.expiration_time || market.expected_expiration_time);
    const minsLeft = (exp - Date.now()) / 60000;
    if (minsLeft < 0.5 || minsLeft > 4) return null; // too close or too far

    // ── IDENTIFY THE FAVORITE ──
    // We want the side priced 70-92¢ (strong favorite but not locked in)
    // Below 70¢ = not enough conviction
    // Above 92¢ = too expensive, risk/reward terrible

    let side = null, price = null, payout = null, reason = '';

    // Momentum must CONFIRM the favorite
    const mom = sig.momentum5m || 0;
    const momUp = mom > 0.01;
    const momDown = mom < -0.01;

    if (yesAsk >= 70 && yesAsk <= 92) {
      // YES is favorite — only buy if BTC momentum is UP
      if (!momUp) return null; // no momentum confirmation
      side = 'yes'; price = yesAsk;
      payout = 100 - yesAsk; // what we win per contract
      reason = `MICRO YES@${yesAsk}¢ (payout:${payout}¢) mom↑`;
    } else if (noAsk >= 70 && noAsk <= 92) {
      // NO is favorite — only buy if BTC momentum is DOWN
      if (!momDown) return null;
      side = 'no'; price = noAsk;
      payout = 100 - noAsk;
      reason = `MICRO NO@${noAsk}¢ (payout:${payout}¢) mom↓`;
    }

    if (!side) return null;

    // ── PAYOFF CHECK ──
    // Need payout to justify the risk after fees
    const fee = 0.07 * (price / 100) * (1 - price / 100);
    const feeCents = fee * 100;
    const netPayout = payout - feeCents;

    // Need at least 5¢ net payout per contract to be worth it
    if (netPayout < 5) return null;

    // Win probability estimate: use market price as base, boost slightly for momentum confirmation
    const impliedProb = price / 100;
    const estWinRate = Math.min(0.95, impliedProb + 0.03); // 3% boost for momentum confirm

    // Expected value check: (winRate × payout) - (lossRate × cost) > 0
    const ev = (estWinRate * netPayout) - ((1 - estWinRate) * price);
    if (ev <= 0) return null;

    return {
      ticker: market.ticker, side, price, payout, netPayout: +netPayout.toFixed(1),
      fee: +feeCents.toFixed(1), ev: +ev.toFixed(1), minsLeft: +minsLeft.toFixed(1),
      reason, isMicro: true
    };
  }

  async _placeMicro(opp) {
    // Micro bets: 1-2 contracts, max $1 risk
    const maxRisk = Math.min(1.00, this.bankroll * 0.05); // 5% of bank or $1, whichever is less
    const contracts = Math.max(1, Math.min(2, Math.floor((maxRisk * 100) / opp.price)));
    const cost = (contracts * opp.price) / 100;

    if (cost > this.bankroll * 0.08) return; // hard cap 8% on micros

    this._log('🔸 MICRO', `${opp.side.toUpperCase()} ${opp.ticker} @ ${opp.price}¢ ×${contracts} ($${cost.toFixed(2)}) | payout:${opp.netPayout}¢ EV:${opp.ev}¢ | ${opp.minsLeft}min | ${opp.reason}`);

    if (this.cfg.dryRun) {
      const id = 'micro-' + uuidv4().slice(0,8);
      this.activeOrders.set(id, { ...opp, contracts, cost, id, at: new Date(), direction: opp.side === 'yes' ? 'UP' : 'DOWN', volRegime: 'micro' });
      this.activeTickers.add(opp.ticker); this.totalBets++; this.totalWagered += cost;
      this._log('🏜️ DRY MICRO', `$${cost.toFixed(2)}`); return;
    }

    try {
      const res = await this.kalshi.placeOrder({
        ticker: opp.ticker, action: 'buy', side: opp.side, type: 'limit', count: contracts,
        ...(opp.side === 'yes' ? { yes_price: opp.price } : { no_price: opp.price }),
        client_order_id: uuidv4(),
      });
      const id = res.order?.order_id || uuidv4();
      this.activeOrders.set(id, { ...opp, contracts, cost, id, at: new Date(), direction: opp.side === 'yes' ? 'UP' : 'DOWN', volRegime: 'micro' });
      this.activeTickers.add(opp.ticker); this.totalBets++; this.totalWagered += cost;
      this._log('✅ MICRO ORDER', `${id.slice(0,8)} $${cost.toFixed(2)} ${opp.side.toUpperCase()} ${opp.ticker}`);
    } catch(e) { this._log('❌ Micro order failed', e.message); }
  }

  async _place(opp) {
    // ── DRAWDOWN PROTECTION ──
    // If bankroll < 50% of peak, halve bet sizes
    const drawdown = 1 - (this.bankroll / this.peak);
    const drawdownMult = drawdown > 0.5 ? 0.25 : drawdown > 0.3 ? 0.5 : 1.0;
    if (drawdown > 0.3 && this._cycleCount % 10 === 0) {
      this._log('🛡️ Drawdown', `${(drawdown*100).toFixed(0)}% from peak $${this.peak.toFixed(2)} — sizing ${drawdownMult < 1 ? 'reduced' : 'normal'}`);
    }

    // ── KELLY CRITERION SIZING ──
    // Kelly fraction = (bp - q) / b
    // where b = payout odds, p = win prob, q = 1-p
    // For binary: b = (100 - price) / price, p = modelProb
    const b = (100 - opp.price) / opp.price; // payout ratio
    const p = opp.modelProb;
    const q = 1 - p;
    let kellyFraction = (b * p - q) / b;
    kellyFraction = Math.max(0, Math.min(0.15, kellyFraction)); // cap at 15%

    // Use half-Kelly for safety (industry standard)
    const halfKelly = kellyFraction * 0.5;

    const sizeMult = this.correction.getSizeMultiplier();
    let maxBet = this.bankroll * halfKelly * sizeMult * drawdownMult;
    maxBet = Math.max(1, Math.min(maxBet, this.bankroll * 0.15)); // hard cap 15%
    const contracts = Math.max(1, Math.floor((maxBet * 100) / opp.price));
    const cost = (contracts * opp.price) / 100;
    if (cost > this.bankroll * 0.20) return;

    this._log('🎯 BET', `${opp.side.toUpperCase()} ${opp.ticker} @ ${opp.price}¢ ×${contracts} ($${cost.toFixed(2)}) | net:${((opp.edge-opp.fee)*100).toFixed(1)}% kelly:${(halfKelly*100).toFixed(1)}% | ${opp.ta?.reasons?.[0] || ''} | ${opp.minsLeft}min`);

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
            if (this._streak <= -this._streakLimit) {
              this._pausedUntil = Date.now() + this._cooldownMs;
              this._log('🧊 CIRCUIT BREAKER', `${Math.abs(this._streak)} consecutive losses — pausing`);
            }
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

            // Circuit breaker — micro losses need 6 straight, regular needs 4
            const limit = order.volRegime === 'micro' ? 6 : this._streakLimit;
            if (this._streak <= -limit) {
              this._pausedUntil = Date.now() + this._cooldownMs;
              this._log('🧊 CIRCUIT BREAKER', `${Math.abs(this._streak)} consecutive losses — pausing ${this._cooldownMs/60000}min`);
            }
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
      stats: { bets: this.totalBets, wins: this.totalWins, losses: this.totalLosses, wr: this.totalBets > 0 ? Math.round(this.totalWins/this.totalBets*100) : 0, wagered: +this.totalWagered.toFixed(2), streak: this._streak, drawdown: this.peak > 0 ? +((1 - this.bankroll/this.peak)*100).toFixed(1) : 0, coolingDown: this._pausedUntil > Date.now(), microBets: this._microBets, microWins: this._microWins },
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
