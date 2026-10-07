/**
 * RDCM Live Coinbase Broker Integration
 * Crypto trading, digital assets, real-time execution, account management
 *
 * Usage:
 *   const cb = new CoinbaseLiveIntegration(config);
 *   await cb.authenticate(apiKey, apiSecret, passphrase);
 *   await cb.placeOrder(productId, size, price, side, orderType);
 *   const positions = await cb.getPositions();
 */

const axios = require('axios');
const crypto = require('crypto');

class CoinbaseLiveIntegration {
    constructor(config = {}) {
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.passphrase = config.passphrase;
        this.accountId = null;
        this.baseURL = 'https://api.exchange.coinbase.com'; // Production API
        this.sandboxURL = 'https://api-sandbox.exchange.coinbase.com'; // Paper trading
        this.isProduction = config.production !== false; // Default to production
        this.currentURL = this.isProduction ? this.baseURL : this.sandboxURL;
        this.db = config.db;
        this.logger = console;
        this.websocket = null;
        this.reconnectInterval = 30000;
    }

    // ===== AUTHENTICATION =====

    async authenticate(apiKey, apiSecret, passphrase) {
        try {
            this.apiKey = apiKey;
            this.apiSecret = apiSecret;
            this.passphrase = passphrase;

            // Test connection by getting accounts
            const accounts = await this.makeRequest('GET', '/accounts');

            if (!accounts || accounts.length === 0) {
                return { success: false, error: 'No trading accounts found' };
            }

            // Find account with highest balance for default
            const primaryAccount = accounts.reduce((max, acc) =>
                parseFloat(acc.balance) > parseFloat(max.balance) ? acc : max
            );

            this.accountId = primaryAccount.id;

            // Store credentials securely
            await this.storeCredentials(apiKey, apiSecret, passphrase);

            return {
                success: true,
                accountId: this.accountId,
                accountCurrency: primaryAccount.currency,
                accountBalance: parseFloat(primaryAccount.balance),
                message: `Connected to Coinbase ${this.isProduction ? 'LIVE' : 'Sandbox'} account`
            };
        } catch (error) {
            this.logger.error('Coinbase authentication failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ===== REQUEST SIGNING =====

    generateAuthHeaders(method, path, body = '') {
        const timestamp = Date.now() / 1000;
        const message = timestamp + method + path + body;

        const hmac = crypto.createHmac('sha256', Buffer.from(this.apiSecret, 'base64'));
        const signature = hmac.update(message).digest('base64');

        return {
            'CB-ACCESS-KEY': this.apiKey,
            'CB-ACCESS-SIGN': signature,
            'CB-ACCESS-TIMESTAMP': timestamp,
            'CB-ACCESS-PASSPHRASE': this.passphrase,
            'Content-Type': 'application/json'
        };
    }

    async makeRequest(method, endpoint, data = null) {
        try {
            const body = data ? JSON.stringify(data) : '';
            const headers = this.generateAuthHeaders(method, endpoint, body);

            const config = {
                method,
                url: `${this.currentURL}${endpoint}`,
                headers,
                data: data || undefined
            };

            const response = await axios(config);
            return response.data;
        } catch (error) {
            if (error.response?.status === 401) {
                throw new Error('Authentication failed - check API credentials');
            }
            throw error;
        }
    }

    // ===== ACCOUNT MANAGEMENT =====

    async getAccounts() {
        try {
            const accounts = await this.makeRequest('GET', '/accounts');
            return accounts.map(acc => ({
                id: acc.id,
                currency: acc.currency,
                balance: parseFloat(acc.balance),
                available: parseFloat(acc.available),
                hold: parseFloat(acc.hold)
            }));
        } catch (error) {
            this.logger.error('Failed to get accounts:', error.message);
            throw error;
        }
    }

    async getAccount(accountId = null) {
        try {
            const id = accountId || this.accountId;
            const account = await this.makeRequest('GET', `/accounts/${id}`);
            return {
                id: account.id,
                currency: account.currency,
                balance: parseFloat(account.balance),
                available: parseFloat(account.available),
                hold: parseFloat(account.hold)
            };
        } catch (error) {
            this.logger.error('Failed to get account:', error.message);
            throw error;
        }
    }

    async getAccountHistory(accountId = null) {
        try {
            const id = accountId || this.accountId;
            const history = await this.makeRequest('GET', `/accounts/${id}/ledger`);
            return history.map(entry => ({
                type: entry.type,
                amount: parseFloat(entry.amount),
                balance: parseFloat(entry.balance),
                timestamp: entry.created_at,
                description: entry.description
            }));
        } catch (error) {
            this.logger.error('Failed to get account history:', error.message);
            throw error;
        }
    }

    // ===== ORDER MANAGEMENT =====

    async placeOrder(productId, size, price, side = 'buy', orderType = 'market') {
        try {
            // Validate parameters
            if (!productId || !size || !side) {
                return { success: false, error: 'Missing required parameters: productId, size, side' };
            }

            const orderData = {
                product_id: productId, // e.g., 'BTC-USD', 'ETH-USD'
                side: side.toLowerCase(), // 'buy' or 'sell'
                size: parseFloat(size),
                type: orderType.toLowerCase() // 'market' or 'limit'
            };

            // Add price for limit orders
            if (orderType.toLowerCase() === 'limit' && price) {
                orderData.price = price.toFixed(2);
            }

            const response = await this.makeRequest('POST', '/orders', orderData);

            // Log order
            await this.logOrder(productId, size, price, side, orderType, response.id, 'submitted');

            return {
                success: true,
                orderId: response.id,
                productId: response.product_id,
                size: parseFloat(response.size),
                price: response.price ? parseFloat(response.price) : null,
                side: response.side,
                status: response.status,
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
            await this.makeRequest('DELETE', `/orders/${orderId}`);
            return {
                success: true,
                orderId: orderId,
                message: 'Order cancelled'
            };
        } catch (error) {
            this.logger.error('Cancel order failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async getOrders(status = 'all', productId = null) {
        try {
            let endpoint = '/orders';
            const params = new URLSearchParams();

            if (status !== 'all') {
                params.append('status', status); // 'pending', 'done', 'active'
            }

            if (productId) {
                params.append('product_id', productId);
            }

            const queryString = params.toString();
            const response = await this.makeRequest('GET', `/orders${queryString ? '?' + queryString : ''}`);

            return {
                orders: response.map(order => ({
                    orderId: order.id,
                    productId: order.product_id,
                    size: parseFloat(order.size),
                    price: order.price ? parseFloat(order.price) : null,
                    side: order.side,
                    type: order.type,
                    status: order.status,
                    filledSize: parseFloat(order.filled_size),
                    executedValue: parseFloat(order.executed_value),
                    createdAt: order.created_at,
                    updatedAt: order.updated_at
                }))
            };
        } catch (error) {
            this.logger.error('Failed to get orders:', error.message);
            throw error;
        }
    }

    async getOrderDetails(orderId) {
        try {
            const order = await this.makeRequest('GET', `/orders/${orderId}`);
            return {
                orderId: order.id,
                productId: order.product_id,
                size: parseFloat(order.size),
                price: order.price ? parseFloat(order.price) : null,
                side: order.side,
                type: order.type,
                status: order.status,
                filledSize: parseFloat(order.filled_size),
                executedValue: parseFloat(order.executed_value),
                createdAt: order.created_at,
                updatedAt: order.updated_at
            };
        } catch (error) {
            this.logger.error('Failed to get order details:', error.message);
            throw error;
        }
    }

    // ===== POSITION MANAGEMENT =====

    async getPositions() {
        try {
            const accounts = await this.getAccounts();
            const positions = [];

            for (let account of accounts) {
                if (account.balance > 0 && account.currency !== 'USD') {
                    // Get current price
                    const quote = await this.getProductTicker(`${account.currency}-USD`);

                    positions.push({
                        symbol: account.currency,
                        quantity: account.balance,
                        availableQuantity: account.available,
                        onHoldQuantity: account.hold,
                        currentPrice: quote.price,
                        totalValue: account.balance * quote.price,
                        totalCost: account.balance * quote.price, // Approximation
                        unrealizedGain: 0, // Would need cost basis
                        unrealizedGainPercent: 0
                    });
                }
            }

            return positions;
        } catch (error) {
            this.logger.error('Failed to get positions:', error.message);
            throw error;
        }
    }

    async sellPosition(productId, quantity) {
        try {
            const order = await this.placeOrder(productId, quantity, null, 'sell', 'market');
            return order;
        } catch (error) {
            this.logger.error('Failed to sell position:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ===== MARKET DATA =====

    async getProducts() {
        try {
            const response = await this.makeRequest('GET', '/products');
            return response.map(product => ({
                id: product.id,
                baseCurrency: product.base_currency,
                quoteCurrency: product.quote_currency,
                baseMinSize: parseFloat(product.base_min_size),
                baseMaxSize: parseFloat(product.base_max_size),
                quoteIncrement: parseFloat(product.quote_increment),
                displayName: product.display_name
            }));
        } catch (error) {
            this.logger.error('Failed to get products:', error.message);
            throw error;
        }
    }

    async getProductTicker(productId) {
        try {
            const ticker = await this.makeRequest('GET', `/products/${productId}/ticker`);
            return {
                productId: ticker.product_id,
                price: parseFloat(ticker.price),
                bid: parseFloat(ticker.bid),
                ask: parseFloat(ticker.ask),
                volume: parseFloat(ticker.volume),
                time: ticker.time,
                trade_id: ticker.trade_id
            };
        } catch (error) {
            this.logger.error('Failed to get ticker:', error.message);
            throw error;
        }
    }

    async getCandles(productId, interval = 60, start = null, end = null) {
        try {
            let endpoint = `/products/${productId}/candles?granularity=${interval}`;

            if (start) endpoint += `&start=${start}`;
            if (end) endpoint += `&end=${end}`;

            const response = await this.makeRequest('GET', endpoint);

            return response.map(candle => ({
                timestamp: new Date(candle[0] * 1000),
                low: parseFloat(candle[1]),
                high: parseFloat(candle[2]),
                open: parseFloat(candle[3]),
                close: parseFloat(candle[4]),
                volume: parseFloat(candle[5])
            }));
        } catch (error) {
            this.logger.error('Failed to get candles:', error.message);
            throw error;
        }
    }

    async getProductStats(productId) {
        try {
            const stats = await this.makeRequest('GET', `/products/${productId}/stats`);
            return {
                open: parseFloat(stats.open),
                high: parseFloat(stats.high),
                low: parseFloat(stats.low),
                volume: parseFloat(stats.volume),
                last: parseFloat(stats.last),
                volume_30day: parseFloat(stats.volume_30day)
            };
        } catch (error) {
            this.logger.error('Failed to get product stats:', error.message);
            throw error;
        }
    }

    // ===== FILLS & TRANSACTIONS =====

    async getFills(orderId = null, productId = null) {
        try {
            let endpoint = '/fills';
            const params = new URLSearchParams();

            if (orderId) params.append('order_id', orderId);
            if (productId) params.append('product_id', productId);

            const queryString = params.toString();
            const response = await this.makeRequest('GET', `/fills${queryString ? '?' + queryString : ''}`);

            return response.map(fill => ({
                orderId: fill.order_id,
                tradeId: fill.trade_id,
                productId: fill.product_id,
                side: fill.side,
                size: parseFloat(fill.size),
                price: parseFloat(fill.price),
                fee: parseFloat(fill.fee),
                createdAt: fill.created_at,
                liquidity: fill.liquidity
            }));
        } catch (error) {
            this.logger.error('Failed to get fills:', error.message);
            throw error;
        }
    }

    // ===== DATABASE OPERATIONS =====

    async storeCredentials(apiKey, apiSecret, passphrase) {
        return new Promise((resolve, reject) => {
            const encryptedSecret = this.encryptToken(apiSecret);
            const encryptedPassphrase = this.encryptToken(passphrase);

            this.db.run(
                `INSERT OR REPLACE INTO broker_credentials (user_email, broker, auth_token, account_id, connected_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [apiKey, 'coinbase', encryptedSecret + '|' + encryptedPassphrase, this.accountId],
                (err) => {
                    if (err) reject(err);
                    else resolve({ success: true });
                }
            );
        });
    }

    async logOrder(productId, size, price, side, orderType, orderId, status) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO broker_orders (broker, symbol, quantity, price, side, order_type, order_id, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    'coinbase',
                    productId,
                    size,
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
                `UPDATE broker_positions SET synced_at = CURRENT_TIMESTAMP WHERE broker = 'coinbase'`,
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
                                'coinbase',
                                pos.symbol,
                                pos.quantity,
                                pos.currentPrice,
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

                    if (positions.length === 0) resolve({ success: true, positionsSync: 0 });
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

    // ===== WEBSOCKET REAL-TIME FEED =====

    async startWebSocketFeed(productIds = ['BTC-USD', 'ETH-USD']) {
        try {
            const WebSocket = require('ws');
            const wsUrl = 'wss://ws-feed.exchange.coinbase.com';

            this.websocket = new WebSocket(wsUrl);

            this.websocket.on('open', () => {
                const subscribeMessage = {
                    type: 'subscribe',
                    product_ids: productIds,
                    channels: ['ticker', 'full']
                };
                this.websocket.send(JSON.stringify(subscribeMessage));
                this.logger.info('WebSocket connected to Coinbase');
            });

            this.websocket.on('message', (data) => {
                const message = JSON.parse(data);
                this.handleWebSocketMessage(message);
            });

            this.websocket.on('close', () => {
                this.logger.warn('WebSocket disconnected, attempting reconnect...');
                setTimeout(() => this.startWebSocketFeed(productIds), this.reconnectInterval);
            });

            this.websocket.on('error', (error) => {
                this.logger.error('WebSocket error:', error.message);
            });
        } catch (error) {
            this.logger.error('Failed to start WebSocket feed:', error.message);
        }
    }

    async handleWebSocketMessage(message) {
        if (message.type === 'ticker') {
            await this.updatePriceCache(message);
        } else if (message.type === 'done') {
            await this.notifyOrderFill(message);
        }
    }

    async updatePriceCache(tickerData) {
        this.priceCache = this.priceCache || {};
        this.priceCache[tickerData.product_id] = {
            price: parseFloat(tickerData.price),
            time: tickerData.time
        };
    }

    async notifyOrderFill(fillData) {
        this.logger.info(`Order filled: ${fillData.product_id} ${fillData.side} ${fillData.size}@${fillData.price}`);
        // Trigger notifications for order fills
    }
}

module.exports = CoinbaseLiveIntegration;
