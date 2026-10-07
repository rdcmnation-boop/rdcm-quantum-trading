/**
 * RDCMNATION QUANTUM - Broker Adapter Interface
 *
 * Enables QUANTUM to work with ANY broker.
 * QUANTUM is the product. Brokers are just adapters.
 *
 * This is what makes RDCMNATION QUANTUM a platform, not a bot.
 */

/**
 * BrokerAdapter - Base interface all brokers must implement
 *
 * If you want to support a new broker:
 * 1. Extend BrokerAdapter
 * 2. Implement all abstract methods
 * 3. Add to BrokerFactory
 * 4. Done - QUANTUM works with that broker
 */

class BrokerAdapter {
  constructor(config) {
    this.config = config;
    this.name = 'abstract-broker';
    this.connected = false;
  }

  /**
   * INITIALIZATION & CONNECTION
   */

  async connect() {
    throw new Error('connect() must be implemented');
  }

  async disconnect() {
    throw new Error('disconnect() must be implemented');
  }

  async validateConnection() {
    throw new Error('validateConnection() must be implemented');
  }

  /**
   * ACCOUNT INFORMATION
   */

  async getAccountBalance() {
    // Returns: { cash, portfolio_value, buying_power, equity }
    throw new Error('getAccountBalance() must be implemented');
  }

  async getPositions() {
    // Returns: array of { symbol, quantity, avg_cost, current_price, unrealized_pl }
    throw new Error('getPositions() must be implemented');
  }

  async getAccount() {
    // Returns: complete account object
    throw new Error('getAccount() must be implemented');
  }

  /**
   * ORDER EXECUTION
   */

  async placeOrder(orderDetails) {
    // Input: { symbol, quantity, side, type, time_in_force, limit_price? }
    // Output: { order_id, status, symbol, quantity, filled_quantity, average_price }
    throw new Error('placeOrder() must be implemented');
  }

  async cancelOrder(orderId) {
    // Input: order_id
    // Output: { order_id, status }
    throw new Error('cancelOrder() must be implemented');
  }

  async getOrderStatus(orderId) {
    // Input: order_id
    // Output: { order_id, status, filled_quantity, average_price, timestamp }
    throw new Error('getOrderStatus() must be implemented');
  }

  async getOrders(options) {
    // Input: { status?, limit?, after_date? }
    // Output: array of order objects
    throw new Error('getOrders() must be implemented');
  }

  /**
   * MARKET DATA
   */

  async getQuote(symbol) {
    // Input: symbol (e.g., "AAPL")
    // Output: { symbol, price, bid, ask, volume, change }
    throw new Error('getQuote() must be implemented');
  }

  async getQuotes(symbols) {
    // Input: array of symbols
    // Output: array of quote objects
    throw new Error('getQuotes() must be implemented');
  }

  async getHistoricalData(symbol, timeframe, limit) {
    // Input: symbol, timeframe (1min, 5min, 1hour, 1day), limit
    // Output: array of { timestamp, open, high, low, close, volume }
    throw new Error('getHistoricalData() must be implemented');
  }

  /**
   * BROKER-SPECIFIC FEATURES
   */

  async getSupported() {
    // Returns capabilities of this broker
    throw new Error('getSupported() must be implemented');
  }

  async validateOrderLimits(order) {
    // Check if order violates broker-specific limits
    // Returns: { valid: boolean, reason? }
    throw new Error('validateOrderLimits() must be implemented');
  }

  /**
   * ERROR HANDLING & RESILIENCE
   */

  async isConnected() {
    throw new Error('isConnected() must be implemented');
  }

  async getLastError() {
    // For debugging
    throw new Error('getLastError() must be implemented');
  }

  async reconcile(localState) {
    // Compare local state with broker
    // Returns: { matches: boolean, discrepancies: [] }
    throw new Error('reconcile() must be implemented');
  }
}

/**
 * BrokerFactory - Creates broker adapters
 * This is how QUANTUM switches between brokers transparently
 */

class BrokerFactory {
  static createBroker(brokerType, config) {
    switch (brokerType.toLowerCase()) {
      case 'robinhood':
        const RobinhoodAdapter = require('./adapters/robinhood-adapter');
        return new RobinhoodAdapter(config);

      case 'alpaca':
        const AlpacaAdapter = require('./adapters/alpaca-adapter');
        return new AlpacaAdapter(config);

      case 'coinbase':
        const CoinbaseAdapter = require('./adapters/coinbase-adapter');
        return new CoinbaseAdapter(config);

      case 'td':
      case 'td-ameritrade':
        const TDAdapter = require('./adapters/td-adapter');
        return new TDAdapter(config);

      case 'ibkr':
      case 'interactive-brokers':
        const IBKRAdapter = require('./adapters/ibkr-adapter');
        return new IBKRAdapter(config);

      case 'paper':
      case 'simulator':
        const PaperAdapter = require('./adapters/paper-trading-adapter');
        return new PaperAdapter(config);

      default:
        throw new Error(`Broker type "${brokerType}" not supported`);
    }
  }

  static getAvailableBrokers() {
    return [
      {
        name: 'Robinhood',
        type: 'robinhood',
        description: 'Commission-free stock and crypto trading',
        features: ['stocks', 'crypto', 'options'],
        regions: ['US']
      },
      {
        name: 'Alpaca',
        type: 'alpaca',
        description: 'API-first broker for algorithmic trading',
        features: ['stocks', 'crypto', 'paper-trading'],
        regions: ['US']
      },
      {
        name: 'Coinbase',
        type: 'coinbase',
        description: 'Cryptocurrency exchange',
        features: ['crypto'],
        regions: ['US', 'EU', 'Global']
      },
      {
        name: 'TD Ameritrade',
        type: 'td',
        description: 'Full-service broker with advanced tools',
        features: ['stocks', 'options', 'futures'],
        regions: ['US']
      },
      {
        name: 'Interactive Brokers',
        type: 'ibkr',
        description: 'Global broker with lowest commissions',
        features: ['stocks', 'crypto', 'forex', 'futures'],
        regions: ['Global']
      },
      {
        name: 'Paper Trading',
        type: 'paper',
        description: 'Risk-free simulation environment',
        features: ['stocks', 'crypto', 'full-simulation'],
        regions: ['All']
      }
    ];
  }
}

/**
 * BrokerManager - Manages multiple broker connections
 * Allows trading across multiple brokers simultaneously
 */

class BrokerManager {
  constructor() {
    this.brokers = {};
    this.activeBroker = null;
  }

  addBroker(name, brokerType, config) {
    const broker = BrokerFactory.createBroker(brokerType, config);
    this.brokers[name] = broker;

    if (!this.activeBroker) {
      this.activeBroker = name;
    }

    return broker;
  }

  getBroker(name) {
    return this.brokers[name];
  }

  setActiveBroker(name) {
    if (!this.brokers[name]) {
      throw new Error(`Broker "${name}" not found`);
    }
    this.activeBroker = name;
  }

  async placeOrderAcrossAll(orderDetails) {
    // Execute same order on all connected brokers
    const results = {};

    for (const [name, broker] of Object.entries(this.brokers)) {
      try {
        results[name] = await broker.placeOrder(orderDetails);
      } catch (error) {
        results[name] = { error: error.message };
      }
    }

    return results;
  }

  async placeOrderOnActive(orderDetails) {
    // Execute only on active broker
    const broker = this.brokers[this.activeBroker];
    if (!broker) {
      throw new Error('No active broker set');
    }
    return await broker.placeOrder(orderDetails);
  }

  async getAllPositions() {
    // Get positions across all brokers
    const positions = {};

    for (const [name, broker] of Object.entries(this.brokers)) {
      positions[name] = await broker.getPositions();
    }

    return positions;
  }

  async getAggregatedBalance() {
    // Sum balances across all brokers
    let totalCash = 0;
    let totalValue = 0;

    for (const broker of Object.values(this.brokers)) {
      const balance = await broker.getAccountBalance();
      totalCash += balance.cash || 0;
      totalValue += balance.portfolio_value || 0;
    }

    return { totalCash, totalValue, brokerCount: Object.keys(this.brokers).length };
  }
}

module.exports = {
  BrokerAdapter,
  BrokerFactory,
  BrokerManager
};
