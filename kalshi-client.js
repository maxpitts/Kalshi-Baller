const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');

class KalshiClient {
  constructor(opts = {}) {
    this.env = opts.env || process.env.KALSHI_ENV || 'demo';
    this.baseUrl = this.env === 'production'
      ? 'https://api.elections.kalshi.com/trade-api/v2'
      : 'https://demo-api.kalshi.co/trade-api/v2';
    this.apiKeyId = opts.apiKeyId || process.env.KALSHI_API_KEY_ID;
    this.privateKey = this._loadKey(opts);
    if (!this.apiKeyId) throw new Error('KALSHI_API_KEY_ID required');
    if (!this.privateKey) throw new Error('Private key required');
    console.log(`[KALSHI] ${this.env} mode — ${this.baseUrl}`);
  }

  _loadKey(opts) {
    if (opts.privateKeyPem || process.env.KALSHI_PRIVATE_KEY_PEM) {
      return crypto.createPrivateKey({ key: opts.privateKeyPem || process.env.KALSHI_PRIVATE_KEY_PEM, format: 'pem' });
    }
    if (opts.privateKeyBase64 || process.env.KALSHI_PRIVATE_KEY_BASE64) {
      return crypto.createPrivateKey({ key: Buffer.from(opts.privateKeyBase64 || process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8'), format: 'pem' });
    }
    const p = opts.privateKeyPath || process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi-key.pem';
    if (fs.existsSync(p)) return crypto.createPrivateKey({ key: fs.readFileSync(p, 'utf8'), format: 'pem' });
    return null;
  }

  _sign(ts, method, path) {
    return crypto.sign('sha256', Buffer.from(ts + method.toUpperCase() + path), {
      key: this.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
  }

  async _req(method, path, body) {
    const url = this.baseUrl + path;
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = this._sign(ts, method, '/trade-api/v2' + path);
    const headers = { 'Content-Type': 'application/json', 'KALSHI-ACCESS-KEY': this.apiKeyId, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': ts };
    const opts = { method, headers };
    if (body && (method === 'POST' || method === 'PUT')) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`Kalshi ${res.status}: ${text.substring(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async getMarkets(params = {}) { const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null)); return this._req('GET', '/markets' + (qs.toString() ? '?' + qs : '')); }
  async getMarket(ticker) { return this._req('GET', `/markets/${ticker}`); }
  async getOrderbook(ticker) { return this._req('GET', `/markets/${ticker}/orderbook`); }
  async getBalance() { return this._req('GET', '/portfolio/balance'); }
  async getPositions(params = {}) { const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null)); return this._req('GET', '/portfolio/positions' + (qs.toString() ? '?' + qs : '')); }
  async getFills(params = {}) { const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null)); return this._req('GET', '/portfolio/fills' + (qs.toString() ? '?' + qs : '')); }
  async placeOrder(order) { return this._req('POST', '/portfolio/orders', order); }
  async cancelOrder(id) { return this._req('DELETE', `/portfolio/orders/${id}`); }
  async getOrders(params = {}) { const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null)); return this._req('GET', '/portfolio/orders' + (qs.toString() ? '?' + qs : '')); }
}

module.exports = KalshiClient;
