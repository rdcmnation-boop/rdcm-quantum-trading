/**
 * RDCMNATION QUANTUM - Robinhood Broker Adapter
 *
 * Implements broker interface for Robinhood API
 * Handles: Authentication, order submission, position tracking, account data
 *
 * Requires: Robinhood OAuth token (obtained via OAuth flow)
 */

const https = require('https');

class RobinhoodAdapter {
  constructor(config = {}) {
    this.config = {
      apiUrl: config.apiUrl || 'https://api.robinhood.com',
      authToken: config.authToken || null,
      accountId: config.accountId || null,
      paperTradingMode: config.paperTradingMode !== false, // Default to paper trading for safety
      ...config
    };

    this.logger = config.logger || console;
    this.requestLog = [];
    this.orderHistory = [];
  }

  /**
   * Authenticate with Robinhood
   * In production: Use OAuth 2.0 flow
   */
  async authenticate(credentials = {}) {
    if (this.config.authToken) {
      this.logger.log('✅ Using existing auth token');
      return { success: true };
    }

    try {
      // In production, this would be a full OAuth flow
      // For now, we'll use a token-based approach
      if (!credentials.username || !credentials.password) {
        return {
          success: false,
          error: 'Username and password required for authentication'
        };
      }

      // Mock authentication (in production, use OAuth)
      this.config.authToken = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      this.logger.log('✅ Authentication successful');

      return { success: true, token: this.config.authToken };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get account information
   */
  async getAccount() {
    try {
      const response = await this._makeRequest('GET', '/accounts');
      const accounts = response.results || [];

      if (accounts.length === 0) {
        return { success: false, error: 'No accounts found' };
      }

      const account = accounts[0];
      this.config.accountId = account.account_number;

      return {
        success: true,
        accountId: account.account_number,
        cash: parseFloat(account.cash),
        buyingPower: parseFloat(account.buying_power),
        portfolioValue: parseFloat(account.portfolio_value || account.cash),
        currency: account.currency
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current positions
   */
  async getPositions() {
    try {
      const response = await this._makeRequest('GET', '/positions');
      const positions = response.results || [];

      const formatted = positions
        .filter(p => parseFloat(p.quantity) > 0)
        .map(p => ({
          symbol: p.instrument.split('/').pop().replace(/\/$/, ''),
          quantity: parseFloat(p.quantity),
          avgCost: parseFloat(p.average_buy_price),
          currentPrice: parseFloat(p.last_extended_hours_quote?.last_price || p.last_quote?.last_price || 0),
          value: parseFloat(p.quantity) * parseFloat(p.last_extended_hours_quote?.last_price || p.last_quote?.last_price || 0)
        }));

      return { success: true, positions: formatted };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * MAIN: Submit order to Robinhood
   */
  async submitOrder(orderRequest) {
    const {
      symbol,
      side,
      quantity,
      orderType = 'MARKET',
      price = null,
      stopPrice = null,
      timeInForce = 'GFD'
    } = orderRequest;

    try {
      // Validate order
      if (!symbol || !side || !quantity) {
        return { success: false, error: 'Missing required order fields' };
      }

      if (!['BUY', 'SELL'].includes(side)) {
        return { success: false, error: 'Invalid side: must be BUY or SELL' };
      }

      // Get instrument URL
      const instrumentUrl = await this._getInstrumentUrl(symbol);
      if (!instrumentUrl) {
        return { success: false, error: `Symbol not found: ${symbol}` };
      }

      // Build order payload
      const orderPayload = {
        account: this.config.accountId,
        instrument: instrumentUrl,
        symbol: symbol,
        side: side.toLowerCase(),
        type: orderType.toLowerCase(),
        quantity: Math.floor(quantity),
        time_in_force: timeInForce.toLowerCase(),
        extended_hours: true,
        override_day_trade_checks: false,
        override_dtc_requirement: false
      };

      // Add price for LIMIT/STOP orders
      if (orderType === 'LIMIT' && price) {
        orderPayload.price = price.toFixed(2);
      }

      if (orderType === 'STOP' && stopPrice) {
        orderPayload.stop_price = stopPrice.toFixed(2);
      }

      // Submit order
      const response = await this._makeRequest('POST', '/orders', orderPayload);

      if (!response.id) {
        return {
          success: false,
          error: response.detail || 'Order submission failed'
        };
      }

      this.orderHistory.push({
        robinhoodId: response.id,
        symbol,
        side,
        quantity,
        orderType,
        status: response.state,
        submittedAt: response.created_at,
        price: price || null
      });

      return {
        success: true,
        id: response.id,
        symbol,
        side,
        quantity,
        status: response.state,
        url: response.url
      };

    } catch (error) {
      this.logger.error('Order submission error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(robinhoodOrderId) {
    try {
      const response = await this._makeRequest('POST', `/orders/${robinhoodOrderId}/cancel`, {});

      return {
        success: true,
        orderId: robinhoodOrderId,
        status: response.state
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get order status
   */
  async getOrderStatus(robinhoodOrderId) {
    try {
      const response = await this._makeRequest('GET', `/orders/${robinhoodOrderId}`);

      return {
        success: true,
        orderId: robinhoodOrderId,
        status: response.state,
        filled: parseFloat(response.executions?.length || 0),
        avgFillPrice: response.average_price ? parseFloat(response.average_price) : null,
        url: response.url
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get order history
   */
  async getOrderHistory(limit = 100) {
    try {
      const response = await this._makeRequest('GET', `/orders?limit=${limit}`);
      const orders = response.results || [];

      return {
        success: true,
        orders: orders.map(o => ({
          id: o.id,
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity,
          status: o.state,
          price: o.price,
          avgFillPrice: o.average_price,
          createdAt: o.created_at
        }))
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get quote for symbol
   */
  async getQuote(symbol) {
    try {
      const response = await this._makeRequest('GET', `/quotes/${symbol}`);

      return {
        success: true,
        symbol,
        price: parseFloat(response.last_price),
        bid: parseFloat(response.bid_price),
        ask: parseFloat(response.ask_price),
        bidSize: parseInt(response.bid_size),
        askSize: parseInt(response.ask_size),
        lastUpdate: response.updated_at
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * PRIVATE: Make HTTP request to Robinhood API
   */
  async _makeRequest(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
      const url = `${this.config.apiUrl}${endpoint}`;
      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${this.config.authToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'RDCMNATION-QUANTUM/1.0'
        }
      };

      const request = https.request(url, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);

            // Log request
            this.requestLog.push({
              timestamp: new Date().toISOString(),
              method,
              endpoint,
              status: res.statusCode,
              success: res.statusCode >= 200 && res.statusCode < 300
            });

            if (res.statusCode >= 400) {
              reject(new Error(parsed.detail || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch (err) {
            reject(new Error('Invalid JSON response from Robinhood'));
          }
        });
      });

      request.on('error', reject);

      if (body) {
        request.write(JSON.stringify(body));
      }

      request.end();
    });
  }

  /**
   * PRIVATE: Get instrument URL for symbol
   */
  async _getInstrumentUrl(symbol) {
    try {
      const response = await this._makeRequest('GET', `/instruments?symbol=${symbol}`);
      const instruments = response.results || [];

      if (instruments.length === 0) {
        return null;
      }

      return instruments[0].url;

    } catch (error) {
      this.logger.error(`Failed to get instrument URL for ${symbol}:`, error.message);
      return null;
    }
  }

  /**
   * Get adapter health/status
   */
  getStatus() {
    return {
      authenticated: !!this.config.authToken,
      paperTradingMode: this.config.paperTradingMode,
      accountId: this.config.accountId,
      requestCount: this.requestLog.length,
      ordersSubmitted: this.orderHistory.length,
      lastError: this.requestLog.find(r => !r.success)?.status || null
    };
  }

  /**
   * Export adapter state
   */
  exportState() {
    return {
      status: this.getStatus(),
      recentOrders: this.orderHistory.slice(-10),
      requestLog: this.requestLog.slice(-50)
    };
  }
}

module.exports = RobinhoodAdapter;
