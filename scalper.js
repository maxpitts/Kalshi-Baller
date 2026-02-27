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
      maxBetPct: cfg.maxBetPct || +process.env.MAX_BET_FRACTION || 0.15,
      minEdge: cfg.minEdge || +process.env.MIN_EDGE || 0.05,
      maxBets: cfg.maxBets || +process.env.MAX_SIMULTANEOUS_BETS || 3,
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
      await this._cancelStale();

      if (this.activeOrders.size >= this.cfg.maxBets) { this.emit('status', this.getStatus()); return; }

      const sig = this.feed.getSignals();
      if (!sig.price) { this._log('⚠️ No BTC price'); return; }

      // Heartbeat — always show what TA sees
      this._log('💓 Cycle', `$${sig.price?.toLocaleString()} | TA:${sig.score>0?'+':''}${sig.score} (${sig.direction}) | RSI:${sig.rsi?.toFixed(0)} MACD:${sig.macdHist?.toFixed(1)} BB:${(sig.bbPctB*100)?.toFixed(0)}% | ${sig.regime}`);

      await this._findAndBet(sig);
      this.emit('status', this.getStatus());
    } catch(e) { this._log('❌ Error', e.message); }
  }

  async _findAndBet(sig) {
    let markets = [];
    try {
      // Try series_ticker first
      const r = await this.kalshi.getMarkets({ series_ticker: 'KXBTC15M', status: 'open', limit: 100 });
      markets = r.markets || [];
      if (this._cycleCount % 5 === 1) this._log('📡 Markets', `${markets.length} KXBTC15M open`);
    } catch(e) {
      this._log('⚠️ Series fetch failed', e.message);
    }

    if (!markets.length) {
      try {
        // Fallback: search all open markets for BTC
        const r = await this.kalshi.getMarkets({ status: 'open', limit: 1000 });
        const allMarkets = r.markets || [];
        this._log('📡 Fallback search', `${allMarkets.length} total open markets`);
        markets = allMarkets.filter(m => {
          const t = (m.ticker || '').toUpperCase();
          const title = (m.title || '').toLowerCase();
          return (t.includes('BTC') || t.includes('BITCOIN') || title.includes('bitcoin') || title.includes('btc')) &&
                 (title.includes('15 min') || title.includes('15min') || title.includes('up or down') || t.includes('15M'));
        });
        this._log('📡 Filtered BTC', `${markets.length} BTC 15m markets found`);
        if (markets.length > 0) {
          this._log('📡 Sample ticker', markets[0].ticker + ' | ' + markets[0].title);
        }
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
        await new Promise(r => setTimeout(r, 200)); // rate limit courtesy
      } catch(e){}
    }

    scored.sort((a, b) => b.edge - a.edge);
    const slots = this.cfg.maxBets - this.activeOrders.size;
    for (const opp of scored.slice(0, slots)) await this._place(opp);
  }

  async _analyze(market, sig) {
    // Use market-level pricing first (no extra API call needed)
    let yesAsk = market.yes_ask || null;
    let noAsk = market.no_ask || null;

    // Fallback to orderbook if market-level prices missing
    if (!yesAsk && !noAsk) {
      try {
        const ob = await this.kalshi.getOrderbook(market.ticker);
        const book = ob.orderbook || ob; // handle both formats
        yesAsk = book.yes?.length ? book.yes[0][0] : null;
        noAsk = book.no?.length ? book.no[0][0] : null;
      } catch(e) { return null; }
    }
    if (!yesAsk && !noAsk) return null;

    const dir = sig.direction;
    const vol = sig.volatility5m > 0.15 ? 'high' : sig.volatility5m > 0.05 ? 'medium' : 'low';
    const exp = new Date(market.close_time || market.expiration_time || market.expected_expiration_time);
    const minsLeft = (exp - Date.now()) / 60000;
    const taScore = sig.score || 0;
    const taConf = sig.confidence || 0;
    const reasons = sig.reasons || [];

    if (this.correction.shouldAvoidDirection(dir)) return null;

    // ══════════════════════════════════════════════
    //  ENTRY GATES — must pass ALL of these
    // ══════════════════════════════════════════════

    // Gate 1: Minimum TA score — need multiple indicators agreeing
    if (Math.abs(taScore) < 20) {
      return null; // silent skip for very weak — too noisy to log every one
    }

    // Gate 2: Minimum confidence
    if (taConf < 20) return null;

    // Gate 3: Need at least 3 confirming reasons
    if (reasons.length < 3) {
      this._log('🚫 Few confirms', `${market.ticker} score=${taScore} but only ${reasons.length} reasons`);
      return null;
    }

    // Gate 4: No betting on NEUTRAL — only clear BUY or SELL
    if (dir === 'NEUTRAL') return null;

    // Gate 5: RSI must not be extreme against direction
    if (dir === 'UP' && sig.rsi > 78) { this._log('🚫 RSI too hot', `${sig.rsi?.toFixed(0)}`); return null; }
    if (dir === 'DOWN' && sig.rsi < 22) { this._log('🚫 RSI too cold', `${sig.rsi?.toFixed(0)}`); return null; }

    let side, price, modelProb;

    if (dir === 'UP' && yesAsk) {
      side = 'yes'; price = yesAsk;
      // Conservative probability: base 52% + scaled TA score
      modelProb = 0.52 + (taScore / 600) + (taConf / 800);
      if (sig.trend === 'STRONG_UP' && taConf >= 45) modelProb = Math.min(0.90, modelProb + 0.06);
      if (minsLeft < 6 && sig.momentum1m > 0.04 && taConf >= 35) modelProb = Math.min(0.90, modelProb + 0.04);
    } else if (dir === 'DOWN' && noAsk) {
      side = 'no'; price = noAsk;
      modelProb = 0.52 + (Math.abs(taScore) / 600) + (taConf / 800);
      if (sig.trend === 'STRONG_DOWN' && taConf >= 45) modelProb = Math.min(0.90, modelProb + 0.06);
      if (minsLeft < 6 && sig.momentum1m < -0.04 && taConf >= 35) modelProb = Math.min(0.90, modelProb + 0.04);
    } else return null;

    if (!price || price < 3 || price > 97) return null;

    const edge = modelProb - price / 100;
    const tw = this.correction.getCurrentTimeWindow();
    const adjEdge = this.correction.getAdjustedEdge(this.cfg.minEdge, { direction: dir, volRegime: vol, timeWindow: tw });
    if (edge < adjEdge) {
      this._log('📊 Skip (low edge)', `${market.ticker} ${side} @ ${price}¢ | edge:${(edge*100).toFixed(1)}% < needed:${(adjEdge*100).toFixed(1)}% | model:${(modelProb*100).toFixed(0)}%`);
      return null;
    }

    const fee = 0.07 * (price / 100) * (1 - price / 100);
    if (edge - fee <= 0) {
      this._log('📊 Skip (fees eat edge)', `${market.ticker} edge:${(edge*100).toFixed(1)}% - fee:${(fee*100).toFixed(1)}% = net ${((edge-fee)*100).toFixed(1)}%`);
      return null;
    }

    return { ticker: market.ticker, title: market.title || market.ticker, side, price, edge: +edge.toFixed(3), fee: +fee.toFixed(3), modelProb: +modelProb.toFixed(2), direction: dir, volRegime: vol, timeWindow: tw, minsLeft: +minsLeft.toFixed(1), btcPrice: sig.price,
      ta: { score: taScore, conf: taConf, rsi: +(sig.rsi||0).toFixed(1), macd: sig.macdHist ? +(sig.macdHist).toFixed(2) : 0, bbPctB: +(sig.bbPctB||0).toFixed(2), vwap: +(sig.vwapDelta||0).toFixed(3), regime: sig.regime, reasons: (sig.reasons||[]).slice(0,5) } };
  }

  async _place(opp) {
    const sizeMult = this.correction.getSizeMultiplier();
    let maxBet = this.bankroll * this.cfg.maxBetPct * sizeMult;
    maxBet = Math.max(1, Math.min(maxBet, this.bankroll * 0.30));
    const contracts = Math.max(1, Math.floor((maxBet * 100) / opp.price));
    const cost = (contracts * opp.price) / 100;
    if (cost > this.bankroll * 0.35) return;

    this._log('🎯 BET', `${opp.side.toUpperCase()} ${opp.ticker} @ ${opp.price}¢ ×${contracts} | edge:${(opp.edge*100).toFixed(1)}% | TA:${opp.ta?.score}/${opp.ta?.conf} | RSI:${opp.ta?.rsi} MACD:${opp.ta?.macd} | ${opp.minsLeft}min`);

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

          if (won) { this.totalWins++; this._log('🎉 WIN', `${order.ticker} → ${result} (we had ${order.side}) | +$${pnl.toFixed(2)}`); }
          else { this.totalLosses++; this._log('💀 LOSS', `${order.ticker} → ${result} (we had ${order.side}) | -$${Math.abs(pnl).toFixed(2)}`); }

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
      stats: { bets: this.totalBets, wins: this.totalWins, losses: this.totalLosses, wr: this.totalBets > 0 ? Math.round(this.totalWins/this.totalBets*100) : 0, wagered: +this.totalWagered.toFixed(2) },
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
