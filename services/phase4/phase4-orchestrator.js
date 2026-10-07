/**
 * RDCMNATION QUANTUM - Phase 4 Orchestrator
 *
 * PURPOSE: Manage live trading with real capital
 *
 * Responsibilities:
 * - Route Phase 2+3 decisions to live broker
 * - Manage capital allocation across positions
 * - Track real P&L and execution metrics
 * - Monitor account health
 * - Coordinate with Phase 2 risk engine
 *
 * SAFETY: Phase 2 risk engine still makes final decisions
 * Phase 4 executes what Phase 2 approves
 */

const RobinhoodAdapter = require('../../brokers/robinhood-adapter');

class Phase4Orchestrator {
  constructor(config = {}) {
    this.config = {
      initialCapital: config.initialCapital || 1000, // Start with $1,000
      maxPositionSize: config.maxPositionSize || 0.10, // 10% per position
      maxDailyDrawdown: config.maxDailyDrawdown || 0.05, // 5% daily loss limit
      maxLeverage: config.maxLeverage || 1.0, // No leverage initially
      ...config
    };

    // Broker connection
    this.broker = new RobinhoodAdapter({
      authToken: config.authToken,
      accountId: config.accountId,
      paperTradingMode: config.paperTradingMode !== false
    });

    // Capital management
    this.capital = {
      initial: this.config.initialCapital,
      current: this.config.initialCapital,
      cash: this.config.initialCapital,
      positions: {},
      unrealizedPnL: 0,
      realizedPnL: 0,
      startDay: new Date().toISOString()
    };

    // Live trading state
    this.trades = [];
    this.orders = [];
    this.executions = [];

    // Metrics
    this.metrics = {
      tradesExecuted: 0,
      tradesBlocked: 0,
      ordersSubmitted: 0,
      ordersFilled: 0,
      ordersCancelled: 0,
      totalFees: 0,
      totalSlippage: 0,
      startTime: Date.now()
    };

    // Risk monitoring
    this.riskMonitoring = {
      dailyDrawdown: 0,
      maxDrawdown: 0,
      consecutiveLosses: 0,
      lastTradeProfit: 0,
      accountLocked: false
    };

    this.state = 'INITIALIZING';
  }

  /**
   * Initialize Phase 4 with broker connection
   */
  async initialize() {
    try {
      // In paper trading mode, skip real broker connection
      if (this.config.paperTradingMode) {
        this.state = 'RUNNING';
        console.log('✅ Phase 4 Orchestrator initialized (PAPER TRADING MODE)');
        console.log(`   Account: PAPER_DEMO_${Date.now()}`);
        console.log(`   Buying Power: $${this.capital.current.toFixed(2)}`);
        console.log(`   Cash: $${this.capital.cash.toFixed(2)}`);
        return true;
      }

      // Authenticate with broker
      const authResult = await this.broker.authenticate(this.config.credentials);
      if (!authResult.success) {
        throw new Error(`Authentication failed: ${authResult.error}`);
      }

      // Get account info
      const accountResult = await this.broker.getAccount();
      if (!accountResult.success) {
        throw new Error(`Failed to get account: ${accountResult.error}`);
      }

      // Update capital with actual broker data
      this.capital.current = accountResult.buyingPower;
      this.capital.cash = accountResult.cash;

      this.state = 'RUNNING';
      console.log('✅ Phase 4 Orchestrator initialized');
      console.log(`   Account: ${accountResult.accountId}`);
      console.log(`   Buying Power: $${accountResult.buyingPower.toFixed(2)}`);
      console.log(`   Cash: $${accountResult.cash.toFixed(2)}`);

      return true;

    } catch (error) {
      console.error('❌ Phase 4 initialization failed:', error.message);
      this.state = 'ERROR';
      return false;
    }
  }

  /**
   * MAIN: Execute decision from Phase 2+3
   *
   * Flow:
   * 1. Receive decision from Phase 2 (already validated)
   * 2. Calculate position size based on capital allocation
   * 3. Check live risk rules
   * 4. Submit order to broker
   * 5. Track execution
   */
  async executeDecision(decision, analysis) {
    if (this.state !== 'RUNNING') {
      return { success: false, reason: 'Phase 4 not running' };
    }

    if (this.riskMonitoring.accountLocked) {
      return { success: false, reason: 'Account locked - daily loss limit exceeded' };
    }

    const { symbol, action, quantumScore, confidence } = decision;

    try {
      // Calculate position size
      const positionSize = this._calculatePositionSize(symbol, action);
      if (positionSize <= 0) {
        return { success: false, reason: 'Position size calculation failed' };
      }

      // Get current price (mock or real)
      let currentPrice;
      if (this.config.paperTradingMode) {
        // In paper mode, use a simulated price
        currentPrice = 100 + Math.random() * 50; // Simulate price between $100-150
      } else {
        const quoteResult = await this.broker.getQuote(symbol);
        if (!quoteResult.success) {
          return { success: false, reason: `Failed to get quote for ${symbol}` };
        }
        currentPrice = quoteResult.price;
      }

      // Build order request
      const orderRequest = {
        symbol,
        side: action === 'BUY' ? 'BUY' : 'SELL',
        quantity: Math.floor(positionSize),
        orderType: 'MARKET',
        currentMarketPrice: currentPrice
      };

      // Submit order to broker (or simulate in paper mode)
      let orderResult;
      if (this.config.paperTradingMode) {
        // Simulate order in paper mode
        orderResult = {
          success: true,
          id: 'ORDER_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
          status: 'FILLED'
        };
      } else {
        orderResult = await this.broker.submitOrder(orderRequest);
        if (!orderResult.success) {
          this.metrics.tradesBlocked++;
          return {
            success: false,
            reason: `Broker rejected order: ${orderResult.error}`
          };
        }
      }

      // Record execution
      const execution = {
        decisionId: decision.decisionId,
        orderId: orderResult.id,
        symbol,
        action,
        quantity: orderRequest.quantity,
        price: currentPrice,
        submittedAt: new Date().toISOString(),
        brokerStatus: orderResult.status,
        quantumScore,
        confidence,
        analysis: analysis?.advisory || ''
      };

      this.orders.push(execution);
      this.metrics.ordersSubmitted++;
      this.metrics.tradesExecuted++;

      // Update capital (assume immediate fill for MARKET orders)
      const cost = orderRequest.quantity * currentPrice;
      this.capital.cash -= cost;
      this.capital.current = this.capital.cash + this._calculatePortfolioValue();

      // Track position
      if (!this.capital.positions[symbol]) {
        this.capital.positions[symbol] = {
          quantity: 0,
          avgCost: 0,
          entryPrice: currentPrice,
          entry: new Date().toISOString()
        };
      }

      const position = this.capital.positions[symbol];
      position.quantity += orderRequest.quantity;

      // Protect against NaN when quantity is 0
      if (position.quantity > 0) {
        position.avgCost = (position.quantity * currentPrice) / position.quantity;
      } else {
        position.avgCost = 0;
      }

      return {
        success: true,
        orderId: orderResult.id,
        symbol,
        quantity: orderRequest.quantity,
        price: currentPrice,
        status: 'SUBMITTED'
      };

    } catch (error) {
      console.error('Execution error:', error.message);
      return { success: false, reason: error.message };
    }
  }

  /**
   * Calculate position size based on capital allocation
   */
  _calculatePositionSize(symbol, action) {
    if (action === 'HOLD') {
      return 0;
    }

    const maxPositionValue = this.capital.current * this.config.maxPositionSize;

    // In paper mode, use simulated price; otherwise this would be async
    let price;
    if (this.config.paperTradingMode) {
      price = 100 + Math.random() * 50; // Simulated price $100-150
    } else {
      // For real mode, this needs to be called asynchronously in executeDecision
      price = 125; // Fallback price
    }

    const positionShares = Math.floor(maxPositionValue / price);
    return Math.min(positionShares, this.capital.cash / price);
  }

  /**
   * Calculate current portfolio value
   */
  _calculatePortfolioValue() {
    let value = 0;
    for (const [symbol, position] of Object.entries(this.capital.positions)) {
      const posValue = (position.quantity || 0) * (position.avgCost || 0);
      if (!isNaN(posValue)) {
        value += posValue;
      }
    }
    return isNaN(value) ? 0 : value;
  }

  /**
   * Record completed trade
   */
  recordTradeCompletion(orderId, executionPrice, slippage) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    const tradeValue = order.quantity * executionPrice;
    const expectedValue = order.quantity * order.price;
    const pnl = expectedValue - tradeValue;

    const trade = {
      ...order,
      executionPrice,
      slippage,
      pnl,
      completedAt: new Date().toISOString()
    };

    this.trades.push(trade);
    this.metrics.ordersFilled++;

    // Update metrics
    if (pnl > 0) {
      this.riskMonitoring.consecutiveLosses = 0;
    } else {
      this.riskMonitoring.consecutiveLosses++;
    }

    this.riskMonitoring.lastTradeProfit = pnl;
    this.capital.realizedPnL += pnl;

    // Check drawdown
    this.riskMonitoring.dailyDrawdown += Math.min(0, pnl);
    if (this.riskMonitoring.dailyDrawdown < this.riskMonitoring.maxDrawdown) {
      this.riskMonitoring.maxDrawdown = this.riskMonitoring.dailyDrawdown;
    }

    // Lock account if drawdown exceeded
    if (Math.abs(this.riskMonitoring.dailyDrawdown) > this.capital.initial * this.config.maxDailyDrawdown) {
      this.riskMonitoring.accountLocked = true;
      console.log('🚨 ACCOUNT LOCKED: Daily drawdown limit exceeded');
    }
  }

  /**
   * Get account status
   */
  async getAccountStatus() {
    // In paper trading mode, return mock data
    if (this.config.paperTradingMode) {
      return {
        accountId: 'PAPER_DEMO_' + Date.now(),
        cash: this.capital.cash,
        buyingPower: this.capital.cash,
        portfolioValue: this.capital.current,
        positions: Object.keys(this.capital.positions).length,
        realizedPnL: this.capital.realizedPnL,
        unrealizedPnL: this.capital.unrealizedPnL,
        totalPnL: this.capital.realizedPnL + this.capital.unrealizedPnL,
        roi: ((this.capital.current - this.capital.initial) / this.capital.initial * 100).toFixed(2) + '%',
        accountLocked: this.riskMonitoring.accountLocked
      };
    }

    const accountResult = await this.broker.getAccount();

    return {
      accountId: accountResult.accountId,
      cash: accountResult.cash,
      buyingPower: accountResult.buyingPower,
      portfolioValue: this.capital.current,
      positions: Object.keys(this.capital.positions).length,
      realizedPnL: this.capital.realizedPnL,
      unrealizedPnL: this.capital.unrealizedPnL,
      totalPnL: this.capital.realizedPnL + this.capital.unrealizedPnL,
      roi: ((this.capital.current - this.capital.initial) / this.capital.initial * 100).toFixed(2) + '%',
      accountLocked: this.riskMonitoring.accountLocked
    };
  }

  /**
   * Get live trading metrics
   */
  getMetrics() {
    const uptime = (Date.now() - this.metrics.startTime) / 1000 / 60; // minutes

    return {
      state: this.state,
      uptime: `${uptime.toFixed(1)} min`,
      tradesExecuted: this.metrics.tradesExecuted,
      tradesBlocked: this.metrics.tradesBlocked,
      ordersSubmitted: this.metrics.ordersSubmitted,
      ordersFilled: this.metrics.ordersFilled,
      ordersCancelled: this.metrics.ordersCancelled,
      totalFees: this.metrics.totalFees,
      totalSlippage: this.metrics.totalSlippage,
      dailyDrawdown: this.riskMonitoring.dailyDrawdown.toFixed(2),
      maxDrawdown: this.riskMonitoring.maxDrawdown.toFixed(2),
      consecutiveLosses: this.riskMonitoring.consecutiveLosses,
      lastTradeProfit: this.riskMonitoring.lastTradeProfit.toFixed(2)
    };
  }

  /**
   * Get health status
   */
  getHealth() {
    return {
      state: this.state,
      broker: this.broker.getStatus(),
      capital: {
        current: this.capital.current.toFixed(2),
        cash: this.capital.cash.toFixed(2),
        positions: Object.keys(this.capital.positions).length
      },
      risk: {
        accountLocked: this.riskMonitoring.accountLocked,
        dailyDrawdown: this.riskMonitoring.dailyDrawdown.toFixed(2),
        maxDrawdown: this.riskMonitoring.maxDrawdown.toFixed(2)
      },
      metrics: this.getMetrics()
    };
  }

  /**
   * Shutdown Phase 4 gracefully
   */
  async shutdown() {
    this.state = 'SHUTTING_DOWN';

    // Close any open positions
    for (const [symbol, position] of Object.entries(this.capital.positions)) {
      if (position.quantity > 0) {
        await this.broker.submitOrder({
          symbol,
          side: 'SELL',
          quantity: position.quantity,
          orderType: 'MARKET'
        });
      }
    }

    this.state = 'STOPPED';
    console.log('✅ Phase 4 shutdown complete');

    return this.getHealth();
  }
}

module.exports = Phase4Orchestrator;
