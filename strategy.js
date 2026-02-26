/**
 * ═══════════════════════════════════════════════════════════════
 * STRATEGY ENGINE v2 — Sniper + Multi-Position + Compounding
 * ═══════════════════════════════════════════════════════════════
 *
 * Five modes:
 *  sniper       — Target contracts expiring within hours, high conviction
 *  edge_hunter  — Kelly-adjacent sizing on mispriced contracts
 *  multi_spread — Spread across 3-5 markets simultaneously
 *  momentum     — Chase volume spikes and price movement
 *  full_send    — All-in on the single best opportunity
 */

class StrategyEngine {
  constructor(config = {}) {
    this.mode = config.mode || 'sniper';
    this.maxBetFraction = config.maxBetFraction || 0.5;
    this.minEdge = config.minEdge || 0.05;
    this.targetMultiple = config.targetMultiple || 100;
    this.maxSimultaneousPositions = config.maxPositions || 4;

    // Track performance
    this.betHistory = [];
    this.wins = 0;
    this.losses = 0;
    this.totalWagered = 0;
    this.activePositionTickers = new Set();

    console.log(`[STRATEGY] Mode: ${this.mode} | Max bet: ${this.maxBetFraction * 100}% | Max positions: ${this.maxSimultaneousPositions}`);
  }

  // ─── Main Decision ────────────────────────────────────────────

  decideBets(opportunities, bankrollCents, timeRemainingHours) {
    if (!opportunities || opportunities.length === 0) return [];

    const bankrollDollars = bankrollCents / 100;
    const urgency = this._calcUrgency(bankrollDollars, timeRemainingHours);

    // Filter out markets we already have positions in
    const fresh = opportunities.filter(o => !this.activePositionTickers.has(o.ticker));

    switch (this.mode) {
      case 'sniper':
        return this._sniperStrategy(fresh, bankrollCents, urgency);
      case 'multi_spread':
        return this._multiSpreadStrategy(fresh, bankrollCents, urgency);
      case 'edge_hunter':
        return [this._edgeHunterStrategy(fresh, bankrollCents, urgency)].filter(Boolean);
      case 'momentum':
        return [this._momentumStrategy(fresh, bankrollCents, urgency)].filter(Boolean);
      case 'full_send':
        return [this._fullSendStrategy(fresh, bankrollCents, urgency)].filter(Boolean);
      default:
        return this._sniperStrategy(fresh, bankrollCents, urgency);
    }
  }

  // Keep backward compat
  decideBet(opportunities, bankrollCents, timeRemainingHours) {
    const bets = this.decideBets(opportunities, bankrollCents, timeRemainingHours);
    return bets.length > 0 ? bets[0] : null;
  }

  // ─── SNIPER STRATEGY ──────────────────────────────────────────
  /**
   * The money maker. Targets contracts that:
   * 1. Expire within 1-24 hours (fast resolution = fast compounding)
   * 2. Have strong directional conviction (price > 75¢ or < 25¢)
   * 3. Have real volume (people are trading, not ghost markets)
   *
   * Logic: If a contract is trading at 90¢ YES with 2 hours left,
   * the market is 90% confident it'll resolve YES. Buy YES at 90¢,
   * make 10¢ per contract if correct — that's 11% return in 2 hours.
   * Compound that 7 times = 2x. Do it 20 times = 100x.
   */
  _sniperStrategy(opps, bankrollCents, urgency) {
    const bets = [];
    const slotsAvailable = this.maxSimultaneousPositions - this.activePositionTickers.size;
    if (slotsAvailable <= 0) return [];

    // TIER 1: "Almost certain" — expiring soon, high conviction
    // Buy the likely winner at 80-97¢, collect 3-20¢ profit per contract
    const sniperTargets = opps
      .filter(o => {
        const expiresWithin24h = o.hoursToExpiry <= 24;
        const hasVolume = o.volume >= 20;
        const highConviction = o.yesPrice >= 75 || o.yesPrice <= 25; // Strong lean
        const notTooExpensive = Math.min(o.yesPrice, o.noPrice) <= 97; // Some upside left
        return expiresWithin24h && hasVolume && highConviction && notTooExpensive;
      })
      .sort((a, b) => {
        // Sort by: quickest expiry first, then by volume
        const timeA = a.hoursToExpiry;
        const timeB = b.hoursToExpiry;
        if (Math.abs(timeA - timeB) > 2) return timeA - timeB;
        return b.volume - a.volume;
      });

    // TIER 2: "Asymmetric longshots" — cheap contracts that could pop
    // Buy contracts at 3-15¢ that resolve within 48h
    const longshots = opps
      .filter(o => {
        const expiresWithin48h = o.hoursToExpiry <= 48;
        const hasVolume = o.volume >= 10;
        const isCheap = o.cheapPrice >= 3 && o.cheapPrice <= 15;
        return expiresWithin48h && hasVolume && isCheap;
      })
      .sort((a, b) => a.cheapPrice - b.cheapPrice); // Cheapest first

    // Allocate bankroll: 70% to sniper bets, 30% to longshots
    const sniperBudget = Math.floor(bankrollCents * 0.7);
    const longshotBudget = Math.floor(bankrollCents * 0.3);

    // Place sniper bets
    const sniperSlots = Math.min(Math.ceil(slotsAvailable * 0.6), sniperTargets.length, 3);
    const perSniperBet = sniperSlots > 0 ? Math.floor(sniperBudget / sniperSlots) : 0;

    for (let i = 0; i < sniperSlots; i++) {
      const pick = sniperTargets[i];
      // Buy the winning side
      const side = pick.yesPrice >= 75 ? 'yes' : 'no';
      const price = side === 'yes' ? pick.yesPrice : pick.noPrice;
      const numContracts = Math.max(1, Math.floor(perSniperBet / price));
      const cost = numContracts * price;
      const profit = numContracts * (100 - price);

      bets.push(this._buildBet(pick, {
        side,
        numContracts,
        pricePerContract: price,
        totalCost: cost,
        potentialPayout: numContracts * 100,
        potentialMultiple: Math.round(((numContracts * 100) / cost) * 10) / 10,
        urgency: Math.round(urgency * 100),
        strategy: 'sniper',
        reasoning: `🎯 SNIPER: ${side.toUpperCase()} @ ${price}¢ | ${pick.hoursToExpiry}h to expiry | +$${(profit/100).toFixed(2)} if correct | Vol: ${pick.volume}`,
      }));
    }

    // Place longshot bets
    const longshotSlots = Math.min(slotsAvailable - sniperSlots, longshots.length, 2);
    const perLongshotBet = longshotSlots > 0 ? Math.floor(longshotBudget / longshotSlots) : 0;

    for (let i = 0; i < longshotSlots; i++) {
      const pick = longshots[i];
      const numContracts = Math.max(1, Math.floor(perLongshotBet / pick.cheapPrice));
      const cost = numContracts * pick.cheapPrice;

      bets.push(this._buildBet(pick, {
        side: pick.bestSide,
        numContracts,
        pricePerContract: pick.cheapPrice,
        totalCost: cost,
        potentialPayout: numContracts * 100,
        potentialMultiple: Math.round(((numContracts * 100) / cost) * 10) / 10,
        urgency: Math.round(urgency * 100),
        strategy: 'sniper_longshot',
        reasoning: `🎲 LONGSHOT: ${pick.bestSide.toUpperCase()} @ ${pick.cheapPrice}¢ | ${pick.potentialMultiple}x if it hits | ${pick.hoursToExpiry}h left`,
      }));
    }

    return bets;
  }

  // ─── MULTI-SPREAD STRATEGY ────────────────────────────────────
  /**
   * Diversify across 3-5 markets simultaneously.
   * Sizes each position to risk equal amounts.
   */
  _multiSpreadStrategy(opps, bankrollCents, urgency) {
    const bets = [];
    const slotsAvailable = this.maxSimultaneousPositions - this.activePositionTickers.size;
    if (slotsAvailable <= 0) return [];

    const viable = opps.filter(o =>
      o.volume >= 15 &&
      o.cheapPrice >= 5 &&
      o.cheapPrice <= 50 &&
      o.hoursToExpiry <= 72 &&
      o.compositeScore >= this.minEdge * 0.5
    );

    const numBets = Math.min(slotsAvailable, viable.length, 4);
    if (numBets === 0) return [];

    const perBet = Math.floor(bankrollCents / numBets);

    for (let i = 0; i < numBets; i++) {
      const pick = viable[i];
      const numContracts = Math.max(1, Math.floor(perBet / pick.cheapPrice));
      const cost = numContracts * pick.cheapPrice;

      bets.push(this._buildBet(pick, {
        side: pick.bestSide,
        numContracts,
        pricePerContract: pick.cheapPrice,
        totalCost: cost,
        potentialPayout: numContracts * 100,
        potentialMultiple: Math.round(((numContracts * 100) / cost) * 10) / 10,
        urgency: Math.round(urgency * 100),
        strategy: 'multi_spread',
        reasoning: `📊 SPREAD ${i+1}/${numBets}: ${pick.bestSide.toUpperCase()} @ ${pick.cheapPrice}¢ | ${pick.potentialMultiple}x | Vol: ${pick.volume}`,
      }));
    }

    return bets;
  }

  // ─── EDGE HUNTER ──────────────────────────────────────────────

  _edgeHunterStrategy(opps, bankrollCents, urgency) {
    const adjustedMinEdge = this.minEdge * Math.max(0.3, 1 - urgency * 0.7);
    const viable = opps.filter(o =>
      o.compositeScore >= adjustedMinEdge &&
      o.volume >= 10 &&
      o.cheapPrice >= 3 && o.cheapPrice <= 60 &&
      o.potentialMultiple >= 1.2
    );
    if (viable.length === 0) return null;

    const pick = viable[0];
    const estimatedEdge = pick.compositeScore;
    const odds = pick.potentialMultiple;
    const kellyFraction = Math.min(estimatedEdge / (odds > 0 ? odds : 1), 0.5);
    const aggressionMultiplier = 1 + urgency * 2;
    let betFraction = Math.min(kellyFraction * aggressionMultiplier, this.maxBetFraction);
    const minBetCents = Math.max(bankrollCents * 0.05, 100);
    let betAmountCents = Math.max(Math.floor(bankrollCents * betFraction), minBetCents);
    betAmountCents = Math.min(betAmountCents, bankrollCents);

    const numContracts = Math.max(1, Math.floor(betAmountCents / pick.cheapPrice));
    const actualCostCents = numContracts * pick.cheapPrice;

    return this._buildBet(pick, {
      side: pick.bestSide,
      numContracts,
      pricePerContract: pick.cheapPrice,
      totalCost: actualCostCents,
      potentialPayout: numContracts * 100,
      potentialMultiple: Math.round(((numContracts * 100) / actualCostCents) * 10) / 10,
      urgency: Math.round(urgency * 100),
      strategy: 'edge_hunter',
      reasoning: `${pick.bestSide.toUpperCase()} @ ${pick.cheapPrice}¢ | ${pick.potentialMultiple}x | Score: ${pick.compositeScore} | Urgency: ${Math.round(urgency * 100)}%`,
    });
  }

  // ─── MOMENTUM ─────────────────────────────────────────────────

  _momentumStrategy(opps, bankrollCents, urgency) {
    const byVolume = [...opps]
      .filter(o => o.volume >= 20 && o.cheapPrice >= 5 && o.cheapPrice <= 70)
      .sort((a, b) => b.volume - a.volume);
    if (byVolume.length === 0) return null;

    const pick = byVolume[0];
    const betFraction = Math.min(0.25 + urgency * 0.25, this.maxBetFraction);
    let betAmountCents = Math.max(Math.floor(bankrollCents * betFraction), 100);
    betAmountCents = Math.min(betAmountCents, bankrollCents);
    const numContracts = Math.max(1, Math.floor(betAmountCents / pick.cheapPrice));
    const actualCostCents = numContracts * pick.cheapPrice;

    return this._buildBet(pick, {
      side: pick.bestSide,
      numContracts,
      pricePerContract: pick.cheapPrice,
      totalCost: actualCostCents,
      potentialPayout: numContracts * 100,
      potentialMultiple: Math.round(((numContracts * 100) / actualCostCents) * 10) / 10,
      urgency: Math.round(urgency * 100),
      strategy: 'momentum',
      reasoning: `HIGH VOLUME: ${pick.volume} | ${pick.bestSide.toUpperCase()} @ ${pick.cheapPrice}¢`,
    });
  }

  // ─── FULL SEND ────────────────────────────────────────────────

  _fullSendStrategy(opps, bankrollCents, urgency) {
    const viable = opps.filter(o => o.cheapPrice >= 3 && o.cheapPrice <= 50 && o.volume >= 5);
    if (viable.length === 0) return null;

    const pick = viable[0];
    const numContracts = Math.max(1, Math.floor(bankrollCents / pick.cheapPrice));
    const actualCostCents = numContracts * pick.cheapPrice;

    return this._buildBet(pick, {
      side: pick.bestSide,
      numContracts,
      pricePerContract: pick.cheapPrice,
      totalCost: actualCostCents,
      potentialPayout: numContracts * 100,
      potentialMultiple: Math.round(((numContracts * 100) / actualCostCents) * 10) / 10,
      urgency: 100,
      strategy: 'full_send',
      reasoning: `🚀 FULL SEND: ALL-IN ${pick.bestSide.toUpperCase()} @ ${pick.cheapPrice}¢ | ${pick.potentialMultiple}x`,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────

  _buildBet(pick, overrides) {
    return {
      ticker: pick.ticker,
      title: pick.title,
      action: 'buy',
      hoursToExpiry: pick.hoursToExpiry,
      category: pick.category,
      compositeScore: pick.compositeScore,
      estimatedFees: 0,
      ...overrides,
    };
  }

  _calcUrgency(bankrollDollars, timeRemainingHours) {
    const targetDollars = 10000;
    const startingDollars = 100;
    const progress = Math.max(0, (bankrollDollars - startingDollars) / (targetDollars - startingDollars));
    const maxHours = 48;
    const timePressure = Math.max(0, 1 - (timeRemainingHours / maxHours));
    const expectedProgress = timePressure;
    const behindSchedule = Math.max(0, expectedProgress - progress);
    return Math.min(1, timePressure * 0.4 + behindSchedule * 0.6);
  }

  // ─── Position Tracking ────────────────────────────────────────

  markPositionActive(ticker) { this.activePositionTickers.add(ticker); }
  markPositionClosed(ticker) { this.activePositionTickers.delete(ticker); }
  getActivePositionCount() { return this.activePositionTickers.size; }

  recordBet(bet, outcome) {
    this.betHistory.push({ ...bet, outcome, timestamp: Date.now() });
    if (outcome === 'win') this.wins++;
    else if (outcome === 'loss') this.losses++;
    this.totalWagered += bet.totalCost;
    this.activePositionTickers.delete(bet.ticker);
  }

  getStats() {
    return {
      totalBets: this.betHistory.length,
      wins: this.wins,
      losses: this.losses,
      winRate: this.betHistory.length > 0 ? this.wins / this.betHistory.length : 0,
      totalWagered: this.totalWagered,
      activePositions: this.activePositionTickers.size,
      history: this.betHistory.slice(-50),
    };
  }
}

module.exports = StrategyEngine;
