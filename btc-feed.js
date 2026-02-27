/**
 * BTC TECHNICAL ANALYSIS ENGINE v2
 * Multiple candle sources + fast synthetic candle fallback
 * Adaptive indicator periods based on available data
 */
const fetch = require('node-fetch');

class BTCTechnicalEngine {
  constructor() {
    this.candles = [];       // 1-min candles [{o,h,l,c,v,t}]
    this.maxCandles = 200;
    this.currentPrice = null;
    this.lastUpdate = null;
    this.source = null;
    this.candleSource = null;
    this.fetchErrors = [];

    this.indicators = {
      price: 0, ema9: 0, ema21: 0, ema50: 0, sma20: 0,
      rsi14: 50, macdLine: 0, macdSignal: 0, macdHist: 0,
      bbUpper: 0, bbMiddle: 0, bbLower: 0, bbWidth: 0, bbPctB: 0.5,
      stochRsiK: 50, stochRsiD: 50, vwap: 0, roc5: 0, roc15: 0,
      atr14: 0, adx: 0,
    };

    this.signal = {
      direction: 'NEUTRAL', confidence: 0, strength: 0,
      reasons: [], trend: 'FLAT', regime: 'NEUTRAL',
    };
    console.log('[TA] BTCTechnicalEngine v2 initialized');
  }

  // ═══════════════════════════════════════
  //  CANDLE FETCHING — multiple sources
  // ═══════════════════════════════════════

  async fetchCandles() {
    // Try each candle source in order
    const sources = [
      { name: 'Binance', fn: () => this._binanceCandles() },
      { name: 'Binance.us', fn: () => this._binanceUsCandles() },
      { name: 'CoinGecko OHLC', fn: () => this._coingeckoOHLC() },
    ];

    for (const src of sources) {
      try {
        const candles = await src.fn();
        if (candles && candles.length >= 10) {
          this.candles = candles.slice(-this.maxCandles);
          this.currentPrice = this.candles[this.candles.length - 1].c;
          this.lastUpdate = Date.now();
          this.candleSource = src.name;
          this.source = src.name;
          this._computeAll();
          console.log(`[TA] ${src.name}: ${candles.length} candles, price $${this.currentPrice.toFixed(2)}`);
          return this.currentPrice;
        }
      } catch (e) {
        this.fetchErrors.push(`${src.name}: ${e.message}`);
        console.error(`[TA] ${src.name} failed:`, e.message);
      }
    }

    // All candle sources failed — use spot price with synthetic candles
    console.log('[TA] All candle sources failed, using spot + synthetic');
    return this._fetchSpotAndBuild();
  }

  async _binanceCandles() {
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=200', { timeout: 8000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.code) throw new Error(d.msg || `API error ${d.code}`);
    if (!Array.isArray(d)) throw new Error('Not an array');
    return d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }

  async _binanceUsCandles() {
    const r = await fetch('https://api.binance.us/api/v3/klines?symbol=BTCUSD&interval=1m&limit=200', { timeout: 8000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.code) throw new Error(d.msg || `API error ${d.code}`);
    if (!Array.isArray(d)) throw new Error('Not an array');
    return d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }

  async _coingeckoOHLC() {
    // CoinGecko OHLC: 1-day range returns ~288 5-min candles (close enough)
    const r = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1', { timeout: 8000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d) || d.length < 5) throw new Error(`Only ${d?.length} candles`);
    return d.map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: 0 }));
  }

  // ═══════════════════════════════════════
  //  SPOT PRICE — for building synthetic candles
  // ═══════════════════════════════════════

  async _fetchSpotAndBuild() {
    const price = await this._getSpotPrice();
    if (!price) return this.currentPrice;

    this.currentPrice = price;
    this.lastUpdate = Date.now();
    this._buildSynthCandle(price);
    this._computeAll();
    return price;
  }

  async _getSpotPrice() {
    // Try multiple spot sources
    for (const fn of [
      async () => { const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {timeout:5000}); const d = await r.json(); this.source='Binance'; return +d.price; },
      async () => { const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', {timeout:5000}); const d = await r.json(); this.source='Coinbase'; return +(d.data?.amount); },
      async () => { const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', {timeout:5000}); const d = await r.json(); this.source='CoinGecko'; return d.bitcoin?.usd; },
    ]) {
      try { const p = await fn(); if (p > 0) return p; } catch(e) {}
    }
    return null;
  }

  _buildSynthCandle(price) {
    const now = Date.now();

    // Build 15-second synthetic candles (4× faster than 1-min)
    // We'll treat every 15 seconds as a micro-candle
    const INTERVAL = 15000; // 15 seconds

    if (!this.candles.length || now - this.candles[this.candles.length - 1].t > INTERVAL) {
      this.candles.push({ t: now, o: price, h: price, l: price, c: price, v: 0 });
      if (this.candles.length > this.maxCandles) this.candles.shift();
    } else {
      const last = this.candles[this.candles.length - 1];
      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
    }
  }

  async fetchPrice() { return this.fetchCandles(); }

  // ═══════════════════════════════════════
  //  INDICATOR CALCULATIONS
  //  Adaptive: uses shorter periods if limited data
  // ═══════════════════════════════════════

  _computeAll() {
    const n = this.candles.length;
    if (n < 3) return; // Need at least 3 candles

    const c = this.candles.map(x => x.c);
    const h = this.candles.map(x => x.h);
    const l = this.candles.map(x => x.l);
    const v = this.candles.map(x => x.v);
    const ind = this.indicators;
    ind.price = this.currentPrice;

    // Adaptive periods — use shorter when limited data
    const rsiP = Math.min(14, Math.max(5, Math.floor(n / 3)));
    const macdF = Math.min(12, Math.max(4, Math.floor(n / 5)));
    const macdS = Math.min(26, Math.max(8, Math.floor(n / 3)));
    const macdSig = Math.min(9, Math.max(3, Math.floor(n / 8)));
    const bbP = Math.min(20, Math.max(5, Math.floor(n / 3)));
    const emaShort = Math.min(9, Math.max(3, Math.floor(n / 5)));
    const emaMid = Math.min(21, Math.max(5, Math.floor(n / 4)));
    const emaLong = Math.min(50, Math.max(10, Math.floor(n / 2)));

    // EMAs
    ind.ema9 = this._ema(c, emaShort);
    ind.ema21 = this._ema(c, emaMid);
    ind.ema50 = this._ema(c, emaLong);
    ind.sma20 = this._sma(c, bbP);

    // RSI
    ind.rsi14 = n > rsiP + 1 ? this._rsi(c, rsiP) : 50;

    // MACD
    if (n > macdS + macdSig) {
      const macd = this._macd(c, macdF, macdS, macdSig);
      ind.macdLine = macd.line; ind.macdSignal = macd.signal; ind.macdHist = macd.hist;
    }

    // Bollinger Bands
    const bb = this._bb(c, bbP, 2);
    ind.bbUpper = bb.u; ind.bbMiddle = bb.m; ind.bbLower = bb.l;
    ind.bbWidth = bb.u - bb.l;
    ind.bbPctB = bb.u !== bb.l ? (this.currentPrice - bb.l) / (bb.u - bb.l) : 0.5;

    // StochRSI
    if (n > rsiP * 2) {
      const sr = this._stochRsi(c, rsiP, rsiP, 3, 3);
      ind.stochRsiK = sr.k; ind.stochRsiD = sr.d;
    }

    // ATR
    if (n > 5) ind.atr14 = this._atr(h, l, c, Math.min(14, n - 1));

    // Rate of Change
    ind.roc5 = n > 5 ? ((c[n-1] - c[n - Math.min(6, n)]) / c[n - Math.min(6, n)]) * 100 : 0;
    ind.roc15 = n > 15 ? ((c[n-1] - c[n-16]) / c[n-16]) * 100 :
                n > 5 ? ((c[n-1] - c[0]) / c[0]) * 100 : 0;

    // VWAP
    ind.vwap = this._vwap(h, l, c, v);

    // ADX
    if (n > 10) ind.adx = this._adx(h, l, c, Math.min(14, Math.floor(n / 2)));

    // Score
    this._score();
  }

  // ═══ Math helpers ═══

  _ema(d, p) {
    if (d.length < p) return d[d.length - 1] || 0;
    const k = 2 / (p + 1);
    let e = d.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < d.length; i++) e = d[i] * k + e * (1 - k);
    return e;
  }

  _sma(d, p) {
    const s = d.slice(-Math.min(p, d.length));
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  _rsi(c, p) {
    if (c.length < p + 1) return 50;
    let g = 0, lo = 0;
    for (let i = c.length - p; i < c.length; i++) {
      const d = c[i] - c[i-1];
      if (d > 0) g += d; else lo -= d;
    }
    const ag = g / p, al = lo / p;
    return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  }

  _macd(c, f, s, sig) {
    const ef = this._emaArr(c, f), es = this._emaArr(c, s), ml = [];
    const st = Math.max(f, s) - 1;
    for (let i = st; i < c.length; i++) ml.push(ef[i] - es[i]);
    if (!ml.length) return { line: 0, signal: 0, hist: 0 };
    const sl = this._emaArr(ml, sig);
    const lm = ml[ml.length - 1], ls = sl[sl.length - 1];
    return { line: lm, signal: ls, hist: lm - ls };
  }

  _emaArr(d, p) {
    const r = new Array(d.length).fill(0);
    if (d.length < p) return r;
    const k = 2 / (p + 1);
    r[p - 1] = d.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < d.length; i++) r[i] = d[i] * k + r[i-1] * (1-k);
    return r;
  }

  _bb(c, p, m) {
    const mid = this._sma(c, p);
    const s = c.slice(-Math.min(p, c.length));
    const v = s.reduce((sum, x) => sum + (x - mid) ** 2, 0) / s.length;
    const sd = Math.sqrt(v);
    return { u: mid + m * sd, m: mid, l: mid - m * sd };
  }

  _stochRsi(c, rp, sp, ks, ds) {
    if (c.length < rp + sp) return { k: 50, d: 50 };
    const rv = [];
    for (let i = rp + 1; i <= c.length; i++) rv.push(this._rsi(c.slice(0, i), rp));
    if (rv.length < sp) return { k: 50, d: 50 };
    const kv = [];
    for (let i = sp - 1; i < rv.length; i++) {
      const w = rv.slice(i - sp + 1, i + 1);
      const hi = Math.max(...w), lo = Math.min(...w);
      kv.push(hi === lo ? 50 : ((rv[i] - lo) / (hi - lo)) * 100);
    }
    return {
      k: kv.length >= ks ? this._sma(kv.slice(-ks), ks) : kv[kv.length-1] || 50,
      d: kv.length >= ks + ds ? this._sma(kv.slice(-ds), ds) : kv[kv.length-1] || 50
    };
  }

  _atr(h, l, c, p) {
    if (c.length < p + 1) return 0;
    const tr = [];
    for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
    return this._sma(tr.slice(-p), p);
  }

  _vwap(h, l, c, v) {
    let cvp = 0, cv = 0;
    const st = Math.max(0, c.length - 60);
    for (let i = st; i < c.length; i++) { const tp = (h[i]+l[i]+c[i])/3, vol = v[i]||1; cvp += tp*vol; cv += vol; }
    return cv > 0 ? cvp/cv : c[c.length-1];
  }

  _adx(h, l, c, p) {
    if (c.length < p * 2) return 25;
    let su = 0, sd = 0;
    for (let i = c.length - p; i < c.length; i++) {
      const um = h[i] - h[i-1], dm = l[i-1] - l[i];
      if (um > dm && um > 0) su += um;
      if (dm > um && dm > 0) sd += dm;
    }
    const atr = this.indicators.atr14 || 1;
    const pdi = (su/p)/atr*100, mdi = (sd/p)/atr*100;
    return (pdi+mdi) > 0 ? Math.abs(pdi-mdi)/(pdi+mdi)*100 : 0;
  }

  // ═══════════════════════════════════════
  //  COMPOSITE SCORING
  // ═══════════════════════════════════════

  _score() {
    let s = 0;
    const r = [], p = this.currentPrice, ind = this.indicators;

    // 1. EMA ALIGNMENT (25pts)
    if (p > ind.ema9 && ind.ema9 > ind.ema21) {
      s += 15; r.push('EMA bull stack');
      if (ind.ema21 > ind.ema50) { s += 10; r.push('Full EMA↑'); }
    } else if (p < ind.ema9 && ind.ema9 < ind.ema21) {
      s -= 15; r.push('EMA bear stack');
      if (ind.ema21 < ind.ema50) { s -= 10; r.push('Full EMA↓'); }
    }

    // 2. RSI (20pts)
    const rsi = ind.rsi14;
    if (rsi > 70) { s -= 8; r.push(`RSI OB ${rsi.toFixed(0)}`); }
    else if (rsi > 58) { s += 10; r.push(`RSI bull ${rsi.toFixed(0)}`); }
    else if (rsi < 30) { s += 8; r.push(`RSI OS ${rsi.toFixed(0)}`); }
    else if (rsi < 42) { s -= 10; r.push(`RSI bear ${rsi.toFixed(0)}`); }
    if (rsi > 52 && ind.roc5 > 0) s += 5;
    if (rsi < 48 && ind.roc5 < 0) s -= 5;

    // 3. MACD (20pts)
    if (ind.macdHist > 0) {
      s += 10; r.push('MACD +');
      if (ind.macdLine > ind.macdSignal && ind.macdLine > 0) { s += 5; r.push('MACD bull>0'); }
    } else if (ind.macdHist < 0) {
      s -= 10; r.push('MACD -');
      if (ind.macdLine < ind.macdSignal && ind.macdLine < 0) { s -= 5; r.push('MACD bear<0'); }
    }

    // 4. BOLLINGER (15pts)
    if (ind.bbPctB > 0.92) { s -= 8; r.push('Above BB'); }
    else if (ind.bbPctB > 0.70) { s += 5; r.push('Upper BB'); }
    else if (ind.bbPctB < 0.08) { s += 8; r.push('Below BB'); }
    else if (ind.bbPctB < 0.30) { s -= 5; r.push('Lower BB'); }

    // 5. STOCH RSI (10pts)
    if (ind.stochRsiK > 80 && ind.stochRsiK > ind.stochRsiD) { s -= 5; r.push('StochRSI OB'); }
    else if (ind.stochRsiK < 20 && ind.stochRsiK < ind.stochRsiD) { s += 5; r.push('StochRSI OS'); }
    if (ind.stochRsiK > ind.stochRsiD && ind.stochRsiK < 50) { s += 3; r.push('StochRSI↑'); }
    if (ind.stochRsiK < ind.stochRsiD && ind.stochRsiK > 50) { s -= 3; r.push('StochRSI↓'); }

    // 6. VWAP (10pts)
    if (p > ind.vwap * 1.0005) { s += 5; r.push('Above VWAP'); }
    else if (p < ind.vwap * 0.9995) { s -= 5; r.push('Below VWAP'); }

    // 7. ROC (10pts)
    if (ind.roc5 > 0.05) { s += 5; r.push(`ROC +${ind.roc5.toFixed(2)}%`); }
    else if (ind.roc5 < -0.05) { s -= 5; r.push(`ROC ${ind.roc5.toFixed(2)}%`); }

    s = Math.max(-100, Math.min(100, s));
    const sig = this.signal;
    sig.direction = s >= 15 ? 'BUY' : s <= -15 ? 'SELL' : 'NEUTRAL';
    sig.confidence = Math.min(100, Math.abs(s));
    sig.strength = s;
    sig.reasons = r;
    sig.trend = s >= 40 ? 'STRONG_BUY' : s >= 15 ? 'BUY' : s <= -40 ? 'STRONG_SELL' : s <= -15 ? 'SELL' : 'FLAT';
    const bbw = ind.bbWidth / (ind.bbMiddle || 1) * 100;
    sig.regime = ind.adx > 40 ? (s > 0 ? 'TRENDING_UP' : 'TRENDING_DOWN') : bbw > 1.5 ? 'VOLATILE' : 'RANGING';
  }

  // ═══════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════

  getSignals() {
    const ind = this.indicators, sig = this.signal;
    return {
      price: this.currentPrice,
      direction: sig.direction === 'BUY' ? 'UP' : sig.direction === 'SELL' ? 'DOWN' : 'NEUTRAL',
      strength: sig.confidence,
      trend: sig.trend === 'STRONG_BUY' ? 'STRONG_UP' : sig.trend === 'BUY' ? 'UP' :
             sig.trend === 'STRONG_SELL' ? 'STRONG_DOWN' : sig.trend === 'SELL' ? 'DOWN' : 'FLAT',
      momentum1m: ind.roc5 / 5, momentum5m: ind.roc5, momentum15m: ind.roc15,
      volatility5m: ind.atr14 > 0 && this.currentPrice ? (ind.atr14 / this.currentPrice) * 100 : 0,
      rsi: ind.rsi14, macdHist: ind.macdHist, bbPctB: ind.bbPctB,
      vwapDelta: this.currentPrice && ind.vwap ? ((this.currentPrice - ind.vwap) / ind.vwap) * 100 : 0,
      score: sig.strength, confidence: sig.confidence, regime: sig.regime, reasons: sig.reasons,
    };
  }

  getStatus() {
    return {
      price: this.currentPrice, source: this.source, candleSource: this.candleSource,
      lastUpdate: this.lastUpdate ? new Date(this.lastUpdate).toISOString() : null,
      candles: this.candles.length, indicators: { ...this.indicators },
      signal: { ...this.signal }, signals: this.getSignals(),
      fetchErrors: this.fetchErrors.slice(-5),
    };
  }
}

module.exports = BTCTechnicalEngine;
