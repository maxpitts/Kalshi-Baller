/**
 * ═══════════════════════════════════════════════════════════════
 * KALSHI API CLIENT — RSA-PSS Authenticated
 * ═══════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const HOSTS = {
  production: 'trading-api.kalshi.com',
  demo: 'demo-api.kalshi.co',
};

class KalshiClient {
  constructor({ apiKeyId, privateKeyPath, env = 'demo' }) {
    this.apiKeyId = apiKeyId;
    this.host = HOSTS[env] || HOSTS.demo;
    this.basePath = '/trade-api/v2';
    this.env = env;

    // Load RSA private key (base64 env var OR file path)
    let keyData;
    if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
      keyData = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
      console.log('[KALSHI] Loaded private key from KALSHI_PRIVATE_KEY_BASE64 env var');
    } else if (privateKeyPath && fs.existsSync(privateKeyPath)) {
      keyData = fs.readFileSync(privateKeyPath, 'utf8');
      console.log(`[KALSHI] Loaded private key from file: ${privateKeyPath}`);
    } else {
      console.warn('[KALSHI] No private key found — bot will run in dry-run mode');
      keyData = null;
    }

    this.privateKey = null;
    if (keyData) {
      const trimmed = keyData.trim();
      console.log('[KALSHI] Key data length:', trimmed.length);

      // Check if it's PEM (text) or DER (binary)
      if (trimmed.startsWith('-----')) {
        console.log('[KALSHI] Detected PEM format key');
        // PEM format — try various types
        const formats = [
          { key: trimmed, format: 'pem', type: 'pkcs8' },
          { key: trimmed, format: 'pem', type: 'pkcs1' },
          { key: trimmed, format: 'pem' },
          { key: trimmed },
        ];
        for (const opts of formats) {
          try {
            this.privateKey = crypto.createPrivateKey(opts);
            console.log('[KALSHI] PEM key loaded successfully');
            break;
          } catch (e) { /* try next */ }
        }
      } else {
        console.log('[KALSHI] Detected binary/DER format key — trying DER decode');
        // It's binary DER — load from the raw base64 env var directly as a Buffer
        const derBuffer = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64');
        const derFormats = [
          { key: derBuffer, format: 'der', type: 'pkcs8' },
          { key: derBuffer, format: 'der', type: 'pkcs1' },
        ];
        for (const opts of derFormats) {
          try {
            this.privateKey = crypto.createPrivateKey(opts);
            console.log('[KALSHI] DER key loaded successfully with type:', opts.type);
            break;
          } catch (e) {
            console.log('[KALSHI] DER', opts.type, 'failed:', e.message);
          }
        }
      }

      if (!this.privateKey) {
        console.error('[KALSHI] Could not parse private key in any format');
      }
    }

    console.log(`[KALSHI] Client initialized — ${env} @ ${this.host}`);
  }

  // ─── RSA-PSS Signing ─────────────────────────────────────────

  _sign(timestamp, method, path) {
    // Strip query params before signing
    const cleanPath = path.split('?')[0];
    const message = `${timestamp}${method}${cleanPath}`;
    const signature = crypto.sign('sha256', Buffer.from(message), {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return signature.toString('base64');
  }

  _getHeaders(method, path) {
    const timestamp = String(Date.now());
    const signature = this._sign(timestamp, method, path);
    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  // ─── HTTP Methods ─────────────────────────────────────────────

  _request(method, path, body = null) {
    const fullPath = this.basePath + path;
    const headers = this._getHeaders(method, fullPath);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: 443,
        path: fullPath,
        method,
        headers,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode >= 400) {
              const err = new Error(`Kalshi API Error ${res.statusCode}: ${data}`);
              err.statusCode = res.statusCode;
              err.body = data;
              reject(err);
            } else {
              resolve(data ? JSON.parse(data) : {});
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  get(path) {
    return this._request('GET', path);
  }

  post(path, body) {
    return this._request('POST', path, body);
  }

  delete(path) {
    return this._request('DELETE', path);
  }

  // ─── Portfolio ────────────────────────────────────────────────

  async getBalance() {
    const res = await this.get('/portfolio/balance');
    return res.balance; // cents
  }

  async getPositions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const path = '/portfolio/positions' + (qs ? `?${qs}` : '');
    const res = await this.get(path);
    return res.market_positions || [];
  }

  async getOrders(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const path = '/portfolio/orders' + (qs ? `?${qs}` : '');
    const res = await this.get(path);
    return res.orders || [];
  }

  async getFills(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const path = '/portfolio/fills' + (qs ? `?${qs}` : '');
    const res = await this.get(path);
    return res.fills || [];
  }

  // ─── Markets ──────────────────────────────────────────────────

  async getMarkets(params = {}) {
    const defaults = { limit: 200, status: 'open' };
    const merged = { ...defaults, ...params };
    const qs = new URLSearchParams(merged).toString();
    const res = await this.get(`/markets?${qs}`);
    return res.markets || [];
  }

  async getMarket(ticker) {
    const res = await this.get(`/markets/${ticker}`);
    return res.market;
  }

  async getOrderbook(ticker, depth = 10) {
    const res = await this.get(`/markets/${ticker}/orderbook?depth=${depth}`);
    return res.orderbook;
  }

  async getEvents(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const path = '/events' + (qs ? `?${qs}` : '');
    const res = await this.get(path);
    return res.events || [];
  }

  // ─── Trading ──────────────────────────────────────────────────

  async createOrder({ ticker, side, action, count, type = 'limit', yesPrice, noPrice, clientOrderId }) {
    const order = {
      ticker,
      side,        // "yes" or "no"
      action,      // "buy" or "sell"
      count,       // number of contracts
      type,        // "limit" or "market"
      client_order_id: clientOrderId || crypto.randomUUID(),
    };

    if (type === 'limit') {
      if (side === 'yes' && yesPrice != null) order.yes_price = yesPrice;
      if (side === 'no' && noPrice != null) order.no_price = noPrice;
    }

    const res = await this.post('/portfolio/orders', order);
    return res.order;
  }

  async cancelOrder(orderId) {
    return this.delete(`/portfolio/orders/${orderId}`);
  }

  async cancelAllOrders() {
    // Get all resting orders and cancel them
    const orders = await this.getOrders({ status: 'resting' });
    const results = [];
    for (const order of orders) {
      try {
        await this.cancelOrder(order.order_id);
        results.push({ orderId: order.order_id, cancelled: true });
      } catch (e) {
        results.push({ orderId: order.order_id, cancelled: false, error: e.message });
      }
    }
    return results;
  }

  // ─── Exchange Status ──────────────────────────────────────────

  async getExchangeStatus() {
    return this.get('/exchange/status');
  }
}

module.exports = KalshiClient;
