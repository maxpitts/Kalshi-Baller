/**
 * ═══════════════════════════════════════════════════════════════
 * YOLO ENGINE — Main Bot
 * ═══════════════════════════════════════════════════════════════
 *
 *   $100 → $10,000 in 48 hours or self-destruct
 *
 * ═══════════════════════════════════════════════════════════════
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const KalshiClient = require('./kalshi-client');
const MarketScanner = require('./scanner');
const StrategyEngine = require('./strategy');

const BOT_STATES = {
  IDLE: 'IDLE',
  SCANNING: 'SCANNING',
  BETTING: 'BETTING',
  WAITING: 'WAITING',
  TARGET_HIT: 'TARGET_HIT',
  SELF_DESTRUCTING: 'SELF_DESTRUCTING',
  DEAD: 'DEAD',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
};

class YoloEngine extends EventEmitter {
  constructor(config) {
    super();

    this.config = {
      startingBankroll: config.startingBankroll || 10000, // cents
      targetBankroll: config.targetBankroll || 1000000,   // cents ($10,000)
      timeLimitHours: config.timeLimitHours || 48,
      scanIntervalSeconds: config.scanIntervalSeconds || 30,
      strategyMode: config.strategyMode || 'edge_hunter',
      maxBetFraction: config.maxBetFraction || 0.5,
      minEdge: config.minEdge || 0.05,
      destructMode: config.destructMode || 'withdraw',
      dryRun: config.dryRun || false,
    };

    // Initialize components
    this.client = new KalshiClient({
      apiKeyId: config.apiKeyId,
      privateKeyPath: config.privateKeyPath,
      env: config.env || 'demo',
    });

    this.scanner = new MarketScanner(this.client);
    this.strategy = new StrategyEngine({
      mode: this.config.strategyMode,
      maxBetFraction: this.config.maxBetFraction,
      minEdge: this.config.minEdge,
    });

    // State
    this.state = BOT_STATES.IDLE;
    this.startTime = null;
    this.bankroll = 0;
    this.peakBankroll = 0;
    this.positions = [];
    this.pendingBets = [];
    this.scanInterval = null;
    this.positionCheckInterval = null;
    this.activeBet = null;
    this.activeOrders = new Map();
    this.processedFills = new Set();
    this.countedFills = new Set();
    this.totalBetsPlaced = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.totalWagered = 0;

    // Event log
    this.eventLog = [];
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async start() {
    console.log('\n');
    console.log('  ╔═══════════════════════════════════════════╗');
    console.log('  ║         🎰  YOLO ENGINE v1.0  🎰         ║');
    console.log('  ║                                           ║');
    console.log(`  ║  Target: $${(this.config.targetBankroll / 100).toLocaleString().padStart(8)}                      ║`);
    console.log(`  ║  Time:   ${this.config.timeLimitHours}h countdown                   ║`);
    console.log(`  ║  Mode:   ${this.config.strategyMode.padEnd(20)}          ║`);
    console.log(`  ║  Dry Run: ${this.config.dryRun ? 'YES' : 'NO '}                            ║`);
    console.log('  ╚═══════════════════════════════════════════╝');
    console.log('\n');

    this.startTime = Date.now();
    this.state = BOT_STATES.SCANNING;

    // Get initial balance
    try {
      const balance = await this.client.getBalance();
      this.bankroll = balance; // Already in cents
      this.peakBankroll = this.bankroll;
      this._log('START', `Initial balance: $${(this.bankroll / 100).toFixed(2)}`);
      this.emit('status', this.getStatus());
    } catch (e) {
      this._log('ERROR', `Failed to get balance: ${e.message}`);
      if (this.config.dryRun) {
        this.bankroll = this.config.startingBankroll;
        this.peakBankroll = this.bankroll;
        this._log('DRY_RUN', `Using simulated balance: $${(this.bankroll / 100).toFixed(2)}`);
      } else {
        this.state = BOT_STATES.ERROR;
        this.emit('error', e);
        return;
      }
    }

    // Start the main loop
    this._runCycle();
    this.scanInterval = setInterval(() => this._runCycle(), this.config.scanIntervalSeconds * 1000);

    // Check positions every 10 seconds
    this.positionCheckInterval = setInterval(() => this._checkPositions(), 10000);

    this._log('RUNNING', `Bot started. Scanning every ${this.config.scanIntervalSeconds}s`);
    this.emit('started', this.getStatus());
  }

  async stop() {
    this._log('STOPPING', 'Bot shutting down...');
    clearInterval(this.scanInterval);
    clearInterval(this.positionCheckInterval);
    this.state = BOT_STATES.IDLE;
    this.emit('stopped', this.getStatus());
  }

  pause() {
    this.state = BOT_STATES.PAUSED;
    this._log('PAUSED', 'Bot paused by user');
    this.emit('status', this.getStatus());
  }

  resume() {
    this.state = BOT_STATES.SCANNING;
    this._log('RESUMED', 'Bot resumed');
    this.emit('status', this.getStatus());
  }

  // ─── Main Cycle ───────────────────────────────────────────────

  async _runCycle() {
    if (this.state === BOT_STATES.PAUSED || this.state === BOT_STATES.DEAD) return;

    try {
      // Check countdown
      const timeRemaining = this._getTimeRemaining();
      if (timeRemaining <= 0) {
        await this._selfDestruct('TIME_EXPIRED');
        return;
      }

      // Check if we hit the target
      if (this.bankroll >= this.config.targetBankroll) {
        this.state = BOT_STATES.TARGET_HIT;
        this._log('🎉 TARGET HIT', `Balance: $${(this.bankroll / 100).toFixed(2)} — WE MADE IT!`);
        this.emit('target_hit', this.getStatus());
        await this.stop();
        return;
      }

      // Check if we're busted
      if (this.bankroll <= 0 && !this.config.dryRun) {
        await this._selfDestruct('BANKROLL_ZERO');
        return;
      }

      // Scan for opportunities
      this.state = BOT_STATES.SCANNING;
      this.emit('status', this.getStatus());

      const opportunities = await this.scanner.scanMarkets();

      if (opportunities.length === 0) {
        this._log('SCAN', 'No opportunities found this cycle');
        this.state = BOT_STATES.WAITING;
        this.emit('status', this.getStatus());
        return;
      }

      // Get strategy decision(s) — may return multiple bets
      const bets = this.strategy.decideBets
        ? this.strategy.decideBets(opportunities, this.bankroll, timeRemaining / (1000 * 60 * 60))
        : [this.strategy.decideBet(opportunities, this.bankroll, timeRemaining / (1000 * 60 * 60))].filter(Boolean);

      if (!bets || bets.length === 0) {
        this._log('STRATEGY', 'No viable bets this cycle — waiting');
        this.state = BOT_STATES.WAITING;
        this.emit('status', this.getStatus());
        return;
      }

      // Execute each bet
      for (const bet of bets) {
        // Skip if we already have a position on this ticker
        if (this.strategy.activePositionTickers && this.strategy.activePositionTickers.has(bet.ticker)) {
          this._log('SKIP', `Already positioned in ${bet.ticker}`);
          continue;
        }

        // Check we still have enough bankroll
        if (bet.totalCost > this.bankroll && !this.config.dryRun) {
          this._log('SKIP', `Not enough bankroll for ${bet.ticker} (need ${bet.totalCost}¢, have ${this.bankroll}¢)`);
          continue;
        }

        this._log('BET', bet.reasoning);
        this.emit('bet_signal', { bet, opportunities: opportunities.slice(0, 5) });

        if (!this.config.dryRun) {
          await this._executeBet(bet);
          await new Promise(r => setTimeout(r, 500)); // Rate limit between orders
        } else {
          this._simulateBet(bet);
        }
      }
    } catch (e) {
      this._log('ERROR', `Cycle error: ${e.message}`);
      this.state = BOT_STATES.ERROR;
      this.emit('error', { message: e.message, stack: e.stack });

      // Don't crash — retry next cycle
      setTimeout(() => {
        if (this.state === BOT_STATES.ERROR) this.state = BOT_STATES.SCANNING;
      }, 5000);
    }
  }

  // ─── Bet Execution ────────────────────────────────────────────

  async _executeBet(bet) {
    this.state = BOT_STATES.BETTING;
    this.emit('status', this.getStatus());

    try {
      // Get live orderbook to find actual ask price
      let fillPrice = bet.pricePerContract;
      try {
        const ob = await this.client.getOrderbook(bet.ticker, 5);
        const yesBids = ob?.yes || [];
        const noBids = ob?.no || [];
        
        if (bet.side === 'yes' && noBids.length > 0) {
          const bestNoBid = Array.isArray(noBids[0]) ? noBids[0][0] : noBids[0];
          const yesAsk = 100 - bestNoBid;
          fillPrice = Math.max(fillPrice, yesAsk);
          this._log('ORDERBOOK', `YES ask: ${yesAsk}¢ (from NO bid: ${bestNoBid}¢)`);
        } else if (bet.side === 'no' && yesBids.length > 0) {
          const bestYesBid = Array.isArray(yesBids[0]) ? yesBids[0][0] : yesBids[0];
          const noAsk = 100 - bestYesBid;
          fillPrice = Math.max(fillPrice, noAsk);
          this._log('ORDERBOOK', `NO ask: ${noAsk}¢ (from YES bid: ${bestYesBid}¢)`);
        }
        
        fillPrice = Math.min(fillPrice + 2, 95);
      } catch (e) {
        this._log('ORDERBOOK', `Couldn't fetch orderbook, using scanner price: ${fillPrice}¢`);
      }

      // Recalculate contracts at the actual fill price
      const maxSpend = bet.totalCost + (bet.totalCost * 0.1);
      const numContracts = Math.max(1, Math.floor(Math.min(this.bankroll, maxSpend) / fillPrice));
      
      this._log('EXEC', `${bet.side.toUpperCase()} ${numContracts}x ${bet.ticker} @ ${fillPrice}¢ (scanner: ${bet.pricePerContract}¢)`);

      const order = await this.client.createOrder({
        ticker: bet.ticker,
        side: bet.side,
        action: bet.action,
        count: numContracts,
        type: 'limit',
        yesPrice: bet.side === 'yes' ? fillPrice : undefined,
        noPrice: bet.side === 'no' ? fillPrice : undefined,
        clientOrderId: crypto.randomUUID(),
      });

      const trackedOrder = {
        ...bet,
        fillPrice,
        numContracts,
        totalCost: numContracts * fillPrice,
        orderId: order.order_id,
        status: order.status,
        placedAt: Date.now(),
      };

      // Track in active orders map
      this.activeOrders.set(order.order_id, trackedOrder);
      this.activeBet = trackedOrder; // Keep for backward compat with dashboard

      this._log('ORDER', `Placed: ${order.order_id} | Status: ${order.status} | Cost: $${(trackedOrder.totalCost / 100).toFixed(2)}`);
      this.emit('order_placed', trackedOrder);
      this.emit('bet_signal', { bet: trackedOrder, opportunities: [] });

      // Track position in strategy engine
      if (this.strategy.markPositionActive) {
        this.strategy.markPositionActive(bet.ticker);
      }

      // If immediately filled, record it
      if (order.status === 'executed' || order.status === 'filled') {
        this.totalBetsPlaced++;
        this.totalWagered += trackedOrder.totalCost;
        this._log('FILLED', `✓ ${bet.ticker} filled immediately | ${numContracts} contracts @ ${fillPrice}¢`);
        this.emit('bet_result', { ...trackedOrder, outcome: 'placed', profit: 0 });
      }

      this.state = BOT_STATES.WAITING;
      this.emit('status', this.getStatus());
    } catch (e) {
      this._log('ORDER_ERROR', `Failed to place order: ${e.message}`);
      this.state = BOT_STATES.SCANNING;
      this.emit('order_error', { bet, error: e.message });
    }
  }

  _simulateBet(bet) {
    this.state = BOT_STATES.BETTING;

    const roll = Math.random();
    const winProb = 0.1 + (bet.pricePerContract / 100) * 0.8;

    const simResult = {
      ...bet,
      orderId: `SIM-${crypto.randomUUID().slice(0, 8)}`,
      status: 'simulated',
      placedAt: Date.now(),
    };

    this.totalBetsPlaced++;
    this.totalWagered += bet.totalCost;

    if (roll < winProb) {
      const profit = bet.potentialPayout - bet.totalCost;
      this.bankroll += profit;
      this.peakBankroll = Math.max(this.peakBankroll, this.bankroll);
      this.totalWins++;
      this.strategy.recordBet(bet, 'win');
      this._log('SIM_WIN', `+$${(profit / 100).toFixed(2)} | New balance: $${(this.bankroll / 100).toFixed(2)}`);
      this.emit('bet_result', { ...simResult, outcome: 'win', profit });
    } else {
      this.bankroll -= bet.totalCost;
      this.totalLosses++;
      this.strategy.recordBet(bet, 'loss');
      this._log('SIM_LOSS', `-$${(bet.totalCost / 100).toFixed(2)} | New balance: $${(this.bankroll / 100).toFixed(2)}`);
      this.emit('bet_result', { ...simResult, outcome: 'loss', profit: -bet.totalCost });
    }

    this.activeBet = null;
    this.state = BOT_STATES.WAITING;
    this.emit('status', this.getStatus());
  }

  // ─── Position Monitoring ──────────────────────────────────────

  async _checkPositions() {
    if (this.config.dryRun || this.state === BOT_STATES.DEAD) return;

    try {
      // Refresh balance
      const newBalance = await this.client.getBalance();
      const balanceChange = newBalance - this.bankroll;
      this.bankroll = newBalance;
      this.peakBankroll = Math.max(this.peakBankroll, this.bankroll);

      // Check for balance changes (indicates a fill or settlement)
      if (balanceChange !== 0 && this.totalBetsPlaced > 0) {
        if (balanceChange > 0) {
          this._log('💰 PROFIT', `Balance +$${(balanceChange / 100).toFixed(2)} → $${(this.bankroll / 100).toFixed(2)}`);
        } else {
          this._log('📉 SPENT', `Balance $${(balanceChange / 100).toFixed(2)} → $${(this.bankroll / 100).toFixed(2)}`);
        }
      }

      // Check current positions
      this.positions = await this.client.getPositions({ limit: 100 });

      // Check fills to track what actually executed
      try {
        const fills = await this.client.getFills({ limit: 20 });
        this._processFills(fills);
      } catch (e) {
        // Non-fatal
      }

      // Cancel stale resting orders (older than 90 seconds)
      for (const [orderId, order] of this.activeOrders) {
        const age = Date.now() - (order.placedAt || 0);
        if (age > 90000) {
          try {
            await this.client.cancelOrder(orderId);
            this._log('CANCEL', `Stale order ${orderId.slice(0, 8)}... cancelled after ${Math.round(age / 1000)}s`);
          } catch (e) {
            // Already filled or cancelled
          }
          this.activeOrders.delete(orderId);
          if (this.strategy.markPositionClosed) {
            this.strategy.markPositionClosed(order.ticker);
          }
        }
      }

      this.emit('positions_update', {
        bankroll: this.bankroll,
        positions: this.positions,
        peakBankroll: this.peakBankroll,
      });
      this.emit('status', this.getStatus());
    } catch (e) {
      console.warn(`[BOT] Position check failed: ${e.message}`);
    }
  }

  _processFills(fills) {
    if (!fills || fills.length === 0) return;

    for (const fill of fills) {
      const fillId = fill.trade_id || fill.order_id;
      if (this.processedFills.has(fillId)) continue;
      this.processedFills.add(fillId);

      // Only track recent fills (last 5 minutes)
      const fillTime = fill.created_time ? new Date(fill.created_time).getTime() : Date.now();
      if (Date.now() - fillTime > 300000) continue;

      const side = fill.side || 'unknown';
      const count = fill.count || 0;
      const price = fill.yes_price || fill.no_price || 0;
      const ticker = fill.ticker || 'unknown';

      if (!this.processedFills.has(`logged-${fillId}`)) {
        this.processedFills.add(`logged-${fillId}`);
        this._log('FILL', `${side.toUpperCase()} ${count}x ${ticker} @ ${price}¢`);
        
        // Count as a placed bet
        if (!this.countedFills.has(fillId)) {
          this.countedFills.add(fillId);
          this.totalBetsPlaced++;
          this.totalWagered += count * price;
        }
      }
    }
  }

  // ─── Self-Destruct ────────────────────────────────────────────

  async _selfDestruct(reason) {
    this.state = BOT_STATES.SELF_DESTRUCTING;
    this._log('💀 SELF-DESTRUCT', `Reason: ${reason}`);
    this.emit('self_destruct_initiated', { reason });

    clearInterval(this.scanInterval);
    clearInterval(this.positionCheckInterval);

    switch (this.config.destructMode) {
      case 'withdraw':
        await this._destructWithdraw();
        break;
      case 'halt':
        this._log('HALT', 'Bot halted. Positions left open.');
        break;
      case 'nuke':
        await this._destructNuke();
        break;
    }

    this.state = BOT_STATES.DEAD;

    const finalStatus = this.getStatus();
    this._log('DEAD', `Final balance: $${(this.bankroll / 100).toFixed(2)} | Peak: $${(this.peakBankroll / 100).toFixed(2)}`);
    this.emit('self_destruct_complete', finalStatus);
    this.emit('status', finalStatus);
  }

  async _destructWithdraw() {
    this._log('DESTRUCT', 'Cancelling all open orders...');
    try {
      if (!this.config.dryRun) {
        const cancelled = await this.client.cancelAllOrders();
        this._log('DESTRUCT', `Cancelled ${cancelled.length} orders`);
      }
    } catch (e) {
      this._log('DESTRUCT_ERROR', `Failed to cancel orders: ${e.message}`);
    }
  }

  async _destructNuke() {
    await this._destructWithdraw();
    this._log('NUKE', '🔥 Config files marked for deletion. Bot is permanently dead.');
    // In a real deployment, you might:
    // - Delete the .env file
    // - Revoke the API key
    // - Send a final notification
  }

  // ─── Status & Helpers ─────────────────────────────────────────

  _getTimeRemaining() {
    if (!this.startTime) return this.config.timeLimitHours * 60 * 60 * 1000;
    const elapsed = Date.now() - this.startTime;
    const limit = this.config.timeLimitHours * 60 * 60 * 1000;
    return Math.max(0, limit - elapsed);
  }

  getStatus() {
    const timeRemaining = this._getTimeRemaining();
    const elapsed = this.startTime ? Date.now() - this.startTime : 0;
    const progress = this.bankroll / this.config.targetBankroll;
    const strategyStats = this.strategy.getStats();

    // Merge bot-level live tracking with strategy stats
    const stats = {
      ...strategyStats,
      totalBets: this.totalBetsPlaced || strategyStats.totalBets,
      wins: this.totalWins || strategyStats.wins,
      losses: this.totalLosses || strategyStats.losses,
      winRate: this.totalBetsPlaced > 0 
        ? this.totalWins / this.totalBetsPlaced 
        : strategyStats.winRate,
      totalWagered: this.totalWagered || strategyStats.totalWagered || 0,
    };

    return {
      state: this.state,
      bankroll: this.bankroll,
      bankrollDollars: (this.bankroll / 100).toFixed(2),
      peakBankroll: this.peakBankroll,
      peakBankrollDollars: (this.peakBankroll / 100).toFixed(2),
      targetBankroll: this.config.targetBankroll,
      targetDollars: (this.config.targetBankroll / 100).toFixed(2),
      progress: Math.round(progress * 10000) / 100,
      startTime: this.startTime,
      elapsed,
      elapsedFormatted: this._formatDuration(elapsed),
      timeRemaining,
      timeRemainingFormatted: this._formatDuration(timeRemaining),
      countdown: {
        hours: Math.floor(timeRemaining / (1000 * 60 * 60)),
        minutes: Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((timeRemaining % (1000 * 60)) / 1000),
      },
      strategy: this.config.strategyMode,
      dryRun: this.config.dryRun,
      stats,
      activeBet: this.activeBet,
      activeOrders: Array.from(this.activeOrders.values()),
      positionCount: this.positions.length,
      positions: this.positions,
      eventLog: this.eventLog.slice(-100),
    };
  }

  _formatDuration(ms) {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((ms % (1000 * 60)) / 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  _log(type, message) {
    const entry = {
      timestamp: Date.now(),
      time: new Date().toISOString(),
      type,
      message,
    };
    this.eventLog.push(entry);
    console.log(`[${type}] ${message}`);
    this.emit('log', entry);
  }
}

module.exports = { YoloEngine, BOT_STATES };
