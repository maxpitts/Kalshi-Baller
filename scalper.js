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

    if (!markets.length) { this._log('🔍 No BTC 15m markets'); return; }

    const now = Date.now();
    const candidates = markets.filter(m => {
      if (this.activeTickers.has(m.ticker)) return false;
      const exp = new Date(m.close_time || m.expiration_time || m.expected_expiration_time).getTime();
      const mins = (exp - now) / 60000;
      return mins >= 2 && mins <= 25;
    });

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
    //  VOLATILITY-BASED MISPRICING STRATEGY
    //
    //  Core thesis: BTC 15-min markets are ~coin flips.
    //  Fair value ≈ 50¢ with small drift adjustment.
    //  When market deviates from fair → fade the extreme.
    //
    //  Edge sources:
    //  1. Fade overbought: YES at 60+¢ → buy NO (market overestimates direction)
    //  2. Fade oversold: NO at 60+¢ → buy YES
    //  3. Buy cheap: either side under 40¢ against expensive opposite
    //  4. Small momentum adjustment: if BTC trending, slight bias
    // ══════════════════════════════════════════════════════════

    let yesAsk = market.yes_ask || null;
    let noAsk = market.no_ask || null;
    const yesBid = market.yes_bid || null;
    const noBid = market.no_bid || null;

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

    // ── VIG/SPREAD CHECK ──
    // If YES + NO asks > 105, the built-in vig eats our edge
    if (yesAsk && noAsk && yesAsk + noAsk > 105) {
      return null; // silent skip — too much vig
    }

    const exp = new Date(market.close_time || market.expiration_time || market.expected_expiration_time);
    const minsLeft = (exp - Date.now()) / 60000;

    // ── FAIR VALUE MODEL ──
    // Base: 50/50 (15-min BTC is a coin flip)
    // Momentum adjustment: slight bias based on recent price action
    let fairYes = 50; // cents

    // Small momentum bias (max ±5¢)
    if (sig.price && sig.momentum5m) {
      // If BTC is up 0.1% in last 5 min, slight YES bias
      const momBias = Math.max(-5, Math.min(5, sig.momentum5m * 30));
      fairYes += momBias;
    }

    // Time decay: as expiry approaches with strong trend, increase conviction slightly
    if (minsLeft < 5 && sig.momentum1m) {
      const nearBias = Math.max(-3, Math.min(3, sig.momentum1m * 50));
      fairYes += nearBias;
    }

    const fairNo = 100 - fairYes;

    // ── FIND MISPRICING ──
    let side = null, price = null, edge = 0, reason = '';

    if (yesAsk && yesAsk < fairYes - 2) {
      // YES is cheap relative to fair value → buy YES
      side = 'yes'; price = yesAsk;
      edge = (fairYes - yesAsk) / 100;
      reason = `YES cheap: ${yesAsk}¢ vs fair ${fairYes.toFixed(0)}¢`;
    } else if (noAsk && noAsk < fairNo - 2) {
      // NO is cheap relative to fair value → buy NO
      side = 'no'; price = noAsk;
      edge = (fairNo - noAsk) / 100;
      reason = `NO cheap: ${noAsk}¢ vs fair ${fairNo.toFixed(0)}¢`;
    }

    // FADE EXTREMES: if one side is priced > 60¢, buy the other side
    if (!side) {
      if (yesAsk && yesAsk > 60 && noAsk && noAsk < 45) {
        side = 'no'; price = noAsk;
        edge = (fairNo - noAsk) / 100;
        reason = `FADE: YES@${yesAsk}¢ overpriced, buy NO@${noAsk}¢`;
      } else if (noAsk && noAsk > 60 && yesAsk && yesAsk < 45) {
        side = 'yes'; price = yesAsk;
        edge = (fairYes - yesAsk) / 100;
        reason = `FADE: NO@${noAsk}¢ overpriced, buy YES@${yesAsk}¢`;
      }
    }

    if (!side || !price || price < 3 || price > 97 || edge <= 0) {
      // Log what we saw
      this._log('📊 Pass', `${market.ticker} YES:${yesAsk}¢ NO:${noAsk}¢ fair:${fairYes.toFixed(0)}/${fairNo.toFixed(0)} | no mispricing`);
      return null;
    }

    // Fee calculation
    const fee = 0.07 * (price / 100) * (1 - price / 100);
    const netEdge = edge - fee;

    this._log('🔬 Found', `${market.ticker} ${reason} | edge:${(edge*100).toFixed(1)}% fee:${(fee*100).toFixed(1)}% net:${(netEdge*100).toFixed(1)}%`);

    if (netEdge < 0.02) {
      this._log('📊 Skip (thin edge)', `net ${(netEdge*100).toFixed(1)}% < 2%`);
      return null;
    }

    const dir = side === 'yes' ? 'UP' : 'DOWN';
    const vol = sig.volatility5m > 0.15 ? 'high' : sig.volatility5m > 0.05 ? 'medium' : 'low';

    return {
      ticker: market.ticker, title: market.title || market.ticker,
      side, price, edge: +edge.toFixed(3), fee: +fee.toFixed(3),
      modelProb: +(side === 'yes' ? fairYes/100 : fairNo/100).toFixed(2),
      direction: dir, volRegime: vol,
      timeWindow: this.correction.getCurrentTimeWindow(),
      minsLeft: +minsLeft.toFixed(1), btcPrice: sig.price,
      ta: { score: sig.score||0, conf: sig.confidence||0, rsi: +(sig.rsi||0).toFixed(1), macd: sig.macdHist ? +(sig.macdHist).toFixed(2) : 0, bbPctB: +(sig.bbPctB||0).toFixed(2), vwap: +(sig.vwapDelta||0).toFixed(3), regime: sig.regime, reasons: [reason] }
    };
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

    for (const [id, order] of this.activeOrders.entries()) {
      // Skip dry run orders — can't sell them
      if (id.startsWith('dry-')) continue;

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

        // ── TAKE PROFIT ──
        // If bid is 6+¢ above entry, we've captured most of the edge → lock it in
        if (pnlPerContract >= 6) {
          exitReason = `TP +${pnlPerContract}¢/ct ($${totalPnl.toFixed(2)})`;
        }

        // ── STOP LOSS ──
        // If bid drops 10+¢ below entry, cut the loss
        if (pnlPerContract <= -10) {
          exitReason = `SL ${pnlPerContract}¢/ct ($${totalPnl.toFixed(2)})`;
        }

        // ── TIME-BASED EXIT ──
        // If <2 min left AND we're in any profit → sell to lock it in
        // (holding through last 2 min is pure coin flip territory)
        if (minsRemaining < 2 && pnlPerContract >= 2) {
          exitReason = `TIME TP +${pnlPerContract}¢ <2min left`;
        }

        // ── MEAN REVERSION COMPLETE ──
        // If we bought at 42¢ and bid is now 49-51¢, fair value reached → exit
        if (pnlPerContract >= 3 && currentBid >= 47 && currentBid <= 53) {
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
            this._streak = Math.max(0, this._streak) + 1; // reset to positive
            this._log('🎉 WIN', `${order.ticker} → ${result} (we had ${order.side}) | +$${pnl.toFixed(2)} | bank:$${this.bankroll.toFixed(2)} | streak:+${this._streak}`);
          } else {
            this.totalLosses++;
            this.bankroll += pnl; // pnl is negative
            this._streak = Math.min(0, this._streak) - 1; // go more negative
            this._log('💀 LOSS', `${order.ticker} → ${result} (we had ${order.side}) | -$${Math.abs(pnl).toFixed(2)} | bank:$${this.bankroll.toFixed(2)} | streak:${this._streak}`);

            // Circuit breaker: pause after N consecutive losses
            if (this._streak <= -this._streakLimit) {
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
      stats: { bets: this.totalBets, wins: this.totalWins, losses: this.totalLosses, wr: this.totalBets > 0 ? Math.round(this.totalWins/this.totalBets*100) : 0, wagered: +this.totalWagered.toFixed(2), streak: this._streak, drawdown: this.peak > 0 ? +((1 - this.bankroll/this.peak)*100).toFixed(1) : 0, coolingDown: this._pausedUntil > Date.now() },
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
