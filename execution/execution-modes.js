/**
 * RDCMNATION QUANTUM - Execution Modes
 *
 * Abstraction layer supporting LIVE vs SHADOW execution.
 * Same order interface, different backends.
 * Enables: Test new strategies in shadow mode while production runs live.
 */

class ExecutionMode {
  static LIVE = 'LIVE';
  static SHADOW = 'SHADOW';
  static SIMULATION = 'SIMULATION';

  static isValid(mode) {
    return [ExecutionMode.LIVE, ExecutionMode.SHADOW, ExecutionMode.SIMULATION].includes(mode);
  }
}

/**
 * Base execution interface (implemented by LIVE and SHADOW)
 */
class BaseExecutor {
  constructor(mode) {
    this.mode = mode;
    this.executedOrders = [];
    this.executionLog = [];
  }

  /**
   * Submit order - implemented by subclasses
   */
  async submitOrder(orderRequest) {
    throw new Error('submitOrder() must be implemented by subclass');
  }

  /**
   * Cancel order - implemented by subclasses
   */
  async cancelOrder(orderId) {
    throw new Error('cancelOrder() must be implemented by subclass');
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId) {
    throw new Error('getOrderStatus() must be implemented by subclass');
  }

  /**
   * Get all orders
   */
  getOrders() {
    return this.executedOrders;
  }

  /**
   * Log execution event
   */
  logEvent(event) {
    this.executionLog.push({
      timestamp: new Date().toISOString(),
      mode: this.mode,
      ...event
    });
  }
}

/**
 * LIVE Executor - Actually submits orders to broker
 */
class LiveExecutor extends BaseExecutor {
  constructor(brokerAdapter) {
    super(ExecutionMode.LIVE);
    this.brokerAdapter = brokerAdapter;
  }

  /**
   * Submit order to real broker
   */
  async submitOrder(orderRequest) {
    const {
      orderId,
      symbol,
      side,
      quantity,
      orderType,
      price,
      stopPrice,
      timeInForce
    } = orderRequest;

    try {
      console.log(`📤 LIVE: Submitting order to broker: ${symbol} ${side} ${quantity}`);

      // Call actual broker adapter
      const brokerOrder = await this.brokerAdapter.submitOrder({
        symbol,
        side,
        quantity,
        orderType,
        price,
        stopPrice,
        timeInForce
      });

      const order = {
        orderId,
        brokerOrderId: brokerOrder.id,
        symbol,
        side,
        quantity,
        status: 'SUBMITTED',
        submittedAt: new Date().toISOString(),
        brokerResponse: brokerOrder,
        mode: this.mode
      };

      this.executedOrders.push(order);
      this.logEvent({
        type: 'ORDER_SUBMITTED',
        orderId,
        symbol,
        status: 'SUCCESS'
      });

      return {
        success: true,
        orderId,
        brokerOrderId: brokerOrder.id,
        status: 'SUBMITTED'
      };

    } catch (error) {
      this.logEvent({
        type: 'ORDER_SUBMITTED',
        orderId,
        symbol,
        status: 'FAILED',
        error: error.message
      });

      return {
        success: false,
        error: error.message,
        orderId
      };
    }
  }

  /**
   * Cancel order with broker
   */
  async cancelOrder(orderId) {
    try {
      const order = this.executedOrders.find(o => o.orderId === orderId);
      if (!order) {
        return { error: 'Order not found', orderId };
      }

      console.log(`🛑 LIVE: Cancelling order: ${orderId}`);

      const result = await this.brokerAdapter.cancelOrder(order.brokerOrderId);

      order.status = 'CANCELLED';
      order.cancelledAt = new Date().toISOString();

      this.logEvent({
        type: 'ORDER_CANCELLED',
        orderId,
        status: 'SUCCESS'
      });

      return { success: true, orderId };

    } catch (error) {
      this.logEvent({
        type: 'ORDER_CANCELLED',
        orderId,
        status: 'FAILED',
        error: error.message
      });

      return { error: error.message, orderId };
    }
  }

  /**
   * Get order status from broker
   */
  async getOrderStatus(orderId) {
    const order = this.executedOrders.find(o => o.orderId === orderId);
    if (!order) {
      return null;
    }

    // Query broker for latest status
    const status = await this.brokerAdapter.getOrderStatus(order.brokerOrderId);
    order.status = status.status;
    order.filled = status.filled;
    order.avgFillPrice = status.avgFillPrice;

    return order;
  }
}

/**
 * SHADOW Executor - Simulates orders without hitting broker
 * Perfect for testing new strategies in parallel with production
 */
class ShadowExecutor extends BaseExecutor {
  constructor(marketDataProvider = null) {
    super(ExecutionMode.SHADOW);
    this.marketDataProvider = marketDataProvider;
    this.shadowPortfolio = {};
    this.simulationSpeed = 1.0; // 1.0 = real-time, 2.0 = 2x speed
  }

  /**
   * Simulate order execution
   * Does NOT submit to broker
   */
  async submitOrder(orderRequest) {
    const {
      orderId,
      symbol,
      side,
      quantity,
      orderType,
      price,
      currentMarketPrice
    } = orderRequest;

    try {
      console.log(`🌑 SHADOW: Simulating order: ${symbol} ${side} ${quantity}`);

      // Simulate execution with market data
      const executionPrice = this.calculateExecutionPrice(
        orderType,
        side,
        price,
        currentMarketPrice
      );

      // Simulate slippage
      const slippage = this.calculateSlippage(quantity, currentMarketPrice);
      const finalPrice = side === 'BUY' ? executionPrice + slippage : executionPrice - slippage;

      // Create simulated order
      const order = {
        orderId,
        symbol,
        side,
        quantity,
        status: 'FILLED',
        submittedAt: new Date().toISOString(),
        filledAt: new Date().toISOString(),
        submittedPrice: price || currentMarketPrice,
        executionPrice: finalPrice,
        slippage: slippage,
        estimatedCost: quantity * finalPrice,
        mode: this.mode,
        isSimulated: true
      };

      this.executedOrders.push(order);

      // Update shadow portfolio
      this.updateShadowPortfolio(symbol, side, quantity, finalPrice);

      this.logEvent({
        type: 'ORDER_SIMULATED',
        orderId,
        symbol,
        status: 'FILLED',
        executionPrice: finalPrice
      });

      return {
        success: true,
        orderId,
        status: 'FILLED',
        executionPrice: finalPrice,
        slippage: slippage,
        note: 'SIMULATED - NOT SENT TO BROKER'
      };

    } catch (error) {
      this.logEvent({
        type: 'ORDER_SIMULATED',
        orderId,
        symbol,
        status: 'FAILED',
        error: error.message
      });

      return {
        success: false,
        error: error.message,
        orderId
      };
    }
  }

  /**
   * Cancel simulated order
   */
  async cancelOrder(orderId) {
    const order = this.executedOrders.find(o => o.orderId === orderId);
    if (!order) {
      return { error: 'Order not found', orderId };
    }

    if (order.status === 'FILLED') {
      return {
        error: 'Cannot cancel filled order',
        orderId,
        note: 'In shadow mode, order already simulated as filled'
      };
    }

    order.status = 'CANCELLED';
    order.cancelledAt = new Date().toISOString();

    this.logEvent({
      type: 'ORDER_CANCELLED',
      orderId,
      status: 'SUCCESS'
    });

    return { success: true, orderId };
  }

  /**
   * Get order status (always returns last simulated state)
   */
  async getOrderStatus(orderId) {
    return this.executedOrders.find(o => o.orderId === orderId);
  }

  /**
   * Calculate execution price based on order type
   */
  calculateExecutionPrice(orderType, side, limitPrice, marketPrice) {
    switch (orderType) {
      case 'MARKET':
        // Market order executes at current price
        return marketPrice;

      case 'LIMIT':
        // Limit order executes if price reaches limit
        if (side === 'BUY') {
          return Math.min(limitPrice, marketPrice);
        } else {
          return Math.max(limitPrice, marketPrice);
        }

      case 'STOP':
        // Stop order executes at market once triggered
        return marketPrice;

      default:
        return marketPrice;
    }
  }

  /**
   * Calculate realistic slippage
   */
  calculateSlippage(quantity, price) {
    // Slippage = (quantity * spread) + (market impact)
    const baseSpread = price * 0.0005; // 0.05% base spread
    const marketImpact = quantity > 10000 ? price * 0.001 : 0; // Impact for large orders

    return baseSpread + marketImpact;
  }

  /**
   * Update shadow portfolio position
   */
  updateShadowPortfolio(symbol, side, quantity, price) {
    if (!this.shadowPortfolio[symbol]) {
      this.shadowPortfolio[symbol] = {
        quantity: 0,
        avgCost: 0,
        costBasis: 0
      };
    }

    const position = this.shadowPortfolio[symbol];

    if (side === 'BUY') {
      const newQuantity = position.quantity + quantity;
      position.costBasis = (position.quantity * position.avgCost) + (quantity * price);
      position.avgCost = position.costBasis / newQuantity;
      position.quantity = newQuantity;
    } else if (side === 'SELL') {
      position.quantity = Math.max(0, position.quantity - quantity);
    }
  }

  /**
   * Get shadow portfolio (what would be held in shadow mode)
   */
  getShadowPortfolio() {
    return this.shadowPortfolio;
  }

  /**
   * Compare LIVE vs SHADOW execution
   * Returns differences for analysis
   */
  compareWithLiveExecution(liveOrders) {
    return {
      shadowOrderCount: this.executedOrders.length,
      liveOrderCount: liveOrders.length,
      shadowPortfolio: this.shadowPortfolio,
      comparison: {
        totalShadowCost: this.calculatePortfolioCost(),
        differenceNote: 'Shadow mode executed without broker friction, live mode includes actual slippage and fees'
      }
    };
  }

  /**
   * Calculate total portfolio cost in shadow mode
   */
  calculatePortfolioCost() {
    return Object.values(this.shadowPortfolio).reduce((sum, pos) => {
      return sum + (pos.quantity * pos.avgCost);
    }, 0);
  }
}

/**
 * SIMULATION Executor - Replays historical data
 * Used for backtesting and scenario analysis
 */
class SimulationExecutor extends BaseExecutor {
  constructor(historicalData = null) {
    super(ExecutionMode.SIMULATION);
    this.historicalData = historicalData;
    this.simulationTime = new Date();
    this.simulationPortfolio = {};
  }

  /**
   * Simulate order using historical data
   */
  async submitOrder(orderRequest) {
    const { orderId, symbol, side, quantity, orderType, price } = orderRequest;

    // Get historical price at simulation time
    const historicalPrice = this.getHistoricalPrice(symbol, this.simulationTime);
    if (!historicalPrice) {
      return { error: 'No historical data for symbol', orderId };
    }

    // Simulate execution
    const executionPrice = orderType === 'LIMIT'
      ? Math.min(price, historicalPrice)
      : historicalPrice;

    const order = {
      orderId,
      symbol,
      side,
      quantity,
      status: 'FILLED',
      submittedAt: this.simulationTime.toISOString(),
      executionPrice,
      mode: this.mode,
      isSimulated: true
    };

    this.executedOrders.push(order);
    return { success: true, orderId, executionPrice };
  }

  /**
   * Get historical price (stub - would use actual historical data)
   */
  getHistoricalPrice(symbol, timestamp) {
    // In real implementation, would query historical database
    return null;
  }

  /**
   * Cancel order (in simulation, already past)
   */
  async cancelOrder(orderId) {
    return { error: 'Cannot cancel historical simulation order', orderId };
  }

  /**
   * Advance simulation time
   */
  advanceTime(milliseconds) {
    this.simulationTime = new Date(this.simulationTime.getTime() + milliseconds);
  }
}

/**
 * Execution Router - Routes orders to correct executor
 */
class ExecutionRouter {
  constructor() {
    this.liveExecutor = null;
    this.shadowExecutor = null;
    this.simulationExecutor = null;
    this.currentMode = ExecutionMode.SHADOW; // Default to SHADOW for safety
  }

  /**
   * Initialize executors
   */
  initialize(config = {}) {
    const { brokerAdapter, marketDataProvider } = config;

    if (brokerAdapter) {
      this.liveExecutor = new LiveExecutor(brokerAdapter);
    }

    this.shadowExecutor = new ShadowExecutor(marketDataProvider);
    this.simulationExecutor = new SimulationExecutor();
  }

  /**
   * Get current executor
   */
  getCurrentExecutor() {
    switch (this.currentMode) {
      case ExecutionMode.LIVE:
        if (!this.liveExecutor) {
          throw new Error('Live executor not initialized');
        }
        return this.liveExecutor;

      case ExecutionMode.SHADOW:
        return this.shadowExecutor;

      case ExecutionMode.SIMULATION:
        return this.simulationExecutor;

      default:
        throw new Error(`Unknown execution mode: ${this.currentMode}`);
    }
  }

  /**
   * Submit order through current executor
   */
  async submitOrder(orderRequest) {
    const executor = this.getCurrentExecutor();
    const result = await executor.submitOrder(orderRequest);

    console.log(`${this.getModeIcon()} ${this.currentMode}: Order ${orderRequest.orderId} - ${result.success ? 'SUCCESS' : 'FAILED'}`);

    return result;
  }

  /**
   * Switch execution mode
   */
  switchMode(mode) {
    if (!ExecutionMode.isValid(mode)) {
      return { error: `Invalid mode: ${mode}` };
    }

    this.currentMode = mode;
    console.log(`🔀 Switched execution mode to: ${mode}`);

    return { success: true, mode };
  }

  /**
   * Get current mode
   */
  getMode() {
    return this.currentMode;
  }

  /**
   * Get mode icon for logging
   */
  getModeIcon() {
    switch (this.currentMode) {
      case ExecutionMode.LIVE:
        return '🔴';
      case ExecutionMode.SHADOW:
        return '🌑';
      case ExecutionMode.SIMULATION:
        return '⏮️ ';
      default:
        return '❓';
    }
  }
}

module.exports = {
  ExecutionMode,
  BaseExecutor,
  LiveExecutor,
  ShadowExecutor,
  SimulationExecutor,
  ExecutionRouter
};
