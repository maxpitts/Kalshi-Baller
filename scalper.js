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
      maxBets: cfg.maxBets || +process.env.MAX_SIMULTANEOUS_BETS || 12,
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

    // ── ALWAYS LOG: show where markets are relative to our window ──
    const marketInfo = markets.map(m => {
      const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time).getTime();
      const mins = (exp - now) / 60000;
      return { ticker: m.ticker, mins, yesAsk: m.yes_ask, noAsk: m.no_ask };
    });
    // Log every cycle so we can see the countdown
    const summary = marketInfo.slice(0, 4).map(m =>
      `${m.ticker.replace('KXBTC15M-','B').replace('KXETH15M-','E').replace('KXSOL15M-','S').slice(0,12)} ${m.mins.toFixed(1)}m Y:${m.yesAsk||'?'} N:${m.noAsk||'?'}`
    ).join(' | ');
    this._log('📊 Scan', summary);

    // ── FILTER: 0.3-5 min window ──
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

    if (!scored.length) {
      // Log WHY nothing qualified
      const c = candidates[0];
      const exp = new Date(c.close_time || c.expiration_time || c.expected_expiration_time);
      const mins = ((exp.getTime() - now) / 60000).toFixed(1);
      const ya = c.yes_ask || '?', na = c.no_ask || '?';
      const fav = Math.max(ya||0, na||0);
      this._log('📊 No opps', `${candidates.length} in window | sample: ${c.ticker} Y:${ya}¢ N:${na}¢ ${mins}m fav:${fav}¢`);
    }

    // Sort by EV, take best opportunities
    scored.sort((a, b) => b.ev - a.ev);
    const slots = this.cfg.maxBets - this.activeOrders.size;
    for (const opp of scored.slice(0, slots)) await this._place(opp);
  }

  // ════════════════════════════════════════════════════════════
  //  QUANTITATIVE MODEL — Data-Driven Probability
  //
  //  OLD APPROACH: "market says 92¢, add 3% time bonus" = MADE UP
  //  NEW APPROACH: calculate actual flip probability from:
  //    1. Current BTC price vs strike price
  //    2. Time remaining
  //    3. Recent BTC volatility (how much it moves per minute)
  //    4. TA signals (momentum, trend strength)
  //
  //  If our calculated probability significantly exceeds market
  //  price → real edge. If not → no trade.
  // ════════════════════════════════════════════════════════════

  _extractStrike(market) {
    // Try multiple ways to get the strike price from market data
    // Kalshi encodes strike info in various fields

    // Method 1: floor_strike / cap_strike (ranged markets)
    if (market.floor_strike) return +market.floor_strike;
    if (market.cap_strike) return +market.cap_strike;

    // Method 2: Parse from title - "Bitcoin above $64,000?" or "above 64000"
    const title = (market.title || market.subtitle || '').toLowerCase();
    const priceMatch = title.match(/\$?([\d,]+\.?\d*)/);
    if (priceMatch) {
      const val = +priceMatch[1].replace(/,/g, '');
      if (val > 1000) return val; // looks like a BTC price
    }

    // Method 3: Parse from yes/no sub titles
    const yesSub = (market.yes_sub_title || '').toLowerCase();
    const noSub = (market.no_sub_title || '').toLowerCase();
    const subMatch = (yesSub + ' ' + noSub).match(/\$?([\d,]+\.?\d*)/);
    if (subMatch) {
      const val = +subMatch[1].replace(/,/g, '');
      if (val > 1000) return val;
    }

    return null;
  }

  _calcFlipProbability(currentPrice, strikePrice, minsLeft, volatilityPct) {
    // Calculate probability that BTC crosses the strike in remaining time
    // Using simplified Black-Scholes-like model for binary options
    //
    // Key insight: BTC needs to move X% to flip. If recent vol says it
    // moves Y% per minute, we can estimate the probability.
    //
    // distance = |currentPrice - strike| / currentPrice (as %)
    // volPerMin = volatility5m / sqrt(5) (scale from 5-min to 1-min)
    // volRemaining = volPerMin * sqrt(minsLeft) (scale to remaining time)
    // zScore = distance / volRemaining
    // flipProb = normalCDF(-zScore) (probability of crossing)

    if (!currentPrice || !strikePrice || !minsLeft) return 0.5;

    const distance = Math.abs(currentPrice - strikePrice) / currentPrice;

    // Volatility scaling: if we have 5-min vol, scale to per-minute
    const vol5m = volatilityPct / 100 || 0.001; // default tiny vol if missing
    const volPerMin = vol5m / Math.sqrt(5);
    const volRemaining = volPerMin * Math.sqrt(Math.max(0.1, minsLeft));

    if (volRemaining < 0.00001) return currentPrice > strikePrice ? 0.99 : 0.01;

    const zScore = distance / volRemaining;

    // Approximate normal CDF using logistic function
    // P(flip) ≈ 1 / (1 + exp(1.7 * z))
    const flipProb = 1 / (1 + Math.exp(1.7 * zScore));

    // If BTC is above strike: YES prob = 1 - flipProb, NO prob = flipProb
    // If BTC is below strike: YES prob = flipProb, NO prob = 1 - flipProb
    const yesProb = currentPrice >= strikePrice ? (1 - flipProb) : flipProb;

    return yesProb;
  }

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

    if (yesAsk && noAsk && yesAsk + noAsk > 105) return null;

    // ── DUMP MARKET FIELDS (first 5 cycles only, for discovery) ──
    if (this._cycleCount <= 5 && this._cycleCount % 2 === 1) {
      const fields = Object.keys(market).filter(k => market[k] != null && market[k] !== '').slice(0, 20);
      this._log('🔬 FIELDS', `${market.ticker}: ${fields.join(', ')}`);
      if (market.title) this._log('🔬 TITLE', market.title);
      if (market.subtitle) this._log('🔬 SUBTITLE', market.subtitle);
      if (market.yes_sub_title) this._log('🔬 YES_SUB', market.yes_sub_title);
      if (market.no_sub_title) this._log('🔬 NO_SUB', market.no_sub_title);
      if (market.floor_strike) this._log('🔬 STRIKE', `floor:${market.floor_strike} cap:${market.cap_strike}`);
    }

    // ── GET STRIKE PRICE ──
    const strike = this._extractStrike(market);
    const btcPrice = sig.price;
    const vol5m = sig.volatility5m || 0;

    // ── QUANT MODEL: calculate true probability ──
    let yesProb, noProb, modelSource;

    if (strike && btcPrice && btcPrice > 1000) {
      // We have both prices → use quantitative model
      yesProb = this._calcFlipProbability(btcPrice, strike, minsLeft, vol5m);
      noProb = 1 - yesProb;
      modelSource = 'QUANT';

      const distPct = ((btcPrice - strike) / strike * 100).toFixed(3);
      if (this._cycleCount % 3 === 0) {
        this._log('📐 Model', `${market.ticker} BTC:$${btcPrice.toFixed(0)} strike:$${strike.toFixed(0)} dist:${distPct}% vol:${vol5m.toFixed(3)}% ${minsLeft.toFixed(1)}m → yesP:${(yesProb*100).toFixed(1)}%`);
      }
    } else {
      // No strike data → use TA-enhanced estimate
      // Base: use market midpoint as starting estimate
      const mid = ((yesAsk||50) + (100-(noAsk||50))) / 2;
      yesProb = mid / 100;

      // TA adjustments — use actual chart signals
      const mom = sig.momentum5m || 0;
      const rsi = sig.rsi || 50;
      const trend = sig.trend || 'FLAT';
      const strength = sig.strength || 0;

      // Momentum: strong BTC movement shifts probability
      if (mom > 0.05)       yesProb += 0.05;
      else if (mom > 0.02)  yesProb += 0.03;
      else if (mom < -0.05) yesProb -= 0.05;
      else if (mom < -0.02) yesProb -= 0.03;

      // RSI extremes: overbought/oversold affect near-term probability
      if (rsi > 75)      yesProb += 0.02; // overbought, but momentum usually continues short-term
      else if (rsi < 25) yesProb -= 0.02;

      // Trend strength: strong trends are more likely to continue
      if (trend === 'STRONG_UP')   yesProb += 0.03;
      else if (trend === 'UP')     yesProb += 0.01;
      else if (trend === 'STRONG_DOWN') yesProb -= 0.03;
      else if (trend === 'DOWN')   yesProb -= 0.01;

      // Time decay: closer to expiry, current state is more likely to persist
      if (minsLeft < 2) {
        // Amplify the deviation from 50% — trends are stickier near expiry
        yesProb = 0.5 + (yesProb - 0.5) * 1.3;
      }

      yesProb = Math.max(0.02, Math.min(0.98, yesProb));
      noProb = 1 - yesProb;
      modelSource = 'TA';
    }

    // ── FIND EDGE: model prob vs market price ──
    // Only trade when OUR probability significantly exceeds what the market is charging
    let side = null, price = null, edge = 0, prob = 0, reason = '';

    if (yesAsk && yesProb > (yesAsk / 100) + 0.05) {
      // Our model says YES is worth more than market charges
      side = 'yes'; price = yesAsk;
      prob = yesProb;
      edge = yesProb - (yesAsk / 100);
      reason = `YES model:${(yesProb*100).toFixed(0)}% > mkt:${yesAsk}¢ edge:${(edge*100).toFixed(1)}%`;
    }
    if (noAsk && noProb > (noAsk / 100) + 0.05) {
      const noEdge = noProb - (noAsk / 100);
      // Take the side with bigger edge
      if (!side || noEdge > edge) {
        side = 'no'; price = noAsk;
        prob = noProb;
        edge = noEdge;
        reason = `NO model:${(noProb*100).toFixed(0)}% > mkt:${noAsk}¢ edge:${(edge*100).toFixed(1)}%`;
      }
    }

    if (!side || edge < 0.05) {
      // Log why we're skipping — model doesn't see enough edge
      if (this._cycleCount % 3 === 0) {
        const bestEdge = Math.max(
          yesAsk ? yesProb - yesAsk/100 : -1,
          noAsk ? noProb - noAsk/100 : -1
        );
        this._log('🔍 Skip', `${market.ticker} [${modelSource}] yesP:${(yesProb*100).toFixed(0)}% Y:${yesAsk}¢ N:${noAsk}¢ bestEdge:${(bestEdge*100).toFixed(1)}% (need 5%+) ${minsLeft.toFixed(1)}m`);
      }
      return null;
    }

    // ── FEE + EV ──
    const payout = 100 - price;
    const fee = 0.07 * (price / 100) * (1 - price / 100);
    const feeCents = fee * 100;
    const netPayout = payout - feeCents;
    if (netPayout < 2) return null;

    const ev = (prob * netPayout) - ((1 - prob) * price);
    if (ev <= 0) return null;

    // ── SIZE BY CONFIDENCE ──
    // More edge = more contracts. But capped to prevent blowups.
    const isMicro = edge < 0.10; // small edge = micro size
    const tier = minsLeft < 1 ? 'LOCK' : minsLeft < 2 ? 'SNIPE' : minsLeft < 4 ? 'LATE' : 'SWING';

    reason = `[${modelSource}] ${reason} | ${tier} ${minsLeft.toFixed(1)}m`;
    this._log('🔬 EDGE', `${market.ticker} ${reason} EV:${ev.toFixed(1)}¢`);

    return {
      ticker: market.ticker, title: market.title || market.ticker,
      side, price, edge: +edge.toFixed(3), fee: +fee.toFixed(3),
      ev: +ev.toFixed(1), modelProb: +prob.toFixed(3),
      direction: side === 'yes' ? 'UP' : 'DOWN',
      volRegime: isMicro ? 'micro' : 'scalp', tier,
      timeWindow: this.correction.getCurrentTimeWindow(),
      minsLeft: +minsLeft.toFixed(1), btcPrice: sig.price,
      payout, netPayout: +netPayout.toFixed(1), isMicro,
      ta: { score: sig.score||0, conf: sig.confidence||0, rsi: +(sig.rsi||0).toFixed(1),
            macd: sig.macdHist ? +(sig.macdHist).toFixed(2) : 0, bbPctB: +(sig.bbPctB||0).toFixed(2),
            vwap: +(sig.vwapDelta||0).toFixed(3), regime: modelSource, reasons: [reason] }
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
      // ── EDGE-BASED SIZING ──
      // Small edge (5-8%) = 2 contracts
      // Medium edge (8-12%) = 3 contracts
      // Large edge (12%+) = 4-5 contracts
      const edgePct = (opp.edge || 0.05) * 100;
      let maxContracts, riskCap;
      if (edgePct >= 12) {
        maxContracts = 5; riskCap = 0.15;
      } else if (edgePct >= 8) {
        maxContracts = 3; riskCap = 0.12;
      } else {
        maxContracts = 2; riskCap = 0.08;
      }
      const maxRisk = this.bankroll * riskCap * drawdownMult;
      contracts = Math.max(1, Math.min(maxContracts, Math.floor((maxRisk * 100) / opp.price)));
      cost = (contracts * opp.price) / 100;
      if (cost > this.bankroll * 0.20) return;
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
