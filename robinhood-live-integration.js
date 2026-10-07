/**
 * RDCM Live Robinhood Broker Integration
 * Real-time trading, position management, account sync, P&L tracking
 *
 * Usage:
 *   const rh = new RobinhoodLiveIntegration(config);
 *   await rh.authenticate(username, password, mfaCode);
 *   await rh.placeOrder(symbol, quantity, price, side, orderType);
 *   const positions = await rh.getPositions();
 */

const axios = require('axios');
const crypto = require('crypto');

class RobinhoodLiveIntegration {
    constructor(config = {}) {
        this.clientId = config.clientId; // Robinhood OAuth client ID
        this.clientSecret = config.clientSecret; // Robinhood OAuth secret
        this.accessToken = null;
        this.refreshToken = null;
        this.authToken = null;
        this.accountId = null;
        this.baseURL = 'https://api.robinhood.com';
        this.db = config.db;
        this.logger = console;
        this.websocket = null;
        this.reconnectInterval = 30000; // 30 seconds
        this.lastHeartbeat = Date.now();
    }

    // ===== AUTHENTICATION =====

    async authenticate(email, password, mfaCode) {
        try {
            // Step 1: Get challenge for MFA
            const challengeResponse = await axios.post(`${this.baseURL}/api-token-auth/`, {
                username: email,
                password: password
            });

            if (challengeResponse.data.mfa_required) {
                // Step 2: Submit MFA code
                const mfaResponse = await axios.post(
                    `${this.baseURL}/api-token-auth/`,
                    {
                        username: email,
                        password: password,
                        mfa_code: mfaCode
                    }
                );

                this.authToken = mfaResponse.data.token;
                this.accessToken = mfaResponse.data.token;
            } else {
                this.authToken = challengeResponse.data.token;
                this.accessToken = challengeResponse.data.token;
            }

            // Step 3: Get account details
            const accountResponse = await this.makeRequest('GET', '/accounts/');
            const account = accountResponse.results[0];
            this.accountId = account.account_number;

            // Store credentials securely in database
            await this.storeCredentials(email, this.accessToken);

            return {
                success: true,
                accountId: this.accountId,
                accountValue: parseFloat(account.equity),
                buyingPower: parseFloat(account.cash_available_for_withdrawal),
                message: `Connected to Robinhood account ${this.accountId}`
            };
        } catch (error) {
            this.logger.error('Robinhood authentication failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async makeRequest(method, endpoint, data = null, params = null) {
        try {
            const config = {
                method,
                url: `${this.baseURL}${endpoint}`,
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'RDCM Trading Platform'
                }
            };

            if (params) config.params = params;
            if (data) config.data = data;

            const response = await axios(config);
            return response.data;
        } catch (error) {
            if (error.response?.status === 401) {
                // Token expired, attempt refresh
                await this.refreshAccessToken();
                return this.makeRequest(method, endpoint, data, params);
            }
            throw error;
        }
    }

    async refreshAccessToken() {
        try {
            const response = await axios.post(`${this.baseURL}/oauth2/token/`, {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.clientId,
                client_secret: this.clientSecret
            });

            this.accessToken = response.data.access_token;
            this.refreshToken = response.data.refresh_token;
            return { success: true };
        } catch (error) {
            this.logger.error('Token refresh failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ===== ACCOUNT MANAGEMENT =====

    async getAccountDetails() {
        try {
            const account = await this.makeRequest('GET', `/accounts/${this.accountId}/`);
            return {
                accountNumber: account.account_number,
                accountType: account.account_type,
                equity: parseFloat(account.equity),
                cash: parseFloat(account.cash_available_for_withdrawal),
                buyingPower: parseFloat(account.cash),
                marginLimit: parseFloat(account.margin_limit),
                dayTradeCount: account.day_trade_count,
                createdAt: account.created_at
            };
        } catch (error) {
            this.logger.error('Failed to get account details:', error.message);
            throw error;
        }
    }

    async getPortfolioHistory(interval = 'day', span = 'year') {
        try {
            const history = await this.makeRequest('GET', '/portfolios/historicals/', null, {
                interval,
                span
            });

            return {
                timestamp: history.timestamp,
                interval: history.interval,
                data: history.results.map(point => ({
                    timestamp: point.begins_at,
                    value: parseFloat(point.adjusted_close_equity),
                    allTimeReturn: parseFloat(point.adjusted_equity_previous_close) || 0
                }))
            };
        } catch (error) {
            this.logger.error('Failed to get portfolio history:', error.message);
            throw error;
        }
    }

    // ===== ORDER MANAGEMENT =====

    async placeOrder(symbol, quantity, price, side = 'buy', orderType = 'market', timeInForce = 'gfd') {
        try {
            // Validate order parameters
            if (!symbol || !quantity || !side) {
                return { success: false, error: 'Missing required parameters: symbol, quantity, side' };
            }

            // Get instrument URL
            const instrumentUrl = await this.getInstrumentUrl(symbol);
            if (!instrumentUrl) {
                return { success: false, error: `Symbol ${symbol} not found` };
            }

            // Place order
            const orderData = {
                account: `${this.baseURL}/accounts/${this.accountId}/`,
                instrument: instrumentUrl,
                symbol: symbol,
                side: side.toLowerCase(),
                quantity: parseInt(quantity),
                type: orderType.toLowerCase(), // 'market' or 'limit'
                time_in_force: timeInForce.toLowerCase(), // 'gfd' = good for day, 'gtc' = good til cancelled
                extended_hours: false
            };

            // Add price for limit orders
            if (orderType.toLowerCase() === 'limit' && price) {
                orderData.price = price.toFixed(2);
            }

            const response = await this.makeRequest('POST', '/orders/', orderData);

            // Log order in database
            await this.logOrder(symbol, quantity, price, side, orderType, response.id, 'submitted');

            return {
                success: true,
                orderId: response.id,
                symbol: response.symbol,
                quantity: response.quantity,
                price: response.price,
                side: response.side,
                state: response.state,
                createdAt: response.created_at,
                updatedAt: response.updated_at
            };
        } catch (error) {
            this.logger.error('Order placement failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async cancelOrder(orderId) {
        try {
            const response = await this.makeRequest('POST', `/orders/${orderId}/cancel/`);
            return {
                success: true,
                orderId: response.id,
                state: response.state
            };
        } catch (error) {
            this.logger.error('Cancel order failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async getOrders(state = null) {
        try {
            const params = state ? { state } : {};
            const response = await this.makeRequest('GET', '/orders/', null, params);

            return {
                orders: response.results.map(order => ({
                    orderId: order.id,
                    symbol: order.symbol,
                    quantity: parseInt(order.quantity),
                    price: parseFloat(order.price) || 0,
                    side: order.side,
                    type: order.type,
                    state: order.state,
                    createdAt: order.created_at,
                    updatedAt: order.updated_at,
                    executions: order.executions || []
                }))
            };
        } catch (error) {
            this.logger.error('Failed to get orders:', error.message);
            throw error;
        }
    }

    async getOrderDetails(orderId) {
        try {
            const order = await this.makeRequest('GET', `/orders/${orderId}/`);
            return {
                orderId: order.id,
                symbol: order.symbol,
                quantity: parseInt(order.quantity),
                price: parseFloat(order.price) || 0,
                averagePrice: parseFloat(order.average_price) || 0,
                side: order.side,
                type: order.type,
                state: order.state,
                createdAt: order.created_at,
                updatedAt: order.updated_at,
                executions: order.executions || []
            };
        } catch (error) {
            this.logger.error('Failed to get order details:', error.message);
            throw error;
        }
    }

    // ===== POSITION MANAGEMENT =====

    async getPositions() {
        try {
            const positions = await this.makeRequest('GET', '/positions/', null, {
                nonzero: true // Only show positions with quantity > 0
            });

            const positionList = [];

            for (let position of positions.results) {
                const instrument = await this.getInstrumentDetails(position.instrument);
                const quote = await this.getQuote(instrument.symbol);

                positionList.push({
                    symbol: instrument.symbol,
                    quantity: parseInt(position.quantity),
                    avgBuyPrice: parseFloat(position.average_buy_price),
                    currentPrice: parseFloat(quote.last_trade_price),
                    totalValue: parseFloat(position.quantity) * parseFloat(quote.last_trade_price),
                    totalCost: parseFloat(position.quantity) * parseFloat(position.average_buy_price),
                    unrealizedGain: (parseFloat(position.quantity) * parseFloat(quote.last_trade_price)) -
                                   (parseFloat(position.quantity) * parseFloat(position.average_buy_price)),
                    unrealizedGainPercent: ((parseFloat(quote.last_trade_price) - parseFloat(position.average_buy_price)) /
                                           parseFloat(position.average_buy_price) * 100),
                    instrument: instrument.name
                });
            }

            return positionList;
        } catch (error) {
            this.logger.error('Failed to get positions:', error.message);
            throw error;
        }
    }

    async closePosition(symbol) {
        try {
            // Get current position
            const positions = await this.makeRequest('GET', '/positions/');
            const position = positions.results.find(p => p.symbol === symbol);

            if (!position || parseInt(position.quantity) === 0) {
                return { success: false, error: `No open position for ${symbol}` };
            }

            // Place sell order for entire position
            const order = await this.placeOrder(
                symbol,
                Math.abs(position.quantity),
                null,
                'sell',
                'market'
            );

            return order;
        } catch (error) {
            this.logger.error('Failed to close position:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ===== MARKET DATA =====

    async getQuote(symbol) {
        try {
            const quotes = await this.makeRequest('GET', '/quotes/', null, {
                symbols: symbol.toUpperCase()
            });

            const quote = quotes.results[0];
            return {
                symbol: quote.symbol,
                lastTradePrice: parseFloat(quote.last_trade_price),
                lastExtendedHoursTradePrice: parseFloat(quote.last_extended_hours_trade_price) || null,
                bidPrice: parseFloat(quote.bid_price),
                askPrice: parseFloat(quote.ask_price),
                bidSize: parseInt(quote.bid_size),
                askSize: parseInt(quote.ask_size),
                volume: parseInt(quote.trading_volume),
                updatedAt: quote.updated_at
            };
        } catch (error) {
            this.logger.error('Failed to get quote:', error.message);
            throw error;
        }
    }

    async getHistoricals(symbol, interval = '5minute', span = 'day') {
        try {
            const response = await this.makeRequest('GET', '/quotes/historicals/', null, {
                symbols: symbol.toUpperCase(),
                interval,
                span
            });

            const data = response.results[0];
            return {
                symbol: data.symbol,
                interval: data.interval,
                span: data.span,
                candles: data.historicals.map(candle => ({
                    timestamp: candle.begins_at,
                    open: parseFloat(candle.open_price),
                    close: parseFloat(candle.close_price),
                    high: parseFloat(candle.high_price),
                    low: parseFloat(candle.low_price),
                    volume: parseInt(candle.volume)
                }))
            };
        } catch (error) {
            this.logger.error('Failed to get historicals:', error.message);
            throw error;
        }
    }

    // ===== HELPER METHODS =====

    async getInstrumentUrl(symbol) {
        try {
            const response = await this.makeRequest('GET', '/instruments/', null, {
                symbol: symbol.toUpperCase()
            });

            if (response.results.length === 0) return null;
            return response.results[0].url;
        } catch (error) {
            this.logger.error('Failed to get instrument URL:', error.message);
            return null;
        }
    }

    async getInstrumentDetails(instrumentUrl) {
        try {
            const response = await axios.get(instrumentUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            return {
                symbol: response.data.symbol,
                name: response.data.name,
                type: response.data.type
            };
        } catch (error) {
            this.logger.error('Failed to get instrument details:', error.message);
            throw error;
        }
    }

    // ===== DATABASE OPERATIONS =====

    async storeCredentials(email, token) {
        return new Promise((resolve, reject) => {
            const encryptedToken = this.encryptToken(token);
            this.db.run(
                `INSERT OR REPLACE INTO broker_credentials (user_email, broker, auth_token, account_id, connected_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [email, 'robinhood', encryptedToken, this.accountId],
                (err) => {
                    if (err) reject(err);
                    else resolve({ success: true });
                }
            );
        });
    }

    async logOrder(symbol, quantity, price, side, orderType, orderId, status) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO broker_orders (broker, symbol, quantity, price, side, order_type, order_id, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    'robinhood',
                    symbol,
                    quantity,
                    price || 0,
                    side,
                    orderType,
                    orderId,
                    status
                ],
                function(err) {
                    if (err) reject(err);
                    else resolve({ success: true, logId: this.lastID });
                }
            );
        });
    }

    async syncPositionsWithDB(positions) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE broker_positions SET synced_at = CURRENT_TIMESTAMP WHERE broker = 'robinhood'`,
                (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    let completed = 0;
                    for (let pos of positions) {
                        this.db.run(
                            `INSERT OR REPLACE INTO broker_positions
                             (broker, symbol, quantity, avg_price, current_price, total_value, unrealized_gain, synced_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                            [
                                'robinhood',
                                pos.symbol,
                                pos.quantity,
                                pos.avgBuyPrice,
                                pos.currentPrice,
                                pos.totalValue,
                                pos.unrealizedGain
                            ],
                            (err) => {
                                if (err) reject(err);
                                else {
                                    completed++;
                                    if (completed === positions.length) {
                                        resolve({ success: true, positionsSync: positions.length });
                                    }
                                }
                            }
                        );
                    }
                }
            );
        });
    }

    // ===== ENCRYPTION HELPERS =====

    encryptToken(token) {
        const cipher = crypto.createCipher('aes-256-cbc', process.env.ENCRYPTION_KEY || 'default-key');
        let encrypted = cipher.update(token, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    }

    decryptToken(encrypted) {
        const decipher = crypto.createDecipher('aes-256-cbc', process.env.ENCRYPTION_KEY || 'default-key');
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    // ===== REAL-TIME UPDATES =====

    async startWebSocketFeed() {
        try {
            // WebSocket feed for real-time quotes and updates
            const wsUrl = 'wss://api.robinhood.com/ws/quote/';

            this.websocket = new WebSocket(wsUrl);

            this.websocket.on('open', () => {
                this.logger.info('WebSocket connected to Robinhood');
            });

            this.websocket.on('message', (data) => {
                this.handleWebSocketMessage(JSON.parse(data));
            });

            this.websocket.on('close', () => {
                this.logger.warn('WebSocket disconnected, attempting reconnect...');
                setTimeout(() => this.startWebSocketFeed(), this.reconnectInterval);
            });

            this.websocket.on('error', (error) => {
                this.logger.error('WebSocket error:', error.message);
            });
        } catch (error) {
            this.logger.error('Failed to start WebSocket feed:', error.message);
        }
    }

    async handleWebSocketMessage(message) {
        // Handle real-time price updates, trade executions, etc.
        if (message.type === 'quote') {
            await this.updateQuoteCache(message.data);
        } else if (message.type === 'trade') {
            await this.notifyTradeExecution(message.data);
        }
    }

    async updateQuoteCache(quoteData) {
        // Cache quote data for fast access
        this.quoteCache = this.quoteCache || {};
        this.quoteCache[quoteData.symbol] = quoteData;
    }

    async notifyTradeExecution(tradeData) {
        this.logger.info(`Trade executed: ${tradeData.symbol} ${tradeData.quantity}@${tradeData.price}`);
        // Trigger notifications for trade fills
    }
}

module.exports = RobinhoodLiveIntegration;
