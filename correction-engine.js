/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║       CORRECTION ENGINE v1.0 — SELF-CORRECTING BRAIN     ║
 * ║                                                           ║
 * ║  Tracks outcomes by category, price tier, time window,    ║
 * ║  and expiry proximity. Feeds rolling win rates back into  ║
 * ║  the strategy to dynamically adjust thresholds, sizing,   ║
 * ║  and allocation. Ported from IFP-Q v4.0 adaptive system.  ║
 * ╚═══════════════════════════════════════════════════════════╝
 */

const EventEmitter = require('events');

class CorrectionEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.windowSize = options.windowSize || 40;
    this.minSamples = options.minSamples || 3;

    // ── OUTCOME TRACKING (rolling arrays) ──
    this.categoryOutcomes = {};
    this.tierOutcomes = { certain: [], moderate: [], longshot: [] };
    this.timeOutcomes = { morning: [], midday: [], afternoon: [], evening: [] };
    this.expiryOutcomes = { imminent: [], soon: [], distant: [] };

    // ── STREAK TRACKING ──
    this.consecutiveWins = 0;
    this.consecutiveLosses = 0;
    this.peakWinStreak = 0;
    this.worstLossStreak = 0;

    // ── ADAPTIVE STATE (consumed by strategy/bot) ──
    this.adaptiveState = {
      edgeMultiplier: 1.0,
      tierAllocation: { certain: 0.70, longshot: 0.30 },
      positionSizeMultiplier: 1.0,
      categoryWeights: {},
      timeWindowWeights: { morning: 1.0, midday: 1.0, afternoon: 1.0, evening: 1.0 },
      expiryWeights: { imminent: 1.0, soon: 1.0, distant: 1.0 },
      overallDirection: 'LEARNING',
      lastUpdate: null,
    };

    // ── CUMULATIVE STATS ──
    this.totalRecorded = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.totalPnL = 0;

    // ── HISTORY LOG ──
    this.betHistory = [];
    this.maxHistory = 200;

    console.log('[CORRECTION] Engine initialized — learning mode until', this.minSamples, 'outcomes per dimension');
  }

  // ═══════════════════════════════════════════════════════════
  //  RECORD A BET OUTCOME
  // ═══════════════════════════════════════════════════════════
  recordOutcome(bet) {
    const won = bet.payout > 0 ? 1 : 0;
    const pnl = won ? (100 - bet.buyPrice) * (bet.amount / bet.buyPrice) : -bet.amount;
    const placedAt = bet.placedAt ? new Date(bet.placedAt) : new Date();

    const priceTier = this._getPriceTier(bet.buyPrice);
    const timeWindow = this._getTimeWindow(placedAt);
    const expiryBucket = this._getExpiryBucket(bet.hoursToExpiry || 24);
    const category = bet.category || 'Unknown';

    // Push to rolling arrays
    this._push(this.tierOutcomes[priceTier], won);
    this._push(this.timeOutcomes[timeWindow], won);
    this._push(this.expiryOutcomes[expiryBucket], won);
    if (!this.categoryOutcomes[category]) this.categoryOutcomes[category] = [];
    this._push(this.categoryOutcomes[category], won);

    // Streak
    if (won) {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
      if (this.consecutiveWins > this.peakWinStreak) this.peakWinStreak = this.consecutiveWins;
    } else {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
      if (this.consecutiveLosses > this.worstLossStreak) this.worstLossStreak = this.consecutiveLosses;
    }

    this.totalRecorded++;
    if (won) this.totalWins++; else this.totalLosses++;
    this.totalPnL += pnl;

    // History
    this.betHistory.push({
      ticker: bet.ticker || 'unknown', title: bet.title || '', category, side: bet.side,
      buyPrice: bet.buyPrice, amount: bet.amount, won, pnl: Math.round(pnl * 100) / 100,
      priceTier, timeWindow, expiryBucket, placedAt: placedAt.toISOString(),
      streakAtTime: won ? this.consecutiveWins : -this.consecutiveLosses,
    });
    if (this.betHistory.length > this.maxHistory) this.betHistory.shift();

    // RECALCULATE
    this._recalculate();

    const event = {
      type: won ? 'WIN' : 'LOSS', category, priceTier, timeWindow, expiryBucket,
      pnl: Math.round(pnl * 100) / 100,
      streak: won ? this.consecutiveWins : -this.consecutiveLosses,
      adaptiveState: { ...this.adaptiveState },
    };

    this.emit('correction_update', event);
    console.log(`[CORRECTION] ${won ? '✅ WIN' : '❌ LOSS'} | ${category} | ${priceTier} | ${timeWindow} | streak: ${event.streak} | edge×${this.adaptiveState.edgeMultiplier.toFixed(2)} | size×${this.adaptiveState.positionSizeMultiplier.toFixed(2)}`);
    return event;
  }

  // ═══════════════════════════════════════════════════════════
  //  RECALCULATE ALL ADAPTIVE PARAMETERS
  // ═══════════════════════════════════════════════════════════
  _recalculate() {
    // 1. Global edge multiplier
    const globalWR = this.totalRecorded > 0 ? (this.totalWins / this.totalRecorded) * 100 : -1;
    const wrMult = this._winRateToMult(globalWR);
    const streakMult = this.consecutiveLosses >= 5 ? 1.25 :
                       this.consecutiveLosses >= 3 ? 1.15 :
                       this.consecutiveWins >= 5  ? 0.85 :
                       this.consecutiveWins >= 3  ? 0.92 : 1.0;
    this.adaptiveState.edgeMultiplier = Math.max(0.60, Math.min(1.60, wrMult * streakMult));

    // 2. Position size multiplier
    this.adaptiveState.positionSizeMultiplier =
      this.consecutiveLosses >= 5 ? 0.40 :
      this.consecutiveLosses >= 3 ? 0.60 :
      this.consecutiveWins >= 5   ? 1.30 :
      this.consecutiveWins >= 3   ? 1.15 : 1.0;

    // 3. Tier allocation
    const cWR = this._wr(this.tierOutcomes.certain);
    const lWR = this._wr(this.tierOutcomes.longshot);
    if (cWR >= 0 && lWR >= 0) {
      if (cWR > 60 && lWR < 20) this.adaptiveState.tierAllocation = { certain: 0.85, longshot: 0.15 };
      else if (lWR > 25 && cWR < 45) this.adaptiveState.tierAllocation = { certain: 0.55, longshot: 0.45 };
      else this.adaptiveState.tierAllocation = { certain: 0.70, longshot: 0.30 };
    }

    // 4. Category weights
    for (const [cat, outcomes] of Object.entries(this.categoryOutcomes)) {
      const wr = this._wr(outcomes);
      this.adaptiveState.categoryWeights[cat] = wr < 0 ? 1.0 : Math.max(0.3, Math.min(1.5, 0.5 + (wr / 100) * 1.2));
    }

    // 5. Time window weights
    for (const [w, outcomes] of Object.entries(this.timeOutcomes)) {
      const wr = this._wr(outcomes);
      this.adaptiveState.timeWindowWeights[w] = wr < 0 ? 1.0 : Math.max(0.5, Math.min(1.4, 0.5 + (wr / 100) * 1.1));
    }

    // 6. Expiry weights
    for (const [b, outcomes] of Object.entries(this.expiryOutcomes)) {
      const wr = this._wr(outcomes);
      this.adaptiveState.expiryWeights[b] = wr < 0 ? 1.0 : Math.max(0.5, Math.min(1.4, 0.5 + (wr / 100) * 1.1));
    }

    // 7. Direction label
    if (this.totalRecorded < this.minSamples) this.adaptiveState.overallDirection = 'LEARNING';
    else if (this.adaptiveState.edgeMultiplier > 1.10) this.adaptiveState.overallDirection = 'TIGHTER';
    else if (this.adaptiveState.edgeMultiplier < 0.90) this.adaptiveState.overallDirection = 'LOOSER';
    else this.adaptiveState.overallDirection = 'NORMAL';

    this.adaptiveState.lastUpdate = new Date().toISOString();
  }

  // ═══════════════════════════════════════════════════════════
  //  QUERY METHODS (used by strategy/bot before placing bets)
  // ═══════════════════════════════════════════════════════════

  /** Get adjusted minimum edge for a given market context */
  getAdjustedEdge(baseEdge, context = {}) {
    let mult = this.adaptiveState.edgeMultiplier;
    if (context.category && this.adaptiveState.categoryWeights[context.category]) {
      mult *= (2.0 - this.adaptiveState.categoryWeights[context.category]);
    }
    if (context.timeWindow) {
      mult *= (2.0 - (this.adaptiveState.timeWindowWeights[context.timeWindow] || 1.0));
    }
    if (context.expiryBucket) {
      mult *= (2.0 - (this.adaptiveState.expiryWeights[context.expiryBucket] || 1.0));
    }
    return baseEdge * Math.max(0.50, Math.min(2.0, mult));
  }

  getPositionSizeMultiplier() { return this.adaptiveState.positionSizeMultiplier; }
  getTierAllocation() { return { ...this.adaptiveState.tierAllocation }; }
  getCategoryWeight(cat) { return this.adaptiveState.categoryWeights[cat] || 1.0; }
  getCurrentTimeWindow() { return this._getTimeWindow(new Date()); }

  shouldSkipCategory(category) {
    const o = this.categoryOutcomes[category];
    if (!o || o.length < 5) return false;
    const wr = this._wr(o);
    return wr >= 0 && wr < 15;
  }

  // ═══════════════════════════════════════════════════════════
  //  STATUS (for dashboard)
  // ═══════════════════════════════════════════════════════════
  getStatus() {
    const catBreak = {};
    for (const [c, o] of Object.entries(this.categoryOutcomes)) {
      catBreak[c] = { winRate: this._wr(o), samples: o.length, weight: this.adaptiveState.categoryWeights[c] || 1.0, skip: this.shouldSkipCategory(c) };
    }
    const tierBreak = {};
    for (const [t, o] of Object.entries(this.tierOutcomes)) {
      tierBreak[t] = { winRate: this._wr(o), samples: o.length };
    }
    const timeBreak = {};
    for (const [w, o] of Object.entries(this.timeOutcomes)) {
      timeBreak[w] = { winRate: this._wr(o), samples: o.length, weight: this.adaptiveState.timeWindowWeights[w] };
    }
    const expBreak = {};
    for (const [b, o] of Object.entries(this.expiryOutcomes)) {
      expBreak[b] = { winRate: this._wr(o), samples: o.length, weight: this.adaptiveState.expiryWeights[b] };
    }

    return {
      engine: 'CORRECTION ENGINE v1.0',
      direction: this.adaptiveState.overallDirection,
      edgeMultiplier: Math.round(this.adaptiveState.edgeMultiplier * 100) / 100,
      positionSizeMultiplier: Math.round(this.adaptiveState.positionSizeMultiplier * 100) / 100,
      tierAllocation: this.adaptiveState.tierAllocation,
      streak: {
        current: this.consecutiveWins > 0 ? `🟢${this.consecutiveWins}W` : this.consecutiveLosses > 0 ? `🔴${this.consecutiveLosses}L` : '—',
        peakWin: this.peakWinStreak, worstLoss: this.worstLossStreak,
      },
      overall: {
        totalBets: this.totalRecorded, wins: this.totalWins, losses: this.totalLosses,
        winRate: this.totalRecorded > 0 ? Math.round((this.totalWins / this.totalRecorded) * 100) : 0,
        pnl: Math.round(this.totalPnL * 100) / 100,
      },
      categories: catBreak, tiers: tierBreak, timeWindows: timeBreak, expiryBuckets: expBreak,
      recentHistory: this.betHistory.slice(-10).reverse(),
      lastUpdate: this.adaptiveState.lastUpdate,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════
  _push(arr, val) { arr.push(val); if (arr.length > this.windowSize) arr.shift(); }
  _wr(outcomes) {
    if (!outcomes || outcomes.length < this.minSamples) return -1;
    return (outcomes.reduce((s, v) => s + v, 0) / outcomes.length) * 100;
  }
  _winRateToMult(wr) {
    if (wr < 0) return 1.0;
    if (wr < 25) return 1.30; if (wr < 35) return 1.18; if (wr < 45) return 1.08;
    if (wr < 55) return 1.00; if (wr < 65) return 0.95; if (wr < 75) return 0.88;
    return 0.80;
  }
  _getPriceTier(p) { return p >= 75 ? 'certain' : p >= 40 ? 'moderate' : 'longshot'; }
  _getTimeWindow(d) {
    const h = (d.getUTCHours() - 5 + 24) % 24;
    if (h >= 6 && h < 10) return 'morning'; if (h >= 10 && h < 14) return 'midday';
    if (h >= 14 && h < 18) return 'afternoon'; return 'evening';
  }
  _getExpiryBucket(hrs) { return hrs < 6 ? 'imminent' : hrs < 24 ? 'soon' : 'distant'; }

  // ═══════════════════════════════════════════════════════════
  //  SERIALIZATION (persist across restarts)
  // ═══════════════════════════════════════════════════════════
  serialize() {
    return JSON.stringify({
      categoryOutcomes: this.categoryOutcomes, tierOutcomes: this.tierOutcomes,
      timeOutcomes: this.timeOutcomes, expiryOutcomes: this.expiryOutcomes,
      consecutiveWins: this.consecutiveWins, consecutiveLosses: this.consecutiveLosses,
      peakWinStreak: this.peakWinStreak, worstLossStreak: this.worstLossStreak,
      totalRecorded: this.totalRecorded, totalWins: this.totalWins,
      totalLosses: this.totalLosses, totalPnL: this.totalPnL,
      betHistory: this.betHistory, adaptiveState: this.adaptiveState,
    });
  }

  restore(jsonStr) {
    try {
      const d = JSON.parse(jsonStr);
      for (const k of ['categoryOutcomes','tierOutcomes','timeOutcomes','expiryOutcomes']) if (d[k]) this[k] = d[k];
      for (const k of ['consecutiveWins','consecutiveLosses','peakWinStreak','worstLossStreak','totalRecorded','totalWins','totalLosses','totalPnL']) if (typeof d[k] === 'number') this[k] = d[k];
      if (d.betHistory) this.betHistory = d.betHistory;
      if (d.adaptiveState) this.adaptiveState = { ...this.adaptiveState, ...d.adaptiveState };
      this._recalculate();
      console.log(`[CORRECTION] Restored ${this.totalRecorded} historical outcomes`);
    } catch (err) { console.error('[CORRECTION] Restore failed:', err.message); }
  }
}

module.exports = CorrectionEngine;
