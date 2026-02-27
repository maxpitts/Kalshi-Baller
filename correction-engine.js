const EventEmitter = require('events');

class CorrectionEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.windowSize = opts.windowSize || 50;
    this.minSamples = opts.minSamples || 3;
    this.directionOutcomes = { UP: [], DOWN: [], NEUTRAL: [] };
    this.tierOutcomes = { safe: [], moderate: [], risky: [] };
    this.volOutcomes = { low: [], medium: [], high: [] };
    this.timeOutcomes = { morning: [], midday: [], afternoon: [], evening: [] };
    this.consecutiveWins = 0; this.consecutiveLosses = 0;
    this.peakWinStreak = 0; this.worstLossStreak = 0;
    this.state = {
      edgeMultiplier: 1.0, positionSizeMultiplier: 1.0,
      directionBias: { UP: 1.0, DOWN: 1.0, NEUTRAL: 1.0 },
      volWeights: { low: 1.0, medium: 1.0, high: 1.0 },
      timeWeights: { morning: 1.0, midday: 1.0, afternoon: 1.0, evening: 1.0 },
      mode: 'LEARNING', lastUpdate: null,
    };
    this.totalBets = 0; this.totalWins = 0; this.totalLosses = 0; this.totalPnL = 0;
    this.history = [];
    console.log('[CORR] Engine v2.0 ready');
  }

  recordOutcome(bet) {
    const won = bet.won ? 1 : 0;
    const pnl = bet.pnl || (won ? (100 - bet.buyPrice) * (bet.contracts || 1) / 100 : -(bet.buyPrice * (bet.contracts || 1) / 100));
    const dir = bet.direction || 'NEUTRAL', tier = this._tier(bet.buyPrice), vol = bet.volRegime || 'medium';
    const tw = this._tw(bet.placedAt ? new Date(bet.placedAt) : new Date());

    this._p(this.directionOutcomes[dir] || (this.directionOutcomes[dir] = []), won);
    this._p(this.tierOutcomes[tier], won);
    this._p(this.volOutcomes[vol] || (this.volOutcomes[vol] = []), won);
    this._p(this.timeOutcomes[tw], won);

    if (won) { this.consecutiveWins++; this.consecutiveLosses = 0; if (this.consecutiveWins > this.peakWinStreak) this.peakWinStreak = this.consecutiveWins; }
    else { this.consecutiveLosses++; this.consecutiveWins = 0; if (this.consecutiveLosses > this.worstLossStreak) this.worstLossStreak = this.consecutiveLosses; }
    this.totalBets++; if (won) this.totalWins++; else this.totalLosses++; this.totalPnL += pnl;

    this.history.push({ ticker: bet.ticker, side: bet.side, buyPrice: bet.buyPrice, won, pnl: +pnl.toFixed(2), direction: dir, tier, vol, tw, streak: won ? this.consecutiveWins : -this.consecutiveLosses, at: new Date().toISOString() });
    if (this.history.length > 200) this.history.shift();

    this._recalc();
    const ev = { type: won ? 'WIN' : 'LOSS', pnl: +pnl.toFixed(2), direction: dir, streak: won ? this.consecutiveWins : -this.consecutiveLosses };
    this.emit('update', ev);
    console.log(`[CORR] ${won ? '✅' : '❌'} ${dir} ${tier} | streak:${ev.streak} | edge×${this.state.edgeMultiplier.toFixed(2)} size×${this.state.positionSizeMultiplier.toFixed(2)}`);
    return ev;
  }

  _recalc() {
    const gwr = this.totalBets > 0 ? (this.totalWins / this.totalBets) * 100 : -1;
    const wrm = gwr < 0 ? 1 : gwr < 25 ? 1.35 : gwr < 35 ? 1.20 : gwr < 45 ? 1.08 : gwr < 55 ? 1.0 : gwr < 65 ? 0.92 : gwr < 75 ? 0.85 : 0.78;
    const sm = this.consecutiveLosses >= 5 ? 1.30 : this.consecutiveLosses >= 3 ? 1.15 : this.consecutiveWins >= 5 ? 0.82 : this.consecutiveWins >= 3 ? 0.90 : 1.0;
    this.state.edgeMultiplier = Math.max(0.55, Math.min(1.70, wrm * sm));
    this.state.positionSizeMultiplier = this.consecutiveLosses >= 5 ? 0.35 : this.consecutiveLosses >= 3 ? 0.55 : this.consecutiveWins >= 7 ? 1.40 : this.consecutiveWins >= 5 ? 1.25 : this.consecutiveWins >= 3 ? 1.12 : 1.0;
    for (const [k, o] of Object.entries(this.directionOutcomes)) { const w = this._wr(o); this.state.directionBias[k] = w < 0 ? 1.0 : Math.max(0.3, Math.min(1.6, 0.4 + (w/100)*1.4)); }
    for (const [k, o] of Object.entries(this.volOutcomes)) { const w = this._wr(o); this.state.volWeights[k] = w < 0 ? 1.0 : Math.max(0.4, Math.min(1.5, 0.4 + (w/100)*1.3)); }
    for (const [k, o] of Object.entries(this.timeOutcomes)) { const w = this._wr(o); this.state.timeWeights[k] = w < 0 ? 1.0 : Math.max(0.5, Math.min(1.4, 0.5 + (w/100)*1.1)); }
    this.state.mode = this.totalBets < this.minSamples ? 'LEARNING' : this.state.edgeMultiplier > 1.15 ? 'DEFENSIVE' : this.state.edgeMultiplier < 0.88 ? 'AGGRESSIVE' : 'NORMAL';
    this.state.lastUpdate = new Date().toISOString();
  }

  getAdjustedEdge(base, ctx = {}) {
    let m = this.state.edgeMultiplier;
    if (ctx.direction && this.state.directionBias[ctx.direction]) m *= (2.0 - this.state.directionBias[ctx.direction]);
    if (ctx.volRegime && this.state.volWeights[ctx.volRegime]) m *= (2.0 - this.state.volWeights[ctx.volRegime]);
    if (ctx.timeWindow && this.state.timeWeights[ctx.timeWindow]) m *= (2.0 - this.state.timeWeights[ctx.timeWindow]);
    return base * Math.max(0.40, Math.min(2.5, m));
  }
  getSizeMultiplier() { return this.state.positionSizeMultiplier; }
  getDirectionBias(d) { return this.state.directionBias[d] || 1.0; }
  getCurrentTimeWindow() { return this._tw(new Date()); }
  shouldAvoidDirection(d) { const o = this.directionOutcomes[d]; return o && o.length >= 5 && this._wr(o) < 20; }

  getStatus() {
    const mb = (obj, w) => { const r = {}; for (const [k, o] of Object.entries(obj)) r[k] = { winRate: this._wr(o), n: o.length, w: w?.[k] || undefined }; return r; };
    return { engine: 'CORRECTION v2.0', mode: this.state.mode, edgeMult: +this.state.edgeMultiplier.toFixed(2), sizeMult: +this.state.positionSizeMultiplier.toFixed(2),
      streak: { current: this.consecutiveWins > 0 ? `🟢${this.consecutiveWins}W` : this.consecutiveLosses > 0 ? `🔴${this.consecutiveLosses}L` : '—', peakWin: this.peakWinStreak, worstLoss: this.worstLossStreak },
      overall: { bets: this.totalBets, wins: this.totalWins, losses: this.totalLosses, wr: this.totalBets > 0 ? Math.round((this.totalWins/this.totalBets)*100) : 0, pnl: +this.totalPnL.toFixed(2) },
      directions: mb(this.directionOutcomes, this.state.directionBias), tiers: mb(this.tierOutcomes), vol: mb(this.volOutcomes, this.state.volWeights), time: mb(this.timeOutcomes, this.state.timeWeights),
      recent: this.history.slice(-12).reverse() };
  }

  _p(a, v) { a.push(v); if (a.length > this.windowSize) a.shift(); }
  _wr(o) { if (!o || o.length < this.minSamples) return -1; return (o.reduce((s, v) => s + v, 0) / o.length) * 100; }
  _tier(p) { return p >= 70 ? 'safe' : p >= 35 ? 'moderate' : 'risky'; }
  _tw(d) { const h = (d.getUTCHours() - 5 + 24) % 24; return h >= 6 && h < 10 ? 'morning' : h >= 10 && h < 14 ? 'midday' : h >= 14 && h < 18 ? 'afternoon' : 'evening'; }

  serialize() { return JSON.stringify({ d: this.directionOutcomes, t: this.tierOutcomes, v: this.volOutcomes, tm: this.timeOutcomes, cw: this.consecutiveWins, cl: this.consecutiveLosses, pw: this.peakWinStreak, wl: this.worstLossStreak, tb: this.totalBets, tw2: this.totalWins, tl: this.totalLosses, tp: this.totalPnL, h: this.history, s: this.state }); }
  restore(j) { try { const d = JSON.parse(j); if(d.d) this.directionOutcomes=d.d; if(d.t) this.tierOutcomes=d.t; if(d.v) this.volOutcomes=d.v; if(d.tm) this.timeOutcomes=d.tm;
    if(typeof d.cw==='number') this.consecutiveWins=d.cw; if(typeof d.cl==='number') this.consecutiveLosses=d.cl; if(typeof d.pw==='number') this.peakWinStreak=d.pw; if(typeof d.wl==='number') this.worstLossStreak=d.wl;
    if(typeof d.tb==='number') this.totalBets=d.tb; if(typeof d.tw2==='number') this.totalWins=d.tw2; if(typeof d.tl==='number') this.totalLosses=d.tl; if(typeof d.tp==='number') this.totalPnL=d.tp;
    if(d.h) this.history=d.h; if(d.s) this.state={...this.state,...d.s}; this._recalc(); console.log(`[CORR] Restored ${this.totalBets} outcomes`); } catch(e){} }
}

module.exports = CorrectionEngine;
