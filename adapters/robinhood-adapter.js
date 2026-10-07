/**
 * Robinhood Broker Adapter
 * Implements BrokerAdapter for Robinhood API
 *
 * Usage:
 * const adapter = new RobinhoodAdapter({ token: '...' });
 * await adapter.connect();
 * const order = await adapter.placeOrder({ symbol: 'AAPL', quantity: 10, side: 'buy' });
 */

const { BrokerAdapter } = require('../broker-adapter-interface');

class RobinhoodAdapter extends BrokerAdapter {
  constructor(config) {
    super(config);
    this.name = 'robinhood';
    this.baseURL = 'https://api.robinhood.com';
    this.token = config.token;
    this.userId = config.userId || null;
    this.lastError = null;
  }

  async connect() {
    try {
      // Validate token by fetching account info
      const response = await fetch(`${this.baseURL}/user/`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Robinhood auth failed: ${response.status}`);
      }

      const user = await response.json();
      this.userId = user.id;
      this.connected = true;

      console.log(`✅ Connected to Robinhood: ${user.email}`);
      return { connected: true, user: user.email };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async disconnect() {
    this.connected = false;
    this.token = null;
    console.log('🔌 Disconnected from Robinhood');
  }

  async validateConnection() {
    if (!this.connected) return false;

    try {
      const response = await fetch(`${this.baseURL}/user/`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getAccountBalance() {
    try {
      const response = await fetch(`${this.baseURL}/accounts/${this.userId}/`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      const account = await response.json();

      return {
        cash: parseFloat(account.cash || 0),
        portfolio_value: parseFloat(account.portfolio_value || 0),
        buying_power: parseFloat(account.buying_power || 0),
        equity: parseFloat(account.equity || 0),
        currency: 'USD'
      };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async getPositions() {
    try {
      const response = await fetch(`${this.baseURL}/positions/`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      const data = await response.json();
      const positions = data.results || [];

      return positions.map(pos => ({
        symbol: pos.symbol || 'UNKNOWN',
        quantity: parseFloat(pos.quantity || 0),
        avg_cost: parseFloat(pos.average_buy_price || 0),
        current_price: parseFloat(pos.current_price || 0),
        unrealized_pl: parseFloat((pos.quantity * (pos.current_price - pos.average_buy_price)) || 0),
        type: pos.asset_type || 'stock'
      }));
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async getAccount() {
    try {
      const response = await fetch(`${this.baseURL}/accounts/`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      const data = await response.json();
      return data.results?.[0] || {};
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async placeOrder(orderDetails) {
    try {
      const { symbol, quantity, side, type = 'market', time_in_force = 'day', limit_price } = orderDetails;

      const orderPayload = {
        account: this.userId,
        instrument: symbol,
        symbol: symbol,
        quantity: quantity.toString(),
        side: side.toLowerCase(),
        type: type.toLowerCase(),
        time_in_force: time_in_force,
        extended_hours: false
      };

      if (limit_price && type === 'limit') {
        orderPayload.price = limit_price.toString();
      }

      const response = await fetch(`${this.baseURL}/orders/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderPayload)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Order failed: ${response.status} - ${error}`);
      }

      const order = await response.json();

      return {
        order_id: order.id,
        status: order.state || 'pending',
        symbol: symbol,
        quantity: quantity,
        side: side,
        type: type,
        filled_quantity: parseFloat(order.executions?.length ? order.executions[0].quantity : 0),
        average_price: parseFloat(order.average_price || 0),
        timestamp: order.created_at || new Date().toISOString()
      };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async cancelOrder(orderId) {
    try {
      const response = await fetch(`${this.baseURL}/orders/${orderId}/cancel/`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      if (!response.ok) {
        throw new Error(`Cancel failed: ${response.status}`);
      }

      return { order_id: orderId, status: 'canceled' };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async getOrderStatus(orderId) {
    try {
      const response = await fetch(`${this.baseURL}/orders/${orderId}/`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      const order = await response.json();

      return {
        order_id: order.id,
        status: order.state || 'unknown',
        filled_quantity: parseFloat(order.executions?.length ? order.executions[0].quantity : 0),
        average_price: parseFloat(order.average_price || 0),
        timestamp: order.updated_at || order.created_at
      };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async getOrders(options = {}) {
    try {
      const { status, limit = 10, after_date } = options;

      let url = `${this.baseURL}/orders/?limit=${limit}`;
      if (status) url += `&state=${status}`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      const data = await response.json();
      return data.results || [];
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async getQuote(symbol) {
    try {
      const response = await fetch(`${this.baseURL}/quotes/${symbol}/`, {
        headers: { 'Accept': 'application/json' }
      });

      const quote = await response.json();

      return {
        symbol: symbol,
        price: parseFloat(quote.last_price || 0),
        bid: parseFloat(quote.bid_price || 0),
        ask: parseFloat(quote.ask_price || 0),
        volume: quote.trading_volume || 0,
        change: quote.last_extended_hours_trade_price ?
          (quote.last_extended_hours_trade_price - quote.previous_close) : 0
      };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async getQuotes(symbols) {
    const quotes = [];
    for (const symbol of symbols) {
      try {
        quotes.push(await this.getQuote(symbol));
      } catch {
        // Skip failed quotes
      }
    }
    return quotes;
  }

  async getHistoricalData(symbol, timeframe = '1day', limit = 100) {
    try {
      // Robinhood API has limited historical data support
      // This is a simplified implementation
      const response = await fetch(
        `${this.baseURL}/quotes/historicals/${symbol}/?interval=${timeframe}&span=week`,
        { headers: { 'Accept': 'application/json' } }
      );

      const data = await response.json();
      const historicals = data.results?.[0]?.historicals || [];

      return historicals.map(h => ({
        timestamp: h.begins_at,
        open: parseFloat(h.open_price || 0),
        high: parseFloat(h.high_price || 0),
        low: parseFloat(h.low_price || 0),
        close: parseFloat(h.close_price || 0),
        volume: h.volume || 0
      }));
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  async getSupported() {
    return {
      broker: 'Robinhood',
      type: 'robinhood',
      features: ['stocks', 'crypto', 'options'],
      paper_trading: false,
      max_orders_per_day: null, // Robinhood has PDT rules but no hard limit
      margin_support: true,
      crypto_support: true,
      options_support: true,
      regions: ['US']
    };
  }

  async validateOrderLimits(order) {
    // Robinhood-specific validation
    const { quantity, symbol } = order;

    if (quantity < 1) {
      return { valid: false, reason: 'Minimum quantity is 1' };
    }

    if (quantity > 1000000) {
      return { valid: false, reason: 'Order size exceeds limit' };
    }

    return { valid: true };
  }

  async isConnected() {
    return this.connected && await this.validateConnection();
  }

  async getLastError() {
    return this.lastError;
  }

  async reconcile(localState) {
    // Compare local positions with Robinhood account
    try {
      const brokerPositions = await this.getPositions();
      const discrepancies = [];

      for (const [symbol, position] of Object.entries(localState)) {
        const brokerPos = brokerPositions.find(p => p.symbol === symbol);

        if (!brokerPos) {
          discrepancies.push({
            symbol,
            type: 'missing_on_broker',
            local: position.quantity,
            broker: 0
          });
        } else if (brokerPos.quantity !== position.quantity) {
          discrepancies.push({
            symbol,
            type: 'quantity_mismatch',
            local: position.quantity,
            broker: brokerPos.quantity
          });
        }
      }

      return {
        matches: discrepancies.length === 0,
        discrepancies
      };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }
}

module.exports = RobinhoodAdapter;
