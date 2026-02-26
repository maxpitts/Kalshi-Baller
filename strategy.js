/**
 * ═══════════════════════════════════════════════════════════════
 * STRATEGY ENGINE — Compounding Bet Sizing & Selection
 * ═══════════════════════════════════════════════════════════════
 *
 * Three modes:
 *  edge_hunter  — Kelly-adjacent sizing on mispriced contracts
 *  momentum     — Chase volume spikes and price movement
 *  full_send    — All-in on the single best opportunity
 */

class StrategyEngine {
  constructor(config = {}) {
    this.mode = config.mode || 'edge_hunter';
    this.maxBetFraction = config.maxBetFraction || 0.5;
    this.minEdge = config.minEdge || 0.05;
    this.targetMultiple = config.targetMultiple || 100; // 100x ($100 → $10k)

    // Track performance
    this.betHistory = [];
    this.wins = 0;
    this.losses = 0;
    this.totalWagered = 0;

    console.log(`[STRATEGY] Mode: ${this.mode} | Max bet: ${this.maxBetFraction * 100}% | Min edge: ${this.minEdge}`);
  }

  // ─── Main Decision: What to bet on ───────────────────────────

  decideBet(opportunities, bankrollCents, timeRemainingHours) {
    if (!opportunities || opportunities.length === 0) {
      return null;
    }

    const bankrollDollars = bankrollCents / 100;
    const urgency = this._calcUrgency(bankrollDollars, timeRemainingHours);

    switch (this.mode) {
      case 'edge_hunter':
        return this._edgeHunterStrategy(opportunities, bankrollCents, urgency);
      case 'momentum':
        return this._momentumStrategy(opportunities, bankrollCents, urgency);
      case 'full_send':
        return this._fullSendStrategy(opportunities, bankrollCents, urgency);
      default:
        return this._edgeHunterStrategy(opportunities, bankrollCents, urgency);
    }
  }

  // ─── Edge Hunter Strategy ─────────────────────────────────────

  /**
   * Finds contracts where the market price seems mispriced
   * Uses Kelly-adjacent sizing: bet more when edge is higher
   * Focuses on cheap contracts with high asymmetric payoff
   */
  _edgeHunterStrategy(opps, bankrollCents, urgency) {
    // Filter by minimum edge threshold (adjusted by urgency)
    const adjustedMinEdge = this.minEdge * Math.max(0.3, 1 - urgency * 0.7);

    const viable = opps.filter((o) => {
      return (
        o.compositeScore >= adjustedMinEdge &&
        o.volume > 0 &&
        o.cheapPrice >= 2 && // At least 2 cents (not dust)
        o.cheapPrice <= 40 && // Max 40 cents (need upside)
        o.potentialMultiple >= 1.5 // At least 1.5x payoff
      );
    });

    if (viable.length === 0) return null;

    // Pick the top opportunity
    const pick = viable[0];

    // Kelly-adjacent sizing
    // Simplified Kelly: f = edge / odds
    // But we cap it and adjust for aggression
    const estimatedEdge = pick.compositeScore;
    const odds = pick.potentialMultiple;
    const kellyFraction = Math.min(estimatedEdge / (odds > 0 ? odds : 1), 0.5);

    // Scale by urgency — more aggressive as time runs out
    const aggressionMultiplier = 1 + urgency * 2; // 1x → 3x
    let betFraction = Math.min(kellyFraction * aggressionMultiplier, this.maxBetFraction);

    // Minimum bet: 5% of bankroll or $1 (whichever is higher)
    const minBetCents = Math.max(bankrollCents * 0.05, 100);
    let betAmountCents = Math.max(Math.floor(bankrollCents * betFraction), minBetCents);
    betAmountCents = Math.min(betAmountCents, bankrollCents); // Can't bet more than we have

    // Calculate contracts
    const pricePerContractCents = pick.cheapPrice;
    const numContracts = Math.max(1, Math.floor(betAmountCents / pricePerContractCents));
    const actualCostCents = numContracts * pricePerContractCents;

    // Fee estimate
    const feePer = 0.07 * (pricePerContractCents / 100) * (1 - pricePerContractCents / 100);
    const totalFeeCents = Math.round(feePer * numContracts * 100);

    return {
      ticker: pick.ticker,
      title: pick.title,
      side: pick.bestSide,
      action: 'buy',
      numContracts,
      pricePerContract: pricePerContractCents,
      totalCost: actualCostCents,
      estimatedFees: totalFeeCents,
      potentialPayout: numContracts * 100, // Each contract pays $1 if correct
      potentialMultiple: Math.round(((numContracts * 100) / actualCostCents) * 10) / 10,
      compositeScore: pick.compositeScore,
      urgency: Math.round(urgency * 100),
      strategy: 'edge_hunter',
      reasoning: `${pick.bestSide.toUpperCase()} @ ${pricePerContractCents}¢ | ${pick.potentialMultiple}x payoff | Score: ${pick.compositeScore} | Urgency: ${Math.round(urgency * 100)}%`,
    };
  }

  // ─── Momentum Strategy ────────────────────────────────────────

  _momentumStrategy(opps, bankrollCents, urgency) {
    // Sort by volume — chase the crowd
    const byVolume = [...opps]
      .filter((o) => o.volume > 50 && o.cheapPrice >= 5 && o.cheapPrice <= 60)
      .sort((a, b) => b.volume - a.volume);

    if (byVolume.length === 0) return null;

    const pick = byVolume[0];

    // Momentum bets are more moderate sized
    const betFraction = Math.min(0.25 + urgency * 0.25, this.maxBetFraction);
    let betAmountCents = Math.max(Math.floor(bankrollCents * betFraction), 100);
    betAmountCents = Math.min(betAmountCents, bankrollCents);

    const numContracts = Math.max(1, Math.floor(betAmountCents / pick.cheapPrice));
    const actualCostCents = numContracts * pick.cheapPrice;

    return {
      ticker: pick.ticker,
      title: pick.title,
      side: pick.bestSide,
      action: 'buy',
      numContracts,
      pricePerContract: pick.cheapPrice,
      totalCost: actualCostCents,
      estimatedFees: 0,
      potentialPayout: numContracts * 100,
      potentialMultiple: Math.round(((numContracts * 100) / actualCostCents) * 10) / 10,
      compositeScore: pick.compositeScore,
      urgency: Math.round(urgency * 100),
      strategy: 'momentum',
      reasoning: `HIGH VOLUME: ${pick.volume} contracts | ${pick.bestSide.toUpperCase()} @ ${pick.cheapPrice}¢`,
    };
  }

  // ─── Full Send Strategy ───────────────────────────────────────

  _fullSendStrategy(opps, bankrollCents, urgency) {
    // ALL IN on the single best opportunity
    const viable = opps.filter((o) => o.cheapPrice >= 2 && o.cheapPrice <= 30);

    if (viable.length === 0) return null;

    const pick = viable[0]; // Already sorted by composite score
    const numContracts = Math.max(1, Math.floor(bankrollCents / pick.cheapPrice));
    const actualCostCents = numContracts * pick.cheapPrice;

    return {
      ticker: pick.ticker,
      title: pick.title,
      side: pick.bestSide,
      action: 'buy',
      numContracts,
      pricePerContract: pick.cheapPrice,
      totalCost: actualCostCents,
      estimatedFees: 0,
      potentialPayout: numContracts * 100,
      potentialMultiple: Math.round(((numContracts * 100) / actualCostCents) * 10) / 10,
      compositeScore: pick.compositeScore,
      urgency: 100,
      strategy: 'full_send',
      reasoning: `🚀 FULL SEND: ALL-IN on ${pick.bestSide.toUpperCase()} @ ${pick.cheapPrice}¢ | ${pick.potentialMultiple}x potential`,
    };
  }

  // ─── Urgency Calculator ───────────────────────────────────────

  /**
   * How aggressively should we bet based on time & progress?
   * Returns 0-1 (0 = chill, 1 = desperate)
   */
  _calcUrgency(bankrollDollars, timeRemainingHours) {
    const targetDollars = 10000;
    const startingDollars = 100;

    // Progress towards goal (0 = just started, 1 = at target)
    const progress = Math.max(0, (bankrollDollars - startingDollars) / (targetDollars - startingDollars));

    // Time pressure (0 = plenty of time, 1 = time's up)
    const maxHours = 48;
    const timePressure = Math.max(0, 1 - (timeRemainingHours / maxHours));

    // If we're behind schedule, increase urgency
    const expectedProgress = timePressure; // Linear expectation
    const behindSchedule = Math.max(0, expectedProgress - progress);

    // Combine factors
    const urgency = Math.min(1, timePressure * 0.4 + behindSchedule * 0.6);

    return urgency;
  }

  // ─── Record Results ───────────────────────────────────────────

  recordBet(bet, outcome) {
    this.betHistory.push({
      ...bet,
      outcome,
      timestamp: Date.now(),
    });

    if (outcome === 'win') this.wins++;
    else if (outcome === 'loss') this.losses++;
    this.totalWagered += bet.totalCost;
  }

  getStats() {
    return {
      totalBets: this.betHistory.length,
      wins: this.wins,
      losses: this.losses,
      winRate: this.betHistory.length > 0 ? this.wins / this.betHistory.length : 0,
      totalWagered: this.totalWagered,
      history: this.betHistory.slice(-50), // Last 50 bets
    };
  }
}

module.exports = StrategyEngine;
