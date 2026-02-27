const fetch = require('node-fetch');

class BTCFeed {
  constructor() {
    this.prices = [];
    this.maxHistory = 120;
    this.currentPrice = null;
    this.lastUpdate = null;
    this.source = null;
    this.signals = { price: 0, momentum1m: 0, momentum5m: 0, momentum15m: 0, volatility5m: 0, direction: 'NEUTRAL', strength: 0, trend: 'FLAT' };
  }

  async fetchPrice() {
    for (const fn of [this._coingecko, this._binance, this._coinbase]) {
      try { const p = await fn.call(this); if (p > 0) { this._record(p); return p; } } catch (e) {}
    }
    return this.currentPrice;
  }

  async _coingecko() {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout: 5000 });
    const d = await r.json(); this.source = 'CoinGecko'; return d.bitcoin?.usd;
  }
  async _binance() {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 5000 });
    const d = await r.json(); this.source = 'Binance'; return parseFloat(d.price);
  }
  async _coinbase() {
    const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 });
    const d = await r.json(); this.source = 'Coinbase'; return parseFloat(d.data?.amount);
  }

  _record(price) {
    this.currentPrice = price;
    this.lastUpdate = Date.now();
    this.prices.push({ price, time: Date.now() });
    if (this.prices.length > this.maxHistory) this.prices = this.prices.slice(-this.maxHistory);
    this._compute();
  }

  _compute() {
    this.signals.price = this.currentPrice;
    this.signals.momentum1m = this._mom(60000);
    this.signals.momentum5m = this._mom(300000);
    this.signals.momentum15m = this._mom(900000);
    this.signals.volatility5m = this._vol(300000);

    const wm = this.signals.momentum1m * 0.5 + this.signals.momentum5m * 0.3 + this.signals.momentum15m * 0.2;
    this.signals.direction = wm > 0.04 ? 'UP' : wm < -0.04 ? 'DOWN' : 'NEUTRAL';
    this.signals.strength = Math.min(100, Math.round(Math.abs(wm) * 1000));
    this.signals.trend = wm > 0.15 ? 'STRONG_UP' : wm > 0.04 ? 'UP' : wm < -0.15 ? 'STRONG_DOWN' : wm < -0.04 ? 'DOWN' : 'FLAT';
  }

  _mom(ms) {
    if (this.prices.length < 2) return 0;
    const cutoff = Date.now() - ms;
    const old = this.prices.find(p => p.time >= cutoff);
    return old && old.price > 0 ? ((this.currentPrice - old.price) / old.price) * 100 : 0;
  }

  _vol(ms) {
    const wp = this.prices.filter(p => p.time >= Date.now() - ms).map(p => p.price);
    if (wp.length < 3) return 0;
    const ret = []; for (let i = 1; i < wp.length; i++) if (wp[i-1] > 0) ret.push((wp[i] - wp[i-1]) / wp[i-1]);
    if (ret.length < 2) return 0;
    const avg = ret.reduce((a, b) => a + b, 0) / ret.length;
    return Math.sqrt(ret.reduce((s, r) => s + (r - avg) ** 2, 0) / ret.length) * 100;
  }

  getSignals() { return { ...this.signals }; }
  getStatus() { return { price: this.currentPrice, source: this.source, lastUpdate: this.lastUpdate ? new Date(this.lastUpdate).toISOString() : null, history: this.prices.length, signals: { ...this.signals } }; }
}

module.exports = BTCFeed;
