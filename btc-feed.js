/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║   BTC TECHNICAL ANALYSIS ENGINE                           ║
 * ║   RSI(14), MACD(12,26,9), BB(20,2), EMA(9/21/50),       ║
 * ║   VWAP, StochRSI, ATR, ROC, ADX → Composite Signal      ║
 * ╚═══════════════════════════════════════════════════════════╝
 */
const fetch = require('node-fetch');

class BTCTechnicalEngine {
  constructor() {
    this.candles = [];
    this.maxCandles = 200;
    this.currentPrice = null;
    this.lastUpdate = null;
    this.source = null;
    this.tickPrices = [];

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
    console.log('[TA] Technical Analysis Engine initialized');
  }

  // ═══ DATA FETCHING ═══

  async fetchCandles() {
    try {
      const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=200', { timeout: 8000 });
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        this.candles = data.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
        this.currentPrice = this.candles[this.candles.length - 1].c;
        this.lastUpdate = Date.now();
        this.source = 'Binance';
        this._computeAll();
        return this.currentPrice;
      }
    } catch (e) { console.error('[TA] Binance candles failed:', e.message); }
    return this._fetchSpot();
  }

  async _fetchSpot() {
    for (const fn of [this._binSpot, this._gecko, this._cb]) {
      try { const p = await fn.call(this); if (p > 0) { this.currentPrice = p; this.lastUpdate = Date.now(); this._synthCandle(p); this._computeAll(); return p; } } catch (e) {}
    }
    return this.currentPrice;
  }

  async _binSpot() { const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 5000 }); const d = await r.json(); this.source = 'Binance'; return +d.price; }
  async _gecko() { const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout: 5000 }); const d = await r.json(); this.source = 'CoinGecko'; return d.bitcoin?.usd; }
  async _cb() { const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 }); const d = await r.json(); this.source = 'Coinbase'; return +(d.data?.amount); }

  _synthCandle(p) {
    if (!this.candles.length || Date.now() - this.candles[this.candles.length - 1].t > 60000) {
      this.candles.push({ t: Date.now(), o: p, h: p, l: p, c: p, v: 0 });
      if (this.candles.length > this.maxCandles) this.candles.shift();
    } else { const l = this.candles[this.candles.length - 1]; l.c = p; l.h = Math.max(l.h, p); l.l = Math.min(l.l, p); }
  }

  async fetchPrice() { return this.fetchCandles(); }

  // ═══ INDICATORS ═══

  _computeAll() {
    if (this.candles.length < 5) return;
    const c = this.candles.map(x => x.c), h = this.candles.map(x => x.h), l = this.candles.map(x => x.l), v = this.candles.map(x => x.v);
    const n = c.length;
    const ind = this.indicators;
    ind.price = this.currentPrice;

    ind.ema9 = this._ema(c, 9); ind.ema21 = this._ema(c, 21); ind.ema50 = this._ema(c, 50); ind.sma20 = this._sma(c, 20);
    ind.rsi14 = this._rsi(c, 14);

    const macd = this._macd(c, 12, 26, 9);
    ind.macdLine = macd.line; ind.macdSignal = macd.signal; ind.macdHist = macd.hist;

    const bb = this._bb(c, 20, 2);
    ind.bbUpper = bb.u; ind.bbMiddle = bb.m; ind.bbLower = bb.l;
    ind.bbWidth = bb.u - bb.l;
    ind.bbPctB = bb.u !== bb.l ? (this.currentPrice - bb.l) / (bb.u - bb.l) : 0.5;

    const sr = this._stochRsi(c, 14, 14, 3, 3);
    ind.stochRsiK = sr.k; ind.stochRsiD = sr.d;

    ind.atr14 = this._atr(h, l, c, 14);
    ind.roc5 = n > 5 ? ((c[n-1] - c[n-6]) / c[n-6]) * 100 : 0;
    ind.roc15 = n > 15 ? ((c[n-1] - c[n-16]) / c[n-16]) * 100 : 0;
    ind.vwap = this._vwap(h, l, c, v);
    ind.adx = this._adx(h, l, c, 14);

    this._score();
  }

  _ema(d, p) { if (d.length < p) return d[d.length - 1] || 0; const k = 2 / (p + 1); let e = d.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < d.length; i++) e = d[i] * k + e * (1 - k); return e; }
  _sma(d, p) { const s = d.slice(-Math.min(p, d.length)); return s.reduce((a, b) => a + b, 0) / s.length; }

  _rsi(c, p) {
    if (c.length < p + 1) return 50;
    let g = 0, lo = 0;
    for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i-1]; if (d > 0) g += d; else lo -= d; }
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
    return { k: kv.length >= ks ? this._sma(kv.slice(-ks), ks) : kv[kv.length-1] || 50, d: kv.length >= ks + ds ? this._sma(kv.slice(-ds), ds) : kv[kv.length-1] || 50 };
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

  // ═══ COMPOSITE SCORING ═══

  _score() {
    let s = 0;
    const r = [], p = this.currentPrice, ind = this.indicators;

    // 1. EMA ALIGNMENT (25pts)
    if (p > ind.ema9 && ind.ema9 > ind.ema21) {
      s += 15; r.push('Price > EMA9 > EMA21');
      if (ind.ema21 > ind.ema50) { s += 10; r.push('Full EMA bullish stack'); }
    } else if (p < ind.ema9 && ind.ema9 < ind.ema21) {
      s -= 15; r.push('Price < EMA9 < EMA21');
      if (ind.ema21 < ind.ema50) { s -= 10; r.push('Full EMA bearish stack'); }
    }

    // 2. RSI (20pts)
    if (ind.rsi14 > 70) { s -= 8; r.push(`RSI OB ${ind.rsi14.toFixed(0)}`); }
    else if (ind.rsi14 > 60) { s += 10; r.push(`RSI bull ${ind.rsi14.toFixed(0)}`); }
    else if (ind.rsi14 < 30) { s += 8; r.push(`RSI OS ${ind.rsi14.toFixed(0)}`); }
    else if (ind.rsi14 < 40) { s -= 10; r.push(`RSI bear ${ind.rsi14.toFixed(0)}`); }
    if (ind.rsi14 > 55 && ind.roc5 > 0) s += 5;
    if (ind.rsi14 < 45 && ind.roc5 < 0) s -= 5;

    // 3. MACD (20pts)
    if (ind.macdHist > 0) {
      s += 10; r.push('MACD hist +');
      if (ind.macdLine > ind.macdSignal && ind.macdLine > 0) { s += 5; r.push('MACD bull cross > 0'); }
    } else if (ind.macdHist < 0) {
      s -= 10; r.push('MACD hist -');
      if (ind.macdLine < ind.macdSignal && ind.macdLine < 0) { s -= 5; r.push('MACD bear cross < 0'); }
    }

    // 4. BOLLINGER (15pts)
    if (ind.bbPctB > 0.95) { s -= 8; r.push('Above upper BB'); }
    else if (ind.bbPctB > 0.75) { s += 5; r.push('Upper BB zone'); }
    else if (ind.bbPctB < 0.05) { s += 8; r.push('Below lower BB'); }
    else if (ind.bbPctB < 0.25) { s -= 5; r.push('Lower BB zone'); }

    // 5. STOCH RSI (10pts)
    if (ind.stochRsiK > 80 && ind.stochRsiK > ind.stochRsiD) { s -= 5; r.push('StochRSI OB'); }
    else if (ind.stochRsiK < 20 && ind.stochRsiK < ind.stochRsiD) { s += 5; r.push('StochRSI OS'); }
    if (ind.stochRsiK > ind.stochRsiD && ind.stochRsiK < 50) { s += 3; r.push('StochRSI bull x'); }
    if (ind.stochRsiK < ind.stochRsiD && ind.stochRsiK > 50) { s -= 3; r.push('StochRSI bear x'); }

    // 6. VWAP (10pts)
    if (p > ind.vwap * 1.001) { s += 5; r.push('Above VWAP'); }
    else if (p < ind.vwap * 0.999) { s -= 5; r.push('Below VWAP'); }

    // 7. ROC (10pts)
    if (ind.roc5 > 0.1) { s += 5; r.push(`ROC5 +${ind.roc5.toFixed(2)}%`); }
    else if (ind.roc5 < -0.1) { s -= 5; r.push(`ROC5 ${ind.roc5.toFixed(2)}%`); }

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

  // ═══ PUBLIC INTERFACE ═══

  getSignals() {
    const ind = this.indicators, sig = this.signal;
    return {
      price: this.currentPrice,
      direction: sig.direction === 'BUY' ? 'UP' : sig.direction === 'SELL' ? 'DOWN' : 'NEUTRAL',
      strength: sig.confidence,
      trend: sig.trend === 'STRONG_BUY' ? 'STRONG_UP' : sig.trend === 'BUY' ? 'UP' : sig.trend === 'STRONG_SELL' ? 'STRONG_DOWN' : sig.trend === 'SELL' ? 'DOWN' : 'FLAT',
      momentum1m: ind.roc5 / 5, momentum5m: ind.roc5, momentum15m: ind.roc15,
      volatility5m: ind.atr14 > 0 && this.currentPrice ? (ind.atr14 / this.currentPrice) * 100 : 0,
      rsi: ind.rsi14, macdHist: ind.macdHist, bbPctB: ind.bbPctB,
      vwapDelta: this.currentPrice && ind.vwap ? ((this.currentPrice - ind.vwap) / ind.vwap) * 100 : 0,
      score: sig.strength, confidence: sig.confidence, regime: sig.regime, reasons: sig.reasons,
    };
  }

  getStatus() {
    return {
      price: this.currentPrice, source: this.source,
      lastUpdate: this.lastUpdate ? new Date(this.lastUpdate).toISOString() : null,
      candles: this.candles.length, indicators: { ...this.indicators },
      signal: { ...this.signal }, signals: this.getSignals(),
    };
  }
}

module.exports = BTCTechnicalEngine;
