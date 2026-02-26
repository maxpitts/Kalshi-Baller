/**
 * ═══════════════════════════════════════════════════════════════
 * MARKET SCANNER — Edge Detection & Volatility Analysis
 * ═══════════════════════════════════════════════════════════════
 *
 * Scans all open Kalshi markets and scores them by:
 *  1. Edge — difference between estimated fair value and market price
 *  2. Volatility — wide spreads, high volume, price movement
 *  3. Liquidity — can we actually fill at this price?
 *  4. Time value — contracts expiring soon = faster resolution
 */

class MarketScanner {
  constructor(client) {
    this.client = client;
    this.marketCache = new Map();
    this.priceHistory = new Map(); // ticker -> [{ price, timestamp }]
  }

  // ─── Fee Calculation ──────────────────────────────────────────

  /**
   * Kalshi taker fee: 0.07 * P * (1 - P)
   * P is price in dollars (0-1)
   * Max fee is at P=0.50 → $0.0175 per contract
   */
  static calcFee(priceDollars) {
    return 0.07 * priceDollars * (1 - priceDollars);
  }

  // ─── Scan All Markets ─────────────────────────────────────────

  async scanMarkets() {
    console.log('[SCANNER] Scanning markets...');
    const startTime = Date.now();

    let allMarkets = [];
    let cursor = null;

    // Paginate through all open markets
    do {
      const params = { limit: 200, status: 'open' };
      if (cursor) params.cursor = cursor;

      const markets = await this.client.getMarkets(params);
      allMarkets = allMarkets.concat(markets);
      cursor = markets.length === 200 ? markets[markets.length - 1]?.ticker : null;

      // Rate limit protection
      await this._sleep(200);
    } while (cursor && allMarkets.length < 1000);

    console.log(`[SCANNER] Found ${allMarkets.length} open markets`);

    // Score and rank all markets
    const scored = [];

    for (const market of allMarkets) {
      const score = this._scoreMarket(market);
      if (score) {
        scored.push(score);
        this._updatePriceHistory(market.ticker, score.midPrice);
      }
    }

    // Sort by combined score (edge * volatility * liquidity)
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    const elapsed = Date.now() - startTime;
    console.log(`[SCANNER] Scored ${scored.length} markets in ${elapsed}ms`);

    return scored.slice(0, 20); // Top 20 opportunities
  }

  // ─── Deep Scan (with orderbook) ───────────────────────────────

  async deepScan(ticker) {
    try {
      const [market, orderbook] = await Promise.all([
        this.client.getMarket(ticker),
        this.client.getOrderbook(ticker, 20),
      ]);

      const score = this._scoreMarket(market);
      if (!score) return null;

      // Enhance with orderbook data
      const obAnalysis = this._analyzeOrderbook(orderbook);
      score.orderbook = obAnalysis;
      score.effectiveLiquidity = obAnalysis.totalLiquidity;
      score.spread = obAnalysis.spread;
      score.slippage = obAnalysis.estimatedSlippage;

      return score;
    } catch (e) {
      console.warn(`[SCANNER] Deep scan failed for ${ticker}: ${e.message}`);
      return null;
    }
  }

  // ─── Market Scoring ───────────────────────────────────────────

  _scoreMarket(market) {
    // Skip if no useful price data
    const yesPrice = market.yes_price || market.last_price;
    const noPrice = market.no_price || (100 - (yesPrice || 50));

    if (!yesPrice || yesPrice <= 0 || yesPrice >= 100) return null;

    const priceDollars = yesPrice / 100;
    const noPriceDollars = noPrice / 100;

    // 1. EDGE SCORE — How far from 50/50?
    // Extreme prices (very cheap yes/no) = potential asymmetric payoff
    const distanceFrom50 = Math.abs(priceDollars - 0.5);
    const edgeScore = distanceFrom50;

    // 2. ASYMMETRY SCORE — Cheap contracts with big payoff
    // Buying YES at $0.05 → 20x if it hits
    // Buying NO at $0.05 → 20x if it hits
    const bestSide = priceDollars < 0.5 ? 'yes' : 'no';
    const cheapPrice = Math.min(priceDollars, 1 - priceDollars);
    const potentialMultiple = (1 / cheapPrice) - 1; // e.g., $0.10 → 9x
    const asymmetryScore = Math.min(potentialMultiple / 20, 1); // normalize

    // 3. VOLUME SCORE — Higher volume = more liquidity and interest
    const volume = market.volume || 0;
    const volumeScore = Math.min(Math.log10(Math.max(volume, 1)) / 5, 1);

    // 4. TIME SCORE — Contracts expiring soon resolve faster
    const expirationTs = market.expiration_time
      ? new Date(market.expiration_time).getTime()
      : Date.now() + 7 * 24 * 60 * 60 * 1000;
    const hoursToExpiry = Math.max((expirationTs - Date.now()) / (1000 * 60 * 60), 0.1);
    const timeScore = hoursToExpiry <= 48 ? 1 : hoursToExpiry <= 168 ? 0.5 : 0.2;

    // 5. FEE IMPACT — Lower fees = better effective edge
    const fee = MarketScanner.calcFee(cheapPrice);
    const feeImpact = 1 - (fee / cheapPrice); // Fee as % of price

    // COMPOSITE SCORE
    const compositeScore =
      (edgeScore * 0.25) +
      (asymmetryScore * 0.30) +
      (volumeScore * 0.20) +
      (timeScore * 0.15) +
      (feeImpact * 0.10);

    return {
      ticker: market.ticker,
      title: market.title || market.ticker,
      subtitle: market.subtitle || '',
      category: market.category || 'unknown',
      yesPrice,
      noPrice,
      midPrice: priceDollars,
      volume,
      openInterest: market.open_interest || 0,
      expirationTime: market.expiration_time,
      hoursToExpiry: Math.round(hoursToExpiry * 10) / 10,

      // Strategy signals
      bestSide,
      cheapPrice: Math.round(cheapPrice * 100),
      potentialMultiple: Math.round(potentialMultiple * 10) / 10,
      fee: Math.round(fee * 10000) / 10000,

      // Scores
      edgeScore: Math.round(edgeScore * 1000) / 1000,
      asymmetryScore: Math.round(asymmetryScore * 1000) / 1000,
      volumeScore: Math.round(volumeScore * 1000) / 1000,
      timeScore,
      feeImpact: Math.round(feeImpact * 1000) / 1000,
      compositeScore: Math.round(compositeScore * 1000) / 1000,
    };
  }

  // ─── Orderbook Analysis ───────────────────────────────────────

  _analyzeOrderbook(orderbook) {
    const yesBids = orderbook?.yes_dollars || orderbook?.yes || [];
    const noBids = orderbook?.no_dollars || orderbook?.no || [];

    let bestYesBid = 0;
    let bestNoBid = 0;
    let totalYesLiquidity = 0;
    let totalNoLiquidity = 0;

    for (const [price, qty] of yesBids) {
      const p = parseFloat(price) || (price / 100);
      const q = parseFloat(qty) || qty;
      if (p > bestYesBid) bestYesBid = p;
      totalYesLiquidity += p * q;
    }

    for (const [price, qty] of noBids) {
      const p = parseFloat(price) || (price / 100);
      const q = parseFloat(qty) || qty;
      if (p > bestNoBid) bestNoBid = p;
      totalNoLiquidity += p * q;
    }

    // In binary markets: yes bid at X = no ask at (1-X)
    const bestYesAsk = bestNoBid > 0 ? 1 - bestNoBid : 1;
    const bestNoAsk = bestYesBid > 0 ? 1 - bestYesBid : 1;

    const spread = bestYesAsk - bestYesBid;

    return {
      bestYesBid,
      bestYesAsk,
      bestNoBid,
      bestNoAsk,
      spread: Math.round(spread * 10000) / 10000,
      totalLiquidity: Math.round((totalYesLiquidity + totalNoLiquidity) * 100) / 100,
      estimatedSlippage: spread * 0.5,
    };
  }

  // ─── Price History Tracking ───────────────────────────────────

  _updatePriceHistory(ticker, price) {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }
    const history = this.priceHistory.get(ticker);
    history.push({ price, timestamp: Date.now() });

    // Keep last 100 data points
    if (history.length > 100) history.shift();
  }

  getPriceMovement(ticker) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 2) return 0;

    const recent = history[history.length - 1].price;
    const older = history[Math.max(0, history.length - 10)].price;
    return recent - older;
  }

  // ─── Utils ────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = MarketScanner;
